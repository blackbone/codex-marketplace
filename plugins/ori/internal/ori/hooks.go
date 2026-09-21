package ori

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// HookContext is a bounded, read-only lifecycle adapter. It never opens an
// index, builds a runtime, runs repository commands other than Git discovery,
// or copies repository prose into developer context.
func HookContext(ctx context.Context, input io.Reader, output io.Writer) error {
	b, err := io.ReadAll(io.LimitReader(input, (1<<20)+1))
	if err != nil || len(b) > 1<<20 {
		return nil
	}
	var event struct {
		Event string `json:"hook_event_name"`
		CWD   string `json:"cwd"`
	}
	if json.Unmarshal(b, &event) != nil || event.CWD == "" || !filepath.IsAbs(event.CWD) {
		return nil
	}
	switch event.Event {
	case "SessionStart", "UserPromptSubmit", "SubagentStart":
	default:
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", event.CWD, "rev-parse", "--show-toplevel")
	rootBytes, err := cmd.Output()
	if err != nil {
		return nil
	}
	root, err := filepath.EvalSymlinks(strings.TrimSpace(string(rootBytes)))
	if err != nil {
		return nil
	}
	config, err := SafePath(root, ".ori/config.json")
	if err != nil {
		return nil
	}
	st, err := os.Stat(config)
	if err != nil || !st.Mode().IsRegular() {
		return nil
	}
	w, err := Open(root)
	contextText := "Ori is configured in this repository, but its configuration cannot be read. Use $ori:doctor to diagnose it; preserve existing graph files."
	if err == nil {
		contextText = fmt.Sprintf("Ori repository: %q. Graph directory: %q.\n%s", w.Root, w.Config.Graph, InstructionContext)
	}
	return json.NewEncoder(output).Encode(map[string]any{"hookSpecificOutput": map[string]string{"hookEventName": event.Event, "additionalContext": contextText}})
}
