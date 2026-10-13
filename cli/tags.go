package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Agent tokens carry contents:write, which also lets them push tags. If a workflow publishes
// a release on a tag push, that is a release with no review unless a tag ruleset stops it, and
// GitHub token permissions can't allow branches but forbid tags. hug setup checks for the gap.

var githubAPI = "https://api.github.com" // tests point this at a fake

var (
	tagsKeyRE  = regexp.MustCompile(`^(\s*)tags:\s*(.*)$`)
	listItemRE = regexp.MustCompile(`^\s*-\s*(.+?)\s*$`)
)

// releaseTagPatterns: the tag patterns that trigger a workflow in dir/.github/workflows, by
// file. A line scan, not a YAML parser: `tags:` with an inline value, a [list], or - items.
func releaseTagPatterns(dir string) map[string][]string {
	files, _ := filepath.Glob(filepath.Join(dir, ".github", "workflows", "*.y*ml"))
	found := map[string][]string{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		lines := strings.Split(string(b), "\n")
		for i := 0; i < len(lines); i++ {
			m := tagsKeyRE.FindStringSubmatch(lines[i])
			if m == nil || parentKey(lines[:i], len(m[1])) != "push:" {
				continue // a `tags:` elsewhere (say, docker metadata) is not a trigger
			}
			var pats []string
			if v := strings.TrimSpace(m[2]); v != "" {
				pats = strings.Split(strings.Trim(v, "[]"), ",")
			} else {
				for ; i+1 < len(lines); i++ {
					item := listItemRE.FindStringSubmatch(lines[i+1])
					if item == nil {
						break
					}
					pats = append(pats, item[1])
				}
			}
			for _, p := range pats {
				if p = strings.Trim(strings.TrimSpace(strings.SplitN(p, "#", 2)[0]), `"'`); p != "" {
					found[filepath.Base(f)] = append(found[filepath.Base(f)], p)
				}
			}
		}
	}
	return found
}

// parentKey: the nearest line above that is indented less than indent, trimmed.
func parentKey(above []string, indent int) string {
	for j := len(above) - 1; j >= 0; j-- {
		t := strings.TrimSpace(above[j])
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if len(above[j])-len(strings.TrimLeft(above[j], " ")) < indent {
			return t
		}
	}
	return ""
}

type ruleset struct {
	ID          int    `json:"id"`
	Target      string `json:"target"`
	Enforcement string `json:"enforcement"`
	Conditions  struct {
		RefName struct {
			Include []string `json:"include"`
		} `json:"ref_name"`
	} `json:"conditions"`
	Rules []struct {
		Type string `json:"type"`
	} `json:"rules"`
}

// protects: an active tag ruleset that restricts creating tags matching pattern.
func (r ruleset) protects(pattern string) bool {
	if r.Target != "tag" || r.Enforcement != "active" {
		return false
	}
	creation := false
	for _, x := range r.Rules {
		creation = creation || x.Type == "creation"
	}
	if !creation {
		return false
	}
	for _, inc := range r.Conditions.RefName.Include {
		inc = strings.TrimPrefix(inc, "refs/tags/")
		if inc == "~ALL" || inc == pattern {
			return true
		}
		if ok, _ := path.Match(inc, pattern); ok {
			return true
		}
	}
	return false
}

// tagRulesets fetches the repo's active tag rulesets with the agent's token. ok is false when
// GitHub won't say (a private repo can hide them), so the caller stays quiet rather than guess.
func tagRulesets(token, repoName string) (sets []ruleset, ok bool) {
	hc := &http.Client{Timeout: 10 * time.Second}
	get := func(p string, out any) bool {
		req, err := http.NewRequest("GET", githubAPI+"/repos/"+repoName+p, nil)
		if err != nil {
			return false
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := hc.Do(req)
		if err != nil {
			return false
		}
		defer res.Body.Close()
		return res.StatusCode == 200 && json.NewDecoder(res.Body).Decode(out) == nil
	}
	var list []ruleset
	if !get("/rulesets?includes_parents=true", &list) {
		return nil, false
	}
	for _, r := range list {
		if r.Target != "tag" || r.Enforcement != "active" {
			continue
		}
		var full ruleset
		if !get(fmt.Sprintf("/rulesets/%d", r.ID), &full) {
			return nil, false
		}
		sets = append(sets, full)
	}
	return sets, true
}

// releaseTagWarning: what to tell the human when a tag push would publish and nothing stops
// the agent pushing that tag; "" when there is no such workflow, it's covered, or we can't tell.
func releaseTagWarning(dir, token, repoName string) string {
	byFile := releaseTagPatterns(dir)
	if len(byFile) == 0 {
		return ""
	}
	sets, ok := tagRulesets(token, repoName)
	if !ok {
		return ""
	}
	var open []string
	for file, pats := range byFile {
		for _, p := range pats {
			covered := false
			for _, r := range sets {
				covered = covered || r.protects(p)
			}
			if !covered {
				open = append(open, fmt.Sprintf("%s (%s)", p, file))
			}
		}
	}
	if len(open) == 0 {
		return ""
	}
	sort.Strings(open)
	return fmt.Sprintf(`  Warning: pushing a tag runs a workflow here, and this agent can push tags: %s.
  Anyone holding its key could publish a release with no review. As a repo admin, add a tag
  ruleset that restricts creation, update and deletion of those tags, bypass Repository admin:
    https://github.com/%s/settings/rules/new?target=tag
`, strings.Join(open, ", "), repoName)
}
