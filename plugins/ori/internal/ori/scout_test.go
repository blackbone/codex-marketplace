package ori

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func scoutFixture(t *testing.T) (*Workspace, Snapshot) {
	t.Helper()
	w := &Workspace{Root: filepath.Join(t.TempDir(), "repo ?# unicode путь"), Config: DefaultConfig()}
	files := map[string]string{
		"entities/all.json":        `{"id":"all","name":"Access"}`,
		"components/recovery.json": `{"id":"recovery","entityId":"all","type":"behavior","text":"Восстановление пароля по email ссылке"}`,
		"components/basket.json":   `{"id":"basket","entityId":"all","type":"behavior","text":"The shopping basket calculates total price"}`,
		"projections/all.json":     `{"id":"all","depth":0}`,
	}
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	return w, s
}

func TestScoutLexicalSnapshotAndPaths(t *testing.T) {
	w, s := scoutFixture(t)
	r, err := w.Search(context.Background(), s, "пароля", 10, true)
	if err != nil {
		t.Fatal(err)
	}
	if r.Mode != "lexical" || r.Revision != s.Revision || len(r.Hits) != 1 || r.Hits[0].ID != "recovery" {
		t.Fatalf("unexpected results: %+v", r)
	}
	r, err = w.Search(context.Background(), s, "all", 10, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Hits) == 0 || r.Hits[0].ID != "all" || r.Hits[0].Path != "graph/entities/all.json" {
		t.Fatalf("ID must beat matches and use entity path, not projection: %+v", r)
	}
	files := map[string]string{}
	for p, b := range s.Files {
		files[p] = b
	}
	files["components/recovery.json"] = `{"id":"recovery","entityId":"all","type":"behavior","text":"Email confirmation is required"}`
	updated, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	r, err = w.Search(context.Background(), updated, "пароля", 10, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Hits) != 0 || r.Revision != updated.Revision {
		t.Fatalf("stale hit returned: %+v", r)
	}
	r, err = w.Search(context.Background(), s, "пароля", 10, true)
	if err != nil || len(r.Hits) != 1 {
		t.Fatalf("historical snapshot not searchable: %+v %v", r, err)
	}
}

func TestScoutQueriesCancellationAndRecords(t *testing.T) {
	w, s := scoutFixture(t)
	for _, query := range []string{"", strings.Repeat("x", 4001)} {
		if _, err := w.Search(context.Background(), s, query, 10, true); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := w.Search(ctx, s, "basket", 10, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
	r, err := w.Search(context.Background(), s, `" OR * NOT () :`, 10, true)
	if err != nil || len(r.Hits) != 0 {
		t.Fatalf("FTS syntax must remain data: %+v %v", r, err)
	}
	if err := w.SaveRecord("meta", "bad", nil); err == nil {
		t.Fatal("invalid table accepted")
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := w.SaveRecord("changes", string(rune('a'+i)), map[string]int{"attempt": i}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	rows, err := w.Records("changes")
	if err != nil || len(rows) != 6 {
		t.Fatalf("records %d %v", len(rows), err)
	}
	db, err := w.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow("SELECT count(*) FROM events").Scan(&count); err != nil || count != 6 {
		t.Fatalf("events %d %v", count, err)
	}
	var value map[string]int
	if err := w.Record("changes", "absent", &value); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing record %v", err)
	}
}

func TestScoutFiniteVectorsAndWaitCancellation(t *testing.T) {
	for _, v := range [][]float32{nil, {0}, {float32(math.NaN())}, {float32(math.Inf(1))}} {
		if _, err := cosine(v, v); err == nil {
			t.Fatalf("accepted invalid cosine %v", v)
		}
	}
	valid := make([]float32, EmbeddingDimensions)
	valid[0] = 1
	if err := validateEmbedding(valid); err != nil {
		t.Fatal(err)
	}
	valid[1] = float32(math.Inf(1))
	if err := validateEmbedding(valid); err == nil {
		t.Fatal("nonfinite model vector accepted")
	}
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := acquire(ctx, gate); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait cancellation %v", err)
	}
}

func TestScoutChunksPreserveUnicodeTail(t *testing.T) {
	input := strings.Repeat("🙂пароль漢字", 100) + "tail-sentinel"
	parts := textChunks(input)
	if len(parts) < 2 || !strings.HasSuffix(parts[len(parts)-1], "tail-sentinel") {
		t.Fatalf("tail missing: %v", parts)
	}
	for _, part := range parts {
		if len([]rune(part)) > 256 {
			t.Fatal("coarse chunk too large")
		}
	}
	if len(textChunks("")) != 0 {
		t.Fatal("empty text has chunks")
	}
}

func TestScoutImpactCyclesConstraintsAndLimit(t *testing.T) {
	s := Snapshot{Entities: []Entity{{ID: "a"}, {ID: "b"}}, Components: []Component{{ID: "ca", EntityID: "a"}, {ID: "guard", EntityID: "b", Constraint: true}}, Relations: []Relation{{ID: "r1", From: "ca", To: "b"}, {ID: "r2", From: "b", To: "a"}}}
	impact := FindImpact(s, []string{"ca"}, 100)
	if strings.Join(impact.IDs, ",") != "a,b,ca,guard" || impact.Truncated {
		t.Fatalf("impact=%+v", impact)
	}
	if !contains(impact.Reasons["guard"], "global constraint") {
		t.Fatalf("constraint reason missing %+v", impact)
	}
	truncated := FindImpact(s, []string{"ca"}, 2)
	if !truncated.Truncated || len(truncated.IDs) != 2 {
		t.Fatalf("limit not reported %+v", truncated)
	}
	relation := FindImpact(s, []string{"r1"}, 100)
	if !contains(relation.IDs, "ca") || !contains(relation.IDs, "b") {
		t.Fatalf("relation endpoints missing %+v", relation)
	}
}

func TestScoutSemanticPresentationAndIndexUpgrade(t *testing.T) {
	w, s := scoutFixture(t)
	if err := w.Index(s); err != nil {
		t.Fatal(err)
	}
	db, err := w.DB()
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("UPDATE meta SET value='previous-version' WHERE key='indexFormat'; DELETE FROM document_semantics;")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	result, err := w.Search(context.Background(), s, "recovery", 10, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hits) == 0 || result.Hits[0].Text != "Восстановление пароля по email ссылке" {
		t.Fatalf("metadata leaked into displayed text or index not rebuilt: %+v", result)
	}
	c := Component{ID: "routing-id", EntityID: "owner-id", Type: "schema-type", Tags: []string{"routing-tag"}, Name: "Capture", Text: "Save a place offline", Data: map[string]any{"retentionDays": 30}}
	body := semanticComponent(c)
	for _, noise := range []string{c.ID, c.EntityID, c.Type, c.Tags[0]} {
		if strings.Contains(body, noise) {
			t.Fatalf("technical metadata embedded: %s", body)
		}
	}
	if !strings.Contains(body, "retentionDays") || !strings.Contains(body, "30") {
		t.Fatalf("structured requirements omitted: %s", body)
	}
}
