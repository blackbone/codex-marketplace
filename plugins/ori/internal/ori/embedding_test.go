package ori

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLocalModelSmoke(t *testing.T) {
	if os.Getenv("ORI_MODEL_SMOKE") != "1" {
		t.Skip("set ORI_MODEL_SMOKE=1 to download and run the pinned multilingual model")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	started := time.Now()
	e, err := GetEmbedder(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("model ready in %s", time.Since(started))
	started = time.Now()
	vectors, err := e.Embed(ctx, []string{"Как восстановить забытый пароль?", "Reset a forgotten password using an email recovery link.", "The shopping basket calculates the total price of products."})
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if len(v) != 384 {
			t.Fatalf("dimensions=%d want284", len(v))
		}
	}
	related, err := cosine(vectors[0], vectors[1])
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := cosine(vectors[0], vectors[2])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("three embeddings in %s; cross-language related %.4f unrelated %.4f", time.Since(started), related, unrelated)
	if related <= unrelated+0.15 {
		t.Fatalf("bad semantic ranking %.4f <= %.4f", related, unrelated)
	}
	longText := strings.Repeat("漢字🙂 восстановление пароля резервное ", 80) + "tail-sentinel"
	chunks, err := e.Chunks(ctx, longText)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) < 2 || !strings.HasSuffix(chunks[len(chunks)-1], "tail-sentinel") {
		t.Fatal("model chunks dropped the tail")
	}
	for _, part := range chunks {
		if n := len(e.pipeline.Model.Tokenizer.GoTokenizer.Tokenizer.Encode(part)); n > ModelMaxTokens {
			t.Fatalf("chunk has %d tokens", n)
		}
	}
	started = time.Now()
	longVectors, err := e.Embed(ctx, []string{longText})
	if err != nil {
		t.Fatal(err)
	}
	if len(longVectors) != 1 || validateEmbedding(longVectors[0]) != nil {
		t.Fatal("bad long-text embedding")
	}
	t.Logf("long text embedded as %d bounded chunks in %s", len(chunks), time.Since(started))
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, err := e.Embed(cancelled, []string{"hello"}); err == nil {
		t.Fatal("cancelled embedding succeeded")
	}
	w, s := scoutFixture(t)
	s.Files["components/recovery.json"] = `{"id":"recovery","entityId":"all","type":"behavior","text":"Reset a forgotten password using an email recovery link."}`
	s, err = ParseSnapshot(s.Files)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		started = time.Now()
		result, err := w.Search(ctx, s, "Как восстановить забытый пароль?", 3, false)
		if err != nil {
			t.Fatal(err)
		}
		if result.Mode != "hybrid" || len(result.Hits) == 0 || result.Hits[0].ID != "recovery" {
			t.Fatalf("bad hybrid ranking: %+v", result)
		}
		t.Logf("hybrid search %d in %s", i+1, time.Since(started))
	}
	db, err := w.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT count(*) FROM vectors").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("vector cache count %d want2", count)
	}
	if _, err = db.Exec("UPDATE vectors SET vector='[0]' WHERE key=(SELECT key FROM vectors LIMIT 1)"); err != nil {
		t.Fatal(err)
	}
	repaired, err := w.Search(ctx, s, "Как восстановить забытый пароль?", 3, false)
	if err != nil || len(repaired.Hits) == 0 || repaired.Hits[0].ID != "recovery" {
		t.Fatalf("corrupt vector cache not repaired: %+v %v", repaired, err)
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	t.Logf("heap in use %d MiB; system allocator %d MiB; real-token chunks %d", memory.HeapInuse/(1<<20), memory.Sys/(1<<20), len(chunks))

}

func TestLocalModelRetrieval(t *testing.T) {
	if os.Getenv("ORI_MODEL_SMOKE") != "1" {
		t.Skip("set ORI_MODEL_SMOKE=1 for multilingual retrieval evaluation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	w := &Workspace{Root: t.TempDir(), Config: DefaultConfig()}
	files := map[string]string{}
	for _, v := range []Entity{{ID: "capture", Name: "Capture a place", Tags: []string{"mobile"}}, {ID: "journey", Name: "Journey", Tags: []string{"mobile"}}, {ID: "privacy", Name: "Privacy", Tags: []string{"platform"}}, {ID: "sync", Name: "Offline sync", Tags: []string{"platform"}}} {
		files["entities/"+v.ID+".json"] = string(JSON(v))
	}
	for _, v := range []Component{
		{ID: "capture-intent", EntityID: "capture", Type: "behavior", Name: "Save what matters", Text: "Capture a place with a note and optional photo. Saving must work without an internet connection."},
		{ID: "capture-view", EntityID: "capture", Type: "interface", Name: "Capture sheet", Text: "A quiet capture sheet with title, note, location and one clear Save action. After local persistence, show Saved to your journey, with an Undo action."},
		{ID: "journey-intent", EntityID: "journey", Type: "behavior", Name: "Plan a journey", Text: "People can collect places into a personal journey, reorder stops, and keep their plans accessible offline."},
		{ID: "privacy-rule", EntityID: "privacy", Type: "quality", Name: "Private by default", Text: "Notes, photos and location are private. Sharing requires a deliberate action and can be revoked.", Constraint: true},
		{ID: "sync-conflict", EntityID: "sync", Type: "behavior", Name: "Keep both versions", Text: "When edits conflict, preserve both versions and let the owner choose. Never silently replace notes."},
		{ID: "sync-contract", EntityID: "sync", Type: "contract", Name: "Durable local writes", Text: "Persist each edit locally before confirming. Retry remote synchronization without duplicate records."},
	} {
		files["components/"+v.ID+".json"] = string(JSON(v))
	}
	s, err := ParseSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ query, want string }{
		{"Сохранить место без интернета", "capture-intent"},
		{"При конфликте правок оставить обе версии", "sync-conflict"},
		{"Записки и фотографии должны быть приватными", "privacy-rule"},
		{"Повторная синхронизация не должна создавать дубликаты", "sync-contract"},
	} {
		result, err := w.Search(ctx, s, tc.query, 3, false)
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, h := range result.Hits {
			ids = append(ids, h.ID)
		}
		t.Logf("%q => %v", tc.query, ids)
		if !contains(ids, tc.want) {
			t.Errorf("expected %s among top3 results for %q", tc.want, tc.query)
		}
	}
}
