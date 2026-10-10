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
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
	payload, err := json.Marshal(request)
	if err != nil {
		return Result{}, fmt.Errorf("encode request: %w", err)
	}
	if len(payload) > 1024*1024 {
		return Result{}, errors.New("Sprout request exceeds 1 MiB")
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
	if !json.Valid(result.JSON) {
		return result, &Failure{Status: int(C.SPROUT_HOST_PROTOCOL_ERROR), ExitCode: result.ExitCode, Message: "worker did not emit a valid JSON value", Diagnostics: result.Diagnostics}
	}
	return result, nil
}

// Decode keeps JSON numbers as json.Number when target is an interface/map.
// Exact-value tags remain explicit maps unless the caller supplies a custom type.
func (r Result) Decode(target any) error {
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
