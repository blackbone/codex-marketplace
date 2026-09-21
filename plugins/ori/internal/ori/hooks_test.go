package ori

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func invokeHook(t *testing.T, event, cwd string) string {
	t.Helper()
	var out bytes.Buffer
	if err := HookContext(context.Background(), bytes.NewReader(JSON(map[string]any{"hook_event_name": event, "cwd": cwd, "future_field": true})), &out); err != nil {
		t.Fatal(err)
	}
	return out.String()
}
func TestHooksConfiguredRepositoryAndLifecycle(t *testing.T) {
	root := setupRepository(t)
	if got := invokeHook(t, "SessionStart", root); got != "" {
		t.Fatal("inactive repository emitted context", got)
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "nested")
	if err = os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	// Hook discovery follows the actual Git root and never promotes repository prose.
	if err = AtomicWrite(filepath.Join(root, ".ori/INSTRUCTIONS.md"), []byte("SECRET_PROJECT_PROSE")); err != nil {
		t.Fatal(err)
	}
	before, _ := Git(root, "status", "--porcelain", "--untracked-files=all")
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "SubagentStart"} {
		var result struct {
			Output struct {
				Event string `json:"hookEventName"`
				Text  string `json:"additionalContext"`
			} `json:"hookSpecificOutput"`
		}
		if err = json.Unmarshal([]byte(invokeHook(t, event, child)), &result); err != nil {
			t.Fatal(err)
		}
		if result.Output.Event != event || !strings.Contains(result.Output.Text, w.Root) || !strings.Contains(result.Output.Text, "$ori:") || !strings.Contains(result.Output.Text, ".ori/INSTRUCTIONS.md") {
			t.Fatalf("bad hook output %+v", result)
		}
		if strings.Contains(result.Output.Text, "SECRET_PROJECT_PROSE") {
			t.Fatal("hook copied repository prose")
		}
	}
	after, _ := Git(root, "status", "--porcelain", "--untracked-files=all")
	if before != after {
		t.Fatal("hook changed workspace")
	}
	entries, err := os.ReadDir(filepath.Join(root, ".ori/state"))
	if err != nil || len(entries) != 0 {
		t.Fatal("hook created runtime state", entries, err)
	}
	nested := filepath.Join(root, "unrelated")
	if err = os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = Git(nested, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	if got := invokeHook(t, "SessionStart", nested); got != "" {
		t.Fatal("hook crossed nested repository boundary", got)
	}
	if err = AtomicWrite(filepath.Join(root, ".ori/config.json"), []byte("invalid")); err != nil {
		t.Fatal(err)
	}
	if got := invokeHook(t, "SessionStart", root); !strings.Contains(got, "$ori:doctor") {
		t.Fatal("missing invalid config guidance", got)
	}
}
func TestHooksIgnoreMalformedUnsupportedAndSymlinkedInput(t *testing.T) {
	for _, input := range []string{"", "{", "null", "[]", `{"hook_event_name":"SessionStart"}`, `{"hook_event_name":"SessionStart","cwd":"relative"}`, strings.Repeat("x", (1<<20)+1)} {
		var out bytes.Buffer
		if err := HookContext(context.Background(), strings.NewReader(input), &out); err != nil || out.Len() != 0 {
			t.Fatal("invalid input emitted output", err)
		}
	}
	root := setupRepository(t)
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	if got := invokeHook(t, "Stop", root); got != "" {
		t.Fatal("unexpected event", got)
	}
	config := filepath.Join(root, ".ori/config.json")
	b, _ := os.ReadFile(config)
	outside := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(outside, b, 0600)
	os.Remove(config)
	if err := os.Symlink(outside, config); err != nil {
		t.Fatal(err)
	}
	if got := invokeHook(t, "SessionStart", root); got != "" {
		t.Fatal("followed configuration symlink", got)
	}
}
