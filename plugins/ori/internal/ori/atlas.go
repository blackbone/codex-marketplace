package ori

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	schema "github.com/santhosh-tekuri/jsonschema/v6"
)

type Entity struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Tags []string `json:"tags,omitempty"`
}
type Component struct {
	ID         string   `json:"id"`
	EntityID   string   `json:"entityId"`
	Type       string   `json:"type"`
	Name       string   `json:"name,omitempty"`
	Text       string   `json:"text,omitempty"`
	Body       string   `json:"body,omitempty"`
	Data       any      `json:"data,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Constraint bool     `json:"constraint,omitempty"`
}
type Relation struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	From string `json:"from"`
	To   string `json:"to"`
	Text string `json:"text,omitempty"`
}
type Snapshot struct {
	Version     int               `json:"version"`
	Revision    string            `json:"revision"`
	Commit      string            `json:"commit,omitempty"`
	Entities    []Entity          `json:"entities"`
	Components  []Component       `json:"components"`
	Relations   []Relation        `json:"relations"`
	Projections []ProjectionSpec  `json:"projections"`
	Files       map[string]string `json:"files"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

func validID(s string) bool { return identifier.MatchString(s) }
func graphFile(p string) bool {
	for _, part := range strings.Split(p, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return strings.HasSuffix(p, ".json") || strings.HasSuffix(p, ".md")
}
func (w *Workspace) Snapshot(ref string) (Snapshot, error) {
	if ref != "" && ref != "working" {
		return w.snapshotUnlocked(ref)
	}
	lock, err := w.AcquireGraphLock(context.Background())
	if err != nil {
		return Snapshot{}, err
	}
	defer lock.Unlock()
	if err := w.recoverChangesLocked(); err != nil {
		return Snapshot{}, err
	}
	return w.snapshotUnlocked(ref)
}

// Callers already holding the graph lock use this to avoid nested locks.
func (w *Workspace) snapshotUnlocked(ref string) (Snapshot, error) {
	files := map[string]string{}
	commit := ""
	if ref != "" && ref != "working" {
		if strings.HasPrefix(ref, "-") {
			return Snapshot{}, errors.New("invalid Git ref")
		}
		var err error
		commit, err = Git(w.Root, "rev-parse", "--verify", ref+"^{commit}")
		if err != nil {
			return Snapshot{}, err
		}
		b, err := exec.Command("git", "-C", w.Root, "ls-tree", "-r", "-z", commit, "--", w.Config.Graph+"/").Output()
		if err != nil {
			return Snapshot{}, err
		}
		for _, entry := range strings.Split(string(b), "\x00") {
			if entry == "" {
				continue
			}
			parts := strings.SplitN(entry, "\t", 2)
			if len(parts) != 2 {
				return Snapshot{}, errors.New("invalid Git tree")
			}
			fields := strings.Fields(parts[0])
			if len(fields) != 3 || !strings.HasPrefix(parts[1], w.Config.Graph+"/") {
				return Snapshot{}, errors.New("invalid Git tree entry")
			}
			rel := strings.TrimPrefix(parts[1], w.Config.Graph+"/")
			if fields[1] != "blob" || (fields[0] != "100644" && fields[0] != "100755") {
				return Snapshot{}, fmt.Errorf("unsupported Git file mode: %s", parts[1])
			}
			if !graphFile(rel) {
				continue
			}
			body, e := exec.Command("git", "-C", w.Root, "cat-file", "blob", fields[2]).Output()
			if e != nil {
				return Snapshot{}, e
			}
			if len(body) > 4<<20 {
				return Snapshot{}, errors.New("graph file exceeds 4 MiB")
			}
			files[rel] = string(body)
		}
	} else {
		base, err := SafePath(w.Root, w.Config.Graph)
		if err != nil {
			return Snapshot{}, err
		}
		err = filepath.WalkDir(base, func(p string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
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
			rel, _ := filepath.Rel(base, p)
			rel = filepath.ToSlash(rel)
			if !graphFile(rel) {
				return nil
			}
			st, e := d.Info()
			if e != nil {
				return e
			}
			if !st.Mode().IsRegular() || st.Size() > 4<<20 {
				return fmt.Errorf("unsupported or oversized graph file: %s", rel)
			}
			b, e := os.ReadFile(p)
			if e == nil {
				files[rel] = string(b)
			}
			return e
		})
		if err != nil {
			return Snapshot{}, err
		}
		commit, _ = Git(w.Root, "rev-parse", "HEAD")
	}
	s, err := ParseSnapshot(files)
	s.Commit = commit
	return s, err
}

type denyLoader struct{}

func (denyLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("external schema reference is not allowed: %s", url)
}
func ParseSnapshot(files map[string]string) (Snapshot, error) {
	owned := make(map[string]string, len(files))
	for name, body := range files {
		if !portablePath(name) || !graphFile(name) {
			return Snapshot{}, fmt.Errorf("invalid graph file path %q", name)
		}
		if len(body) > 4<<20 || !utf8.ValidString(body) {
			return Snapshot{}, fmt.Errorf("graph file must be UTF-8 and at most 4 MiB: %s", name)
		}
		owned[name] = body
	}
	files = owned
	s := Snapshot{Version: 1, Revision: Digest(files), Files: files, Entities: []Entity{}, Components: []Component{}, Relations: []Relation{}, Projections: []ProjectionSpec{}}
	names := make([]string, 0, len(files))
	for p := range files {
		names = append(names, p)
	}
	sort.Strings(names)
	ids := map[string]string{}
	types := map[string]*schema.Schema{}
	compiler := schema.NewCompiler()
	compiler.UseLoader(denyLoader{})
	typePaths := map[string]string{}
	// Register every local schema before compiling; sibling $ref values remain
	// portable and no validation ever fetches a schema from the network.
	for _, p := range names {
		if !strings.HasPrefix(p, "types/") || !strings.HasSuffix(p, ".json") {
			continue
		}
		typeID := strings.TrimSuffix(path.Base(p), ".json")
		if !validID(typeID) {
			return s, fmt.Errorf("invalid component type schema name: %s", p)
		}
		if prior, exists := typePaths[typeID]; exists {
			return s, fmt.Errorf("duplicate component type %s in %s and %s", typeID, prior, p)
		}
		var doc any
		if err := json.Unmarshal([]byte(files[p]), &doc); err != nil {
			return s, fmt.Errorf("%s: %w", p, err)
		}
		if err := compiler.AddResource("https://ori.invalid/"+p, doc); err != nil {
			return s, fmt.Errorf("%s: %w", p, err)
		}
		typePaths[typeID] = p
	}
	for _, p := range names {
		if !strings.HasPrefix(p, "types/") || !strings.HasSuffix(p, ".json") {
			continue
		}
		compiled, err := compiler.Compile("https://ori.invalid/" + p)
		if err != nil {
			return s, fmt.Errorf("%s: %w", p, err)
		}
		types[strings.TrimSuffix(path.Base(p), ".json")] = compiled
	}
	for _, p := range names {
		if !strings.HasSuffix(p, ".json") {
			continue
		}
		var id string
		switch strings.Split(p, "/")[0] {
		case "entities":
			var v Entity
			if e := Decode([]byte(files[p]), &v); e != nil {
				return s, fmt.Errorf("%s: %w", p, e)
			}
			if strings.TrimSpace(v.Name) == "" {
				return s, fmt.Errorf("%s: name required", p)
			}
			id = v.ID
			s.Entities = append(s.Entities, v)
		case "components":
			var v Component
			if e := Decode([]byte(files[p]), &v); e != nil {
				return s, fmt.Errorf("%s: %w", p, e)
			}
			id = v.ID
			s.Components = append(s.Components, v)
		case "relations":
			var v Relation
			if e := Decode([]byte(files[p]), &v); e != nil {
				return s, fmt.Errorf("%s: %w", p, e)
			}
			id = v.ID
			s.Relations = append(s.Relations, v)
		case "projections":
			var v ProjectionSpec
			if e := Decode([]byte(files[p]), &v); e != nil {
				return s, fmt.Errorf("%s: %w", p, e)
			}
			if !validID(v.ID) || v.Depth < 0 || v.Depth > 64 {
				return s, fmt.Errorf("%s: invalid projection id or depth", p)
			}
			for _, prev := range s.Projections {
				if prev.ID == v.ID {
					return s, fmt.Errorf("duplicate projection %s", v.ID)
				}
			}
			s.Projections = append(s.Projections, v)
			continue
		case "types":
			continue
		default:
			return s, fmt.Errorf("unknown graph JSON directory: %s", p)
		}
		if !validID(id) {
			return s, fmt.Errorf("%s: invalid id", p)
		}
		if prev, ok := ids[id]; ok {
			return s, fmt.Errorf("duplicate id %s in %s and %s", id, prev, p)
		}
		ids[id] = p
	}
	entities := map[string]bool{}
	refs := map[string]bool{}
	for _, e := range s.Entities {
		entities[e.ID] = true
		refs[e.ID] = true
	}
	for i, c := range s.Components {
		if !entities[c.EntityID] {
			return s, fmt.Errorf("component %s refers to missing entity %s", c.ID, c.EntityID)
		}
		if !validID(c.Type) {
			return s, fmt.Errorf("component %s has invalid type", c.ID)
		}
		if c.Body != "" {
			if !portablePath(c.Body) || !graphFile(c.Body) || !strings.HasSuffix(c.Body, ".md") {
				return s, fmt.Errorf("invalid component body %s", c.Body)
			}
			body, ok := files[c.Body]
			if !ok {
				return s, fmt.Errorf("missing component body %s", c.Body)
			}
			if c.Text != "" {
				return s, fmt.Errorf("component %s cannot have both text and body", c.ID)
			}
			s.Components[i].Text = body
		}
		if validator, ok := types[c.Type]; ok {
			if err := validator.Validate(c.Data); err != nil {
				return s, fmt.Errorf("component %s: %w", c.ID, err)
			}
		}
		refs[c.ID] = true
	}
	for _, r := range s.Relations {
		if !refs[r.From] || !refs[r.To] {
			return s, fmt.Errorf("relation %s has a missing endpoint", r.ID)
		}
		if !validID(r.Type) {
			return s, fmt.Errorf("relation %s has invalid type", r.ID)
		}
	}
	for _, p := range s.Projections {
		for _, id := range p.Entities {
			if id != "*" && !entities[id] {
				return s, fmt.Errorf("projection %s selects missing entity %s", p.ID, id)
			}
		}
		for _, id := range append(append([]string{}, p.Types...), p.RelationTypes...) {
			if id != "*" && !validID(id) {
				return s, fmt.Errorf("projection %s has invalid type selector %q", p.ID, id)
			}
		}
	}
	return s, nil
}
func (s Snapshot) Text(c Component) string {
	return strings.Join([]string{c.ID, c.Name, c.EntityID, c.Type, strings.Join(c.Tags, " "), c.Text, string(JSON(c.Data))}, "\n")
}
