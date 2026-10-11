package sprouthost

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestWorkerProtocolRejectsAmbiguousOrUnrepresentableData(t *testing.T) {
	h := testHost(t, Options{})
	for name, wire := range map[string]string{
		"duplicate":              `{"allow":false,"allow":true}`,
		"escaped duplicate":      `{"allow":false,"\u0061llow":true}`,
		"nested duplicate":       `{"outer":{"role":"reader","role":"admin"}}`,
		"nonfinite":              `{"amount":1e999}`,
		"negative nonfinite":     `-1e999`,
		"deep":                   strings.Repeat("[", 129) + "0" + strings.Repeat("]", 129),
		"deep empty container":   strings.Repeat("[", 129) + strings.Repeat("]", 129),
		"lone high surrogate":    `{"text":"\ud800"}`,
		"lone low surrogate key": `{"\udc00":true}`,
		"nul":                    `{"text":"\u0000suffix"}`,
		"nul key":                `{"\u0000":true}`,
		"leading blank line":     "\n{}",
		"trailing blank line":    "{}\n",
	} {
		t.Run(name, func(t *testing.T) {
			literal, err := json.Marshal(wire)
			if err != nil {
				t.Fatal(err)
			}
			_, err = h.Run(context.Background(), source(t, "show "+string(literal)+"\n"), nil)
			var failure *Failure
			if !errors.As(err, &failure) || failure.Status != 6 {
				t.Fatalf("ambiguous output accepted or wrong failure: %v", err)
			}
		})
	}
	result, err := h.Run(context.Background(), source(t, "show json_encode({ok:yes})\n"), nil)
	if err != nil || !strings.Contains(string(result.JSON), "true") {
		t.Fatalf("recovery failed: %v %s", err, result.JSON)
	}
}

func TestWireBoundaryPreservesValidPairsAndFiniteLargeNumbers(t *testing.T) {
	for _, wire := range []string{
		`{"text":"\ud83c\udf31","literal":"\\ud800","replacement":"�"}`,
		`{"value":100000000000000000000,"tag":{"$sprout.integer":"9223372036854775807"}}`,
		strings.Repeat("[", 128) + "0" + strings.Repeat("]", 128),
		strings.Repeat("[", 128) + strings.Repeat("]", 128),
		`{"__proto__":{"allow":true},"constructor":"ordinary data"}`,
	} {
		result := Result{JSON: json.RawMessage(wire)}
		var value any
		if err := result.Decode(&value); err != nil {
			t.Fatalf("valid boundary changed: %s: %v", wire, err)
		}
	}
}

type rawRequest string

func (r rawRequest) MarshalJSON() ([]byte, error) { return []byte(r), nil }

type observedRequest struct{ calls *int }

func (r observedRequest) MarshalJSON() ([]byte, error) { *r.calls++; return []byte(`"observed"`), nil }

func TestOrdinaryAliasGraphRejectsBeforeSerialization(t *testing.T) {
	h := testHost(t, Options{})
	var aliased any = "leaf"
	for i := 0; i < 18; i++ {
		aliased = []any{aliased, aliased}
	}
	calls := 0
	_, err := h.Run(context.Background(), source(t, "fail \"must not run\"\n"), []any{aliased, observedRequest{&calls}})
	if err == nil || !strings.Contains(err.Error(), "1 MiB") || calls != 0 {
		t.Fatalf("oversized graph was fully serialized: err=%v custom calls=%d", err, calls)
	}
	// A legal request right at the byte boundary still reaches an actual worker.
	if _, err := h.Run(context.Background(), source(t, "show json_encode({ok:yes})\n"), strings.Repeat("x", 1024*1024-2)); err != nil {
		t.Fatalf("exact ASCII request cap rejected: %v", err)
	}
	if _, err := h.Run(context.Background(), source(t, "show json_encode({ok:yes})\n"), strings.Repeat("🌱", (1024*1024-2)/4)); err != nil {
		t.Fatalf("UTF-8 request boundary rejected: %v", err)
	}
}

func TestCustomRequestAndPublicDecodeUseTheSameBoundary(t *testing.T) {
	h := testHost(t, Options{})
	for _, wire := range []string{`{"allow":false,"allow":true}`, `{"text":"\ud800"}`, `{"text":"\u0000"}`, `1e999`, strings.Repeat("[", 129) + "0" + strings.Repeat("]", 129)} {
		// A missing source makes a spawn/runtime error observable if validation is
		// accidentally deferred until after launch.
		_, err := h.Run(context.Background(), source(t, "fail \"must not run\"\n"), rawRequest(wire))
		var failure *Failure
		if err == nil || errors.As(err, &failure) {
			t.Fatalf("invalid request reached worker: %s: %v", wire, err)
		}
		var decoded any
		if err := (Result{JSON: json.RawMessage(wire)}).Decode(&decoded); err == nil {
			t.Fatalf("public Decode accepted %s", wire)
		}
	}
}

func TestPlainRequestTextDoesNotSilentlyNormalizeBeforeSerialization(t *testing.T) {
	h := testHost(t, Options{})
	for _, value := range []any{string([]byte{0xff}), map[string]string{"key": string([]byte{0xff})}, map[string]any{string([]byte{0xff}): true}, []any{"NUL\x00suffix"}, struct{ Text string }{string([]byte{0xff})}} {
		_, err := h.Run(context.Background(), source(t, "fail \"must not run\"\n"), value)
		var failure *Failure
		if err == nil || errors.As(err, &failure) {
			t.Fatalf("malformed host text reached worker: %v", err)
		}
	}
	var input any = []any{map[string]string{"paired": "🌱", "replacement": "�"}}
	for i := 0; i < 126; i++ {
		input = []any{input}
	}
	if _, err := h.Run(context.Background(), source(t, "show json_encode(42)\n"), input); err != nil {
		t.Fatalf("valid 128-container request rejected: %v", err)
	}
}
