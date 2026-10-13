package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeWorkflows(t *testing.T, files map[string]string) string {
	dir := t.TempDir()
	wf := filepath.Join(dir, ".github", "workflows")
	os.MkdirAll(wf, 0o755)
	for name, body := range files {
		os.WriteFile(filepath.Join(wf, name), []byte(body), 0o644)
	}
	return dir
}

func TestReleaseTagPatterns(t *testing.T) {
	dir := writeWorkflows(t, map[string]string{
		"release.yml": "on:\n  push:\n    tags:\n      - \"v*\"   # releases\n      - 'rc-*'\n  workflow_dispatch:\n",
		"inline.yaml": "on:\n  push:\n    branches: [main]\n    tags: [ \"x*\", y ]\n",
		"docker.yml": "on:\n  push:\n    branches: [main]\njobs:\n  b:\n    steps:\n      - uses: docker/metadata-action@v5\n        with:\n          tags: |\n            type=semver\n",
	})
	got := releaseTagPatterns(dir)
	if strings.Join(got["release.yml"], ",") != "v*,rc-*" || strings.Join(got["inline.yaml"], ",") != "x*,y" || got["docker.yml"] != nil {
		t.Fatalf("patterns = %v", got)
	}
}

func TestReleaseTagWarning(t *testing.T) {
	var rulesets []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghs_t" {
			w.WriteHeader(404)
			return
		}
		switch r.URL.Path {
		case "/repos/acme/api/rulesets":
			json.NewEncoder(w).Encode(rulesets)
		case "/repos/acme/api/rulesets/7":
			json.NewEncoder(w).Encode(rulesets[0])
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	githubAPI = srv.URL
	defer func() { githubAPI = "https://api.github.com" }()
	dir := writeWorkflows(t, map[string]string{"release.yml": "on:\n  push:\n    tags:\n      - \"v*\"\n"})

	w := releaseTagWarning(dir, "ghs_t", "acme/api")
	if !strings.Contains(w, "v* (release.yml)") || !strings.Contains(w, "github.com/acme/api/settings/rules/new?target=tag") {
		t.Fatalf("no ruleset: warning = %q", w)
	}
	rulesets = []map[string]any{{"id": 7, "target": "tag", "enforcement": "active",
		"conditions": map[string]any{"ref_name": map[string]any{"include": []string{"refs/tags/v*"}}},
		"rules":      []map[string]any{{"type": "creation"}, {"type": "deletion"}}}}
	if w := releaseTagWarning(dir, "ghs_t", "acme/api"); w != "" {
		t.Fatalf("covered: warning = %q", w)
	}
	rulesets[0]["rules"] = []map[string]any{{"type": "deletion"}}
	if w := releaseTagWarning(dir, "ghs_t", "acme/api"); w == "" {
		t.Fatal("a ruleset that doesn't restrict creation must still warn")
	}
	if w := releaseTagWarning(dir, "other", "acme/api"); w != "" {
		t.Fatalf("rulesets unreadable: should stay quiet, got %q", w)
	}
}
