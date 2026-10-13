package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Config is what `hug` remembers between runs: the account key from device login and
// the bearer key of every agent created from this machine. Written 0600. The keys themselves
// go to the OS keychain when there is one (keystore.go); the file then says "keychain".
type Config struct {
	BaseURL      string            `json:"base_url,omitempty"`
	AccountKey   string            `json:"account_key,omitempty"`
	Login        string            `json:"login,omitempty"`
	Agents       map[string]string `json:"agents,omitempty"` // agent id → ghg_ key, or "keychain"
	DefaultAgent string            `json:"default_agent,omitempty"`

	kept map[string]string // which ("account", "agent:NAME") → the key known to be in the keychain
}

// configPath honours HUG_CONFIG, then $XDG_CONFIG_HOME/hug, then ~/.config/hug.
func configPath() (string, error) {
	if p := os.Getenv("HUG_CONFIG"); p != "" {
		return p, nil
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "hug", "config.json"), nil
}

func loadConfig() (*Config, error) {
	cfg := &Config{Agents: map[string]string{}, kept: map[string]string{}}
	p, err := configPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, cfg); err != nil {
		return nil, err
	}
	if cfg.Agents == nil {
		cfg.Agents = map[string]string{}
	}
	plain := cfg.AccountKey != "" && cfg.AccountKey != inKeychain
	for _, k := range cfg.Agents {
		plain = plain || k != inKeychain
	}
	if cfg.AccountKey == inKeychain {
		k, err := readKey("account")
		if err != nil {
			return nil, fmt.Errorf("your account key is in the keychain but can't be read (%v); run `hug login` again", err)
		}
		cfg.AccountKey = k
		cfg.kept["account"] = k
	}
	// A config from before keys moved to the keychain: move them now, once.
	if plain && keys != nil {
		if err := cfg.save(); err == nil {
			fmt.Fprintf(stderr, "hug: moved the keys in %s to the %s\n", p, keys.name())
		}
	}
	return cfg, nil
}

func readKey(which string) (string, error) {
	if keys == nil {
		return "", errors.New("no keychain here (HUG_KEYCHAIN=0, or none found)")
	}
	return keys.get(keyID(which))
}

// keep puts a key in the keychain and returns what config.json should hold for it: the
// "keychain" marker, or the key itself when there is no keychain or it refused.
func (c *Config) keep(which, key string) string {
	if keys == nil || key == "" || key == inKeychain {
		return key
	}
	if c.kept[which] == key {
		return inKeychain
	}
	if err := keys.set(keyID(which), key); err != nil {
		fmt.Fprintf(stderr, "hug: couldn't store a key in the %s (%v); keeping it in the config file\n", keys.name(), err)
		return key
	}
	c.kept[which] = key
	return inKeychain
}

func (c *Config) save() error {
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	if c.kept == nil {
		c.kept = map[string]string{}
	}
	file := *c
	file.AccountKey = c.keep("account", c.AccountKey)
	file.Agents = map[string]string{}
	for name, k := range c.Agents {
		file.Agents[name] = c.keep("agent:"+name, k)
	}
	b, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// setURL saves a self-hosted githug's address (hug init/login --url).
func (c *Config) setURL(u string) error {
	if u == "" {
		return nil
	}
	u = strings.TrimRight(u, "/")
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://localhost") && !strings.HasPrefix(u, "http://127.0.0.1") {
		return fmt.Errorf("--url must be https:// (or http://localhost for testing): %s", u)
	}
	c.BaseURL = u
	return c.save()
}

// baseURL: GITHUG_URL beats the config, which beats production.
func (c *Config) baseURL() string {
	if u := os.Getenv("GITHUG_URL"); u != "" {
		return u
	}
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return "https://githug.ai"
}

// agentKey resolves which agent acts: GITHUG_AGENT_KEY, else the named agent, else the default.
func (c *Config) agentKey(name string) (string, error) {
	if k := os.Getenv("GITHUG_AGENT_KEY"); k != "" && name == "" {
		return k, nil
	}
	if name == "" {
		name = c.DefaultAgent
	}
	if name == "" {
		return "", errors.New("no agent: set GITHUG_AGENT_KEY or run `hug init --repo owner/repo`")
	}
	k, ok := c.Agents[name]
	if !ok {
		return "", errors.New("no key for agent " + name + " on this machine")
	}
	if k != inKeychain {
		return k, nil
	}
	k, err := readKey("agent:" + name)
	if err != nil {
		return "", fmt.Errorf("the key for agent %s is in the keychain but can't be read (%v)", name, err)
	}
	return k, nil
}

// cmdConfigShow prints the config with every key redacted: the way to look at hug's settings
// without opening a file that may hold keys.
func cmdConfigShow(args []string) error {
	fs := flag.NewFlagSet("config show", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	p, _ := configPath()
	where := func(stored string) string {
		switch {
		case stored == "":
			return "none"
		case keys != nil && stored == inKeychain:
			return "set (" + keys.name() + ")"
		default:
			return "set (in " + filepath.Base(p) + ")"
		}
	}
	// What the file holds, not the resolved keys: that says where each key lives.
	raw := &Config{}
	if b, err := os.ReadFile(p); err == nil {
		_ = json.Unmarshal(b, raw)
	}
	agents := map[string]string{}
	for name := range cfg.Agents {
		agents[name] = where(raw.Agents[name])
	}
	show := map[string]any{"file": p, "url": cfg.baseURL(), "login": cfg.Login, "account_key": where(raw.AccountKey), "default_agent": cfg.DefaultAgent, "agents": agents}
	if *asJSON {
		return json.NewEncoder(stdout).Encode(show)
	}
	fmt.Fprintf(stdout, "file           %s\nurl            %s\nlogin          %s\naccount key    %s\ndefault agent  %s\n", p, cfg.baseURL(), cfg.Login, where(raw.AccountKey), cfg.DefaultAgent)
	names := make([]string, 0, len(agents))
	for name := range agents {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(stdout, "agent          %s: key %s\n", name, agents[name])
	}
	return nil
}
