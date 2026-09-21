package ori

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstructionsInstallPreservesAndRepairs(t *testing.T) {
	root := setupRepository(t)
	before := "# Local rules\r\n\r\nKeep this exact."
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(before), 0644); err != nil {
		t.Fatal(err)
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	installed := read("AGENTS.md")
	if !strings.HasPrefix(installed, before+"\n\n") || strings.Count(installed, oriBegin) != 1 {
		t.Fatalf("user content changed or block missing: %q", installed)
	}
	if _, err := os.Stat(filepath.Join(root, "AGENTS.override.md")); !os.IsNotExist(err) {
		t.Fatal("created unnecessary override")
	}
	customInstructions := "# Project-specific Ori workflow\nPreserve my edits.\n"
	if err := os.WriteFile(filepath.Join(root, ".ori/INSTRUCTIONS.md"), []byte(customInstructions), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	if read("AGENTS.md") != installed || read(".ori/INSTRUCTIONS.md") != customInstructions {
		t.Fatal("repeat setup modified instructions")
	}
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(before), 0644); err != nil {
		t.Fatal(err)
	}
	report, err := w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("doctor missed removed block: %+v %v", report, err)
	}
	if read("AGENTS.md") != before {
		t.Fatal("doctor repaired file")
	}
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	if read("AGENTS.md") != installed {
		t.Fatal("repair differed from initial installation")
	}
	if err := os.Remove(filepath.Join(root, ".ori/INSTRUCTIONS.md")); err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("doctor missed removed instructions: %+v %v", report, err)
	}
}

func TestInstructionsUpdatesOwnedBlockAndOverride(t *testing.T) {
	root := setupRepository(t)
	prefix, suffix := "# Private rules\r\n\r\n", "\r\n\r\nDo not touch trailing text.\r\n"
	old := prefix + oriBegin + "\r\nOld Ori integration\r\n" + oriEnd + suffix
	for _, rel := range []string{"AGENTS.md", "AGENTS.override.md"} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(old), 0644); err != nil {
			t.Fatal(err)
		}
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"AGENTS.md", "AGENTS.override.md"} {
		b, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil || string(b) != prefix+oriAgentBlock+suffix {
			t.Fatalf("%s surrounding content changed: %q %v", rel, b, err)
		}
	}
	report, err := w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("doctor: %+v %v", report, err)
	}
	if err := os.WriteFile(filepath.Join(root, "AGENTS.override.md"), []byte("Override without Ori"), 0644); err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("doctor missed override's removed integration: %+v %v", report, err)
	}
}

func TestInstructionsRejectMalformedBeforeWriting(t *testing.T) {
	malformed := []string{
		oriBegin, oriEnd, oriEnd + "\n" + oriBegin,
		oriBegin + "\n" + oriBegin + "\n" + oriEnd,
		oriBegin + "\n" + oriEnd + "\n" + oriEnd,
		"inline " + oriBegin + "\n" + oriEnd,
		oriBegin + " trailing\n" + oriEnd,
		"<!-- ori:begin",
	}
	for _, rel := range []string{"AGENTS.md", "AGENTS.override.md"} {
		for _, input := range malformed {
			t.Run(rel+input, func(t *testing.T) {
				root := setupRepository(t)
				if err := os.WriteFile(filepath.Join(root, rel), []byte(input), 0644); err != nil {
					t.Fatal(err)
				}
				if _, err := Init(root); err == nil {
					t.Fatal("accepted malformed instruction block")
				}
				if _, err := os.Stat(filepath.Join(root, ".ori")); !os.IsNotExist(err) {
					t.Fatal("wrote project files before rejecting malformed instructions")
				}
				b, _ := os.ReadFile(filepath.Join(root, rel))
				if string(b) != input {
					t.Fatal("overwrote malformed instruction file")
				}
			})
		}
	}
}

func TestInstructionsRejectSymlinksBeforeWriting(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "AGENTS.override.md", ".ori/INSTRUCTIONS.md"} {
		t.Run(rel, func(t *testing.T) {
			root := setupRepository(t)
			outside := filepath.Join(t.TempDir(), "instructions.md")
			if err := os.WriteFile(outside, []byte("external rules"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(root, rel)); err != nil {
				t.Fatal(err)
			}
			if _, err := Init(root); err == nil {
				t.Fatal("accepted symlink")
			}
			if _, err := os.Stat(filepath.Join(root, ".ori/config.json")); !os.IsNotExist(err) {
				t.Fatal("wrote configuration before rejecting symlink")
			}
			b, _ := os.ReadFile(outside)
			if string(b) != "external rules" {
				t.Fatal("changed external target")
			}
		})
	}
}

func TestInstructionsDoctorDetectsIgnoredInstructions(t *testing.T) {
	root := setupRepository(t)
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("AGENTS.md\n.ori/INSTRUCTIONS.md\n"), 0644); err != nil {
		t.Fatal(err)
	}
	report, err := w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("doctor accepted ignored instructions: %+v %v", report, err)
	}
	failed := map[string]bool{}
	for _, check := range report.Checks {
		if !check.OK {
			failed[check.Name] = true
		}
	}
	if !failed["ignore:AGENTS.md"] || !failed["ignore:.ori/INSTRUCTIONS.md"] {
		t.Fatalf("missing ignore checks: %+v", failed)
	}
}

func TestInstructionsDoctorDetectsStaleManagedBlock(t *testing.T) {
	root := setupRepository(t)
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	stale := oriBegin + "\n" + oriEnd + "\n"
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(stale), 0644); err != nil {
		t.Fatal(err)
	}
	report, err := w.Doctor()
	if err != nil || report.Ready {
		t.Fatalf("doctor accepted stale integration: %+v %v", report, err)
	}
	got, _ := os.ReadFile(filepath.Join(root, "AGENTS.md"))
	if string(got) != stale {
		t.Fatal("doctor modified stale integration")
	}
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	report, err = w.Doctor()
	if err != nil || !report.Ready {
		t.Fatalf("doctor rejected repaired integration: %+v %v", report, err)
	}
}
