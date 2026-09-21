package ori

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func setupRepository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if _, err := Git(root, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	if _, err := Git(root, "config", "core.excludesFile", filepath.Join(root, "unused-global-excludes")); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestSetupRepairPreservesUserContent(t *testing.T) {
	root := setupRepository(t)
	child := filepath.Join(root, "nested/child")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	w, err := Init(child)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := filepath.EvalSymlinks(root)
	if w.Root != canonical {
		t.Fatalf("wrong root %q", w.Root)
	}
	cfg := " {\n\"version\":1,\"graph\":\"graph\",\"embeddings\":{\"provider\":\"off\"},\"executor\":{\"maxAttempts\":3,\"timeoutSeconds\":99}}\n"
	files := map[string]string{".ori/config.json": cfg, "graph/entities/user.json": `{"id":"user","name":"User"}`, ".ori/README.md": "User instructions\n"}
	for rel, text := range files {
		if err := AtomicWrite(filepath.Join(root, rel), []byte(text)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(root, "graph/projections/all.json")); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{".ori/state", ".ori/projections", "graph/types", "graph/relations/.gitkeep"} {
		if err := os.RemoveAll(filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
	}
	w, err = Init(child)
	if err != nil {
		t.Fatal(err)
	}
	if w.Config.Embeddings.Provider != "off" || w.Config.Executor.MaxAttempts != 3 {
		t.Fatal("config reset")
	}
	for rel, want := range files {
		got, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil || string(got) != want {
			t.Fatalf("%s changed: %q %v", rel, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "graph/projections/all.json")); !os.IsNotExist(err) {
		t.Fatal("deleted selector resurrected")
	}
	ignore, _ := os.ReadFile(filepath.Join(root, ".ori/.gitignore"))
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(root, ".ori/.gitignore"))
	if string(ignore) != string(again) {
		t.Fatal("repeat modified ignore")
	}
	report, err := w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("doctor: %+v %v", report, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".ori/state/index.sqlite")); !os.IsNotExist(err) {
		t.Fatal("init or doctor created database")
	}
	entries, err := os.ReadDir(filepath.Join(root, ".ori/state"))
	if err != nil || len(entries) != 0 {
		t.Fatal("doctor mutated local state", entries, err)
	}
}

func TestSetupRejectsCollisionsAndInvalidConfig(t *testing.T) {
	t.Run("graph collision", func(t *testing.T) {
		root := setupRepository(t)
		if err := AtomicWrite(filepath.Join(root, "graph/existing.txt"), []byte("mine")); err != nil {
			t.Fatal(err)
		}
		if _, err := Init(root); err == nil {
			t.Fatal("accepted non-Ori graph")
		}
		if _, err := os.Stat(filepath.Join(root, ".ori")); !os.IsNotExist(err) {
			t.Fatal("modified colliding workspace")
		}
	})
	t.Run("invalid config", func(t *testing.T) {
		root := setupRepository(t)
		if err := AtomicWrite(filepath.Join(root, ".ori/config.json"), []byte("broken")); err != nil {
			t.Fatal(err)
		}
		if _, err := Init(root); err == nil {
			t.Fatal("accepted invalid config")
		}
		b, _ := os.ReadFile(filepath.Join(root, ".ori/config.json"))
		if string(b) != "broken" {
			t.Fatal("overwrote invalid config")
		}
	})
	for _, rel := range []string{".ori", ".ori/state", ".ori/.gitignore", "graph/entities/.gitkeep"} {
		t.Run("symlink "+rel, func(t *testing.T) {
			root := setupRepository(t)
			if strings.HasPrefix(rel, "graph/") {
				if _, err := Init(root); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(root, rel)); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), filepath.Join(root, rel)); err != nil {
				t.Fatal(err)
			}
			if _, err := Init(root); err == nil {
				t.Fatal("accepted symlink", rel)
			}
		})
	}
}

func TestSetupDoctorReportsActualGitRules(t *testing.T) {
	t.Run("ignored incidental files", func(t *testing.T) {
		root := setupRepository(t)
		w, err := Init(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(filepath.Join(root, ".gitignore"), []byte(".DS_Store\n*.tmp\n")); err != nil {
			t.Fatal(err)
		}
		for _, rel := range []string{"graph/.DS_Store", "graph/entities/draft.tmp"} {
			if err := AtomicWrite(filepath.Join(root, rel), []byte("junk")); err != nil {
				t.Fatal(err)
			}
		}
		report, err := w.Doctor()
		if err != nil || !report.Ready {
			t.Fatalf("incidental ignored files failed doctor: %+v %v", report, err)
		}
	})
	t.Run("tracked graph content", func(t *testing.T) {
		root := setupRepository(t)
		w, err := Init(root)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Git(root, "add", "--", "graph/projections/all.json"); err != nil {
			t.Fatal(err)
		}
		excludes := filepath.Join(t.TempDir(), "global-excludes")
		if err := AtomicWrite(excludes, []byte("graph/projections/all.json\n")); err != nil {
			t.Fatal(err)
		}
		if _, err := Git(root, "config", "core.excludesFile", excludes); err != nil {
			t.Fatal(err)
		}
		report, err := w.Doctor()
		if err != nil || report.Ready {
			t.Fatalf("globally ignored tracked graph reported ready: %+v %v", report, err)
		}
	})
	for name, rule := range map[string]string{"parent": ".ori/\n", "graph": "graph/\n", "json": "*.json\n"} {
		t.Run(name, func(t *testing.T) {
			root := setupRepository(t)
			w, err := Init(root)
			if err != nil {
				t.Fatal(err)
			}
			if err := AtomicWrite(filepath.Join(root, ".gitignore"), []byte(rule)); err != nil {
				t.Fatal(err)
			}
			report, err := w.Doctor()
			if err != nil || report.Ready {
				t.Fatalf("ignored project reported ready: %+v %v", report, err)
			}
			b, _ := os.ReadFile(filepath.Join(root, ".gitignore"))
			if string(b) != rule {
				t.Fatal("doctor rewrote parent ignore")
			}
		})
	}
	t.Run("tracked runtime", func(t *testing.T) {
		root := setupRepository(t)
		w, err := Init(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(filepath.Join(root, ".ori/state/local.db"), []byte("local")); err != nil {
			t.Fatal(err)
		}
		if _, err := Git(root, "add", "-f", "--", ".ori/state/local.db"); err != nil {
			t.Fatal(err)
		}
		report, err := w.Doctor()
		if err != nil || report.Ready {
			t.Fatalf("tracked runtime reported ready: %+v %v", report, err)
		}
		for _, c := range report.Checks {
			if c.Name == "runtime-tracking" && c.OK {
				t.Fatal("tracked runtime check passed")
			}
		}
	})
	t.Run("overridden runtime ignore", func(t *testing.T) {
		root := setupRepository(t)
		w, err := Init(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(filepath.Join(root, ".ori/.gitignore"), []byte(oriIgnore+"!state/\n")); err != nil {
			t.Fatal(err)
		}
		report, err := w.Doctor()
		if err != nil || report.Ready {
			t.Fatalf("unignored runtime reported ready: %+v %v", report, err)
		}
		if _, err := Init(root); err != nil {
			t.Fatal(err)
		}
		report, err = w.Doctor()
		if err != nil || !report.Ready {
			t.Fatalf("ignore repair failed: %+v %v", report, err)
		}
	})
}

func TestSetupConcurrentInit(t *testing.T) {
	root := setupRepository(t)
	var group sync.WaitGroup
	errors := make(chan error, 4)
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() { defer group.Done(); _, err := Init(root); errors <- err }()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	w, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	report, err := w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("concurrent init result: %+v %v", report, err)
	}
}

func TestSetupRepairsCloneAndInterruptedInitialization(t *testing.T) {
	root := setupRepository(t)
	// Configuration alone is a valid ownership marker if the first run stopped
	// before creating graph or local directories.
	if err := AtomicWrite(filepath.Join(root, ".ori/config.json"), JSON(DefaultConfig())); err != nil {
		t.Fatal(err)
	}
	w, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	report, err := w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("incomplete setup reported ready: %+v %v", report, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".ori/state")); !os.IsNotExist(err) {
		t.Fatal("doctor created missing state")
	}
	w, err = Init(root)
	if err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("repair failed: %+v %v", report, err)
	}
	for _, dir := range localDirectories {
		if err := os.RemoveAll(filepath.Join(root, ".ori", dir)); err != nil {
			t.Fatal(err)
		}
	}
	w, err = Init(root)
	if err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("clone repair failed: %+v %v", report, err)
	}
	if err := AtomicWrite(filepath.Join(root, changeJournalPath), []byte(`{"pending":true}`)); err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("pending recovery reported ready: %+v %v", report, err)
	}
	journal, err := os.ReadFile(filepath.Join(root, changeJournalPath))
	if err != nil || string(journal) != `{"pending":true}` {
		t.Fatal("doctor changed journal")
	}
}
