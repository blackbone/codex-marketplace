package ori

import (
	"errors"
	"fmt"
	"sort"
)

type ProjectionSpec struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Entities      []string `json:"entities,omitempty"`
	Types         []string `json:"types,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	RelationTypes []string `json:"relationTypes,omitempty"`
	Depth         int      `json:"depth"`
}
type Projection struct {
	Version       int                 `json:"version"`
	ID            string              `json:"id"`
	Digest        string              `json:"digest"`
	GraphRevision string              `json:"graphRevision"`
	GraphCommit   string              `json:"graphCommit,omitempty"`
	Spec          ProjectionSpec      `json:"spec"`
	Entities      []Entity            `json:"entities"`
	Components    []Component         `json:"components"`
	Relations     []Relation          `json:"relations"`
	Reasons       map[string][]string `json:"reasons"`
	SourceFiles   map[string]string   `json:"sourceFiles"`
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s || v == "*" {
			return true
		}
	}
	return false
}
func overlaps(a, b []string) bool {
	for _, v := range a {
		if contains(b, v) {
			return true
		}
	}
	return false
}
func Project(s Snapshot, id string) (Projection, error) {
	var spec *ProjectionSpec
	for i := range s.Projections {
		if s.Projections[i].ID == id {
			spec = &s.Projections[i]
			break
		}
	}
	if spec == nil {
		return Projection{}, fmt.Errorf("unknown projection %s", id)
	}
	sourceFiles := make(map[string]string, len(s.Files))
	for name, body := range s.Files {
		sourceFiles[name] = body
	}
	p := Projection{Version: 1, ID: id, GraphRevision: s.Revision, GraphCommit: s.Commit, Spec: *spec, Entities: []Entity{}, Components: []Component{}, Relations: []Relation{}, Reasons: map[string][]string{}, SourceFiles: sourceFiles}
	selected := map[string]bool{}
	distance := map[string]int{}
	type visit struct {
		id    string
		depth int
	}
	queue := []visit{}
	add := func(id, reason string, depth int) {
		if !selected[id] || depth < distance[id] {
			selected[id] = true
			distance[id] = depth
			queue = append(queue, visit{id, depth})
		}
		if !contains(p.Reasons[id], reason) {
			p.Reasons[id] = append(p.Reasons[id], reason)
		}
	}
	entities := map[string]Entity{}
	components := map[string]Component{}
	owned := map[string][]string{}
	for _, e := range s.Entities {
		entities[e.ID] = e
	}
	for _, c := range s.Components {
		components[c.ID] = c
		owned[c.EntityID] = append(owned[c.EntityID], c.ID)
		if (len(spec.Entities) == 0 || contains(spec.Entities, c.EntityID)) && (len(spec.Types) == 0 || contains(spec.Types, c.Type)) && (len(spec.Tags) == 0 || contains(spec.Tags, "*") || overlaps(c.Tags, spec.Tags) || overlaps(entities[c.EntityID].Tags, spec.Tags)) {
			add(c.ID, "selector", 0)
		}
		if c.Constraint {
			add(c.ID, "global constraint", 0)
		}
	}
	for _, e := range s.Entities {
		if len(spec.Types) == 0 && (len(spec.Entities) == 0 || contains(spec.Entities, e.ID)) && (len(spec.Tags) == 0 || contains(spec.Tags, "*") || overlaps(e.Tags, spec.Tags)) {
			add(e.ID, "selector", 0)
		}
	}
	adjacent := map[string][]Relation{}
	for _, r := range s.Relations {
		adjacent[r.From] = append(adjacent[r.From], r)
		if r.From != r.To {
			adjacent[r.To] = append(adjacent[r.To], r)
		}
	}
	// Ownership adds context without selecting unrelated sibling aspects. An
	// entity explicitly reached by a relation contributes all its components.
	// Ordinary edges cost one depth step; constrains edges cost zero and are
	// always followed, so a depth limit cannot silently remove requirements.
	for head := 0; head < len(queue); head++ {
		current := queue[head]
		if distance[current.id] != current.depth {
			continue
		}
		if c, ok := components[current.id]; ok {
			add(c.EntityID, "owner of "+c.ID, current.depth)
		}
		for _, r := range adjacent[current.id] {
			nextDepth := current.depth
			if r.Type != "constrains" {
				if !contains(spec.RelationTypes, r.Type) || current.depth >= spec.Depth {
					continue
				}
				nextDepth++
			}
			target := r.From
			if target == current.id {
				target = r.To
			}
			add(target, "relation "+r.ID, nextDepth)
			for _, child := range owned[target] {
				add(child, "related entity "+target, nextDepth)
			}
		}
	}
	for _, e := range s.Entities {
		if selected[e.ID] {
			p.Entities = append(p.Entities, e)
		}
	}
	for _, c := range s.Components {
		if selected[c.ID] {
			p.Components = append(p.Components, c)
		}
	}
	for _, r := range s.Relations {
		if selected[r.From] && selected[r.To] {
			p.Relations = append(p.Relations, r)
		}
	}
	for id := range p.Reasons {
		sort.Strings(p.Reasons[id])
	}
	p.Digest = projectionDigest(p)
	return p, nil
}
func projectionDigest(p Projection) string { p.Digest = ""; return Digest(p) }
func ValidateProjection(p Projection) error {
	if p.Version != 1 || p.Digest == "" || projectionDigest(p) != p.Digest {
		return errors.New("projection digest is invalid")
	}
	s, e := ParseSnapshot(p.SourceFiles)
	if e != nil {
		return e
	}
	if s.Revision != p.GraphRevision {
		return errors.New("projection source revision mismatch")
	}
	s.Commit = p.GraphCommit
	rebuilt, e := Project(s, p.ID)
	if e != nil {
		return e
	}
	if rebuilt.Digest != p.Digest {
		return errors.New("projection does not match its source snapshot")
	}
	return nil
}

type Difference struct {
	Added   []string `json:"added"`
	Changed []string `json:"changed"`
	Removed []string `json:"removed"`
}

func DiffProjection(before *Projection, after Projection) Difference {
	a, b := map[string]string{}, map[string]string{}
	put := func(p Projection, m map[string]string) {
		for _, v := range p.Entities {
			m[v.ID] = Digest(v)
		}
		for _, v := range p.Components {
			m[v.ID] = Digest(v)
		}
		for _, v := range p.Relations {
			m[v.ID] = Digest(v)
		}
	}
	if before != nil {
		put(*before, a)
	}
	put(after, b)
	d := Difference{[]string{}, []string{}, []string{}}
	for k, v := range b {
		if old, ok := a[k]; !ok {
			d.Added = append(d.Added, k)
		} else if old != v {
			d.Changed = append(d.Changed, k)
		}
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			d.Removed = append(d.Removed, k)
		}
	}
	sort.Strings(d.Added)
	sort.Strings(d.Changed)
	sort.Strings(d.Removed)
	return d
}
