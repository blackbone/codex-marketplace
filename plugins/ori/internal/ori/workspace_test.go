package ori

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceSafePaths(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"", ".", "..", "../escape", "a/../../escape", "a/../b", "/absolute", "a//b", `a\b`, "C:/escape", "a\x00b"} {
		if _, err := SafePath(root, rel); err == nil {
			t.Errorf("unsafe path accepted: %q", rel)
		}
	}
	if p, err := SafePath(root, "a/b.json"); err != nil || p != filepath.Join(root, "a/b.json") {
		t.Fatal(p, err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := SafePath(root, "linked/file.json"); err == nil {
		t.Fatal("symlink ancestor accepted")
	}
}

func TestWorkspaceInitPreservesIgnoreAndFindsParent(t *testing.T) {
	root := t.TempDir()
	if _, err := Git(root, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(root, ".ori/.gitignore"), []byte("custom-data/")); err != nil {
		t.Fatal(err)
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	ignore, err := os.ReadFile(filepath.Join(root, ".ori/.gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if string(ignore) != "custom-data/\n"+oriIgnore {
		t.Fatalf("existing ignore overwritten: %q", ignore)
	}
	child := filepath.Join(root, "nested/child")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	opened, err := Open(child)
	if err != nil || opened.Root != w.Root {
		t.Fatal(opened, err)
	}
	if _, err := Init(root); err != nil {
		t.Fatal("duplicate init failed", err)
	}
	if w.Config.Embeddings.Provider != "local" {
		t.Fatal("local embeddings not default")
	}
}

func TestWorkspaceRejectsUnsupportedConfiguration(t *testing.T) {
	w := atlasRepository(t)
	cases := map[string]func(*Config){
		"nonlocal model":         func(c *Config) { c.Embeddings.Provider = "remote" },
		"reserved graph":         func(c *Config) { c.Graph = ".ori/graph" },
		"aliased reserved graph": func(c *Config) { c.Graph = "a/../.git" },
		"empty check":            func(c *Config) { c.Executor.Checks = [][]string{{}} },
		"empty executable":       func(c *Config) { c.Executor.Command = []string{" "} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := DefaultConfig()
			mutate(&cfg)
			if err := AtomicWrite(filepath.Join(w.Root, ".ori/config.json"), JSON(cfg)); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(w.Root); err == nil {
				t.Fatal("unsupported config accepted")
			}
		})
	}
}

func TestWorkspaceDecodeRejectsTrailingJSON(t *testing.T) {
	var result Entity
	if err := Decode([]byte(`{"id":"x","name":"x"} {}`), &result); err == nil || !strings.Contains(err.Error(), "one JSON value") {
		t.Fatal("trailing JSON accepted", err)
	}
}

func TestWorkspaceSaveConfiguration(t *testing.T) {
	w := atlasRepository(t)
	cfg := w.Config
	cfg.Embeddings.Provider = "off"
	if err := w.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if w.Config.Embeddings.Provider != "local" {
		t.Fatal("SaveConfig mutates shared workspace memory")
	}
	updated, err := Open(w.Root)
	if err != nil || updated.Config.Embeddings.Provider != "off" {
		t.Fatal(updated, err)
	}
	cfg.Graph = "another-graph"
	if err := w.SaveConfig(context.Background(), cfg); err == nil {
		t.Fatal("implicit graph relocation accepted")
	}
	again, err := Open(w.Root)
	if err != nil || again.Config.Graph != w.Config.Graph {
		t.Fatal("failed configuration update modified disk", err)
	}
}
