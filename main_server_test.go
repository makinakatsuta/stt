//go:build !js

package main

import (
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedRuntimeAssets(t *testing.T) {
	handler := staticHandler()
	err := fs.WalkDir(bundledAssets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		url := "/" + strings.TrimPrefix(path, "docs/")
		if url == "/index.html" {
			url = "/"
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", url, nil))
		if response.Code != 200 || response.Body.Len() == 0 {
			t.Errorf("%s: status %d, bytes %d", url, response.Code, response.Body.Len())
		}
		if strings.HasSuffix(url, ".wasm") && response.Header().Get("Content-Type") != "application/wasm" {
			t.Errorf("WASM MIME type: %s", response.Header().Get("Content-Type"))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"/accessibility.test.cjs", "/main_server.go", "/.git/config"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", url, nil))
		if response.Code != 404 {
			t.Errorf("Unexpected published development file %s: %d", url, response.Code)
		}
	}
}
