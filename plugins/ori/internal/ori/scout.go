package ori

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func (w *Workspace) DB() (*sql.DB, error) {
	p, e := SafePath(w.Root, ".ori/state/index.sqlite")
	if e != nil {
		return nil, e
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, e = SafePath(w.Root, ".ori/state/index.sqlite"+suffix); e != nil {
			return nil, e
		}
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return nil, e
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(p), RawQuery: "_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"}).String()
	db, e := sql.Open("sqlite", dsn)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS vectors(key TEXT PRIMARY KEY, vector TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, entity TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_semantics(id TEXT PRIMARY KEY, texts TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, entity, text, tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
 INSERT OR IGNORE INTO meta VALUES('mutation','0');`)
	if e != nil {
		db.Close()
		return nil, e
	}
	_ = os.Chmod(p, 0600)
	return db, nil
}
func event(tx *sql.Tx, kind string, v any) error {
	_, e := tx.Exec("INSERT INTO events(time,kind,payload) VALUES(?,?,?)", time.Now().UTC().Format(time.RFC3339Nano), kind, string(JSON(v)))
	return e
}
func (w *Workspace) SaveRecord(table, id string, v any) error {
	if table != "runs" && table != "changes" {
		return errors.New("invalid record table")
	}
	db, e := w.DB()
	if e != nil {
		return e
	}
	defer db.Close()
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	_, e = tx.Exec("INSERT INTO "+table+"(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", id, string(JSON(v)))
	if e != nil {
		return e
	}
	if e = event(tx, table, v); e != nil {
		return e
	}
	return tx.Commit()
}
func (w *Workspace) Records(table string) ([]json.RawMessage, error) {
	if table != "runs" && table != "changes" {
		return nil, errors.New("invalid record table")
	}
	db, e := w.DB()
	if e != nil {
		return nil, e
	}
	defer db.Close()
	rows, e := db.Query("SELECT payload FROM " + table + " ORDER BY rowid DESC LIMIT 100")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []json.RawMessage{}
	for rows.Next() {
		var s string
		if e = rows.Scan(&s); e != nil {
			return nil, e
		}
		result = append(result, json.RawMessage(s))
	}
	return result, rows.Err()
}
func (w *Workspace) Record(table, id string, v any) error {
	if table != "runs" && table != "changes" {
		return errors.New("invalid record table")
	}
	db, e := w.DB()
	if e != nil {
		return e
	}
	defer db.Close()
	var s string
	if e = db.QueryRow("SELECT payload FROM "+table+" WHERE id=?", id).Scan(&s); e != nil {
		return e
	}
	return json.Unmarshal([]byte(s), v)
}

type SearchHit struct {
	ID       string   `json:"id"`
	EntityID string   `json:"entityId"`
	Path     string   `json:"path"`
	Text     string   `json:"text"`
	Score    float64  `json:"score"`
	Reasons  []string `json:"reasons"`
}
type SearchResult struct {
	Revision string      `json:"revision"`
	Mode     string      `json:"mode"`
	Hits     []SearchHit `json:"hits"`
}

const searchIndexFormat = "lexical-and-semantic-v2"

var words = regexp.MustCompile(`[\p{L}\p{N}_]+`)

func (w *Workspace) Index(s Snapshot) error {
	db, e := w.DB()
	if e != nil {
		return e
	}
	defer db.Close()
	var rev, format string
	_ = db.QueryRow("SELECT value FROM meta WHERE key='indexRevision'").Scan(&rev)
	_ = db.QueryRow("SELECT value FROM meta WHERE key='indexFormat'").Scan(&format)
	if rev == s.Revision && format == searchIndexFormat+":"+s.Revision {
		return nil
	}
	paths := map[string]string{}
	for p, text := range s.Files {
		if !strings.HasSuffix(p, ".json") || (!strings.HasPrefix(p, "entities/") && !strings.HasPrefix(p, "components/")) {
			continue
		}
		var v struct {
			ID string `json:"id"`
		}
		if json.Unmarshal([]byte(text), &v) == nil && v.ID != "" {
			paths[v.ID] = filepath.ToSlash(filepath.Join(w.Config.Graph, p))
		}
	}
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("DELETE FROM documents; DELETE FROM document_semantics; DELETE FROM search;"); e != nil {
		return e
	}
	add := func(id, entity, body string, semantic []string) error {
		if _, e = tx.Exec("INSERT INTO document_semantics VALUES(?,?)", id, string(JSON(semantic))); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO documents VALUES(?,?,?,?)", id, entity, paths[id], body); e != nil {
			return e
		}
		_, e = tx.Exec("INSERT INTO search(id,entity,text) VALUES(?,?,?)", id, entity, body)
		return e
	}
	byEntity := map[string][]string{}
	for _, c := range s.Components {
		if body := semanticComponent(c); body != "" {
			byEntity[c.EntityID] = append(byEntity[c.EntityID], body)
		}
	}
	for _, c := range s.Components {
		semantic := []string{}
		if body := semanticComponent(c); body != "" {
			semantic = append(semantic, body)
		}
		if e = add(c.ID, c.EntityID, s.Text(c), semantic); e != nil {
			return e
		}
	}
	for _, v := range s.Entities {
		semantic := byEntity[v.ID]
		if len(semantic) == 0 && strings.TrimSpace(v.Name) != "" {
			semantic = []string{v.Name}
		}
		if e = add(v.ID, v.ID, v.ID+"\n"+v.Name+"\n"+strings.Join(v.Tags, " "), semantic); e != nil {
			return e
		}
	}
	_, e = tx.Exec("INSERT INTO meta VALUES('indexRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", s.Revision)
	if e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT INTO meta VALUES('indexFormat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", searchIndexFormat+":"+s.Revision); e != nil {
		return e
	}
	return tx.Commit()
}

// Semantic text describes behavior. Identifiers, type names and routing tags belong
// in FTS, where exact matches are useful, rather than in sentence embeddings.
func semanticComponent(c Component) string {
	parts := []string{}
	for _, v := range []string{c.Name, c.Text} {
		if v = strings.TrimSpace(v); v != "" {
			parts = append(parts, v)
		}
	}
	if c.Data != nil {
		data := strings.TrimSpace(string(JSON(c.Data)))
		if data != "null" && data != "{}" && data != "[]" {
			parts = append(parts, data)
		}
	}
	return strings.Join(parts, "\n")
}

func (w *Workspace) Search(ctx context.Context, s Snapshot, query string, limit int, lexicalOnly bool) (SearchResult, error) {
	out := SearchResult{Revision: s.Revision, Mode: "lexical", Hits: []SearchHit{}}
	query = strings.TrimSpace(query)
	if query == "" || len(query) > 4000 || limit < 1 || limit > 100 {
		return out, errors.New("query requires 1–4000 bytes; limit must be 1–100")
	}
	if e := ctx.Err(); e != nil {
		return out, e
	}
	if e := w.Index(s); e != nil {
		return out, e
	}
	db, e := w.DB()
	if e != nil {
		return out, e
	}
	defer db.Close()
	// Search under a transaction so another process cannot replace the indexed snapshot mid-query.
	tx, e := db.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	var rev string
	if e = tx.QueryRow("SELECT value FROM meta WHERE key='indexRevision'").Scan(&rev); e != nil {
		tx.Rollback()
		return out, e
	}
	var format string
	if e = tx.QueryRow("SELECT value FROM meta WHERE key='indexFormat'").Scan(&format); e != nil {
		tx.Rollback()
		return out, e
	}
	if rev != s.Revision || format != searchIndexFormat+":"+s.Revision {
		tx.Rollback()
		return out, errors.New("index changed concurrently; repeat search")
	}
	rows, e := tx.Query("SELECT d.id,d.entity,d.path,d.text,s.texts FROM documents d JOIN document_semantics s ON d.id=s.id ORDER BY d.id")
	if e != nil {
		tx.Rollback()
		return out, e
	}
	docs := []SearchHit{}
	semanticTexts := map[string][]string{}
	for rows.Next() {
		var d SearchHit
		var semantic string
		var semanticTextsEntry []string
		if e = rows.Scan(&d.ID, &d.EntityID, &d.Path, &d.Text, &semantic); e != nil {
			rows.Close()
			tx.Rollback()
			return out, e
		}
		if e = json.Unmarshal([]byte(semantic), &semanticTextsEntry); e != nil {
			rows.Close()
			tx.Rollback()
			return out, e
		}
		semanticTexts[d.ID] = semanticTextsEntry
		d.Text = strings.Join(semanticTextsEntry, "\n\n")
		d.Reasons = []string{}
		docs = append(docs, d)
	}
	if e = rows.Err(); e != nil {
		rows.Close()
		tx.Rollback()
		return out, e
	}
	rows.Close()
	rank := map[string]float64{}
	reasons := map[string][]string{}
	tokens := words.FindAllString(query, 32)
	parts := []string{}
	for _, token := range tokens {
		parts = append(parts, `"`+token+`"`)
	}
	if len(parts) > 0 {
		rows, e = tx.Query("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT 100", strings.Join(parts, " OR "))
		if e != nil {
			tx.Rollback()
			return out, e
		}
		i := 0
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				tx.Rollback()
				return out, e
			}
			rank[id] += 1 / float64(61+i)
			reasons[id] = append(reasons[id], "keyword")
			i++
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			tx.Rollback()
			return out, e
		}
	}
	if e = tx.Commit(); e != nil {
		return out, e
	}
	if !lexicalOnly && w.Config.Embeddings.Provider != "off" && len(docs) > 0 {
		out.Mode = "hybrid"
		embed, e := GetEmbedder(ctx)
		if e != nil {
			return out, e
		}
		q, e := embed.Embed(ctx, []string{query})
		if e != nil {
			return out, e
		}
		type scored struct {
			id      string
			score   float64
			summary bool
		}
		scores := []scored{}
		for _, d := range docs {
			chunks := []string{}
			for _, body := range semanticTexts[d.ID] {
				parts, err := embed.Chunks(ctx, body)
				if err != nil {
					return out, err
				}
				chunks = append(chunks, parts...)
			}
			if len(chunks) == 0 {
				continue
			}
			best := -1.0
			for _, chunk := range chunks {
				key := Digest([]string{EmbeddingFingerprint, chunk})
				var stored string
				var v []float32
				e = db.QueryRowContext(ctx, "SELECT vector FROM vectors WHERE key=?", key).Scan(&stored)
				if e != nil && e != sql.ErrNoRows {
					return out, e
				}
				rebuild := e == sql.ErrNoRows
				if !rebuild {
					if e = json.Unmarshal([]byte(stored), &v); e != nil || validateEmbedding(v) != nil {
						rebuild = true
					}
				}
				if rebuild {
					vv, err := embed.Embed(ctx, []string{chunk})
					if err != nil {
						return out, err
					}
					v = vv[0]
					if _, e = db.ExecContext(ctx, "INSERT INTO vectors VALUES(?,?) ON CONFLICT(key) DO UPDATE SET vector=excluded.vector", key, string(JSON(v))); e != nil {
						return out, e
					}
				}
				similarity, e := cosine(q[0], v)
				if e != nil {
					return out, e
				}
				best = math.Max(best, similarity)
			}
			scores = append(scores, scored{d.ID, best, d.ID == d.EntityID})
		}
		sort.SliceStable(scores, func(i, j int) bool {
			// Prefer the precise component over its entity summary when evidence ties.
			if scores[i].score == scores[j].score && scores[i].summary != scores[j].summary {
				return !scores[i].summary
			}
			return scores[i].score > scores[j].score
		})
		for i, v := range scores {
			if i >= 100 {
				break
			}
			rank[v.id] += 1 / float64(61+i)
			reasons[v.id] = append(reasons[v.id], "semantic")
		}
	}
	for _, d := range docs {
		if strings.EqualFold(d.ID, query) {
			rank[d.ID] += 1
			reasons[d.ID] = append(reasons[d.ID], "exact ID")
		}
		if rank[d.ID] > 0 {
			d.Score = rank[d.ID]
			d.Reasons = reasons[d.ID]
			out.Hits = append(out.Hits, d)
		}
	}
	sort.SliceStable(out.Hits, func(i, j int) bool { return out.Hits[i].Score > out.Hits[j].Score })
	if len(out.Hits) > limit {
		out.Hits = out.Hits[:limit]
	}
	return out, nil
}
func textChunks(s string) []string {
	r := []rune(s)
	result := []string{}
	for start := 0; start < len(r); start += 192 {
		end := start + 256
		if end > len(r) {
			end = len(r)
		}
		result = append(result, string(r[start:end]))
		if end == len(r) {
			break
		}
	}
	return result
}
func cosine(a, b []float32) (float64, error) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, errors.New("embedding dimensions do not match")
	}
	var dot, aa, bb float64
	for i := range a {
		x, y := float64(a[i]), float64(b[i])
		dot += x * y
		aa += x * x
		bb += y * y
	}
	if aa == 0 || bb == 0 {
		return 0, errors.New("embedding has zero norm")
	}
	v := dot / math.Sqrt(aa*bb)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("invalid embedding value")
	}
	return v, nil
}

type Impact struct {
	IDs       []string            `json:"ids"`
	Reasons   map[string][]string `json:"reasons"`
	Truncated bool                `json:"truncated"`
}

func FindImpact(s Snapshot, seeds []string, max int) Impact {
	out := Impact{IDs: []string{}, Reasons: map[string][]string{}}
	type edge struct{ id, reason string }
	adjacency := map[string][]edge{}
	for _, c := range s.Components {
		adjacency[c.ID] = append(adjacency[c.ID], edge{c.EntityID, "owner"})
		adjacency[c.EntityID] = append(adjacency[c.EntityID], edge{c.ID, "component"})
	}
	for _, r := range s.Relations {
		reason := "relation " + r.ID
		adjacency[r.From] = append(adjacency[r.From], edge{r.To, reason})
		adjacency[r.To] = append(adjacency[r.To], edge{r.From, reason})
		adjacency[r.ID] = append(adjacency[r.ID], edge{r.From, reason}, edge{r.To, reason})
	}
	queue := []string{}
	queued := map[string]bool{}
	add := func(id, reason string) {
		if id == "" {
			return
		}
		if !queued[id] {
			queue = append(queue, id)
			queued[id] = true
		}
		if !contains(out.Reasons[id], reason) {
			out.Reasons[id] = append(out.Reasons[id], reason)
		}
	}
	for _, id := range seeds {
		add(id, "seed")
	}
	for _, c := range s.Components {
		if c.Constraint {
			add(c.ID, "global constraint")
		}
	}
	for at := 0; at < len(queue); at++ {
		if len(out.IDs) >= max {
			out.Truncated = true
			break
		}
		id := queue[at]
		out.IDs = append(out.IDs, id)
		for _, v := range adjacency[id] {
			add(v.id, v.reason)
		}
	}
	sort.Strings(out.IDs)
	return out
}
