package ori

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

var graphDirectories = []string{"entities", "components", "relations", "types", "projections"}
var localDirectories = []string{"state", "projections", "cache", "logs", "bin"}

const oriIgnore = "# Ori local runtime files (keep configuration and graph in Git).\n/state/\n/projections/\n/cache/\n/logs/\n/bin/\n"
const oriReadme = `# Ori workspace

Commit config.json, INSTRUCTIONS.md, this README, .gitignore, and the configured graph directory.
The graph is the source of truth; generated projections and runtime state are local.

- state/: SQLite search index, changes, execution records, and locks.
- projections/: exported projection snapshots.
- cache/, logs/, bin/: optional local runtime files.

Run ori init after cloning to restore local directories and missing scaffolding.
Repeated initialization preserves configuration and graph content. Run ori doctor
to check the workspace and the effective Git ignore rules. Initialization never
stages files, commits, downloads models, or generates product sources.
`

// Init bootstraps or repairs the Git worktree without replacing user data.
func Init(root string) (*Workspace, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	gitRoot, err := Git(root, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, errors.New("ori init requires an existing Git repository")
	}
	root, err = filepath.EvalSymlinks(gitRoot)
	if err != nil {
		return nil, err
	}
	// Git's worktree-specific metadata keeps this lock outside tracked files and
	// avoids creating a database merely to initialize the project.
	gitDir, err := Git(root, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return nil, err
	}
	gitDir, err = filepath.EvalSymlinks(gitDir)
	if err != nil {
		return nil, err
	}
	lockPath, err := SafePath(gitDir, "ori-init.lock")
	if err != nil {
		return nil, err
	}
	lock := flock.New(lockPath)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ok, err := lock.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("timed out waiting for Ori initialization")
	}
	defer lock.Unlock()

	p, err := SafePath(root, ".ori/config.json")
	if err != nil {
		return nil, err
	}
	cfg := DefaultConfig()
	b, err := os.ReadFile(p)
	fresh := os.IsNotExist(err)
	if err != nil && !fresh {
		return nil, err
	}
	if !fresh {
		if err := Decode(b, &cfg); err != nil {
			return nil, fmt.Errorf("existing Ori configuration: %w", err)
		}
	}
	if err := validateConfig(root, cfg); err != nil {
		return nil, err
	}
	graph, err := SafePath(root, cfg.Graph)
	if err != nil {
		return nil, err
	}
	if fresh {
		if _, err := os.Lstat(graph); err == nil {
			return nil, errors.New("graph directory already exists; choose/import it explicitly instead of overwriting")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	// Preflight every owned path before writing any project files.
	paths := []string{".ori/.gitignore", ".ori/README.md", ".ori/INSTRUCTIONS.md"}
	for _, dir := range localDirectories {
		paths = append(paths, ".ori/"+dir)
	}
	for _, dir := range graphDirectories {
		paths = append(paths, cfg.Graph+"/"+dir+"/.gitkeep")
	}
	if fresh {
		paths = append(paths, cfg.Graph+"/projections/all.json")
	}
	for _, rel := range paths {
		p, err := SafePath(root, rel)
		if err != nil {
			return nil, err
		}
		wantDirectory := false
		for _, dir := range localDirectories {
			wantDirectory = wantDirectory || rel == ".ori/"+dir
		}
		if st, err := os.Stat(p); err == nil {
			if st.IsDir() != wantDirectory || (!wantDirectory && !st.Mode().IsRegular()) {
				return nil, fmt.Errorf("unexpected file type: %s", rel)
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	ignorePath := filepath.Join(root, ".ori/.gitignore")
	ignore, err := os.ReadFile(ignorePath)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	instructionEdits, err := prepareInstructions(root)
	if err != nil {
		return nil, err
	}
	// The validated configuration is the ownership marker. Persist it before
	// graph scaffolding so an interrupted first run can be safely repaired.
	if fresh {
		if err := writeMissing(p, JSON(cfg)); err != nil {
			return nil, err
		}
	}
	if !strings.HasSuffix(string(ignore), oriIgnore) {
		if len(ignore) > 0 && ignore[len(ignore)-1] != '\n' {
			ignore = append(ignore, '\n')
		}
		ignore = append(ignore, []byte(oriIgnore)...)
		if err := AtomicWrite(ignorePath, ignore); err != nil {
			return nil, err
		}
	}
	if err := writeMissing(filepath.Join(root, ".ori/README.md"), []byte(oriReadme)); err != nil {
		return nil, err
	}
	if err := writeMissing(filepath.Join(root, ".ori/INSTRUCTIONS.md"), []byte(oriInstructions)); err != nil {
		return nil, err
	}
	if err := applyInstructions(instructionEdits); err != nil {
		return nil, err
	}
	for _, dir := range localDirectories {
		if err := os.MkdirAll(filepath.Join(root, ".ori", dir), 0700); err != nil {
			return nil, err
		}
	}
	for _, dir := range graphDirectories {
		if err := writeMissing(filepath.Join(graph, dir, ".gitkeep"), nil); err != nil {
			return nil, err
		}
	}
	if fresh {
		spec := ProjectionSpec{ID: "all", Name: "Whole product", RelationTypes: []string{"*"}, Depth: 64}
		if err := writeMissing(filepath.Join(graph, "projections/all.json"), JSON(spec)); err != nil {
			return nil, err
		}
	}
	return &Workspace{Root: root, Config: cfg}, nil
}

func writeMissing(file string, content []byte) error {
	if st, err := os.Lstat(file); err == nil {
		if !st.Mode().IsRegular() {
			return fmt.Errorf("expected regular file: %s", file)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".ori-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(content)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	// Link publishes a complete file atomically and fails if another writer
	// created the destination. A rename would silently replace that file.
	return os.Link(f.Name(), file)
}

type DoctorCheck struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}
type DoctorReport struct {
	Ready  bool          `json:"ready"`
	Root   string        `json:"root"`
	Checks []DoctorCheck `json:"checks"`
}

// Doctor only reads disk and Git metadata. It never opens the database, repairs
// a journal, creates directories, or loads optional model/executor software.
func (w *Workspace) Doctor() (DoctorReport, error) {
	r := DoctorReport{Ready: true, Root: w.Root, Checks: []DoctorCheck{}}
	add := func(name string, ok bool, message string) {
		r.Checks = append(r.Checks, DoctorCheck{Name: name, OK: ok, Message: message})
		if !ok {
			r.Ready = false
		}
	}
	gitRoot, err := Git(w.Root, "rev-parse", "--show-toplevel")
	if err != nil {
		add("git", false, err.Error())
		return r, nil
	}
	resolved, err := filepath.EvalSymlinks(gitRoot)
	if err != nil {
		return r, err
	}
	add("git", resolved == w.Root, "Git worktree root: "+resolved)
	actual, err := Open(w.Root)
	if err != nil {
		add("configuration", false, err.Error())
		return r, nil
	}
	add("configuration", actual.Root == w.Root, ".ori/config.json is valid")
	if actual.Root != w.Root {
		return r, nil
	}
	checkPath := func(rel string, directory bool) {
		p, err := SafePath(w.Root, rel)
		if err == nil {
			var st os.FileInfo
			st, err = os.Stat(p)
			if err == nil && (st.IsDir() != directory || (!directory && !st.Mode().IsRegular())) {
				err = errors.New("unexpected file type")
			}
		}
		if err != nil {
			add("path:"+rel, false, err.Error()+"; run ori init to repair missing scaffolding")
		} else {
			add("path:"+rel, true, "present")
		}
	}
	for _, rel := range []string{".ori/.gitignore", ".ori/README.md", ".ori/INSTRUCTIONS.md", "AGENTS.md"} {
		checkPath(rel, false)
	}
	instructionPaths := []string{"AGENTS.md"}
	if _, err := os.Lstat(filepath.Join(w.Root, "AGENTS.override.md")); !os.IsNotExist(err) {
		instructionPaths = append(instructionPaths, "AGENTS.override.md")
		checkPath("AGENTS.override.md", false)
	}
	for _, rel := range instructionPaths {
		p, err := SafePath(w.Root, rel)
		var content []byte
		if err == nil {
			content, err = os.ReadFile(p)
		}
		if err == nil {
			var present bool
			var expected []byte
			expected, present, err = managedInstructionBlock(content)
			if err == nil && !present {
				err = errors.New("Ori instruction block is missing; run ori init")
			} else if err == nil && !bytes.Equal(content, expected) {
				err = errors.New("Ori instruction block is outdated; run ori init")
			}
		}
		if err != nil {
			add("instructions:"+rel, false, err.Error())
		} else {
			add("instructions:"+rel, true, "Ori instruction block is present")
		}
	}
	for _, dir := range localDirectories {
		checkPath(".ori/"+dir, true)
	}
	for _, dir := range graphDirectories {
		checkPath(actual.Config.Graph+"/"+dir, true)
		checkPath(actual.Config.Graph+"/"+dir+"/.gitkeep", false)
	}
	_, graphErr := actual.snapshotUnlocked("working")
	if graphErr != nil {
		add("graph", false, graphErr.Error())
	} else {
		add("graph", true, "graph files and references are valid")
	}
	journal, journalErr := SafePath(w.Root, changeJournalPath)
	if journalErr == nil {
		_, journalErr = os.Lstat(journal)
		if journalErr == nil {
			journalErr = errors.New("pending graph change recovery; run ori validate to recover before editing")
		} else if os.IsNotExist(journalErr) {
			journalErr = nil
		}
	}
	if journalErr != nil {
		add("change-journal", false, journalErr.Error())
	} else {
		add("change-journal", true, "no pending change recovery")
	}

	// --no-index is essential: tracked runtime files must not mask ignore rules.
	checkIgnore := func(rel string, shouldIgnore bool) error {
		cmd := exec.Command("git", "-C", w.Root, "check-ignore", "--no-index", "-q", "--", rel)
		err := cmd.Run()
		ignored := err == nil
		if err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				return fmt.Errorf("git check-ignore %s: %w", rel, err)
			}
		}
		message := "trackable"
		if ignored {
			message = "ignored by Git"
		}
		if ignored != shouldIgnore {
			message += "; inspect git check-ignore -v --no-index and repair the matching rule"
		}
		add("ignore:"+rel, ignored == shouldIgnore, message)
		return nil
	}
	for _, dir := range localDirectories {
		if err := checkIgnore(".ori/"+dir+"/ori-doctor-probe", true); err != nil {
			return r, err
		}
	}
	for _, rel := range append([]string{".ori/config.json", ".ori/.gitignore", ".ori/README.md", ".ori/INSTRUCTIONS.md"}, instructionPaths...) {
		if err := checkIgnore(rel, false); err != nil {
			return r, err
		}
	}
	for _, dir := range graphDirectories {
		if err := checkIgnore(actual.Config.Graph+"/"+dir+"/.gitkeep", false); err != nil {
			return r, err
		}
		if err := checkIgnore(actual.Config.Graph+"/"+dir+"/ori-doctor-probe.json", false); err != nil {
			return r, err
		}
	}
	args := []string{"ls-files", "-z", "--"}
	for _, dir := range localDirectories {
		args = append(args, ".ori/"+dir+"/")
	}
	tracked, err := exec.Command("git", append([]string{"-C", w.Root}, args...)...).Output()
	if err != nil {
		return r, err
	}
	message := "local runtime files are not tracked"
	if len(tracked) != 0 {
		message = "runtime files are already tracked: " + strings.ReplaceAll(strings.TrimRight(string(tracked), "\x00"), "\x00", ", ") + "; remove them from the Git index while preserving local files"
	}
	add("runtime-tracking", len(tracked) == 0, message)
	args = []string{"ls-files", "-z", "--others", "--exclude-standard", "--"}
	for _, dir := range localDirectories {
		args = append(args, ".ori/"+dir+"/")
	}
	unignored, err := exec.Command("git", append([]string{"-C", w.Root}, args...)...).Output()
	if err != nil {
		return r, err
	}
	message = "all existing local runtime files are ignored"
	if len(unignored) != 0 {
		message = "runtime files visible to Git: " + strings.ReplaceAll(strings.TrimRight(string(unignored), "\x00"), "\x00", ", ")
	}
	add("runtime-ignores", len(unignored) == 0, message)
	ignored, err := exec.Command("git", "-C", w.Root, "ls-files", "-z", "--cached", "--others", "--ignored", "--exclude-standard", "--", actual.Config.Graph+"/").Output()
	if err != nil {
		return r, err
	}
	var hiddenGraph []string
	for _, rel := range strings.Split(string(ignored), "\x00") {
		if strings.HasPrefix(rel, actual.Config.Graph+"/") && graphFile(strings.TrimPrefix(rel, actual.Config.Graph+"/")) {
			hiddenGraph = append(hiddenGraph, rel)
		}
	}
	message = "no graph content files are hidden by ignore rules"
	if len(hiddenGraph) != 0 {
		message = "graph files hidden by Git ignore rules: " + strings.Join(hiddenGraph, ", ")
	}
	add("graph-tracking", len(hiddenGraph) == 0, message)
	return r, nil
}
