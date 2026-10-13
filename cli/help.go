package main

import (
	"fmt"
	"strings"
)

// helpTopic is one command's help: `hug help <path>`, `hug <path> --help`, and the usage
// line in errors all come from here, so the CLI documents itself in one place.
type helpTopic struct {
	usage   string   // synopsis, without the leading "hug "
	summary string   // one line for the overview
	details string   // what it does and when to use it
	flags   []string // "--flag VALUE  description"
	example []string // shell lines; comments allowed
	see     []string // related command paths
}

var helpTopics = map[string]helpTopic{
	"init": {
		usage:   "init --repo owner/repo [--agent NAME] [--graph-credit] [--wait 10m] [--url URL] [--json]",
		summary: "Log in, install githug on a repo, create an agent, and set up this clone",
		details: `The one command to get started. A human approves one code on github.com (device login),
installs the githug App on the repo if it isn't yet (hug waits), then hug creates the agent,
saves its key on this machine and makes it the default. Run inside a clone of the repo and
it also runs ` + "`hug setup`" + `, so plain git commit / git push work as the agent.

If --agent names an agent that already has a key on this machine, hug puts that agent on
the repo instead of creating a new one.`,
		flags: []string{
			"--repo owner/repo   the repository the agent works on (required)",
			"--agent NAME        agent name; default <repo>-agent (lowercase letters, digits, dashes)",
			"--graph-credit      commits count on your GitHub graph (Co-authored-by); works on an existing agent too",
			"--wait DURATION     how long to wait for the App install (default 10m)",
			"--url URL           a self-hosted githug instance (saved; GITHUG_URL overrides)",
			"--json              one JSON event per line on stdout",
		},
		example: []string{
			"hug init --repo acme/api",
			"hug init --repo acme/api --agent claude --json   # from a coding agent",
		},
		see: []string{"setup", "agent add-repo"},
	},
	"login": {
		usage:   "login [--url URL] [--json]",
		summary: "Log in only (GitHub device flow); saves an account key",
		details: `Prints a code for a human to approve on github.com and saves the resulting account key
(hug_…) on this machine. ` + "`hug init`" + ` does this for you when needed.`,
		flags: []string{
			"--url URL   a self-hosted githug instance (saved)",
			"--json      one JSON event per line on stdout",
		},
		see: []string{"init"},
	},
	"setup": {
		usage:   "setup [--agent NAME] [--repo owner/repo] [--no-hook] [--env] [--force] [--undo]",
		summary: "In a clone: git commit and git push work as the agent",
		details: `Configures the clone you're in: commits are authored as the agent, hug becomes git's
credential helper (a fresh 1-hour token per push), a prepare-commit-msg hook adds the
trailers, and a pre-push hook attests each pushed commit so githug shows it as verified.

A clone you also commit in yourself: use --env. It prints a GIT_CONFIG_* block for the
agent tool's settings (Claude Code: .claude/settings.local.json) instead of writing
.git/config, so only that tool's sessions commit as the agent. The hooks act only when an
agent is configured. If the identity already comes from the environment, plain setup
changes nothing.

If a workflow here runs on a tag push (a release) and no tag ruleset covers that tag, setup
warns you: the agent can push tags, so its key could publish a release with no review.`,
		flags: []string{
			"--agent NAME        which agent (default: the default agent, or GITHUG_AGENT_KEY)",
			"--repo owner/repo   default: read from the origin remote",
			"--no-hook           skip the git hooks",
			"--env               print the settings as GIT_CONFIG_* env instead of writing .git/config",
			"--force             write .git/config even though the environment already sets the agent",
			"--undo              remove what setup wrote (identity, githug keys, credential helper, hooks)",
		},
		example: []string{"hug setup --agent claude", "hug setup --env --agent claude"},
		see:     []string{"init", "pr create"},
	},
	"run": {
		usage:   "run -- <command> [args…]",
		summary: "Run a command with one run id for all its tokens and commits",
		details: `Sets GITHUG_RUN (keeps an existing one) so every token minted and commit made by the
command is tied to the same run in githug's log and the commit trailers.`,
		example: []string{"hug run -- claude -p \"fix the flaky test\""},
	},
	"pr": {
		usage:   "pr create …",
		summary: "Pull requests through githug",
	},
	"pr create": {
		usage:   "pr create --title T [--body B | --body-file F] [--head BRANCH] [--base main] [--as human|agent] [--label L]… [--draft] [--json]",
		summary: "Open a PR with the agent and a verify link in the footer",
		details: `githug opens the PR. By default you (the accountable human) are the author and the agent is
named in the footer. --as agent makes the agent's bot the author, so you can still approve it.`,
		flags: []string{
			"--title T           PR title (required)",
			"--body B            PR body, or --body-file F to read it from a file",
			"--head BRANCH       default: the current branch",
			"--base BRANCH       default: main",
			"--as human|agent    who authors the PR (default human)",
			"--label L           repeatable",
			"--draft             open as a draft",
			"--repo, --agent     override the clone's repo / agent",
			"--json              print the result as JSON",
		},
		example: []string{"git push -u origin HEAD && hug pr create --title \"Fix login redirect\" --body-file pr.md"},
	},
	"attest": {
		usage:   "attest [--repo owner/repo] [--agent NAME] [rev…]",
		summary: "Report commits to githug before pushing them some other way",
		details: `Attests commits with the agent's key so githug verify shows them as the agent's. hug setup's
pre-push hook does this for you; use it when pushing from CI or with ` + "`hug env`" + `.
Default: commits no remote has yet.`,
		example: []string{"hug attest HEAD~3..HEAD"},
	},
	"env": {
		usage:   "env [--repo owner/repo] [--run ID] [--agent NAME]",
		summary: "Print shell exports: a fresh token, git author and trailers",
		details: `Prints GH_TOKEN, GITHUB_TOKEN, git author/committer and GITHUG_TRAILERS for eval. --repo
is needed when the agent works on more than one repo.`,
		example: []string{`eval "$(hug env --repo acme/api)"`},
		see:     []string{"token"},
	},
	"token": {
		usage:   "token [--repo owner/repo] [--run ID] [--agent NAME] [--json]",
		summary: "Print a 1-hour GitHub token for one repo",
		details: `Mints a token scoped to one repository, valid for an hour. --repo is needed when the agent
works on more than one repo (GITHUG_REPO sets it too).`,
		example: []string{"GH_TOKEN=$(hug token --repo acme/api) gh issue list"},
		see:     []string{"env"},
	},
	"repos": {
		usage:   "repos [--json]",
		summary: "List the repos you can put agents on",
		details: `Repos where githug is installed and you can push. Install on more from the URL it prints.`,
	},
	"agent": {
		usage:   "agent list | create | add-repo | credit | rotate | spawn",
		summary: "Manage agents",
		details: "Run 'hug agent <command> --help' for flags and examples.",
	},
	"agent list": {
		usage:   "agent list [--json]",
		summary: "List your agents and their repos",
		details: `Shows each agent, its repos, whether its key is on this machine, whether graph credit is on,
and whether it's disabled.`,
	},
	"agent create": {
		usage:   "agent create NAME --repo owner/repo [--graph-credit] [--json]",
		summary: "Create an agent and save its key on this machine",
		details: `Like ` + "`hug init`" + ` without the login, install wait and clone setup.`,
		flags: []string{
			"--repo owner/repo   the repository the agent works on (required)",
			"--graph-credit      add Co-authored-by for you to its commits",
			"--json              one JSON event per line on stdout",
		},
		example: []string{"hug agent create claude --repo acme/api"},
		see:     []string{"agent add-repo"},
	},
	"agent add-repo": {
		usage:   "agent add-repo NAME --repo owner/repo [--repo …] [--wait 10m] [--json]",
		summary: "Put an existing agent on more repos",
		details: `Adds repos to an agent you own, on the same terms as creating it: githug must be installed
on each repo and you must be able to push to it (hug waits for the install). The agent keeps
one key and one identity; each token it mints is still for one repo. Run inside a clone of
an added repo and hug also runs ` + "`hug setup`" + ` there.

Sub-agents can't be widened: add the repo to the top-level agent and spawn a new one. To
stop an agent working on a repo, disable it and create a new one.`,
		flags: []string{
			"--repo owner/repo   repeatable",
			"--wait DURATION     how long to wait for the App install (default 10m)",
			"--json              one JSON event per line on stdout",
		},
		example: []string{
			"hug agent add-repo claude --repo acme/web",
			"hug agent add-repo claude --repo acme/web --repo acme/docs",
		},
		see: []string{"agent list", "setup"},
	},
	"agent credit": {
		usage:   "agent credit NAME on|off [--json]",
		summary: "Turn graph credit on or off for an agent",
		details: `On: the agent's commits add Co-authored-by for you, so GitHub counts them on your
contribution graph. Takes effect on the next commit (hug drops the agent's cached tokens).
githug needs your email for the trailer, which it has once you've signed in; hug says if not.`,
		example: []string{"hug agent credit claude on"},
		see:     []string{"agent list"},
	},
	"agent rotate": {
		usage:   "agent rotate NAME | --all [--print] [--json]",
		summary: "Replace an agent's key, e.g. after it leaked",
		details: `Gives the agent a new key, saves it on this machine and drops its cached tokens, so the
next commit just works. The old key stops working at once. Sub-agents the old key could
have made are disabled; re-enable the ones you trust on the agent's page.

--all rotates every agent this machine holds a key for: what to run when the config file
leaked. GitHub tokens already minted with an old key stay valid until they expire (1 hour).`,
		flags: []string{
			"--all     every agent with a key on this machine",
			"--print   also print each new key (it is never printed otherwise)",
			"--json    one JSON event per line on stdout",
		},
		example: []string{
			"hug agent rotate claude",
			"hug agent rotate --all",
		},
		see: []string{"agent list"},
	},
	"agent spawn": {
		usage:   "agent spawn NAME [--repo owner/repo] [--agent PARENT] [--env] [--json]",
		summary: "As an agent: create a sub-agent for a worker",
		details: `Creates <agent>-NAME with the same accountable human and a subset of the parent's repos
(default: all of them). Its commits carry an Agent-Chain trailer. Disabling a parent
disables everything under it.`,
		flags: []string{
			"--repo owner/repo   limit the sub-agent to one of the parent's repos",
			"--agent PARENT      the parent (default: the default agent, or GITHUG_AGENT_KEY)",
			"--env               print its GITHUG_AGENT_KEY export instead of saving the key",
		},
		example: []string{`eval "$(hug agent spawn w1 --env)"`},
	},
	"version": {
		usage:   "version",
		summary: "Print hug's version",
	},
	"help": {
		usage:   "help [command]",
		summary: "Show help for hug or one command",
	},
}

// helpGroups orders the overview.
var helpGroups = []struct {
	title string
	paths []string
}{
	{"Get started", []string{"init", "setup"}},
	{"Work as the agent", []string{"pr create", "run", "env", "token", "attest"}},
	{"Manage agents", []string{"agent list", "agent create", "agent add-repo", "agent credit", "agent rotate", "agent spawn", "repos", "login"}},
	{"", []string{"version", "help"}},
}

// helpPath returns the command a help request is about, if args ask for help:
// `hug help [cmd…]`, or -h/--help anywhere before a `--`.
func helpPath(args []string) (string, bool) {
	if len(args) > 0 && args[0] == "help" {
		var words []string
		for _, a := range args[1:] {
			if !strings.HasPrefix(a, "-") {
				words = append(words, a)
			}
		}
		return strings.Join(words, " "), true
	}
	var words []string
	asked := false
	for _, a := range args {
		if a == "--" {
			break
		}
		switch {
		case a == "-h" || a == "--help" || a == "-help":
			asked = true
		case !strings.HasPrefix(a, "-") && len(words) < 2:
			words = append(words, a)
		}
	}
	if !asked {
		return "", false
	}
	// Only the leading words that name a topic: "agent add-repo claude" → "agent add-repo".
	path := ""
	for _, w := range words {
		next := strings.TrimSpace(path + " " + w)
		if _, ok := helpTopics[next]; !ok {
			break
		}
		path = next
	}
	return path, true
}

func printHelp(path string) error {
	if path == "" {
		fmt.Fprint(stdout, overview())
		return nil
	}
	t, ok := helpTopics[path]
	if !ok {
		return fmt.Errorf("no help for %q (try `hug help`)", path)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Usage: hug %s\n\n%s\n", t.usage, t.summary)
	if t.details != "" {
		fmt.Fprintf(&b, "\n%s\n", t.details)
	}
	if subs := subcommands(path); len(subs) > 0 {
		b.WriteString("\nCommands:\n")
		for _, p := range subs {
			fmt.Fprintf(&b, "  hug %-16s %s\n", p, helpTopics[p].summary)
		}
	}
	if len(t.flags) > 0 {
		b.WriteString("\nFlags:\n")
		for _, f := range t.flags {
			fmt.Fprintf(&b, "  %s\n", f)
		}
	}
	if len(t.example) > 0 {
		b.WriteString("\nExamples:\n")
		for _, e := range t.example {
			fmt.Fprintf(&b, "  %s\n", e)
		}
	}
	if len(t.see) > 0 {
		fmt.Fprintf(&b, "\nSee also: hug %s\n", strings.Join(t.see, ", hug "))
	}
	fmt.Fprint(stdout, b.String())
	return nil
}

// subcommands lists a group's commands ("agent" → "agent list", …) in overview order.
func subcommands(path string) []string {
	var subs []string
	for _, g := range helpGroups {
		for _, p := range g.paths {
			if strings.HasPrefix(p, path+" ") {
				subs = append(subs, p)
			}
		}
	}
	return subs
}

func overview() string {
	var b strings.Builder
	b.WriteString("hug — give your coding agent its own name on GitHub (githug.ai)\n\n")
	b.WriteString("Agents get their own key, 1-hour one-repo tokens, and commits that trace back to\nthe human accountable for them. No prompts; --json prints one event per line.\n")
	for _, g := range helpGroups {
		b.WriteString("\n")
		if g.title != "" {
			b.WriteString(g.title + ":\n")
		}
		for _, p := range g.paths {
			fmt.Fprintf(&b, "  hug %-16s %s\n", p, helpTopics[p].summary)
		}
	}
	b.WriteString(`
Run 'hug help <command>' or 'hug <command> --help' for flags and examples.

Environment:
  GITHUG_AGENT_KEY   act as this agent (instead of the default agent on this machine)
  GITHUG_REPO        default --repo for token/env
  GITHUG_RUN         run id for tokens and commits (hug run sets it)
  GITHUG_URL         githug instance (default https://githug.ai, or what --url saved)
  HUG_CONFIG         config file (default ~/.config/hug/config.json)

Docs: https://githug.ai/docs
`)
	return b.String()
}

// usageError is the error for a malformed command: its synopsis and where to read more.
func usageError(path string) error {
	return fmt.Errorf("usage: hug %s\n  (see `hug %s --help`)", helpTopics[path].usage, path)
}
