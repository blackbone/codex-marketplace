package ori

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func TestHTTPBoundaryAndChangeRoundTrip(t *testing.T) {
	w := newChangesWorkspace(t)
	info := WebInfo{URL: "http://127.0.0.1:9901", Token: strings.Repeat("a", 64), PID: 1, Root: w.Root}
	h := w.Handler(info, fstest.MapFS{"index.html": {Data: []byte("Ori")}}, nil)
	request := func(method, path, body, token, origin, host string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, info.URL+path, strings.NewReader(body))
		r.Host = host
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		rw := httptest.NewRecorder()
		h.ServeHTTP(rw, r)
		return rw
	}
	for _, tc := range []struct {
		path, token, origin, host string
		code                      int
	}{
		{"/api/state", "", "", "127.0.0.1:9901", 401},
		{"/api/state", info.Token, "https://evil.example", "127.0.0.1:9901", 403},
		{"/api/state", info.Token, "", "evil.example", 403},
		{"/api/state", info.Token, info.URL, "127.0.0.1:9901", 200},
		{"/", "", "", "127.0.0.1:9901", 200},
	} {
		rw := request("GET", tc.path, "", tc.token, tc.origin, tc.host)
		if rw.Code != tc.code {
			t.Fatalf("%+v: %d %s", tc, rw.Code, rw.Body)
		}
	}
	call := func(path string, v any, out any) {
		t.Helper()
		rw := request("POST", path, string(JSON(v)), info.Token, info.URL, "127.0.0.1:9901")
		if rw.Code != 200 {
			t.Fatalf("%s: %d %s", path, rw.Code, rw.Body)
		}
		if out != nil {
			if e := json.Unmarshal(rw.Body.Bytes(), out); e != nil {
				t.Fatal(e)
			}
		}
	}
	s, e := w.Snapshot("working")
	if e != nil {
		t.Fatal(e)
	}
	var c Change
	call("/api/change", ChangeRequest{Intent: "Add a new entity", BaseRevision: s.Revision, Operations: []Operation{{Path: "entities/transport.json", Content: string(JSON(Entity{ID: "transport", Name: "Transport"}))}}}, &c)
	badReview := request("POST", "/api/change/review", string(JSON(map[string]any{"id": c.ID, "baseRevision": c.BaseRevision, "proposalDigest": "wrong", "reviewer": "r", "summary": "s", "approved": true})), info.Token, info.URL, "127.0.0.1:9901")
	if badReview.Code != http.StatusBadRequest {
		t.Fatal("HTTP review accepted a different proposal digest")
	}
	badApply := request("POST", "/api/change/apply", string(JSON(map[string]string{"id": c.ID})), info.Token, info.URL, "127.0.0.1:9901")
	if badApply.Code != http.StatusBadRequest {
		t.Fatal("HTTP applied unreviewed change")
	}
	var reviewed Change
	call("/api/change/review", map[string]any{"id": c.ID, "baseRevision": c.BaseRevision, "proposalDigest": c.ProposalDigest, "reviewer": "test-human", "summary": "Independent entity; checked no naming or relationship conflict.", "approved": true, "questions": []string{}}, &reviewed)
	if reviewed.Status != "reviewed" {
		t.Fatalf("review: %+v", reviewed)
	}
	var applied Change
	call("/api/change/apply", map[string]string{"id": c.ID}, &applied)
	if applied.Status != "applied" {
		t.Fatalf("apply: %+v", applied)
	}
	cfg := w.Config
	cfg.Embeddings.Provider = "off"
	rw := request("PUT", "/api/config", string(JSON(cfg)), info.Token, info.URL, "127.0.0.1:9901")
	if rw.Code != http.StatusOK {
		t.Fatal(rw.Body)
	}
	state, e := w.State()
	if e != nil || state.Config.Embeddings.Provider != "off" {
		t.Fatalf("fresh config: %+v %v", state.Config, e)
	}
}

func TestHTTPReadsFreshGraphConfiguration(t *testing.T) {
	w := newChangesWorkspace(t)
	info := WebInfo{URL: "http://127.0.0.1:9901", Token: strings.Repeat("a", 64), PID: 1, Root: w.Root}
	h := w.Handler(info, fstest.MapFS{"index.html": {Data: []byte("Ori")}}, nil)
	// An explicit filesystem migration may happen while the web process lives.
	if err := os.Rename(filepath.Join(w.Root, w.Config.Graph), filepath.Join(w.Root, "product-graph")); err != nil {
		t.Fatal(err)
	}
	cfg := w.Config
	cfg.Graph = "product-graph"
	if err := AtomicWrite(filepath.Join(w.Root, ".ori/config.json"), JSON(cfg)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/projection?id=all", "/api/impact?ids=product", "/api/state", "/api/search?q=product&lexical=true"} {
		r := httptest.NewRequest("GET", info.URL+path, nil)
		r.Header.Set("Authorization", "Bearer "+info.Token)
		rw := httptest.NewRecorder()
		h.ServeHTTP(rw, r)
		if rw.Code != http.StatusOK {
			t.Fatalf("%s: stale config response: %d %s", path, rw.Code, rw.Body)
		}
	}
}

func TestHTTPRejectsMalformedWritesAndStaticMethods(t *testing.T) {
	w := newChangesWorkspace(t)
	info := WebInfo{URL: "http://127.0.0.1:9901", Token: strings.Repeat("a", 64), PID: 1, Root: w.Root}
	h := w.Handler(info, fstest.MapFS{"index.html": {Data: []byte("Ori")}}, nil)
	for _, media := range []string{"application/json-extra", "text/plain", ""} {
		r := httptest.NewRequest("PUT", info.URL+"/api/config", strings.NewReader(string(JSON(w.Config))))
		r.Header.Set("Authorization", "Bearer "+info.Token)
		r.Header.Set("Content-Type", media)
		rw := httptest.NewRecorder()
		h.ServeHTTP(rw, r)
		if rw.Code != http.StatusBadRequest {
			t.Fatalf("accepted media type %q: %d", media, rw.Code)
		}
	}
	r := httptest.NewRequest("POST", info.URL+"/", nil)
	rw := httptest.NewRecorder()
	h.ServeHTTP(rw, r)
	if rw.Code != http.StatusMethodNotAllowed {
		t.Fatalf("static POST: %d", rw.Code)
	}
	r = httptest.NewRequest("POST", info.URL+"/api/unknown", nil)
	rw = httptest.NewRecorder()
	h.ServeHTTP(rw, r)
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("unknown API not protected: %d", rw.Code)
	}
}

func TestWebDescriptorAndHealthNeverFollowRedirects(t *testing.T) {
	w := newChangesWorkspace(t)
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		jsonResponse(rw, map[string]any{"root": w.Root, "pid": 1}, nil)
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, destination.URL+"/api/health", http.StatusFound)
	}))
	defer redirect.Close()
	info := WebInfo{URL: redirect.URL, Token: strings.Repeat("a", 64), PID: 1, Root: w.Root}
	if w.WebAlive(info) {
		t.Fatal("redirect treated as Ori health")
	}
	if hits.Load() != 0 {
		t.Fatal("bearer health request followed redirect")
	}
	for _, origin := range []string{"https://127.0.0.1:9901", "http://localhost:9901", "http://127.0.0.1:9901@evil.example", "http://127.0.0.1:9901/", "http://127.0.0.1:9901?", "http://127.0.0.1:9901/#token=x", "http://127.0.0.1:0", "http://127.0.0.1:65536"} {
		bad := info
		bad.URL = origin
		if w.validWebInfo(bad) {
			t.Errorf("accepted descriptor %s", origin)
		}
	}
	info.URL = destination.URL
	info.Token = strings.Repeat("z", 64)
	if w.validWebInfo(info) {
		t.Fatal("nonhex token accepted")
	}
}

func TestMCPSchemasAndMalformedRequests(t *testing.T) {
	for _, tool := range toolCatalog() {
		if _, ok := tool.InputSchema["required"].([]string); !ok {
			t.Fatalf("%s required is not an array", tool.Name)
		}
	}
	if err := validateToolCall("ori_graph", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, args string }{
		{"ori_graph", `{"query":"ignored before validation"}`},
		{"ori_find", `{"limit":0,"query":"q"}`},
		{"ori_impact", `{"ids":[]}`},
		{"ori_change_propose", `{"request":{"intent":"missing base","operations":[]}}`},
		{"ori_change_review", `{"id":"x","review":{"baseRevision":"b","proposalDigest":"p","reviewer":"r","summary":"s"}}`},
		{"ori_status", `null`},
		{"ori_missing", `{}`},
	} {
		if err := validateToolCall(tc.name, json.RawMessage(tc.args)); err == nil {
			t.Fatalf("accepted malformed %s %s", tc.name, tc.args)
		}
	}
	requests := []struct {
		line string
		code int
	}{
		{`{`, -32700},
		{`null`, -32600},
		{`[]`, -32600},
		{`{"id":1,"method":"ping"}`, -32600},
		{`{"jsonrpc":"2.0","id":{},"method":"ping"}`, -32600},
		{`{"jsonrpc":"2.0","id":true,"method":"ping"}`, -32600},
		{`{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}`, -32602},
		{`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":123}}`, -32602},
		{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ori_missing"}}`, -32602},
		{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ori_graph","arguments":{"query":"q"}}}`, -32602},
		{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ori_graph","arguments":null}}`, -32602},
	}
	for _, tc := range requests {
		var out bytes.Buffer
		if err := ServeMCP(context.Background(), t.TempDir(), strings.NewReader(tc.line+"\n"), &out); err != nil {
			t.Fatal(err)
		}
		var response struct {
			Error struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(out.Bytes(), &response); err != nil {
			t.Fatalf("%s: %v %s", tc.line, err, out.String())
		}
		if response.Error.Code != tc.code {
			t.Fatalf("%s: code %d, want %d: %s", tc.line, response.Error.Code, tc.code, out.String())
		}
	}
}

func TestWebStartLockIsIndependentAndCancelable(t *testing.T) {
	w := newChangesWorkspace(t)
	first, err := w.acquireWebStartLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Unlock()
	graph, err := w.AcquireGraphLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = graph.Unlock(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if second, err := w.acquireWebStartLock(ctx); err == nil {
		second.Unlock()
		t.Fatal("parallel start acquired occupied lock")
	}
	if err = first.Unlock(); err != nil {
		t.Fatal(err)
	}
	second, err := w.acquireWebStartLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = second.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestWebShutdownDescriptorOwnership(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "own descriptor removed", true: "new descriptor preserved"}[replace], func(t *testing.T) {
			w := newChangesWorkspace(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ready := make(chan WebInfo, 1)
			done := make(chan error, 1)
			go func() {
				done <- w.Serve(ctx, fstest.MapFS{"index.html": {Data: []byte("Ori")}}, 0, false, func(info WebInfo) { ready <- info })
			}()
			var info WebInfo
			select {
			case info = <-ready:
			case err := <-done:
				t.Fatalf("server exited before ready: %v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("server did not start")
			}
			if !w.WebAlive(info) {
				t.Fatal("server did not serve authenticated loopback health")
			}
			if current, err := w.StartWeb(context.Background()); err != nil || current.Token != info.Token {
				t.Fatalf("failed to reuse live server: %+v %v", current, err)
			}
			descriptor := filepath.Join(w.Root, ".ori/state/web.json")
			if replace {
				info.Token = strings.Repeat("b", 64)
				if err := AtomicWrite(descriptor, JSON(info)); err != nil {
					t.Fatal(err)
				}
			}
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(7 * time.Second):
				t.Fatal("server did not stop after cancellation")
			}
			current, err := w.WebInfo()
			if replace {
				if err != nil || current.Token != info.Token {
					t.Fatalf("shutdown removed another server descriptor: %+v %v", current, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("shutdown retained own descriptor: %+v %v", current, err)
			}
		})
	}
}

func TestMCPProtocolAndToolErrors(t *testing.T) {
	w := newChangesWorkspace(t)
	requests := []any{
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}},
		map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
		map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{"name": "ori_graph", "arguments": map[string]any{}}},
		map[string]any{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{"name": "ori_change_apply", "arguments": map[string]any{"id": "missing"}}},
		map[string]any{"jsonrpc": "2.0", "id": 5, "method": "unknown"},
	}
	var in, out bytes.Buffer
	for _, r := range requests {
		if e := json.NewEncoder(&in).Encode(r); e != nil {
			t.Fatal(e)
		}
	}
	if e := ServeMCP(context.Background(), w.Root, &in, &out); e != nil {
		t.Fatal(e)
	}
	decoder := json.NewDecoder(&out)
	responses := []map[string]any{}
	for {
		var v map[string]any
		e := decoder.Decode(&v)
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		responses = append(responses, v)
	}
	if len(responses) != 5 {
		t.Fatalf("unexpected replies: %v", responses)
	}
	if responses[0]["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatal(responses[0])
	}
	if len(responses[1]["result"].(map[string]any)["tools"].([]any)) < 10 {
		t.Fatal("missing tools")
	}
	if responses[2]["result"].(map[string]any)["isError"] != false {
		t.Fatal(responses[2])
	}
	if responses[3]["result"].(map[string]any)["isError"] != true {
		t.Fatal("tool error was not reported")
	}
	if responses[4]["error"].(map[string]any)["code"] != float64(-32601) {
		t.Fatal(responses[4])
	}
}
