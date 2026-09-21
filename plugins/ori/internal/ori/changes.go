package ori

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

// Operation paths are relative to the graph directory, never the repository.
type Operation struct {
	Path    string `json:"path"`
	Content string `json:"content,omitempty"`
	Delete  bool   `json:"delete,omitempty"`
}
type ChangeRequest struct {
	Intent       string      `json:"intent"`
	BaseRevision string      `json:"baseRevision"`
	Operations   []Operation `json:"operations"`
}

// ReviewRequest is an attestation supplied by the reviewing agent or person.
// Structural validation does not manufacture semantic approval.
type ReviewRequest struct {
	BaseRevision   string   `json:"baseRevision"`
	ProposalDigest string   `json:"proposalDigest"`
	Reviewer       string   `json:"reviewer"`
	Summary        string   `json:"summary"`
	Approved       bool     `json:"approved"`
	Questions      []string `json:"questions"`
}
type ReviewReceipt struct {
	ReviewRequest
	ReviewedAt string `json:"reviewedAt"`
}
type Change struct {
	ID             string      `json:"id"`
	Status         string      `json:"status"`
	Intent         string      `json:"intent"`
	BaseRevision   string      `json:"baseRevision"`
	ProposalDigest string      `json:"proposalDigest"`
	ResultRevision string      `json:"resultRevision"`
	Operations     []Operation `json:"operations"`
	// Before retains original contents only for affected existing files. A
	// missing key means the operation creates a file; an empty value is a file.
	Before    map[string]string `json:"before"`
	Impact    Impact            `json:"impact"`
	Review    *ReviewReceipt    `json:"review,omitempty"`
	CreatedAt string            `json:"createdAt"`
	UpdatedAt string            `json:"updatedAt"`
}

const changeJournalPath = ".ori/state/change-journal.json"

// AcquireGraphLock coordinates Ori writers across processes. External editors
// do not take this lock; their changes are checked again before each write.
func (w *Workspace) AcquireGraphLock(ctx context.Context) (*flock.Flock, error) {
	p, err := SafePath(w.Root, ".ori/state/graph.lock")
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return nil, err
	}
	lock := flock.New(p)
	ok, err := lock.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("graph lock was canceled")
	}
	return lock, nil
}

func changeNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func changeDigest(c Change) string {
	return Digest(struct {
		ChangeRequest
		Before map[string]string `json:"before"`
	}{ChangeRequest: ChangeRequest{Intent: c.Intent, BaseRevision: c.BaseRevision, Operations: c.Operations}, Before: c.Before})
}

func changeBefore(files map[string]string, operations []Operation) map[string]string {
	before := map[string]string{}
	for _, op := range operations {
		if content, exists := files[op.Path]; exists {
			before[op.Path] = content
		}
	}
	return before
}

func validateChangeBefore(c Change, files map[string]string) error {
	if Digest(c.Before) != Digest(changeBefore(files, c.Operations)) {
		return errors.New("proposal original contents do not match its base snapshot")
	}
	return nil
}
func cloneFiles(files map[string]string) map[string]string {
	result := make(map[string]string, len(files))
	for p, content := range files {
		result[p] = content
	}
	return result
}
func validateOperationPath(p string) error {
	if path.Clean(p) != p || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) || path.IsAbs(p) {
		return fmt.Errorf("invalid graph operation path %q", p)
	}
	parts := strings.Split(p, "/")
	if len(parts) < 2 {
		return fmt.Errorf("operation must be inside a graph directory: %s", p)
	}
	for _, part := range parts {
		if part == "" || strings.HasPrefix(part, ".") {
			return fmt.Errorf("hidden or escaping operation path: %s", p)
		}
	}
	switch parts[0] {
	case "entities", "components", "relations", "types", "projections":
	default:
		return fmt.Errorf("unknown graph directory: %s", p)
	}
	if !graphFile(p) {
		return errors.New("graph operations support only .json and .md files")
	}
	return nil
}
func applyOperations(files map[string]string, operations []Operation) (map[string]string, error) {
	if len(operations) == 0 || len(operations) > 1000 {
		return nil, errors.New("change requires 1–1000 operations")
	}
	after := cloneFiles(files)
	seen := map[string]bool{}
	for _, op := range operations {
		if err := validateOperationPath(op.Path); err != nil {
			return nil, err
		}
		if seen[op.Path] {
			return nil, fmt.Errorf("duplicate operation path %s", op.Path)
		}
		seen[op.Path] = true
		if len(op.Content) > 4<<20 {
			return nil, errors.New("graph file exceeds 4 MiB")
		}
		old, exists := files[op.Path]
		if op.Delete {
			if op.Content != "" {
				return nil, errors.New("delete operation cannot contain content")
			}
			if !exists {
				return nil, fmt.Errorf("cannot delete missing graph file %s", op.Path)
			}
			delete(after, op.Path)
		} else {
			if exists && old == op.Content {
				return nil, fmt.Errorf("operation does not change %s", op.Path)
			}
			after[op.Path] = op.Content
		}
	}
	return after, nil
}
func changeImpact(before, after Snapshot, operations []Operation) Impact {
	seeds := map[string]bool{}
	for _, op := range operations {
		for _, snapshot := range []Snapshot{before, after} {
			var v struct {
				ID   string `json:"id"`
				From string `json:"from"`
				To   string `json:"to"`
			}
			if json.Unmarshal([]byte(snapshot.Files[op.Path]), &v) == nil {
				for _, id := range []string{v.ID, v.From, v.To} {
					if id != "" {
						seeds[id] = true
					}
				}
			}
			for _, c := range snapshot.Components {
				if c.Body == op.Path || (strings.HasPrefix(op.Path, "types/") && c.Type == strings.TrimSuffix(path.Base(op.Path), ".json")) {
					seeds[c.ID] = true
				}
			}
		}
	}
	ids := make([]string, 0, len(seeds))
	for id := range seeds {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := Impact{IDs: []string{}, Reasons: map[string][]string{}}
	found := map[string]bool{}
	for _, snapshot := range []Snapshot{before, after} {
		part := FindImpact(snapshot, ids, 10000)
		out.Truncated = out.Truncated || part.Truncated
		for _, id := range part.IDs {
			if !found[id] {
				out.IDs = append(out.IDs, id)
				found[id] = true
			}
		}
		for id, reasons := range part.Reasons {
			for _, reason := range reasons {
				if !contains(out.Reasons[id], reason) {
					out.Reasons[id] = append(out.Reasons[id], reason)
				}
			}
		}
	}
	sort.Strings(out.IDs)
	return out
}

func (w *Workspace) ProposeChange(ctx context.Context, req ChangeRequest) (Change, error) {
	var result Change
	if strings.TrimSpace(req.Intent) == "" || len(req.Intent) > 100000 {
		return result, errors.New("intent requires 1–100000 bytes")
	}
	lock, err := w.AcquireGraphLock(ctx)
	if err != nil {
		return result, err
	}
	defer lock.Unlock()
	if err = w.recoverChangesLocked(); err != nil {
		return result, err
	}
	before, err := w.snapshotUnlocked("working")
	if err != nil {
		return result, err
	}
	if req.BaseRevision == "" || req.BaseRevision != before.Revision {
		return result, errors.New("base revision is stale; read the current graph and propose again")
	}
	operations := append([]Operation(nil), req.Operations...)
	sort.Slice(operations, func(i, j int) bool { return operations[i].Path < operations[j].Path })
	files, err := applyOperations(before.Files, operations)
	if err != nil {
		return result, err
	}
	graphRoot, err := SafePath(w.Root, w.Config.Graph)
	if err != nil {
		return result, err
	}
	for _, op := range operations {
		if _, err = SafePath(graphRoot, op.Path); err != nil {
			return result, err
		}
	}
	after, err := ParseSnapshot(files)
	if err != nil {
		return result, fmt.Errorf("proposed graph is invalid: %w", err)
	}
	var random [12]byte
	if _, err = rand.Read(random[:]); err != nil {
		return result, err
	}
	result = Change{ID: "change-" + hex.EncodeToString(random[:]), Status: "draft", Intent: req.Intent, BaseRevision: req.BaseRevision, ResultRevision: after.Revision, Operations: operations, Before: changeBefore(before.Files, operations), Impact: changeImpact(before, after, operations), CreatedAt: changeNow()}
	result.UpdatedAt = result.CreatedAt
	result.ProposalDigest = changeDigest(result)
	return result, w.SaveRecord("changes", result.ID, result)
}

func (w *Workspace) ReviewChange(ctx context.Context, id string, req ReviewRequest) (Change, error) {
	var result Change
	lock, err := w.AcquireGraphLock(ctx)
	if err != nil {
		return result, err
	}
	defer lock.Unlock()
	if err = w.recoverChangesLocked(); err != nil {
		return result, err
	}
	if err = w.Record("changes", id, &result); err != nil {
		return result, err
	}
	if result.Status == "applied" || result.Status == "conflict" {
		return result, fmt.Errorf("cannot review %s change", result.Status)
	}
	if result.ProposalDigest != changeDigest(result) || req.ProposalDigest != result.ProposalDigest || req.BaseRevision != result.BaseRevision {
		return result, errors.New("review does not match the immutable proposal and base revision")
	}
	if strings.TrimSpace(req.Reviewer) == "" || strings.TrimSpace(req.Summary) == "" {
		return result, errors.New("review requires reviewer identity and semantic review summary")
	}
	current, err := w.snapshotUnlocked("working")
	if err != nil {
		return result, err
	}
	if current.Revision != result.BaseRevision {
		err = w.markChangeConflict(&result)
		return result, err
	}
	if err = validateChangeBefore(result, current.Files); err != nil {
		return result, err
	}
	result.Review = &ReviewReceipt{ReviewRequest: req, ReviewedAt: changeNow()}
	result.Status = "reviewed"
	if !req.Approved {
		result.Status = "rejected"
	} else if len(req.Questions) != 0 {
		result.Status = "waiting"
	}
	result.UpdatedAt = changeNow()
	return result, w.SaveRecord("changes", result.ID, result)
}
func (w *Workspace) markChangeConflict(c *Change) error {
	c.Status = "conflict"
	c.UpdatedAt = changeNow()
	if err := w.SaveRecord("changes", c.ID, c); err != nil {
		return err
	}
	return errors.New("graph changed since proposal; create and review a new proposal")
}

type changeJournal struct {
	Version int               `json:"version"`
	Change  Change            `json:"change"`
	Before  map[string]string `json:"before"`
	After   map[string]string `json:"after"`
}

func (w *Workspace) ApplyChange(ctx context.Context, id string) (Change, error) {
	var result Change
	lock, err := w.AcquireGraphLock(ctx)
	if err != nil {
		return result, err
	}
	defer lock.Unlock()
	if err = w.recoverChangesLocked(); err != nil {
		return result, err
	}
	if err = w.Record("changes", id, &result); err != nil {
		return result, err
	}
	if result.ProposalDigest != changeDigest(result) {
		return result, errors.New("proposal digest mismatch")
	}
	if result.Status == "applied" {
		return result, nil
	}
	if result.Status != "reviewed" || result.Review == nil || !result.Review.Approved || len(result.Review.Questions) != 0 {
		return result, errors.New("change requires approval with no unresolved questions")
	}
	if result.ProposalDigest != changeDigest(result) || result.Review.ProposalDigest != result.ProposalDigest || result.Review.BaseRevision != result.BaseRevision {
		return result, errors.New("proposal or review digest mismatch")
	}
	before, err := w.snapshotUnlocked("working")
	if err != nil {
		return result, err
	}
	if before.Revision != result.BaseRevision {
		err = w.markChangeConflict(&result)
		return result, err
	}
	if err = validateChangeBefore(result, before.Files); err != nil {
		return result, err
	}
	afterFiles, err := applyOperations(before.Files, result.Operations)
	if err != nil {
		return result, err
	}
	after, err := ParseSnapshot(afterFiles)
	if err != nil {
		return result, err
	}
	if after.Revision != result.ResultRevision {
		return result, errors.New("proposal result revision mismatch")
	}
	journal := changeJournal{Version: 1, Change: result, Before: before.Files, After: afterFiles}
	p, err := SafePath(w.Root, changeJournalPath)
	if err != nil {
		return result, err
	}
	if err = durableChangeWrite(p, JSON(journal)); err != nil {
		return result, err
	}
	if err = w.recoverChangesLocked(); err != nil {
		return result, err
	}
	err = w.Record("changes", id, &result)
	return result, err
}

// RecoverChanges completes an interrupted apply only while every graph file is
// still either its recorded before or after value. Unexpected edits are kept.
func (w *Workspace) RecoverChanges(ctx context.Context) error {
	lock, err := w.AcquireGraphLock(ctx)
	if err != nil {
		return err
	}
	defer lock.Unlock()
	return w.recoverChangesLocked()
}

func (w *Workspace) rawChangeFiles() (map[string]string, error) {
	base, err := SafePath(w.Root, w.Config.Graph)
	if err != nil {
		return nil, err
	}
	files := map[string]string{}
	err = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("graph contains symlink: %s", p)
		}
		if d.IsDir() {
			if p != base && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(base, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !graphFile(rel) {
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() || st.Size() > 4<<20 {
			return fmt.Errorf("unsupported graph file: %s", rel)
		}
		b, err := os.ReadFile(p)
		if err == nil {
			files[rel] = string(b)
		}
		return err
	})
	return files, err
}
func sameFile(a map[string]string, b map[string]string, p string) bool {
	av, ae := a[p]
	bv, be := b[p]
	return ae == be && av == bv
}
func syncChangeDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func durableChangeWrite(p string, content []byte) error {
	if err := AtomicWrite(p, content); err != nil {
		return err
	}
	return syncChangeDir(filepath.Dir(p))
}
func (w *Workspace) recoverChangesLocked() error {
	p, err := SafePath(w.Root, changeJournalPath)
	if err != nil {
		return err
	}
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal changeJournal
	if err = Decode(b, &journal); err != nil {
		return fmt.Errorf("invalid change recovery journal: %w", err)
	}
	c := &journal.Change
	if journal.Version != 1 || Digest(journal.Before) != c.BaseRevision || Digest(journal.After) != c.ResultRevision || changeDigest(*c) != c.ProposalDigest || c.Review == nil || !c.Review.Approved || len(c.Review.Questions) != 0 || c.Review.ProposalDigest != c.ProposalDigest || c.Review.BaseRevision != c.BaseRevision {
		return errors.New("change recovery journal integrity failed")
	}
	if err = validateChangeBefore(*c, journal.Before); err != nil {
		return err
	}
	expected, err := applyOperations(journal.Before, c.Operations)
	if err != nil || Digest(expected) != c.ResultRevision {
		return errors.New("change recovery operations do not match result")
	}
	if _, err = ParseSnapshot(journal.After); err != nil {
		return err
	}
	current, err := w.rawChangeFiles()
	if err != nil {
		return err
	}
	all := map[string]bool{}
	for name := range current {
		all[name] = true
	}
	for name := range journal.Before {
		all[name] = true
	}
	for name := range journal.After {
		all[name] = true
	}
	for name := range all {
		if !sameFile(current, journal.Before, name) && !sameFile(current, journal.After, name) {
			return fmt.Errorf("recovery blocked by external edit to %s; preserve it and resolve the journal before retrying", name)
		}
	}
	base, err := SafePath(w.Root, w.Config.Graph)
	if err != nil {
		return err
	}
	for _, op := range c.Operations {
		if sameFile(current, journal.After, op.Path) {
			continue
		}
		file, err := SafePath(base, op.Path)
		if err != nil {
			return err
		}
		// Recheck immediately before replacing: graph locks cannot lock editors.
		bytes, err := os.ReadFile(file)
		old, existed := current[op.Path]
		if (existed && (err != nil || string(bytes) != old)) || (!existed && !os.IsNotExist(err)) {
			return fmt.Errorf("graph file changed during apply: %s", op.Path)
		}
		if op.Delete {
			if err = os.Remove(file); err == nil {
				err = syncChangeDir(filepath.Dir(file))
			}
		} else {
			err = durableChangeWrite(file, []byte(op.Content))
		}
		if err != nil {
			return err
		}
	}
	current, err = w.rawChangeFiles()
	if err != nil {
		return err
	}
	if Digest(current) != c.ResultRevision {
		return errors.New("graph changed during apply; recovery journal retained")
	}
	c.Status = "applied"
	c.UpdatedAt = changeNow()
	if err = w.SaveRecord("changes", c.ID, c); err != nil {
		return err
	}
	if err = os.Remove(p); err != nil {
		return err
	}
	return syncChangeDir(filepath.Dir(p))
}
