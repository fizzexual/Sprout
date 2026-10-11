// Package sprouthost runs bounded, process-isolated Sprout JSON workers.
package sprouthost

/*
#cgo CFLAGS: -std=c11
#include "embed.h"
#include <stdlib.h>
*/
import "C"

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
	"unsafe"
)

const maxBytes = 16 * 1024 * 1024

type Options struct {
	Timeout        time.Duration
	MaxSteps       uint64
	MaxOutputBytes int
	MaxMemoryBytes uint64 // 0 disables the optional OS memory cap.
	WorkingDir     string
	AllowIO        bool // false keeps the language sandbox enabled.
}

type Host struct {
	executable string
	options    Options
}

type Result struct {
	JSON        json.RawMessage
	Diagnostics string
	ExitCode    int
}

type Failure struct {
	Status      int
	ExitCode    int
	SystemCode  int
	Message     string
	Diagnostics string
}

func (e *Failure) Error() string {
	return fmt.Sprintf("Sprout worker failed (status %d, exit %d): %s", e.Status, e.ExitCode, e.Message)
}

func New(executable string, options Options) (*Host, error) {
	if !filepath.IsAbs(executable) || strings.IndexByte(executable, 0) >= 0 {
		return nil, errors.New("Sprout executable must have an absolute path")
	}
	if options.WorkingDir != "" && (!filepath.IsAbs(options.WorkingDir) || strings.IndexByte(options.WorkingDir, 0) >= 0) {
		return nil, errors.New("working directory must have an absolute path")
	}
	if options.Timeout == 0 {
		options.Timeout = 5 * time.Second
	}
	if options.MaxSteps == 0 {
		options.MaxSteps = 10_000_000
	}
	if options.MaxOutputBytes == 0 {
		options.MaxOutputBytes = 1024 * 1024
	}
	if options.Timeout < time.Millisecond || options.Timeout > time.Hour || options.MaxSteps > 1_000_000_000_000 || options.MaxOutputBytes < 1 || options.MaxOutputBytes > maxBytes {
		return nil, errors.New("invalid Sprout timeout, step, or output limit")
	}
	if options.MaxMemoryBytes != 0 && (options.MaxMemoryBytes < 16*1024*1024 || options.MaxMemoryBytes > 1<<46) {
		return nil, errors.New("memory cap must be zero or from 16 MiB to 64 TiB")
	}
	return &Host{executable: executable, options: options}, nil
}

// Run executes a source file in a fresh process. ctx cancellation terminates
// the Windows job or POSIX worker group; handles stay alive until callbacks join.
// POSIX guardians cascade cleanup through nested Sprout runner groups.
// Intentionally detached descendants can escape owned process groups.
func (h *Host) Run(ctx context.Context, program string, request any) (Result, error) {
	if h == nil {
		return Result{}, errors.New("a nonnil Sprout host is required")
	}
	if ctx == nil {
		return Result{}, errors.New("a nonnil context is required")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if !filepath.IsAbs(program) || strings.IndexByte(program, 0) >= 0 {
		return Result{}, errors.New("Sprout program must have an absolute path without NUL")
	}
	if err := validateRequestText(reflect.ValueOf(request), make(map[inputVisit]bool), 0); err != nil {
		return Result{}, fmt.Errorf("invalid request text: %w", err)
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return Result{}, fmt.Errorf("encode request: %w", err)
	}
	if len(payload) > 1024*1024 {
		return Result{}, errors.New("Sprout request exceeds 1 MiB")
	}
	if err := validateWireJSON(payload); err != nil {
		return Result{}, fmt.Errorf("invalid request JSON: %w", err)
	}
	executable, source, cwd, input := C.CString(h.executable), C.CString(program), C.CString(h.options.WorkingDir), C.CString(string(payload))
	defer C.free(unsafe.Pointer(executable))
	defer C.free(unsafe.Pointer(source))
	defer C.free(unsafe.Pointer(cwd))
	defer C.free(unsafe.Pointer(input))
	if executable == nil || source == nil || cwd == nil || input == nil {
		return Result{}, errors.New("native host allocation failed")
	}
	var options C.SproutHostOptions
	C.sprout_host_options_init_sized(&options, C.size_t(unsafe.Sizeof(options)))
	options.executable, options.program, options.request_json = executable, source, input
	if h.options.WorkingDir != "" {
		options.cwd = cwd
	}
	options.request_length = C.size_t(len(payload))
	options.timeout_ms = C.uint(h.options.Timeout.Milliseconds())
	options.max_steps = C.uint64_t(h.options.MaxSteps)
	options.max_output_bytes = C.size_t(h.options.MaxOutputBytes)
	options.max_memory_bytes = C.uint64_t(h.options.MaxMemoryBytes)
	if h.options.AllowIO {
		options.flags = C.SPROUT_HOST_ALLOW_IO
	}
	cancel := C.sprout_host_cancel_new()
	if cancel == nil {
		return Result{}, errors.New("native cancellation allocation failed")
	}
	finished, joined := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(joined)
		select {
		case <-ctx.Done():
			C.sprout_host_cancel_request(cancel)
		case <-finished:
		}
	}()
	var native C.SproutHostResult
	status := C.sprout_host_run_cancellable(&options, &native, cancel)
	close(finished)
	<-joined
	C.sprout_host_cancel_free(cancel)
	defer C.sprout_host_result_free(&native)
	result := Result{JSON: C.GoBytes(unsafe.Pointer(native.output_json), C.int(native.output_length)), Diagnostics: C.GoStringN(native.diagnostics, C.int(native.diagnostics_length)), ExitCode: int(native.exit_code)}
	if status == C.SPROUT_HOST_CANCELLED {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		return result, context.Canceled
	}
	if status == C.SPROUT_HOST_TIMEOUT {
		return result, fmt.Errorf("Sprout worker timeout: %w", context.DeadlineExceeded)
	}
	if status != C.SPROUT_HOST_OK {
		return result, &Failure{Status: int(status), ExitCode: int(native.exit_code), SystemCode: int(native.system_code), Message: C.GoString(native.error), Diagnostics: result.Diagnostics}
	}
	if err := validateWireJSON(result.JSON); err != nil {
		return result, &Failure{Status: int(C.SPROUT_HOST_PROTOCOL_ERROR), ExitCode: result.ExitCode, Message: "worker emitted invalid JSON: " + err.Error(), Diagnostics: result.Diagnostics}
	}
	return result, nil
}

type inputVisit struct {
	kind    reflect.Kind
	typ     reflect.Type
	pointer uintptr
}

// Check plain host text before encoding/json can replace malformed UTF-8. Custom
// marshalers own their transformations; their resulting wire is checked below.
func validateRequestText(value reflect.Value, active map[inputVisit]bool, depth int) error {
	if !value.IsValid() {
		return nil
	}
	if depth > 1024 {
		return errors.New("host object graph is nested too deeply")
	}
	if value.CanInterface() {
		if _, custom := value.Interface().(json.Marshaler); custom {
			return nil
		}
	}
	switch value.Kind() {
	case reflect.String:
		if !utf8.ValidString(value.String()) || strings.IndexByte(value.String(), 0) >= 0 {
			return errors.New("text must be UTF-8 without NUL")
		}
	case reflect.Interface:
		if !value.IsNil() {
			return validateRequestText(value.Elem(), active, depth+1)
		}
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if value.IsNil() {
			return nil
		}
		visit := inputVisit{value.Kind(), value.Type(), uintptr(value.UnsafePointer())}
		if active[visit] {
			return errors.New("host object graph contains a cycle")
		}
		active[visit] = true
		defer delete(active, visit)
		if value.Kind() == reflect.Pointer {
			return validateRequestText(value.Elem(), active, depth+1)
		}
		if value.Kind() == reflect.Map {
			items := value.MapRange()
			for items.Next() {
				if err := validateRequestText(items.Key(), active, depth+1); err != nil {
					return err
				}
				if err := validateRequestText(items.Value(), active, depth+1); err != nil {
					return err
				}
			}
		} else {
			for i := 0; i < value.Len(); i++ {
				if err := validateRequestText(value.Index(i), active, depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.Array:
		for i := 0; i < value.Len(); i++ {
			if err := validateRequestText(value.Index(i), active, depth+1); err != nil {
				return err
			}
		}
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			field := value.Type().Field(i)
			if field.PkgPath == "" && field.Tag.Get("json") != "-" {
				if err := validateRequestText(value.Field(i), active, depth+1); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Decode keeps JSON numbers as json.Number when target is an interface/map.
// Exact-value tags remain explicit maps unless the caller supplies a custom type.
func (r Result) Decode(target any) error {
	if err := validateWireJSON(r.JSON); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(r.JSON))
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("worker output contained multiple JSON values")
	}
	return nil
}

// Tokenize before decoding so duplicate keys cannot silently change a decision.
// Tags remain explicit maps. Large finite ordinary numbers retain json.Number.
func validateWireJSON(payload []byte) error {
	if len(payload) > maxBytes {
		return errors.New("JSON exceeds 16 MiB")
	}
	if err := validateWireText(payload); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(payload))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		token, err := d.Token()
		if err != nil {
			return err
		}
		switch v := token.(type) {
		case json.Delim:
			if depth >= 128 {
				return errors.New("JSON nesting exceeds 128 containers")
			}
			switch v {
			case '{':
				keys := make(map[string]struct{})
				for d.More() {
					key, err := d.Token()
					if err != nil {
						return err
					}
					name, ok := key.(string)
					if !ok {
						return errors.New("JSON object key is not text")
					}
					if _, exists := keys[name]; exists {
						return errors.New("duplicate JSON object key")
					}
					keys[name] = struct{}{}
					if err := value(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for d.More() {
					if err := value(depth + 1); err != nil {
						return err
					}
				}
			default:
				return errors.New("unexpected JSON delimiter")
			}
			_, err = d.Token()
			return err
		case json.Number:
			n, err := strconv.ParseFloat(string(v), 64)
			if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
				return errors.New("JSON number is not finite")
			}
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}

// encoding/json replaces lone surrogate escapes instead of rejecting them.
// Check the wire before that replacement loses the original malformed text.
func validateWireText(payload []byte) error {
	if !utf8.Valid(payload) {
		return errors.New("JSON is not valid UTF-8")
	}
	hex4 := func(at int) (uint16, bool) {
		if at+4 > len(payload) {
			return 0, false
		}
		var value uint16
		for _, c := range payload[at : at+4] {
			value <<= 4
			switch {
			case c >= '0' && c <= '9':
				value |= uint16(c - '0')
			case c >= 'a' && c <= 'f':
				value |= uint16(c - 'a' + 10)
			case c >= 'A' && c <= 'F':
				value |= uint16(c - 'A' + 10)
			default:
				return 0, false
			}
		}
		return value, true
	}
	quoted := false
	for i := 0; i < len(payload); i++ {
		c := payload[i]
		if !quoted {
			if c == '"' {
				quoted = true
			}
			continue
		}
		if c == '"' {
			quoted = false
			continue
		}
		if c != '\\' {
			continue
		}
		i++
		if i >= len(payload) {
			return errors.New("truncated JSON escape")
		}
		if payload[i] != 'u' {
			continue
		}
		cp, ok := hex4(i + 1)
		if !ok {
			return errors.New("invalid JSON Unicode escape")
		}
		i += 4
		if cp == 0 {
			return errors.New("Sprout JSON text cannot contain NUL")
		}
		if cp >= 0xd800 && cp <= 0xdbff {
			if i+6 >= len(payload) || payload[i+1] != '\\' || payload[i+2] != 'u' {
				return errors.New("unpaired JSON surrogate")
			}
			lo, ok := hex4(i + 3)
			if !ok || lo < 0xdc00 || lo > 0xdfff {
				return errors.New("unpaired JSON surrogate")
			}
			i += 6
		} else if cp >= 0xdc00 && cp <= 0xdfff {
			return errors.New("unpaired JSON surrogate")
		}
	}
	return nil
}

type Integer int64

func (n Integer) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"$sprout.integer": strconv.FormatInt(int64(n), 10)})
}

type Decimal string

func (n Decimal) MarshalJSON() ([]byte, error) {
	text := string(n)
	digits := text
	if len(digits) > 0 && (digits[0] == '-' || digits[0] == '+') {
		digits = digits[1:]
	}
	parts := strings.Split(digits, ".")
	if len(parts) > 2 || len(parts[0]) == 0 || (len(parts) == 2 && (len(parts[1]) == 0 || len(parts[1]) > 18)) {
		return nil, errors.New("decimal requires digits and at most 18 fractional places")
	}
	coefficient := strings.ReplaceAll(text, ".", "")
	for _, p := range parts {
		for _, c := range p {
			if c < '0' || c > '9' {
				return nil, errors.New("decimal requires decimal digits, without exponent notation")
			}
		}
	}
	if _, err := strconv.ParseInt(coefficient, 10, 64); err != nil {
		return nil, fmt.Errorf("decimal coefficient exceeds int64: %w", err)
	}
	return json.Marshal(map[string]string{"$sprout.decimal": string(n)})
}

type Bytes []byte

func (b Bytes) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"$sprout.bytes": hex.EncodeToString(b)})
}
