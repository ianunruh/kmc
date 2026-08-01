package ipam

import "testing"

func TestPoolWindowFirstFree(t *testing.T) {
	t.Parallel()
	w, err := ParsePoolWindow("10.40.1.0/24", "10.40.1.1", "", "", []string{"10.40.1.2"})
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]struct{}{"10.40.1.3": {}}
	addr, ok := w.FirstFree(used)
	if !ok || addr != "10.40.1.4" {
		t.Fatalf("got %q ok=%v, want 10.40.1.4", addr, ok)
	}
	if !w.Contains("10.40.1.50") {
		t.Fatal("expected contains")
	}
	if w.PrefixLength() != 24 {
		t.Fatalf("prefix %d", w.PrefixLength())
	}
}

func TestPoolWindowStartEnd(t *testing.T) {
	t.Parallel()
	w, err := ParsePoolWindow("10.0.0.0/24", "", "10.0.0.10", "10.0.0.12", nil)
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]struct{}{"10.0.0.10": {}, "10.0.0.11": {}}
	addr, ok := w.FirstFree(used)
	if !ok || addr != "10.0.0.12" {
		t.Fatalf("got %q ok=%v", addr, ok)
	}
	used["10.0.0.12"] = struct{}{}
	if _, ok := w.FirstFree(used); ok {
		t.Fatal("expected exhausted")
	}
}
