package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// memKeys stands in for the OS keychain in every test: none of them may touch the real one.
type memKeys map[string]string

func (memKeys) name() string { return "test keychain" }
func (m memKeys) get(id string) (string, error) {
	if k, ok := m[id]; ok {
		return k, nil
	}
	return "", errors.New("not found")
}
func (m memKeys) set(id, secret string) error { m[id] = secret; return nil }

func TestMain(m *testing.M) {
	keys = memKeys{}
	os.Exit(m.Run())
}

func TestKeysLiveInTheKeychain(t *testing.T) {
	store := memKeys{}
	keys = store
	defer func() { keys = memKeys{} }()
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("HUG_CONFIG", p)

	// An older config with keys in the file moves them on the next load.
	os.WriteFile(p, []byte(`{"account_key":"hug_acct","login":"ana","agents":{"claude":"ghg_claude"},"default_agent":"claude"}`), 0o600)
	stderr = &bytes.Buffer{}
	defer func() { stderr = os.Stderr }()
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if strings.Contains(string(b), "hug_acct") || strings.Contains(string(b), "ghg_claude") {
		t.Fatalf("config.json still holds keys: %s", b)
	}
	if cfg.AccountKey != "hug_acct" || store[p+"#agent:claude"] != "ghg_claude" {
		t.Fatalf("account = %q, store = %v", cfg.AccountKey, store)
	}

	// A fresh load reads them back: the account key at once, an agent's when it acts.
	cfg, _ = loadConfig()
	if k, err := cfg.agentKey("claude"); err != nil || k != "ghg_claude" || cfg.AccountKey != "hug_acct" {
		t.Fatalf("agentKey = %q, %v; account = %q", k, err, cfg.AccountKey)
	}

	// A rotation replaces the stored key; an unchanged one isn't rewritten.
	writes := len(store)
	cfg.Agents["claude"] = "ghg_new"
	cfg.save()
	if store[p+"#agent:claude"] != "ghg_new" || len(store) != writes {
		t.Fatalf("store = %v", store)
	}

	// config show names where each key lives and prints none.
	var out bytes.Buffer
	stdout = &out
	defer func() { stdout = os.Stdout }()
	if err := run([]string{"config", "show", "--json"}); err != nil {
		t.Fatal(err)
	}
	var shown map[string]any
	json.Unmarshal(out.Bytes(), &shown)
	if strings.Contains(out.String(), "ghg_") || strings.Contains(out.String(), "hug_acct") ||
		shown["account_key"] != "set (test keychain)" || shown["agents"].(map[string]any)["claude"] != "set (test keychain)" {
		t.Fatalf("config show = %s", out.String())
	}
}

// No keychain (CI, HUG_KEYCHAIN=0): keys stay in config.json, as before.
func TestKeysWithoutAKeychain(t *testing.T) {
	keys = nil
	defer func() { keys = memKeys{} }()
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("HUG_CONFIG", p)
	cfg, _ := loadConfig()
	cfg.AccountKey, cfg.Agents["claude"] = "hug_acct", "ghg_claude"
	if err := cfg.save(); err != nil {
		t.Fatal(err)
	}
	cfg, _ = loadConfig()
	if k, _ := cfg.agentKey("claude"); k != "ghg_claude" || cfg.AccountKey != "hug_acct" {
		t.Fatalf("agent = %q, account = %q", k, cfg.AccountKey)
	}
	t.Setenv("HUG_KEYCHAIN", "0")
	if defaultKeystore() != nil {
		t.Fatal("HUG_KEYCHAIN=0 must turn the keychain off")
	}
}
