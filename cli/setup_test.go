package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setupClone: a fake githug that mints for orbit, a config holding orbit's key, and a fresh
// clone of acme/api as the working directory.
func setupClone(t *testing.T) (repo string) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/token" {
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"token": "ghs_tok", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"agent": map[string]any{"id": "orbit"}, "author": map[string]any{"name": "orbit", "email": "orbit@agents.githug.ai"},
			"trailers": []string{"Agent: orbit"},
		})
	}))
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	t.Setenv("HUG_CONFIG", filepath.Join(dir, "cfg", "config.json"))
	t.Setenv("GITHUG_URL", srv.URL)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(dir, "gitconfig"))
	t.Setenv("GIT_CONFIG_COUNT", "")
	githubAPI = srv.URL // no workflows here, but keep the tag check off the network
	t.Cleanup(func() { githubAPI = "https://api.github.com" })
	if err := (&Config{Agents: map[string]string{"orbit": "ghg_k"}, DefaultAgent: "orbit"}).save(); err != nil {
		t.Fatal(err)
	}
	repo = filepath.Join(dir, "repo")
	for _, c := range [][]string{{"init", "-q", repo}, {"-C", repo, "remote", "add", "origin", "https://github.com/acme/api.git"}} {
		if out, err := exec.Command("git", c...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", c, out)
		}
	}
	wd, _ := os.Getwd()
	t.Cleanup(func() { os.Chdir(wd) })
	os.Chdir(repo)
	return repo
}

func localConfig(t *testing.T, key string) []string {
	out, _ := exec.Command("git", "config", "--local", "--get-all", key).Output()
	if len(out) == 0 {
		return nil
	}
	return strings.Split(strings.TrimSuffix(string(out), "\n"), "\n")
}

// A session that brings the agent's identity in GIT_CONFIG_* (a clone shared with a person)
// must not get it written into .git/config, where it would author the person's commits too.
func TestSetupLeavesEnvIdentityAlone(t *testing.T) {
	setupClone(t)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "githug.agent")
	t.Setenv("GIT_CONFIG_VALUE_0", "orbit")
	var errBuf bytes.Buffer
	stderr = &errBuf
	defer func() { stderr = os.Stderr }()
	if err := cmdSetup(nil); err != nil {
		t.Fatal(err)
	}
	if v := localConfig(t, "user.email"); v != nil {
		t.Fatalf("wrote user.email = %v", v)
	}
	if !strings.Contains(errBuf.String(), "Changed nothing") {
		t.Fatalf("stderr = %q", errBuf.String())
	}
	if err := cmdSetup([]string{"--force", "--no-hook"}); err != nil || localConfig(t, "user.email") == nil {
		t.Fatalf("--force: err = %v, user.email = %v", err, localConfig(t, "user.email"))
	}
}

func TestSetupEnvPrintsBlockAndGuardsHooks(t *testing.T) {
	repo := setupClone(t)
	var out bytes.Buffer
	stdout, stderr = &out, &bytes.Buffer{}
	defer func() { stdout, stderr = os.Stdout, os.Stderr }()
	if err := cmdSetup([]string{"--env"}); err != nil {
		t.Fatal(err)
	}
	var block struct{ Env map[string]string }
	if err := json.Unmarshal(out.Bytes(), &block); err != nil {
		t.Fatalf("stdout = %q", out.String())
	}
	e := block.Env
	if e["GIT_CONFIG_COUNT"] != "6" || e["GIT_CONFIG_KEY_1"] != "user.email" || e["GIT_CONFIG_VALUE_1"] != "orbit@agents.githug.ai" ||
		e["GIT_CONFIG_VALUE_4"] != "" || !strings.HasSuffix(e["GIT_CONFIG_VALUE_5"], " credential") {
		t.Fatalf("env = %v", e)
	}
	if localConfig(t, "user.email") != nil || localConfig(t, "githug.agent") != nil {
		t.Fatal("--env wrote .git/config")
	}
	// The person's own commit: no agent configured, so the hook leaves the message alone
	// (and never runs hug).
	hook := filepath.Join(repo, ".git", "hooks", "prepare-commit-msg")
	msg := filepath.Join(repo, "MSG")
	os.WriteFile(msg, []byte("mine\n"), 0o644)
	cmd := exec.Command("sh", hook, msg, "message")
	cmd.Env = append(os.Environ(), "GITHUG_AGENT_KEY=")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("hook: %v %s", err, b)
	}
	if b, _ := os.ReadFile(msg); string(b) != "mine\n" {
		t.Fatalf("message = %q", b)
	}
}

func TestSetupTwiceThenUndo(t *testing.T) {
	repo := setupClone(t)
	stderr = &bytes.Buffer{}
	defer func() { stderr = os.Stderr }()
	exec.Command("git", "config", "--local", "core.autocrlf", "false").Run() // someone else's setting
	for i := 0; i < 2; i++ {
		if err := cmdSetup(nil); err != nil {
			t.Fatal(err)
		}
	}
	if v := localConfig(t, "user.email"); len(v) != 1 {
		t.Fatalf("user.email = %v", v)
	}
	if v := localConfig(t, "credential.https://github.com.helper"); len(v) != 2 || v[0] != "" || !strings.HasSuffix(v[1], " credential") {
		t.Fatalf("helpers = %q", v)
	}
	if err := cmdSetup([]string{"--undo"}); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"user.name", "user.email", "githug.agent", "githug.repo", "credential.https://github.com.helper"} {
		if v := localConfig(t, k); v != nil {
			t.Errorf("%s still set: %v", k, v)
		}
	}
	if v := localConfig(t, "core.autocrlf"); len(v) != 1 {
		t.Error("undo touched a setting setup never wrote")
	}
	if _, err := os.Stat(filepath.Join(repo, ".git", "hooks", "pre-push")); !os.IsNotExist(err) {
		t.Error("undo left hug's pre-push hook")
	}
}
