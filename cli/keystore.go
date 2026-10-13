package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Keys live in the OS keychain when there is one, so config.json holds names and settings
// only, and reading it to debug a setting (as people and agents do) prints no key. Without a
// keychain (CI, a headless box), or with HUG_KEYCHAIN=0, keys stay in config.json (0600).

// inKeychain is what config.json holds in place of a key kept in the keychain.
const inKeychain = "keychain"

type keystore interface {
	name() string
	get(id string) (string, error)
	set(id, secret string) error
}

// keys is nil when there is no usable keychain; tests swap in a fake.
var keys = defaultKeystore()

func defaultKeystore() keystore {
	if os.Getenv("HUG_KEYCHAIN") == "0" {
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		if _, err := exec.LookPath("security"); err == nil {
			return macKeychain{}
		}
	case "linux":
		if _, err := exec.LookPath("secret-tool"); err == nil {
			return secretService{}
		}
	}
	return nil
}

// keyID names a key in the keychain: the config file it belongs to, so two HUG_CONFIGs on one
// machine don't share keys, and which key ("account", "agent:NAME").
func keyID(which string) string {
	p, _ := configPath()
	return p + "#" + which
}

type macKeychain struct{}

func (macKeychain) name() string { return "macOS Keychain" }

func (macKeychain) get(id string) (string, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", "hug", "-a", id, "-w").Output()
	return strings.TrimSpace(string(out)), err
}

// set passes the key as an argument: `security` reads -w no other way without a prompt. It is
// visible to this user's own processes for the moment the command runs.
func (macKeychain) set(id, secret string) error {
	return exec.Command("security", "add-generic-password", "-U", "-s", "hug", "-a", id, "-l", "hug "+id, "-w", secret).Run()
}

type secretService struct{}

func (secretService) name() string { return "Secret Service" }

func (secretService) get(id string) (string, error) {
	out, err := exec.Command("secret-tool", "lookup", "service", "hug", "account", id).Output()
	if err == nil && len(out) == 0 {
		err = errors.New("not found")
	}
	return strings.TrimSpace(string(out)), err
}

func (secretService) set(id, secret string) error {
	cmd := exec.Command("secret-tool", "store", "--label=hug "+id, "service", "hug", "account", id)
	cmd.Stdin = strings.NewReader(secret)
	return cmd.Run()
}
