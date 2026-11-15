package ouogo

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

const testDebugID = "c0ffee00-0000-4000-8000-000000000001"

func TestNormalizeDebugID(t *testing.T) {
	for in, want := range map[string]string{
		testDebugID:                            testDebugID,
		"C0FFEE00000040008000000000000001":     testDebugID,
		"C0FFEE00-0000-4000-8000-000000000001": testDebugID,
		"c0ffee00-0000-4000-8000-00000000001":  "",
		"../../x":                              "",
		"":                                     "",
	} {
		got, ok := NormalizeDebugID(in)
		if got != want || ok != (want != "") {
			t.Errorf("NormalizeDebugID(%q) = %q, %v", in, got, ok)
		}
	}
}

func TestDebugFilePath(t *testing.T) {
	for in, want := range map[string]string{
		"https://shop.example/assets/app.min.js?v=2#x": "/assets/app.min.js",
		"app:///index.android.bundle":                  "/index.android.bundle",
		"index.android.bundle":                         "/index.android.bundle",
		"/a/./b/../app.js?x":                           "/a/app.js",
	} {
		if got := DebugFilePath(in); got != want {
			t.Errorf("DebugFilePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDebugFileReads(t *testing.T) {
	body := []byte(`{"version":3}`)
	var gotQuery, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotAuth = r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/v1/projects/shop/debug-files/sourcemap/" + testDebugID:
			w.Header().Set("Content-Encoding", "gzip")
			zw := gzip.NewWriter(w)
			zw.Write(body)
			zw.Close()
		case "/api/v1/projects/shop/debug-files/sourcemap":
			w.Write([]byte(`{"debug_ids":["` + testDebugID + `","BE3E3E2698CB4AE49A16FAAF2769D6A4","junk"]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m := &Muninn{URL: srv.URL, ReadToken: "rt"}
	ctx := context.Background()

	b, err := m.DebugFile(ctx, "shop", DebugFileSourceMap, "C0FFEE00000040008000000000000001")
	if err != nil || !bytes.Equal(b, body) || gotAuth != "Bearer rt" {
		t.Fatalf("DebugFile = %q, %v (auth %q)", b, err, gotAuth)
	}
	if _, err := m.DebugFile(ctx, "shop", DebugFileDSYM, testDebugID); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing file: %v", err)
	}

	ids, err := m.DebugFileIDs(ctx, "shop", DebugFileSourceMap, "1.4.2", "https://shop.example/assets/app.min.js?v=1")
	if err != nil {
		t.Fatal(err)
	}
	if gotQuery != "file=%2Fassets%2Fapp.min.js&release=1.4.2" || gotPath != "/api/v1/projects/shop/debug-files/sourcemap" {
		t.Errorf("list request %s?%s", gotPath, gotQuery)
	}
	if len(ids) != 2 || ids[0] != testDebugID || ids[1] != "be3e3e26-98cb-4ae4-9a16-faaf2769d6a4" {
		t.Errorf("ids %v", ids)
	}
}

func TestDebugFileValidation(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	m := &Muninn{URL: srv.URL}
	ctx := context.Background()
	long := string(make([]byte, 300))
	for name, err := range map[string]error{
		"kind":       func() error { _, err := m.DebugFile(ctx, "shop", "elf", testDebugID); return err }(),
		"id":         func() error { _, err := m.DebugFile(ctx, "shop", DebugFileSourceMap, "../x"); return err }(),
		"project":    func() error { _, err := m.DebugFile(ctx, "Shop/..", DebugFileSourceMap, testDebugID); return err }(),
		"list kind":  func() error { _, err := m.DebugFileIDs(ctx, "shop", "", "1", "/a.js"); return err }(),
		"no release": func() error { _, err := m.DebugFileIDs(ctx, "shop", DebugFileSourceMap, "", "/a.js"); return err }(),
		"long":       func() error { _, err := m.DebugFileIDs(ctx, "shop", DebugFileSourceMap, long, "/a.js"); return err }(),
		"no file":    func() error { _, err := m.DebugFileIDs(ctx, "shop", DebugFileSourceMap, "1", ""); return err }(),
	} {
		var bad *BadRequestError
		if !errors.As(err, &bad) {
			t.Errorf("%s: %v, want BadRequestError", name, err)
		}
	}
	if calls.Load() != 0 {
		t.Errorf("%d requests sent for invalid input", calls.Load())
	}
}

func TestDebugFileBackendError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bucket down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	_, err := (&Muninn{URL: srv.URL}).DebugFile(context.Background(), "shop", DebugFileSourceMap, testDebugID)
	var be *BackendError
	if !errors.As(err, &be) || errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v", err)
	}
}
