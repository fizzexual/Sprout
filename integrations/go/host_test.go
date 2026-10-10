package sprouthost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testHost(t *testing.T, options Options) *Host {
	t.Helper()
	executable := os.Getenv("SPROUT_BINARY")
	if executable == "" {
		t.Fatal("set SPROUT_BINARY to a native Sprout executable")
	}
	h, err := New(executable, options)
	if err != nil {
		t.Fatal(err)
	}
	return h
}
func source(t *testing.T, code string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "worker's source.sprout")
	if err := os.WriteFile(p, []byte(code), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNativeSourcesAreCurrent(t *testing.T) {
	for _, name := range []string{"embed.c", "embed.h", "process_native.h"} {
		local, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		shared, err := os.ReadFile(filepath.Join("..", "..", "src", name))
		if os.IsNotExist(err) {
			t.Skip("shared repository not present in standalone module archive")
		}
		if err != nil {
			t.Fatal(err)
		}
		if string(local) != string(shared) {
			t.Fatalf("%s is stale; run sync_native.py", name)
		}
	}
}
func TestRoundtripAndPricingRules(t *testing.T) {
	h := testHost(t, Options{})
	p := source(t, "show json_encode(json_decode(read_input()))\n")
	r, err := h.Run(context.Background(), p, map[string]any{"name": "🌱 Привіт", "id": Integer(9223372036854775807), "money": Decimal("0.10"), "bytes": Bytes{0, 255}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := r.Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["name"] != "🌱 Привіт" || decoded["id"].(map[string]any)["$sprout.integer"] != "9223372036854775807" {
		t.Fatal(decoded)
	}
	rules, err := filepath.Abs("examples/rules.sprout")
	if err != nil {
		t.Fatal(err)
	}
	r, err = h.Run(context.Background(), rules, map[string]any{"quantity": 10, "unit_price": Decimal("12.50")})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(r.JSON), "112.5") && !strings.Contains(string(r.JSON), "112.50") {
		t.Fatal(string(r.JSON))
	}
}
func TestFailureBoundsAndRecovery(t *testing.T) {
	h := testHost(t, Options{MaxOutputBytes: 32})
	_, err := h.Run(context.Background(), source(t, "show \""+strings.Repeat("x", 10000)+"\"\n"), nil)
	var failure *Failure
	if !errors.As(err, &failure) || failure.Status != 4 {
		t.Fatalf("expected output limit, got %v", err)
	}
	_, err = h.Run(context.Background(), source(t, "show \"invalid-json\"\n"), nil)
	if !errors.As(err, &failure) || failure.Status != 6 {
		t.Fatalf("expected protocol failure, got %v", err)
	}
	r, err := h.Run(context.Background(), source(t, "show json_encode({ready:yes})\n"), nil)
	if err != nil || !strings.Contains(string(r.JSON), "true") {
		t.Fatalf("%s: %v", r.JSON, err)
	}
	_, err = testHost(t, Options{}).Run(context.Background(), source(t, "show file_read(\"forbidden\")\n"), nil)
	if !errors.As(err, &failure) || failure.Status != 5 || !strings.Contains(failure.Diagnostics, "sandbox") {
		t.Fatalf("expected sandbox failure, got %v", err)
	}
}
func TestCancellationAndTimeout(t *testing.T) {
	p := source(t, "repeat while yes:\n    make n = 1\n")
	h := testHost(t, Options{Timeout: 3 * time.Second, MaxSteps: 1_000_000_000_000})
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(50*time.Millisecond, cancel)
	defer timer.Stop()
	defer cancel()
	start := time.Now()
	_, err := h.Run(ctx, p, nil)
	if !errors.Is(err, context.Canceled) || time.Since(start) > time.Second {
		t.Fatalf("cancellation did not bound worker: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	_, err = h.Run(ctx, p, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	bounded := testHost(t, Options{Timeout: 50 * time.Millisecond, MaxSteps: 1_000_000_000_000})
	_, err = bounded.Run(context.Background(), p, nil)
	var f *Failure
	if !errors.Is(err, context.DeadlineExceeded) && !(errors.As(err, &f) && f.Status == 5) {
		t.Fatalf("expected host/runtime timeout: %v", err)
	}
}
func TestConcurrentCalls(t *testing.T) {
	h := testHost(t, Options{})
	p := source(t, "show json_encode(json_decode(read_input()))\n")
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			r, err := h.Run(context.Background(), p, map[string]int{"n": i})
			if err != nil {
				t.Error(err)
				return
			}
			var v struct{ N int }
			if err := r.Decode(&v); err != nil || v.N != i {
				t.Errorf("%s %v", r.JSON, err)
			}
		}(i)
	}
	group.Wait()
}
func TestInvalidRequestsAndExactDecimals(t *testing.T) {
	h := testHost(t, Options{})
	p := source(t, "show json_encode(42)\n")
	if _, err := h.Run(context.Background(), p, strings.Repeat("x", 1048576)); err == nil {
		t.Fatal("oversized request accepted")
	}
	for _, n := range []Decimal{"NaN", "1e3", ".1", "1.", "9223372036854775808", "0.0000000000000000001"} {
		if _, err := json.Marshal(n); err == nil {
			t.Fatalf("invalid decimal %s", n)
		}
	}
	for _, n := range []Decimal{"-9223372036854775808", "+1.20", "0.000000000000000001"} {
		if _, err := json.Marshal(n); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := New("relative", Options{}); err == nil {
		t.Fatal("relative executable accepted")
	}
}
