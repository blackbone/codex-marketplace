package ori

import (
	"fmt"
	"testing"
)

func lensIDs(p Projection) map[string]bool {
	ids := map[string]bool{}
	for _, e := range p.Entities {
		ids[e.ID] = true
	}
	for _, c := range p.Components {
		ids[c.ID] = true
	}
	return ids
}

func TestLensSelectorDoesNotPullSiblingAspects(t *testing.T) {
	files := atlasFixture()
	files["projections/focus.json"] = string(JSON(ProjectionSpec{ID: "focus", Types: []string{"behavior"}, Depth: 0}))
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Project(s, "focus")
	if err != nil {
		t.Fatal(err)
	}
	ids := lensIDs(p)
	if !ids["product"] || !ids["behavior"] || ids["interface"] {
		t.Fatalf("incorrect aspect selection: %+v", ids)
	}
	if err := ValidateProjection(p); err != nil {
		t.Fatal(err)
	}
	p.SourceFiles["components/behavior.md"] = "tamper"
	if s.Files["components/behavior.md"] == "tamper" {
		t.Fatal("projection aliases graph source map")
	}
	if err := ValidateProjection(p); err == nil {
		t.Fatal("tampered projection accepted")
	}
}

func TestLensConstraintsIgnoreOrdinaryDepthLimit(t *testing.T) {
	files := atlasFixture()
	files["projections/focus.json"] = string(JSON(ProjectionSpec{ID: "focus", Types: []string{"behavior"}, Depth: 0}))
	files["entities/policy.json"] = string(JSON(Entity{ID: "policy", Name: "Policy"}))
	files["components/global.json"] = string(JSON(Component{ID: "global", EntityID: "policy", Type: "policy", Text: "Always required", Constraint: true}))
	previous := "behavior"
	for n := 0; n < 70; n++ {
		id := fmt.Sprintf("constraint-%02d", n)
		files["components/"+id+".json"] = string(JSON(Component{ID: id, EntityID: "policy", Type: "policy", Text: id}))
		files["relations/"+id+".json"] = string(JSON(Relation{ID: "link-" + id, Type: "constrains", From: id, To: previous}))
		previous = id
	}
	files["relations/constraint-cycle.json"] = string(JSON(Relation{ID: "constraint-cycle", Type: "constrains", From: "behavior", To: previous}))
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Project(s, "focus")
	if err != nil {
		t.Fatal(err)
	}
	ids := lensIDs(p)
	if !ids["global"] || !ids["constraint-69"] || !ids["policy"] || ids["interface"] {
		t.Fatalf("incomplete/overbroad constraint closure: %+v", ids)
	}
	if len(p.Components) != 72 {
		t.Fatalf("got %d components, expected initial + 70 constraints + global", len(p.Components))
	}
	if err := ValidateProjection(p); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		again, err := Project(s, "focus")
		if err != nil || again.Digest != p.Digest {
			t.Fatal("projection is nondeterministic", err)
		}
	}
}

func TestLensOrdinaryTraversalDepthAndRelatedEntity(t *testing.T) {
	files := atlasFixture()
	files["entities/other.json"] = string(JSON(Entity{ID: "other", Name: "Other"}))
	files["components/other-ui.json"] = string(JSON(Component{ID: "other-ui", EntityID: "other", Type: "interface", Text: "Related UI"}))
	files["entities/distant.json"] = string(JSON(Entity{ID: "distant", Name: "Distant"}))
	files["relations/other.json"] = string(JSON(Relation{ID: "to-other", Type: "uses", From: "behavior", To: "other"}))
	files["relations/distant.json"] = string(JSON(Relation{ID: "to-distant", Type: "uses", From: "other", To: "distant"}))
	files["projections/focus.json"] = string(JSON(ProjectionSpec{ID: "focus", Entities: []string{"product"}, Types: []string{"behavior"}, RelationTypes: []string{"uses"}, Depth: 1}))
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Project(s, "focus")
	if err != nil {
		t.Fatal(err)
	}
	ids := lensIDs(p)
	if !ids["other"] || !ids["other-ui"] || ids["distant"] || ids["interface"] {
		t.Fatalf("incorrect one-step traversal: %+v", ids)
	}
}

func TestLensPortableArtifactAndAccumulatedDifference(t *testing.T) {
	files := atlasFixture()
	beforeSnapshot, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	before, err := Project(beforeSnapshot, "all")
	if err != nil {
		t.Fatal(err)
	}
	files["components/behavior.md"] = "Change from a different machine"
	delete(files, "components/interface.json")
	delete(files, "relations/first.json")
	delete(files, "relations/return.json")
	files["entities/new.json"] = string(JSON(Entity{ID: "new", Name: "New product intent"}))
	afterSnapshot, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	afterSnapshot.Commit = "source-commit-metadata"
	after, err := Project(afterSnapshot, "all")
	if err != nil {
		t.Fatal(err)
	}
	var imported Projection
	if err := Decode(JSON(after), &imported); err != nil {
		t.Fatal(err)
	}
	if err := ValidateProjection(imported); err != nil {
		t.Fatal(err)
	}
	diff := DiffProjection(&before, imported)
	if Digest(diff) != Digest(Difference{Added: []string{"new"}, Changed: []string{"behavior"}, Removed: []string{"first", "interface", "return"}}) {
		t.Fatalf("incorrect accumulated difference: %+v", diff)
	}
	imported.Components[0].Text = "forged derived representation"
	imported.Digest = projectionDigest(imported)
	if err := ValidateProjection(imported); err == nil {
		t.Fatal("rehashed artifact without matching source accepted")
	}
}
