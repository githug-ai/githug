// hug is the githug Gateway CLI. It is built to be run by a coding agent: every command
// works without prompts, and --json prints one JSON object per line so the agent can relay
// the single thing a human must do (approve a device code, or install the App) and wait.
//
//	hug init --repo owner/repo [--agent name] [--json]   log in + create an agent, ready to push
//	hug login [--json]                                   device login only
//	hug repos | hug agent list | create | add-repo | rotate | spawn
//	hug token [--repo r] [--run id]                      print a 1-hour, one-repo GitHub token
//	hug env   [--repo r] [--run id]                      print exports: GH_TOKEN, git author, trailers
//	hug setup | hug run -- cmd | hug pr create            push/commit/PR as the agent from a clone (M2)
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"time"
)

var version = "dev" // release builds: -ldflags "-X main.version=…" (scripts/release-hug.sh)

func init() {
	// `go install github.com/githug-ai/hug@vX` builds carry the module version instead.
	if version == "dev" {
		if bi, ok := debug.ReadBuildInfo(); ok && strings.HasPrefix(bi.Main.Version, "v") {
			version = strings.TrimPrefix(bi.Main.Version, "v")
		}
	}
}

var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(stderr, "hug:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if path, ok := helpPath(args); ok {
		return printHelp(path)
	}
	if len(args) == 0 {
		return printHelp("")
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "init":
		return cmdInit(rest)
	case "login":
		return cmdLogin(rest)
	case "repos":
		return cmdRepos(rest)
	case "agent":
		if len(rest) == 0 {
			return usageError("agent")
		}
		switch rest[0] {
		case "list":
			return cmdAgentList(rest[1:])
		case "create":
			return cmdAgentCreate(rest[1:])
		case "add-repo":
			return cmdAgentAddRepo(rest[1:])
		case "spawn":
			return cmdAgentSpawn(rest[1:])
		case "rotate":
			return cmdAgentRotate(rest[1:])
		case "credit":
			return cmdAgentCredit(rest[1:])
		}
		return fmt.Errorf("unknown agent command %q\n  (see `hug agent --help`)", rest[0])
	case "config":
		if len(rest) == 0 || rest[0] != "show" {
			return usageError("config show")
		}
		return cmdConfigShow(rest[1:])
	case "setup":
		return cmdSetup(rest)
	case "credential":
		return cmdCredential(rest)
	case "hook":
		return cmdHook(rest)
	case "run":
		return cmdRun(rest)
	case "attest":
		return cmdAttest(rest)
	case "pr":
		return cmdPR(rest)
	case "token":
		return cmdToken(rest, false)
	case "env":
		return cmdToken(rest, true)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, "hug", version)
		return nil
	}
	return fmt.Errorf("unknown command %q (try `hug help`)", cmd)
}

// parse lets flags and positionals mix ("create NAME --repo x" and "create --repo x NAME").
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(io.Discard)
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, fmt.Errorf("%v\n  (see `hug %s --help`)", err, fs.Name())
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

// out prints a JSON event (json mode) or a human line on stderr, keeping stdout clean.
type out struct{ json bool }

func (o out) event(name string, fields map[string]any, human string) {
	if o.json {
		m := map[string]any{"event": name}
		for k, v := range fields {
			m[k] = v
		}
		b, _ := json.Marshal(m)
		fmt.Fprintln(stdout, string(b))
		return
	}
	if human != "" {
		fmt.Fprintln(stderr, human)
	}
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

// ensureLogin returns a working account key, running device login if there is none
// or the saved one was revoked.
func ensureLogin(cfg *Config, c *client, o out) error {
	if cfg.AccountKey != "" {
		var r reposReply
		_, err := c.do("GET", "/v1/repos", cfg.AccountKey, nil, &r)
		var ae *apiError
		if err == nil {
			return nil
		}
		if !(errors.As(err, &ae) && ae.Status == 401) {
			return err
		}
	}
	return deviceLogin(cfg, c, o)
}

func deviceLogin(cfg *Config, c *client, o out) error {
	var d deviceCode
	if _, err := c.do("POST", "/v1/device/code", "", map[string]any{}, &d); err != nil {
		return err
	}
	o.event("device_code", map[string]any{
		"user_code": d.UserCode, "verification_uri": d.VerificationURI, "expires_in": d.ExpiresIn,
		"message": "Ask your human to open " + d.VerificationURI + " and enter " + d.UserCode,
	}, fmt.Sprintf("\n  Open %s and enter: %s\n\n  Waiting for approval…", d.VerificationURI, d.UserCode))
	interval := time.Duration(max(d.Interval, 5)) * time.Second
	deadline := time.Now().Add(time.Duration(max(d.ExpiresIn, 60)) * time.Second)
	host, _ := os.Hostname()
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		var t deviceToken
		status, err := c.do("POST", "/v1/device/token", "", map[string]any{"device_code": d.DeviceCode, "name": host}, &t)
		if err != nil {
			return err
		}
		if status == 202 {
			if t.Status == "slow_down" {
				interval += 5 * time.Second
			}
			continue
		}
		cfg.AccountKey, cfg.Login = t.AccountKey, t.Login
		if err := cfg.save(); err != nil {
			return err
		}
		o.event("logged_in", map[string]any{"login": t.Login}, "  Logged in as "+t.Login+".")
		return nil
	}
	return errors.New("device code expired before it was approved; run again")
}

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	urlF := fs.String("url", "", "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if err := cfg.setURL(*urlF); err != nil {
		return err
	}
	return deviceLogin(cfg, newClient(cfg.baseURL()), out{*asJSON})
}

// ---------------------------------------------------------------------------
// init: login → installed on the repo → agent created → ready
// ---------------------------------------------------------------------------

var repoRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`)
var agentRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)

// defaultAgentName: "<repo>-agent", squeezed into the agent-id alphabet.
func defaultAgentName(repo string) string {
	name := strings.ToLower(repo[strings.Index(repo, "/")+1:])
	name = regexp.MustCompile(`[^a-z0-9-]+`).ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if len(name) > 33 {
		name = strings.Trim(name[:33], "-")
	}
	return name + "-agent"
}

func cmdInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	repoF := fs.String("repo", "", "")
	agentF := fs.String("agent", "", "")
	graphCredit := fs.Bool("graph-credit", false, "")
	asJSON := fs.Bool("json", false, "")
	fs.Bool("no-interactive", true, "") // hug never prompts; accepted for agents that pass it
	wait := fs.Duration("wait", 10*time.Minute, "")
	urlF := fs.String("url", "", "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	o := out{*asJSON}
	cfg, err := loadConfig()
	if err == nil {
		err = cfg.setURL(*urlF)
	}
	if err != nil {
		return err
	}
	c := newClient(cfg.baseURL())
	if err := ensureLogin(cfg, c, o); err != nil {
		return err
	}
	if *repoF == "" {
		o.event("ready", map[string]any{"login": cfg.Login}, "  Next: hug init --repo owner/repo")
		return nil
	}
	if !repoRE.MatchString(*repoF) {
		return fmt.Errorf("--repo must be owner/repo")
	}
	name := *agentF
	if name == "" {
		name = defaultAgentName(*repoF)
	}
	if !agentRE.MatchString(name) {
		return fmt.Errorf("--agent must be lowercase letters, digits and dashes")
	}
	if err := waitForRepo(cfg, c, o, *repoF, *wait); err != nil {
		return err
	}
	if _, ok := cfg.Agents[name]; ok {
		// An agent this machine already has a key for: put it on the repo (no-op if it's there).
		if _, err := addRepos(cfg, c, o, name, []string{*repoF}); err != nil {
			return err
		}
		// --graph-credit used to be dropped here without a word; turn it on for the agent too.
		if *graphCredit {
			if err := setCredit(cfg, c, o, name, true); err != nil {
				return err
			}
		}
	} else if err := createAgent(cfg, c, name, *repoF, *graphCredit); err != nil {
		return err
	}
	cfg.DefaultAgent = name
	if err := cfg.save(); err != nil {
		return err
	}
	// Inside a clone of this repo, finish the job: git push / commit as the agent from now on.
	if strings.EqualFold(repoFromRemote(), *repoF) {
		if err := cmdSetup([]string{"--agent", name, "--repo", *repoF}); err != nil {
			fmt.Fprintln(stderr, "  hug setup:", err)
		} else {
			o.event("ready", map[string]any{"login": cfg.Login, "agent": name, "repo": *repoF, "setup": true, "next": "git push and `hug pr create` work as the agent"},
				fmt.Sprintf("  Agent %s is ready on %s. git push and `hug pr create` now work as the agent.", name, *repoF))
			return nil
		}
	}
	o.event("ready", map[string]any{"login": cfg.Login, "agent": name, "repo": *repoF, "next": "in a clone: hug setup (or eval \"$(hug env)\")"},
		fmt.Sprintf("  Agent %s is ready on %s.\n  Next, in a clone of it: hug setup", name, *repoF))
	return nil
}

// waitForRepo returns once the App is installed on repo for this account, asking the
// human to install it (and polling) if it isn't yet.
func waitForRepo(cfg *Config, c *client, o out, repoName string, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	asked := false
	for {
		var r reposReply
		path := "/v1/repos"
		if asked {
			path += "?fresh=1"
		}
		if _, err := c.do("GET", path, cfg.AccountKey, nil, &r); err != nil {
			return err
		}
		for _, x := range r.Repos {
			if strings.EqualFold(x.Repo, repoName) {
				return nil
			}
		}
		if !asked {
			o.event("install_required", map[string]any{
				"repo": repoName, "install_url": r.InstallURL,
				"message": "Ask your human to install githug on " + repoName + " at " + r.InstallURL,
			}, fmt.Sprintf("\n  Install githug on %s: %s\n\n  Waiting for the install…", repoName, r.InstallURL))
			asked = true
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("githug is not installed on %s yet; install it and run again", repoName)
		}
		time.Sleep(5 * time.Second)
	}
}

// createAgent: graphCredit adds Co-authored-by for you to the agent's commits, which GitHub
// counts on your contribution graph (off by default; Accountable: always names you).
func createAgent(cfg *Config, c *client, name, repoName string, graphCredit bool) error {
	var r struct {
		Agent agent  `json:"agent"`
		Key   string `json:"key"`
	}
	if _, err := c.do("POST", "/v1/agents", cfg.AccountKey, map[string]any{"id": name, "repos": []string{repoName}, "credit_human": graphCredit}, &r); err != nil {
		return err
	}
	cfg.Agents[name] = r.Key
	return cfg.save()
}

// ---------------------------------------------------------------------------
// repos, agents
// ---------------------------------------------------------------------------

func accountClient(asJSON bool) (*Config, *client, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, nil, err
	}
	if cfg.AccountKey == "" {
		return nil, nil, errors.New("not logged in: run `hug login`")
	}
	return cfg, newClient(cfg.baseURL()), nil
}

func cmdRepos(args []string) error {
	fs := flag.NewFlagSet("repos", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	var r reposReply
	if _, err := c.do("GET", "/v1/repos?fresh=1", cfg.AccountKey, nil, &r); err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(stdout).Encode(r)
	}
	for _, x := range r.Repos {
		fmt.Fprintln(stdout, x.Repo)
	}
	if len(r.Repos) == 0 {
		fmt.Fprintln(stderr, "No repositories yet. Install githug:", r.InstallURL)
	}
	return nil
}

func cmdAgentList(args []string) error {
	fs := flag.NewFlagSet("agent list", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	var r struct {
		Agents []agent `json:"agents"`
	}
	if _, err := c.do("GET", "/v1/agents", cfg.AccountKey, nil, &r); err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(stdout).Encode(r)
	}
	for _, a := range r.Agents {
		mark := ""
		if _, ok := cfg.Agents[a.ID]; ok {
			mark = " (key on this machine)"
		}
		if a.CreditHuman {
			mark += " [graph credit]"
		}
		if a.Disabled != 0 {
			mark += " [disabled]"
		}
		fmt.Fprintf(stdout, "%s\t%s%s\n", a.ID, strings.Join(a.Repos, ","), mark)
	}
	return nil
}

func cmdAgentCreate(args []string) error {
	fs := flag.NewFlagSet("agent create", flag.ContinueOnError)
	repoF := fs.String("repo", "", "")
	graphCredit := fs.Bool("graph-credit", false, "")
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || !agentRE.MatchString(pos[0]) || !repoRE.MatchString(*repoF) {
		return usageError("agent create")
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	if err := createAgent(cfg, c, pos[0], *repoF, *graphCredit); err != nil {
		return err
	}
	if cfg.DefaultAgent == "" {
		cfg.DefaultAgent = pos[0]
		if err := cfg.save(); err != nil {
			return err
		}
	}
	out{*asJSON}.event("agent_created", map[string]any{"agent": pos[0], "repo": *repoF}, "Created "+pos[0]+"; its key is saved on this machine.")
	return nil
}

func cmdAgentAddRepo(args []string) error {
	fs := flag.NewFlagSet("agent add-repo", flag.ContinueOnError)
	var repos []string
	fs.Func("repo", "", func(v string) error { repos = append(repos, v); return nil })
	wait := fs.Duration("wait", 10*time.Minute, "")
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || !agentRE.MatchString(pos[0]) || len(repos) == 0 {
		return usageError("agent add-repo")
	}
	for _, r := range repos {
		if !repoRE.MatchString(r) {
			return fmt.Errorf("--repo must be owner/repo, got %q", r)
		}
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	o := out{*asJSON}
	for _, r := range repos {
		if err := waitForRepo(cfg, c, o, r, *wait); err != nil {
			return err
		}
	}
	name := pos[0]
	all, err := addRepos(cfg, c, o, name, repos)
	if err != nil {
		return err
	}
	// Inside a clone of an added repo with this agent's key here: set the clone up too.
	if _, ok := cfg.Agents[name]; ok {
		here := repoFromRemote()
		for _, r := range repos {
			if strings.EqualFold(here, r) {
				if err := cmdSetup([]string{"--agent", name, "--repo", here}); err != nil {
					fmt.Fprintln(stderr, "  hug setup:", err)
				}
				return nil
			}
		}
	}
	o.event("ready", map[string]any{"agent": name, "repos": all, "next": "in a clone of an added repo: hug setup --agent " + name},
		"  Next, in a clone of an added repo: hug setup --agent "+name)
	return nil
}

// addRepos puts an existing agent on more repos and returns its full list.
func addRepos(cfg *Config, c *client, o out, name string, repos []string) ([]string, error) {
	var r struct {
		Repos []string `json:"repos"`
		Added []string `json:"added"`
	}
	if _, err := c.do("POST", "/v1/agents/"+name+"/repos", cfg.AccountKey, map[string]any{"repos": repos}, &r); err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.Status == 404 {
			return nil, fmt.Errorf("no agent %q on your account (see `hug agent list`)", name)
		}
		return nil, err
	}
	msg := fmt.Sprintf("  %s already works on %s.", name, strings.Join(repos, ", "))
	if len(r.Added) > 0 {
		msg = fmt.Sprintf("  Added %s to %s; it now works on %s.", strings.Join(r.Added, ", "), name, strings.Join(r.Repos, ", "))
	}
	o.event("repos_added", map[string]any{"agent": name, "added": r.Added, "repos": r.Repos}, msg)
	return r.Repos, nil
}

func cmdAgentRotate(args []string) error {
	fs := flag.NewFlagSet("agent rotate", flag.ContinueOnError)
	all := fs.Bool("all", false, "")
	printKey := fs.Bool("print", false, "")
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if *all == (len(pos) == 1) || len(pos) > 1 || (len(pos) == 1 && !agentRE.MatchString(pos[0])) {
		return usageError("agent rotate")
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	names := pos
	if *all {
		for name := range cfg.Agents {
			names = append(names, name)
		}
		if len(names) == 0 {
			return errors.New("no agent keys on this machine (see `hug agent list`)")
		}
		sort.Strings(names) // parents before their sub-agents (orbit < orbit-w1)
	}
	o := out{*asJSON}
	var failed []string
	for _, name := range names {
		var r struct {
			Key              string `json:"key"`
			DisabledChildren int    `json:"disabled_children"`
		}
		if _, err := c.do("POST", "/v1/agents/"+name+"/rotate", cfg.AccountKey, nil, &r); err != nil {
			var ae *apiError
			if errors.As(err, &ae) && ae.Status == 404 {
				err = fmt.Errorf("no agent %q on your account (see `hug agent list`)", name)
			}
			if !*all {
				return err
			}
			failed = append(failed, name)
			o.event("rotate_failed", map[string]any{"agent": name, "error": err.Error()}, "  "+name+": "+err.Error())
			continue
		}
		// The old key is dead from here: save the new one before anything else can fail.
		cfg.Agents[name] = r.Key
		if err := cfg.save(); err != nil {
			fmt.Fprintf(stderr, "hug: could not save the new key for %s; it is:\n%s\n", name, r.Key)
			return err
		}
		clearTokenCache(name)
		fields := map[string]any{"agent": name, "rotated": true, "children_disabled": r.DisabledChildren}
		msg := "  Rotated " + name + "; the new key is saved on this machine."
		if r.DisabledChildren > 0 {
			msg += fmt.Sprintf(" Disabled %d sub-agent(s) the old key could have made; re-enable the ones you trust on its page.", r.DisabledChildren)
		}
		if *printKey {
			fields["key"] = r.Key
			msg += "\n  " + r.Key
		}
		o.event("rotated", fields, msg)
	}
	o.event("note", map[string]any{"tokens": "GitHub tokens minted with an old key in the last hour stay valid until they expire"},
		"  GitHub tokens minted with an old key in the last hour stay valid until they expire.")
	if len(failed) > 0 {
		return fmt.Errorf("could not rotate %s", strings.Join(failed, ", "))
	}
	return nil
}

func cmdAgentCredit(args []string) error {
	fs := flag.NewFlagSet("agent credit", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 || !agentRE.MatchString(pos[0]) || (pos[1] != "on" && pos[1] != "off") {
		return usageError("agent credit")
	}
	cfg, c, err := accountClient(*asJSON)
	if err != nil {
		return err
	}
	return setCredit(cfg, c, out{*asJSON}, pos[0], pos[1] == "on")
}

// setCredit turns graph credit on or off, and drops the agent's cached tokens so the next
// commit carries the new trailers instead of the ones minted with the old setting.
func setCredit(cfg *Config, c *client, o out, name string, on bool) error {
	var r struct {
		Trailer bool   `json:"trailer"`
		Note    string `json:"note"`
	}
	if _, err := c.do("POST", "/v1/agents/"+name+"/credit", cfg.AccountKey, map[string]any{"on": on}, &r); err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.Status == 404 {
			return fmt.Errorf("no agent %q on your account (see `hug agent list`)", name)
		}
		return err
	}
	clearTokenCache(name)
	state := map[bool]string{true: "on", false: "off"}[on]
	msg := "  graph credit: " + state + " for " + name
	if r.Note != "" {
		msg += "\n  " + r.Note
	}
	o.event("graph_credit", map[string]any{"agent": name, "on": on, "trailer": r.Trailer, "note": r.Note}, msg)
	return nil
}

// ---------------------------------------------------------------------------
// token / env
// ---------------------------------------------------------------------------

func cmdToken(args []string, asEnv bool) error {
	fs := flag.NewFlagSet("token", flag.ContinueOnError)
	repoF := fs.String("repo", os.Getenv("GITHUG_REPO"), "")
	runF := fs.String("run", os.Getenv("GITHUG_RUN"), "")
	agentF := fs.String("agent", "", "")
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	key, err := cfg.agentKey(*agentF)
	if err != nil {
		return err
	}
	body := map[string]any{}
	if *repoF != "" {
		body["repo"] = *repoF
	}
	if *runF != "" {
		body["run"] = *runF
	}
	var t tokenReply
	if _, err := newClient(cfg.baseURL()).do("POST", "/v1/token", key, body, &t); err != nil {
		return err
	}
	switch {
	case asEnv:
		fmt.Fprint(stdout, envExports(t))
	case *asJSON:
		return json.NewEncoder(stdout).Encode(t)
	default:
		fmt.Fprintln(stdout, t.Token)
	}
	return nil
}

// envExports renders POSIX-sh exports for a minted token, safe to eval.
func envExports(t tokenReply) string {
	vars := [][2]string{
		{"GH_TOKEN", t.Token},
		{"GITHUB_TOKEN", t.Token},
		{"GIT_AUTHOR_NAME", t.Author.Name},
		{"GIT_AUTHOR_EMAIL", t.Author.Email},
		{"GIT_COMMITTER_NAME", t.Author.Name},
		{"GIT_COMMITTER_EMAIL", t.Author.Email},
		{"GITHUG_REPO", t.Repo},
		{"GITHUG_RUN", t.Run},
		{"GITHUG_TOKEN_EXPIRES", t.ExpiresAt},
		{"GITHUG_TRAILERS", strings.Join(t.Trailers, "\n")},
	}
	var b strings.Builder
	for _, v := range vars {
		fmt.Fprintf(&b, "export %s=%s\n", v[0], shellQuote(v[1]))
	}
	return b.String()
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// cmdAgentSpawn: the acting agent (GITHUG_AGENT_KEY, --agent, or the default) creates a
// sub-agent (M2.6). Its key is saved on this machine; --env prints it as an export instead,
// for handing to a worker process.
func cmdAgentSpawn(args []string) error {
	fs := flag.NewFlagSet("agent spawn", flag.ContinueOnError)
	repoF := fs.String("repo", "", "")
	agentF := fs.String("agent", "", "")
	env := fs.Bool("env", false, "")
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("agent spawn")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	key, err := cfg.agentKey(*agentF)
	if err != nil {
		return err
	}
	body := map[string]any{"name": pos[0]}
	if *repoF != "" {
		body["repos"] = []string{*repoF}
	}
	var r struct {
		Agent agent  `json:"agent"`
		Key   string `json:"key"`
	}
	if _, err := newClient(cfg.baseURL()).do("POST", "/v1/agents/children", key, body, &r); err != nil {
		return err
	}
	if *env {
		fmt.Fprintf(stdout, "export GITHUG_AGENT_KEY=%s\n", shellQuote(r.Key))
		return nil
	}
	cfg.Agents[r.Agent.ID] = r.Key
	if err := cfg.save(); err != nil {
		return err
	}
	out{*asJSON}.event("agent_spawned", map[string]any{"agent": r.Agent.ID, "repos": r.Agent.Repos}, "Created sub-agent "+r.Agent.ID+"; its key is saved on this machine (use --agent "+r.Agent.ID+").")
	return nil
}
