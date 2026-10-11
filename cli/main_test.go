package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultAgentName(t *testing.T) {
	for in, want := range map[string]string{
		"acme/api":                     "api-agent",
		"Acme/My.Repo_v2":              "my-repo-v2-agent",
		"a/" + strings.Repeat("x", 60): strings.Repeat("x", 33) + "-agent",
	} {
		if got := defaultAgentName(in); got != want || !agentRE.MatchString(got) {
			t.Errorf("defaultAgentName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEnvExportsEvalsInSh(t *testing.T) {
	tok := tokenReply{Token: "ghs_x", Repo: "acme/api", Trailers: []string{"Accountable: ana", "Agent: it's-me"}}
	tok.Author.Name, tok.Author.Email = "orbit", "orbit@agents.githug.ai"
	script := envExports(tok) + `printf '%s|%s|%s' "$GH_TOKEN" "$GIT_AUTHOR_EMAIL" "$GITHUG_TRAILERS"`
	got, err := exec.Command("sh", "-c", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	want := "ghs_x|orbit@agents.githug.ai|Accountable: ana\nAgent: it's-me"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// TestInitFlow drives `hug init --json` against a fake githug: device login (one pending
// poll), the repo missing until "installed", then agent creation and a saved config.
func TestInitFlow(t *testing.T) {
	polls, repoCalls := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/device/code":
			json.NewEncoder(w).Encode(map[string]any{"device_code": "dc", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 60, "interval": 0})
		case "/v1/device/token":
			if polls++; polls == 1 {
				w.WriteHeader(202)
				json.NewEncoder(w).Encode(map[string]any{"status": "authorization_pending"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "ok", "account_key": "hug_k", "login": "ana"})
		case "/v1/repos":
			if r.Header.Get("Authorization") != "Bearer hug_k" {
				w.WriteHeader(401)
				return
			}
			repos := []map[string]any{}
			if repoCalls++; repoCalls > 1 {
				repos = append(repos, map[string]any{"repo": "acme/api"})
			}
			json.NewEncoder(w).Encode(map[string]any{"repos": repos, "install_url": "https://githug.ai/app/install"})
		case "/v1/agents":
			json.NewEncoder(w).Encode(map[string]any{"agent": map[string]any{"id": "api-agent"}, "key": "ghg_agent"})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	t.Setenv("HUG_CONFIG", filepath.Join(dir, "config.json"))
	t.Setenv("GITHUG_URL", srv.URL)
	var buf bytes.Buffer
	stdout = &buf
	defer func() { stdout = os.Stdout }()
	// interval 0 → floor of 5s per poll and 5s per install check; keep the test honest but short.
	if err := run([]string{"init", "--repo", "acme/api", "--json"}); err != nil {
		t.Fatal(err)
	}
	var events []string
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("non-JSON line %q", line)
		}
		events = append(events, m["event"].(string))
	}
	if strings.Join(events, ",") != "device_code,logged_in,install_required,ready" {
		t.Fatalf("events = %v", events)
	}
	cfg, _ := loadConfig()
	if cfg.AccountKey != "hug_k" || cfg.Agents["api-agent"] != "ghg_agent" || cfg.DefaultAgent != "api-agent" {
		t.Fatalf("config = %+v", cfg)
	}
}

// fakeAddRepo serves /v1/repos (acme/api, acme/web installed) and /v1/agents/claude/repos,
// recording the repos each add asked for.
func fakeAddRepo(t *testing.T, asked *[][]string) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer hug_k" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/v1/repos":
			json.NewEncoder(w).Encode(map[string]any{"repos": []map[string]any{{"repo": "acme/api"}, {"repo": "acme/web"}}})
		case "/v1/agents/claude/repos":
			var body struct{ Repos []string }
			json.NewDecoder(r.Body).Decode(&body)
			*asked = append(*asked, body.Repos)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "repos": append([]string{"acme/api"}, body.Repos...), "added": body.Repos})
		default:
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]any{"error": "no such agent"})
		}
	}))
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	t.Setenv("HUG_CONFIG", filepath.Join(dir, "config.json"))
	t.Setenv("GITHUG_URL", srv.URL)
	cfg, _ := loadConfig()
	cfg.AccountKey, cfg.Agents["claude"], cfg.DefaultAgent = "hug_k", "ghg_claude", "claude"
	if err := cfg.save(); err != nil {
		t.Fatal(err)
	}
}

func TestAgentAddRepo(t *testing.T) {
	var asked [][]string
	fakeAddRepo(t, &asked)
	var buf bytes.Buffer
	stdout = &buf
	defer func() { stdout = os.Stdout }()
	if err := run([]string{"agent", "add-repo", "claude", "--repo", "acme/web", "--json"}); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 1 || strings.Join(asked[0], ",") != "acme/web" {
		t.Fatalf("asked = %v", asked)
	}
	var first map[string]any
	json.Unmarshal([]byte(strings.SplitN(buf.String(), "\n", 2)[0]), &first)
	if first["event"] != "repos_added" || first["agent"] != "claude" {
		t.Fatalf("first event = %v", first)
	}
	err := run([]string{"agent", "add-repo", "nobody", "--repo", "acme/web"})
	if err == nil || !strings.Contains(err.Error(), "hug agent list") {
		t.Fatalf("unknown agent: err = %v", err)
	}
	if err := run([]string{"agent", "add-repo", "claude"}); err == nil || !strings.Contains(err.Error(), "--help") {
		t.Fatalf("missing --repo: err = %v", err)
	}
}

// hug init --agent <one this machine has> puts it on the repo instead of creating another.
func TestInitReusesExistingAgent(t *testing.T) {
	var asked [][]string
	fakeAddRepo(t, &asked)
	stdout = io.Discard
	defer func() { stdout = os.Stdout }()
	if err := run([]string{"init", "--repo", "acme/web", "--agent", "claude", "--json"}); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 1 || asked[0][0] != "acme/web" {
		t.Fatalf("asked = %v", asked)
	}
}

func TestHelp(t *testing.T) {
	for _, g := range helpGroups {
		for _, p := range g.paths {
			if _, ok := helpTopics[p]; !ok {
				t.Errorf("overview lists %q with no help topic", p)
			}
		}
	}
	for args, want := range map[string]string{
		"help":                         "",
		"--help":                       "",
		"help agent add-repo":          "agent add-repo",
		"agent add-repo claude --help": "agent add-repo",
		"agent -h":                     "agent",
		"pr create --title x --help":   "pr create",
		"token --repo acme/api -h":     "token",
	} {
		got, ok := helpPath(strings.Fields(args))
		if !ok || got != want {
			t.Errorf("helpPath(%q) = %q, %v; want %q", args, got, ok, want)
		}
	}
	if _, ok := helpPath([]string{"run", "--", "make", "--help"}); ok {
		t.Error("--help after -- belongs to the wrapped command")
	}
	var buf bytes.Buffer
	stdout = &buf
	defer func() { stdout = os.Stdout }()
	for p := range helpTopics {
		buf.Reset()
		args := append(strings.Fields(p), "--help")
		if p == "help" {
			args = []string{"help", "help"} // `hug help --help` is the overview
		}
		if err := run(args); err != nil || !strings.HasPrefix(buf.String(), "Usage: hug "+strings.Fields(helpTopics[p].usage)[0]) {
			t.Errorf("hug %s --help: err=%v out=%q", p, err, buf.String())
		}
	}
}
