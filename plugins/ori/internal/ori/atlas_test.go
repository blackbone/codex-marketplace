package ori

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func atlasFixture() map[string]string {
	return map[string]string{
		"entities/product.json":     string(JSON(Entity{ID: "product", Name: "Product"})),
		"components/behavior.json":  string(JSON(Component{ID: "behavior", EntityID: "product", Type: "behavior", Body: "components/behavior.md", Data: map[string]any{"limit": 3}})),
		"components/behavior.md":    "# Search\nFind local facts, включая русский текст.\n",
		"components/interface.json": string(JSON(Component{ID: "interface", EntityID: "product", Type: "interface", Text: "A searchable interface"})),
		"relations/first.json":      string(JSON(Relation{ID: "first", Type: "informs", From: "behavior", To: "interface"})),
		"relations/return.json":     string(JSON(Relation{ID: "return", Type: "informs", From: "interface", To: "behavior"})),
		"types/behavior.json":       `{"type":"object","properties":{"limit":{"$ref":"positive.json"}},"required":["limit"],"additionalProperties":false}`,
		"types/positive.json":       `{"type":"integer","minimum":1}`,
		"projections/all.json":      string(JSON(ProjectionSpec{ID: "all", Name: "Product", RelationTypes: []string{"*"}, Depth: 64})),
	}
}

func TestAtlasSnapshotSchemasBodiesAndCycles(t *testing.T) {
	files := atlasFixture()
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Components) != 2 || len(s.Relations) != 2 {
		t.Fatalf("unexpected graph: %+v", s)
	}
	if s.Components[0].Text != files["components/behavior.md"] {
		t.Fatal("markdown body was not resolved")
	}
	if s.Revision != Digest(files) {
		t.Fatal("revision does not identify raw files")
	}
	files["components/behavior.md"] = "changed by the caller"
	if s.Files["components/behavior.md"] == files["components/behavior.md"] {
		t.Fatal("snapshot aliases caller's map")
	}
	if !strings.Contains(s.Text(s.Components[0]), "русский") {
		t.Fatal("body not included in searchable text")
	}
}

func TestAtlasRejectsInvalidGraph(t *testing.T) {
	cases := map[string]func(map[string]string){
		"traversal":    func(f map[string]string) { f["../outside.md"] = "bad" },
		"alias":        func(f map[string]string) { f["components/../outside.md"] = "bad" },
		"windows path": func(f map[string]string) { f["components\\other.md"] = "bad" },
		"invalid UTF8": func(f map[string]string) { f["components/behavior.md"] = string([]byte{0xff}) },
		"unknown field": func(f map[string]string) {
			f["entities/product.json"] = `{"id":"product","name":"Product","unknown":1}`
		},
		"duplicate id":   func(f map[string]string) { f["entities/duplicate.json"] = f["entities/product.json"] },
		"duplicate type": func(f map[string]string) { f["types/nested/positive.json"] = `true` },
		"missing owner":  func(f map[string]string) { delete(f, "entities/product.json") },
		"missing endpoint": func(f map[string]string) {
			f["relations/first.json"] = string(JSON(Relation{ID: "first", Type: "informs", From: "missing", To: "behavior"}))
		},
		"schema violation": func(f map[string]string) { f["types/positive.json"] = `{"type":"integer","minimum":5}` },
		"external ref":     func(f map[string]string) { f["types/positive.json"] = `{"$ref":"https://example.com/not-loaded.json"}` },
		"missing body":     func(f map[string]string) { delete(f, "components/behavior.md") },
		"body and text": func(f map[string]string) {
			f["components/behavior.json"] = string(JSON(Component{ID: "behavior", EntityID: "product", Type: "other", Body: "components/behavior.md", Text: "ambiguous"}))
		},
		"bad projection": func(f map[string]string) {
			f["projections/all.json"] = string(JSON(ProjectionSpec{ID: "all", Entities: []string{"missing"}}))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			files := atlasFixture()
			mutate(files)
			if _, err := ParseSnapshot(files); err == nil {
				t.Fatal("invalid graph accepted")
			}
		})
	}
}

func atlasRepository(t *testing.T) *Workspace {
	t.Helper()
	root := t.TempDir()
	if _, err := Git(root, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	w, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range atlasFixture() {
		if err := AtomicWrite(filepath.Join(root, "graph", filepath.FromSlash(name)), []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	return w
}

func TestAtlasWorkingAndCommittedSnapshots(t *testing.T) {
	w := atlasRepository(t)
	if err := AtomicWrite(filepath.Join(w.Root, "graph/.scratch/ignored.json"), []byte("not a graph file")); err != nil {
		t.Fatal(err)
	}
	if _, err := Git(w.Root, "add", "."); err != nil {
		t.Fatal(err)
	}
	if _, err := Git(w.Root, "-c", "user.name=Ori Test", "-c", "user.email=ori@example.invalid", "commit", "-qm", "initial graph"); err != nil {
		t.Fatal(err)
	}
	committed, err := w.Snapshot("HEAD")
	if err != nil {
		t.Fatal(err)
	}
	working, err := w.Snapshot("working")
	if err != nil {
		t.Fatal(err)
	}
	if committed.Revision != working.Revision || committed.Commit != working.Commit {
		t.Fatal("same content differs between Git and working snapshots")
	}
	if err := AtomicWrite(filepath.Join(w.Root, "graph/components/behavior.md"), []byte("new intent")); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(w.Root, "graph/entities/untracked.json"), JSON(Entity{ID: "untracked", Name: "Untracked entity"})); err != nil {
		t.Fatal(err)
	}
	working, err = w.Snapshot("")
	if err != nil {
		t.Fatal(err)
	}
	if working.Revision == committed.Revision || len(working.Entities) != 2 {
		t.Fatal("uncommitted graph changes absent")
	}
	if working.Commit != committed.Commit {
		t.Fatal("working snapshot changed source commit metadata")
	}
	again, err := w.Snapshot(committed.Commit)
	if err != nil {
		t.Fatal(err)
	}
	if again.Revision != committed.Revision {
		t.Fatal("historical snapshot depends on working files")
	}
	if _, err := w.Snapshot("--help"); err == nil {
		t.Fatal("option accepted as Git ref")
	}
}

func TestAtlasRejectsGraphSymlink(t *testing.T) {
	w := atlasRepository(t)
	external := filepath.Join(t.TempDir(), "external.md")
	if err := os.WriteFile(external, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(w.Root, "graph/components/link.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Snapshot("working"); err == nil {
		t.Fatal("working graph symlink accepted")
	}
	if _, err := Git(w.Root, "add", "."); err != nil {
		t.Fatal(err)
	}
	if _, err := Git(w.Root, "-c", "user.name=Ori Test", "-c", "user.email=ori@example.invalid", "commit", "-qm", "symlink graph"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Snapshot("HEAD"); err == nil {
		t.Fatal("committed graph symlink accepted")
	}
}
