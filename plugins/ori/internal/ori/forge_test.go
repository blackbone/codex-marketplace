package ori

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test executable doubles as a portable direct-argv executor/check.
func TestForgeHelperProcess(t *testing.T) {
	if os.Getenv("ORI_RUN_ID") == "" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	stdin, _ := io.ReadAll(os.Stdin)
	switch mode {
	case "generate":
		b, e := os.ReadFile(os.Getenv("ORI_INPUT"))
		if e != nil {
			os.Exit(8)
		}
		var input BuildRequest
		if json.Unmarshal(stdin, &input) != nil || input.Projection.Digest == "" || string(stdin) != string(b) {
			os.Exit(9)
		}
		if os.WriteFile("generated.txt", []byte(input.Projection.Digest), 0600) != nil {
			os.Exit(10)
		}
	case "retry":
		var input BuildRequest
		if json.Unmarshal(stdin, &input) != nil || input.Projection.Digest == "" {
			os.Exit(14)
		}
		feedback, e := os.ReadFile(os.Getenv("ORI_FEEDBACK_FILE"))
		if e != nil {
			os.Exit(15)
		}
		if os.Getenv("ORI_ATTEMPT") == "1" {
			if len(feedback) != 0 {
				os.Exit(16)
			}
			fmt.Fprintln(os.Stderr, "deliberate executor failure")
			os.Exit(7)
		}
		if !strings.Contains(string(feedback), "deliberate executor failure") {
			os.Exit(17)
		}
		_ = os.WriteFile("generated.txt", []byte("fixed"), 0600)
	case "check":
		if _, e := os.ReadFile("generated.txt"); e != nil {
			os.Exit(11)
		}
	case "fail":
		fmt.Fprintln(os.Stderr, "deliberate check failure")
		os.Exit(12)
	case "mutating-check":
		_ = os.WriteFile("generated.txt", []byte("changed after check"), 0600)
	case "waiting":
		_ = os.WriteFile(os.Getenv("ORI_REPORT"), []byte(`{"status":"needs_input","summary":"Unspecified behavior","questions":["Which currency?"]}`), 0600)
	case "graph":
		_ = os.MkdirAll("graph/components", 0755)
		_ = os.WriteFile("graph/components/illegal.json", []byte(`{}`), 0600)
	case "timeout":
		time.Sleep(20 * time.Second)
	case "large-log":
		_, _ = fmt.Fprint(os.Stdout, strings.Repeat("x", 3*1024*1024))
	default:
		os.Exit(13)
	}
	os.Exit(0)
}
func forgeArgv(mode string) []string {
	return []string{os.Args[0], "-test.run=^TestForgeHelperProcess$", "--", mode}
}
func forgeGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	s, e := Git(root, args...)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func forgeRepository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	forgeGit(t, root, "init", "-b", "main")
	forgeGit(t, root, "config", "user.name", "Test")
	forgeGit(t, root, "config", "user.email", "test@example.invalid")
	if e := os.WriteFile(filepath.Join(root, "README.md"), []byte("baseline\n"), 0600); e != nil {
		t.Fatal(e)
	}
	forgeGit(t, root, "add", ".")
	forgeGit(t, root, "commit", "-m", "baseline")
	return root
}
func forgeWorkspace(t *testing.T) (*Workspace, Projection) {
	t.Helper()
	root := forgeRepository(t)
	w, e := Init(root)
	if e != nil {
		t.Fatal(e)
	}
	if e = AtomicWrite(filepath.Join(root, "graph/entities/product.json"), JSON(Entity{ID: "product", Name: "Product"})); e != nil {
		t.Fatal(e)
	}
	forgeGit(t, root, "add", ".")
	forgeGit(t, root, "commit", "-m", "graph")
	s, e := w.Snapshot("")
	if e != nil {
		t.Fatal(e)
	}
	p, e := Project(s, "all")
	if e != nil {
		t.Fatal(e)
	}
	w.Config.Executor.Command = forgeArgv("generate")
	w.Config.Executor.Checks = [][]string{forgeArgv("check")}
	w.Config.Executor.MaxAttempts = 2
	w.Config.Executor.TimeoutSeconds = 10
	return w, p
}
func TestForgeBuildPortableAndDirtyMain(t *testing.T) {
	w, p := forgeWorkspace(t)
	source := forgeRepository(t)
	before := forgeGit(t, source, "rev-parse", "HEAD")
	if e := os.WriteFile(filepath.Join(source, "README.md"), []byte("uncommitted user work"), 0600); e != nil {
		t.Fatal(e)
	}
	r, e := w.Build(context.Background(), BuildRequest{Projection: p, SourceRoot: source})
	if e != nil {
		t.Fatal(e)
	}
	if r.Status != "verified" || r.BaseCommit != before || r.SourceCommit == "" {
		t.Fatalf("unexpected receipt: %+v", r)
	}
	if forgeGit(t, source, "rev-parse", "HEAD") != before || forgeGit(t, source, "branch", "--show-current") != "main" {
		t.Fatal("changed caller HEAD")
	}
	b, _ := os.ReadFile(filepath.Join(source, "README.md"))
	if string(b) != "uncommitted user work" {
		t.Fatal("changed dirty caller file")
	}
	if _, e = os.Stat(filepath.Join(source, "generated.txt")); !os.IsNotExist(e) {
		t.Fatal("generated into caller checkout")
	}
	if forgeGit(t, r.Worktree, "status", "--porcelain") != "" {
		t.Fatal("captured worktree is not clean")
	}
	if forgeGit(t, source, "show", r.SourceCommit+":generated.txt") != p.Digest {
		t.Fatal("missing generated content")
	}
	stored, e := w.GetRun(r.ID)
	if e != nil || stored.Status != "verified" {
		t.Fatalf("missing persisted result: %+v %v", stored, e)
	}
	if !RunEvidence(r, p, r.SourceCommit).Current {
		t.Fatal("matching receipt not current")
	}
	if RunEvidence(r, p, before).Current {
		t.Fatal("wrong source treated as current")
	}
	if e = AtomicWrite(filepath.Join(w.Root, "graph/entities/product.json"), JSON(Entity{ID: "product", Name: "Changed intent"})); e != nil {
		t.Fatal(e)
	}
	s, _ := w.Snapshot("")
	next, _ := Project(s, "all")
	if RunEvidence(r, next, r.SourceCommit).Current {
		t.Fatal("old successful run satisfied new intent")
	}
}
func TestForgeGeneratedIsNotVerified(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Checks = nil
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e != nil {
		t.Fatal(e)
	}
	if r.Status != "generated" || RunEvidence(r, p, r.SourceCommit).Current {
		t.Fatal("unchecked generation reported verification")
	}
}

func TestForgeAccumulatesIndependentGraphAndSourceBaselines(t *testing.T) {
	w, previous := forgeWorkspace(t)
	source := forgeRepository(t)
	first, e := w.Build(context.Background(), BuildRequest{Projection: previous, SourceRoot: source})
	if e != nil {
		t.Fatal(e)
	}
	// Two graph edits can be accumulated without generating sources in between.
	for _, name := range []string{"Intermediate requirement", "Latest requirement"} {
		if e = AtomicWrite(filepath.Join(w.Root, "graph/entities/product.json"), JSON(Entity{ID: "product", Name: name})); e != nil {
			t.Fatal(e)
		}
		forgeGit(t, w.Root, "add", "graph")
		forgeGit(t, w.Root, "commit", "-m", name)
	}
	s, e := w.Snapshot("")
	if e != nil {
		t.Fatal(e)
	}
	next, e := Project(s, "all")
	if e != nil {
		t.Fatal(e)
	}
	r, e := w.Build(context.Background(), BuildRequest{Projection: next, SourceRoot: source, BaseRef: first.SourceCommit, Previous: &previous})
	if e != nil {
		t.Fatal(e)
	}
	if r.BaseCommit != first.SourceCommit || r.PreviousDigest != previous.Digest || len(r.Difference.Changed) != 1 || r.Difference.Changed[0] != "product" {
		t.Fatalf("lost explicit baselines: %+v", r)
	}
	if forgeGit(t, source, "show", r.SourceCommit+":generated.txt") != next.Digest {
		t.Fatal("wrong graph snapshot generated")
	}
}
func TestForgeRetriesAndRetainsEvidence(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Command = forgeArgv("retry")
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e != nil {
		t.Fatal(e)
	}
	if r.Status != "verified" || len(r.Attempts) != 2 || r.Attempts[0].Executor.ExitCode != 7 || len(r.Attempts[1].Checks) != 1 {
		t.Fatalf("missing retry evidence: %+v", r)
	}
	if !strings.Contains(readLogTail(r.Attempts[0].Executor.LogPath), "deliberate executor failure") {
		t.Fatal("failure log not retained")
	}
}
func TestForgeFailedChecksDoNotVerify(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Checks = [][]string{forgeArgv("fail")}
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e == nil || r.Status != "failed" || r.SourceCommit != "" || len(r.Attempts) != 2 {
		t.Fatalf("failed checks receipt: %+v %v", r, e)
	}
	if _, e = os.Stat(filepath.Join(r.Worktree, "generated.txt")); e != nil {
		t.Fatal("failed work retained for review", e)
	}
}
func TestForgeRejectsCheckMutations(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Checks = [][]string{forgeArgv("mutating-check")}
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e == nil || r.Status != "failed" || !strings.Contains(e.Error(), "checks changed source files") {
		t.Fatalf("unchecked tree verified: %+v %v", r, e)
	}
}
func TestForgeHumanQuestion(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Command = forgeArgv("waiting")
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e != nil || r.Status != "waiting" || len(r.Questions) != 1 || r.SourceCommit != "" {
		t.Fatalf("missing human question: %+v %v", r, e)
	}
}
func TestForgeProtectsGraph(t *testing.T) {
	w, p := forgeWorkspace(t)
	w.Config.Executor.Command = forgeArgv("graph")
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e == nil || r.Status != "failed" || !strings.Contains(e.Error(), "protected graph") {
		t.Fatalf("graph mutation accepted: %+v %v", r, e)
	}
}
func TestForgeRejectsCorruptProjectionBeforeSideEffects(t *testing.T) {
	w, p := forgeWorkspace(t)
	p.GraphRevision = "tampered"
	r, e := w.Build(context.Background(), BuildRequest{Projection: p})
	if e == nil || r.ID != "" {
		t.Fatal("corrupt projection started a run")
	}
}
func TestForgeTimeoutAndLogBound(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		r := runCommand(context.Background(), t.TempDir(), forgeArgv("timeout"), "", []string{"ORI_RUN_ID=test"}, filepath.Join(t.TempDir(), "log"), 100*time.Millisecond)
		if !strings.Contains(r.Error, "deadline exceeded") {
			t.Fatalf("timeout not enforced: %+v", r)
		}
	})
	t.Run("bounded", func(t *testing.T) {
		r := runCommand(context.Background(), t.TempDir(), forgeArgv("large-log"), "", []string{"ORI_RUN_ID=test"}, filepath.Join(t.TempDir(), "log"), 10*time.Second)
		if r.Error != "" || !r.LogTruncated {
			t.Fatalf("log not bounded: %+v", r)
		}
		st, _ := os.Stat(r.LogPath)
		if st.Size() != 2*1024*1024 {
			t.Fatal(st.Size())
		}
	})
}

func TestForgePromptContainsOnlySelectedProjection(t *testing.T) {
	files := map[string]string{
		"entities/selected.json":      string(JSON(Entity{ID: "selected", Name: "Selected entity"})),
		"entities/unrelated.json":     string(JSON(Entity{ID: "unrelated", Name: "UNRELATED_RAW_GRAPH_MARKER"})),
		"components/requirement.json": string(JSON(Component{ID: "requirement", EntityID: "selected", Type: "behavior", Body: "components/requirement.md"})),
		"components/requirement.md":   "SELECTED_MARKDOWN_REQUIREMENT",
		"projections/limited.json":    string(JSON(ProjectionSpec{ID: "limited", Name: "Limited", Entities: []string{"selected"}, Depth: 0})),
	}
	s, e := ParseSnapshot(files)
	if e != nil {
		t.Fatal(e)
	}
	p, e := Project(s, "limited")
	if e != nil {
		t.Fatal(e)
	}
	request := BuildRequest{Projection: p, Previous: &p, SourceRoot: "/source", BaseRef: "base-commit", Intent: "Build the selected behavior"}
	prompt := buildPrompt(request, DiffProjection(&p, p), "retry-feedback")
	for _, forbidden := range []string{"UNRELATED_RAW_GRAPH_MARKER", `"sourceFiles"`, "entities/unrelated.json"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("prompt leaked excluded graph context: %s", forbidden)
		}
	}
	for _, required := range []string{"SELECTED_MARKDOWN_REQUIREMENT", p.Digest, p.GraphRevision, "base-commit", "Build the selected behavior", "retry-feedback", `"previous"`, `"difference"`} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("prompt lost required context: %s", required)
		}
	}
	if !strings.Contains(string(JSON(request)), "UNRELATED_RAW_GRAPH_MARKER") {
		t.Fatal("full portable artifact was changed")
	}
}
