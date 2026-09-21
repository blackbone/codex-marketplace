package ori

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newChangesWorkspace(t *testing.T) *Workspace {
	t.Helper()
	root := t.TempDir()
	if _, err := Git(root, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"entities/product.json":  string(JSON(Entity{ID: "product", Name: "Product"})),
		"components/limits.json": string(JSON(Component{ID: "limits", EntityID: "product", Type: "limits", Data: map[string]any{"max": 10}, Constraint: true})),
		"types/limits.json":      `{"type":"object","properties":{"max":{"type":"integer","minimum":1}},"required":["max"],"additionalProperties":false}`,
	}
	for p, b := range files {
		if err = AtomicWrite(filepath.Join(root, w.Config.Graph, p), []byte(b)); err != nil {
			t.Fatal(err)
		}
	}
	return w
}
func proposeRename(t *testing.T, w *Workspace) Change {
	t.Helper()
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	c, err := w.ProposeChange(context.Background(), ChangeRequest{Intent: "Rename product without changing its limits", BaseRevision: s.Revision, Operations: []Operation{{Path: "entities/product.json", Content: string(JSON(Entity{ID: "product", Name: "Ori"}))}}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func approveChange(t *testing.T, w *Workspace, c Change) Change {
	t.Helper()
	out, err := w.ReviewChange(context.Background(), c.ID, ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: c.ProposalDigest, Reviewer: "test-reviewer", Summary: "Reviewed entity rename against constraints: identity and limits remain intact.", Approved: true, Questions: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestChangesRequireExactSemanticReview(t *testing.T) {
	w := newChangesWorkspace(t)
	c := proposeRename(t, w)
	if c.Status != "draft" || c.Review != nil || !contains(c.Impact.IDs, "limits") {
		t.Fatalf("unexpected proposal: %+v", c)
	}
	if _, err := w.ApplyChange(context.Background(), c.ID); err == nil {
		t.Fatal("unreviewed apply succeeded")
	}
	if _, err := w.ReviewChange(context.Background(), c.ID, ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: "other", Reviewer: "r", Summary: "s", Approved: true}); err == nil {
		t.Fatal("review of another proposal succeeded")
	}
	if _, err := w.ReviewChange(context.Background(), c.ID, ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: c.ProposalDigest, Approved: true}); err == nil {
		t.Fatal("empty semantic evidence succeeded")
	}
	waiting, err := w.ReviewChange(context.Background(), c.ID, ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: c.ProposalDigest, Reviewer: "r", Summary: "Name is ambiguous", Approved: true, Questions: []string{"Is Ori the intended public name?"}})
	if err != nil || waiting.Status != "waiting" {
		t.Fatalf("waiting review: %+v, %v", waiting, err)
	}
	if _, err = w.ApplyChange(context.Background(), c.ID); err == nil {
		t.Fatal("unanswered question did not block apply")
	}
	approveChange(t, w, c)
	applied, err := w.ApplyChange(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Status != "applied" {
		t.Fatalf("status %s", applied.Status)
	}
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	if s.Revision != c.ResultRevision || s.Entities[0].Name != "Ori" {
		t.Fatalf("wrong applied graph: %+v", s)
	}
	if _, err = w.ApplyChange(context.Background(), c.ID); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if _, err = Git(w.Root, "rev-parse", "HEAD"); err == nil {
		t.Fatal("apply created a Git commit")
	}
}

func TestChangesRejectStaleGraphAndBrokenSchema(t *testing.T) {
	w := newChangesWorkspace(t)
	c := approveChange(t, w, proposeRename(t, w))
	path := filepath.Join(w.Root, w.Config.Graph, "components/limits.json")
	external := JSON(Component{ID: "limits", EntityID: "product", Type: "limits", Data: map[string]any{"max": 20}, Constraint: true})
	if err := AtomicWrite(path, external); err != nil {
		t.Fatal(err)
	}
	if _, err := w.ApplyChange(context.Background(), c.ID); err == nil {
		t.Fatal("stale proposal applied")
	}
	var stored Change
	if err := w.Record("changes", c.ID, &stored); err != nil || stored.Status != "conflict" {
		t.Fatalf("conflict not persisted: %+v %v", stored, err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != string(external) {
		t.Fatal("external edit changed")
	}
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.ProposeChange(context.Background(), ChangeRequest{Intent: "Invalid limit", BaseRevision: s.Revision, Operations: []Operation{{Path: "components/limits.json", Content: string(JSON(Component{ID: "limits", EntityID: "product", Type: "limits", Data: map[string]any{"max": -1}}))}}})
	if err == nil || !strings.Contains(err.Error(), "proposed graph is invalid") {
		t.Fatalf("schema violation accepted: %v", err)
	}
	_, err = w.ProposeChange(context.Background(), ChangeRequest{Intent: "Delete owner", BaseRevision: s.Revision, Operations: []Operation{{Path: "entities/product.json", Delete: true}}})
	if err == nil {
		t.Fatal("dangling component accepted")
	}
}

func TestChangesRejectEscapesAndNoOps(t *testing.T) {
	w := newChangesWorkspace(t)
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"../config.json", "entities/../../p.json", "entities/./p.json", "/tmp/p.json", "entities/.hidden/p.json", "entities/evil.txt", "entities\\p.json"} {
		_, err = w.ProposeChange(context.Background(), ChangeRequest{Intent: "Bad path", BaseRevision: s.Revision, Operations: []Operation{{Path: p, Content: "{}"}}})
		if err == nil {
			t.Errorf("accepted %s", p)
		}
	}
	for _, operations := range [][]Operation{
		{{Path: "entities/product.json", Content: s.Files["entities/product.json"]}},
		{{Path: "entities/missing.json", Delete: true}},
		{{Path: "entities/product.json", Delete: true, Content: "bad"}},
		{{Path: "entities/product.json", Delete: true}, {Path: "entities/product.json", Delete: true}},
	} {
		if _, err = w.ProposeChange(context.Background(), ChangeRequest{Intent: "Invalid operations", BaseRevision: s.Revision, Operations: operations}); err == nil {
			t.Errorf("accepted operations %+v", operations)
		}
	}
	outside := t.TempDir()
	if err = os.Symlink(outside, filepath.Join(w.Root, w.Config.Graph, "entities", "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err = w.ProposeChange(context.Background(), ChangeRequest{Intent: "Symlink", BaseRevision: s.Revision, Operations: []Operation{{Path: "entities/linked/p.json", Content: string(JSON(Entity{ID: "other", Name: "Other"}))}}}); err == nil {
		t.Fatal("accepted symlink")
	}
}

func TestChangesRecoveryCompletesPartialBatch(t *testing.T) {
	w := newChangesWorkspace(t)
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	operations := []Operation{
		{Path: "entities/product.json", Content: string(JSON(Entity{ID: "product", Name: "Ori"}))},
		{Path: "entities/new.json", Content: string(JSON(Entity{ID: "new", Name: "New entity"}))},
	}
	c, err := w.ProposeChange(context.Background(), ChangeRequest{Intent: "Rename and add", BaseRevision: s.Revision, Operations: operations})
	if err != nil {
		t.Fatal(err)
	}
	c = approveChange(t, w, c)
	after, err := applyOperations(s.Files, c.Operations)
	if err != nil {
		t.Fatal(err)
	}
	journal := changeJournal{Version: 1, Change: c, Before: s.Files, After: after}
	journalFile := filepath.Join(w.Root, changeJournalPath)
	if err = durableChangeWrite(journalFile, JSON(journal)); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after one file is replaced, before the other is written.
	if err = AtomicWrite(filepath.Join(w.Root, w.Config.Graph, operations[0].Path), []byte(operations[0].Content)); err != nil {
		t.Fatal(err)
	}
	if err = w.RecoverChanges(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != c.ResultRevision {
		t.Fatal("partial batch not completed")
	}
	if _, err = os.Stat(journalFile); !os.IsNotExist(err) {
		t.Fatalf("journal retained: %v", err)
	}
	var stored Change
	if err = w.Record("changes", c.ID, &stored); err != nil || stored.Status != "applied" {
		t.Fatalf("not applied: %+v %v", stored, err)
	}
	if err = w.RecoverChanges(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestChangesRecoveryPreservesExternalEdits(t *testing.T) {
	for _, mode := range []string{"modified", "created", "deleted"} {
		t.Run(mode, func(t *testing.T) {
			w := newChangesWorkspace(t)
			c := approveChange(t, w, proposeRename(t, w))
			s, err := w.Snapshot("working")
			if err != nil {
				t.Fatal(err)
			}
			after, err := applyOperations(s.Files, c.Operations)
			if err != nil {
				t.Fatal(err)
			}
			journalFile := filepath.Join(w.Root, changeJournalPath)
			if err = durableChangeWrite(journalFile, JSON(changeJournal{Version: 1, Change: c, Before: s.Files, After: after})); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(w.Root, w.Config.Graph, "entities/product.json")
			switch mode {
			case "modified":
				err = AtomicWrite(file, []byte(`{"id":"product","name":"External"}`))
			case "created":
				file = filepath.Join(w.Root, w.Config.Graph, "entities/external.json")
				err = AtomicWrite(file, []byte(`{"id":"external","name":"External"}`))
			case "deleted":
				err = os.Remove(file)
			}
			if err != nil {
				t.Fatal(err)
			}
			beforeRecovery, beforeErr := os.ReadFile(file)
			if err = w.RecoverChanges(context.Background()); err == nil || !strings.Contains(err.Error(), "external edit") {
				t.Fatalf("recovery did not block: %v", err)
			}
			afterRecovery, afterErr := os.ReadFile(file)
			if string(beforeRecovery) != string(afterRecovery) || os.IsNotExist(beforeErr) != os.IsNotExist(afterErr) {
				t.Fatal("external change overwritten")
			}
			if _, err = os.Stat(journalFile); err != nil {
				t.Fatal("recovery journal removed")
			}
		})
	}
}

func TestChangesGraphLockHonorsCancellation(t *testing.T) {
	w := newChangesWorkspace(t)
	lock, err := w.AcquireGraphLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err = w.AcquireGraphLock(ctx); err == nil {
		t.Fatal("second writer acquired occupied lock")
	}
}

func TestChangesPreserveOriginalContentsAfterApply(t *testing.T) {
	w := newChangesWorkspace(t)
	if err := AtomicWrite(filepath.Join(w.Root, w.Config.Graph, "components/empty.md"), []byte{}); err != nil {
		t.Fatal(err)
	}
	s, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	c, err := w.ProposeChange(context.Background(), ChangeRequest{
		Intent: "Rename product, add an entity and remove an empty note", BaseRevision: s.Revision,
		Operations: []Operation{
			{Path: "entities/product.json", Content: string(JSON(Entity{ID: "product", Name: "Ori"}))},
			{Path: "entities/added.json", Content: string(JSON(Entity{ID: "added", Name: "Added"}))},
			{Path: "components/empty.md", Delete: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Before) != 2 || c.Before["entities/product.json"] != s.Files["entities/product.json"] {
		t.Fatalf("draft lost originals: %+v", c.Before)
	}
	if content, exists := c.Before["components/empty.md"]; !exists || content != "" {
		t.Fatal("empty original must be present in before map")
	}
	if _, exists := c.Before["entities/added.json"]; exists {
		t.Fatal("new file must be absent from before map")
	}
	originalDigest := Digest(c.Before)
	approveChange(t, w, c)
	applied, err := w.ApplyChange(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if Digest(applied.Before) != originalDigest {
		t.Fatal("applied receipt changed original contents")
	}
	// Later edits do not change the saved historical diff, even without a commit.
	if err = AtomicWrite(filepath.Join(w.Root, w.Config.Graph, "entities/product.json"), JSON(Entity{ID: "product", Name: "Later"})); err != nil {
		t.Fatal(err)
	}
	var stored Change
	if err = w.Record("changes", c.ID, &stored); err != nil {
		t.Fatal(err)
	}
	if Digest(stored.Before) != originalDigest || stored.ProposalDigest != c.ProposalDigest {
		t.Fatal("persisted receipt lost immutable review input")
	}
}

func TestChangesRejectOriginalContentsTampering(t *testing.T) {
	for _, stage := range []string{"review", "apply", "applied", "recovery", "rebound"} {
		t.Run(stage, func(t *testing.T) {
			w := newChangesWorkspace(t)
			c := proposeRename(t, w)
			if stage != "review" && stage != "rebound" {
				c = approveChange(t, w, c)
			}
			if stage == "applied" {
				var err error
				c, err = w.ApplyChange(context.Background(), c.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			c.Before["entities/product.json"] = `{"id":"product","name":"Forged original"}`
			if stage == "rebound" {
				c.ProposalDigest = changeDigest(c)
			}
			if stage == "recovery" {
				s, err := w.Snapshot("working")
				if err != nil {
					t.Fatal(err)
				}
				after, err := applyOperations(s.Files, c.Operations)
				if err != nil {
					t.Fatal(err)
				}
				if err = durableChangeWrite(filepath.Join(w.Root, changeJournalPath), JSON(changeJournal{Version: 1, Change: c, Before: s.Files, After: after})); err != nil {
					t.Fatal(err)
				}
				if err = w.RecoverChanges(context.Background()); err == nil {
					t.Fatal("recovery accepted altered original contents")
				}
				return
			}
			if err := w.SaveRecord("changes", c.ID, c); err != nil {
				t.Fatal(err)
			}
			if stage == "review" || stage == "rebound" {
				_, err := w.ReviewChange(context.Background(), c.ID, ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: c.ProposalDigest, Reviewer: "r", Summary: "s", Approved: true})
				if err == nil {
					t.Fatal("review accepted altered original contents")
				}
			} else if _, err := w.ApplyChange(context.Background(), c.ID); err == nil {
				t.Fatal("apply accepted altered original contents")
			}
		})
	}
}
