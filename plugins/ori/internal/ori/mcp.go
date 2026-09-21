package ori

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	schema "github.com/santhosh-tekuri/jsonschema/v6"
)

type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations"`
}

func toolCatalog() []toolDef {
	str := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	obj := func(props map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": append([]string{}, required...), "additionalProperties": false}
	}
	makeTool := func(name, description string, readOnly bool, props map[string]any, required ...string) toolDef {
		props["root"] = str("Path to target Git repository. Defaults to MCP working directory.")
		return toolDef{Name: name, Description: description, InputSchema: obj(props, required...), Annotations: map[string]any{"readOnlyHint": readOnly, "destructiveHint": !readOnly, "openWorldHint": name == "ori_build"}}
	}
	stringsArray := map[string]any{"type": "array", "items": map[string]any{"type": "string", "minLength": 1}}
	change := obj(map[string]any{
		"intent": str("Requested product change"), "baseRevision": str("Exact observed graph revision"),
		"operations": map[string]any{"type": "array", "minItems": 1, "maxItems": 1000, "items": obj(map[string]any{
			"path": str("Path relative to graph directory"), "content": str("Complete replacement file content"), "delete": map[string]any{"type": "boolean"},
		}, "path")},
	}, "intent", "baseRevision", "operations")
	review := obj(map[string]any{
		"baseRevision": str("Exact proposal base revision"), "proposalDigest": str("Exact proposal digest"),
		"reviewer": str("Reviewing agent or person identity"), "summary": str("Semantic review evidence and conclusion"),
		"approved": map[string]any{"type": "boolean"}, "questions": stringsArray,
	}, "baseRevision", "proposalDigest", "reviewer", "summary", "approved")
	build := obj(map[string]any{
		"projection": map[string]any{"type": "object", "description": "Complete portable projection returned by ori_project"},
		"sourceRoot": str("Target source Git repository"), "baseRef": str("Source base ref, default HEAD"),
		"previous": map[string]any{"type": []string{"object", "null"}}, "intent": str("Human clarification or answers"),
	}, "projection", "sourceRoot")
	return []toolDef{
		makeTool("ori_init", "Initialize or repair local Ori scaffolding in an existing Git repository. Preserves existing graph/configuration. A fresh setup refuses a graph directory collision.", false, map[string]any{}),
		makeTool("ori_doctor", "Read-only readiness check of Ori project scaffolding, graph validity and actual Git ignore behavior. Does not download a model or build an index.", true, map[string]any{}),
		makeTool("ori_graph", "Read validated Git-backed entities, components, typed links, selectors and source files at a working or committed snapshot.", true, map[string]any{"ref": str("working or Git ref")}),
		makeTool("ori_find", "Search current graph using local semantic embeddings and SQLite FTS5. First semantic use downloads the pinned model (~487 MB); no graph text leaves the machine.", true, map[string]any{"query": str("Search query"), "lexical": map[string]any{"type": "boolean"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, "query"),
		makeTool("ori_impact", "Trace graph links, ownership and constraints from selected IDs. Inspect truncated before deciding scope.", true, map[string]any{"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 1}}, "ids"),
		makeTool("ori_project", "Materialize a portable projection bound to the exact graph snapshot, with its source files and content digest.", true, map[string]any{"id": str("Projection selector ID, default all"), "ref": str("working or Git ref")}),
		makeTool("ori_change_propose", "Validate and stage graph-file operations without applying them. request: intent, baseRevision, operations [{path,content,delete}]. Paths are relative to graph directory.", false, map[string]any{"request": change}, "request"),
		makeTool("ori_change_review", "Record an actual consistency review, bound to baseRevision and proposalDigest. Review: reviewer, summary, approved, questions. Unresolved questions prevent apply. Read proposal and affected context before approving; schema validity alone is not a semantic review.", false, map[string]any{"id": str("Changeset ID"), "review": review}, "id", "review"),
		makeTool("ori_change_apply", "Apply a reviewed changeset only if its graph base is still current. Uses a recoverable journal; never commits or pushes.", false, map[string]any{"id": str("Changeset ID")}, "id"),
		makeTool("ori_status", "Read graph plus recent changesets and source execution receipts. generated/verified apply to recorded inputs, not automatically to current graph.", true, map[string]any{}),
		makeTool("ori_open", "Start or reuse the local Ori web UI. Return authenticated loopback URL to open in browser.", false, map[string]any{}),
		makeTool("ori_build", "Execute source generation from a validated portable projection in an isolated Git worktree. Runs configured executor/check commands; explicitly request this only after examining configuration. Can take many minutes; CLI is preferable for long runs. No checks means generated, not verified.", false, map[string]any{"request": build}, "request"),
	}
}

type toolInputError struct{ err error }

func (e *toolInputError) Error() string { return e.err.Error() }

var toolSchemas struct {
	sync.Once
	items map[string]*schema.Schema
	err   error
}

func validateToolCall(name string, raw json.RawMessage) error {
	toolSchemas.Do(func() {
		toolSchemas.items = map[string]*schema.Schema{}
		for _, tool := range toolCatalog() {
			compiler := schema.NewCompiler()
			// Round-trip to JSON's native types, as required by the schema compiler.
			var document any
			if toolSchemas.err = json.Unmarshal(JSON(tool.InputSchema), &document); toolSchemas.err != nil {
				return
			}
			url := "https://ori.invalid/tools/" + tool.Name
			if toolSchemas.err = compiler.AddResource(url, document); toolSchemas.err != nil {
				return
			}
			var compiled *schema.Schema
			compiled, toolSchemas.err = compiler.Compile(url)
			if toolSchemas.err != nil {
				return
			}
			toolSchemas.items[tool.Name] = compiled
		}
	})
	if toolSchemas.err != nil {
		return toolSchemas.err
	}
	validator, exists := toolSchemas.items[name]
	if !exists {
		return &toolInputError{fmt.Errorf("unknown tool %q", name)}
	}
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var args any
	if err := json.Unmarshal(raw, &args); err != nil {
		return &toolInputError{err}
	}
	if err := validator.Validate(args); err != nil {
		return &toolInputError{fmt.Errorf("invalid arguments for %s: %w", name, err)}
	}
	return nil
}

type toolArgs struct {
	Root    string          `json:"root"`
	Ref     string          `json:"ref"`
	Query   string          `json:"query"`
	Lexical bool            `json:"lexical"`
	Limit   int             `json:"limit"`
	IDs     []string        `json:"ids"`
	ID      string          `json:"id"`
	Request json.RawMessage `json:"request"`
	Review  json.RawMessage `json:"review"`
}

func callTool(ctx context.Context, defaultRoot, name string, raw json.RawMessage) (any, error) {
	if err := validateToolCall(name, raw); err != nil {
		return nil, err
	}
	var a toolArgs
	if len(raw) > 0 {
		if e := Decode(raw, &a); e != nil {
			return nil, e
		}
	}
	if a.Root == "" {
		a.Root = defaultRoot
	}
	if name == "ori_init" {
		w, e := Init(a.Root)
		if e != nil {
			return nil, e
		}
		return map[string]any{"root": w.Root, "config": w.Config}, nil
	}
	w, e := Open(a.Root)
	if e != nil {
		return nil, e
	}
	switch name {
	case "ori_doctor":
		return w.Doctor()
	case "ori_graph":
		return w.Snapshot(a.Ref)
	case "ori_find":
		s, e := w.Snapshot("working")
		if e != nil {
			return nil, e
		}
		if a.Limit == 0 {
			a.Limit = 20
		}
		return w.Search(ctx, s, a.Query, a.Limit, a.Lexical)
	case "ori_impact":
		if len(a.IDs) == 0 {
			return nil, errors.New("ids required")
		}
		s, e := w.Snapshot("working")
		if e != nil {
			return nil, e
		}
		return FindImpact(s, a.IDs, 1000), nil
	case "ori_project":
		s, e := w.Snapshot(a.Ref)
		if e != nil {
			return nil, e
		}
		if a.ID == "" {
			a.ID = "all"
		}
		return Project(s, a.ID)
	case "ori_change_propose":
		var req ChangeRequest
		if e = Decode(a.Request, &req); e != nil {
			return nil, e
		}
		return w.ProposeChange(ctx, req)
	case "ori_change_review":
		var req ReviewRequest
		if e = Decode(a.Review, &req); e != nil {
			return nil, e
		}
		return w.ReviewChange(ctx, a.ID, req)
	case "ori_change_apply":
		return w.ApplyChange(ctx, a.ID)
	case "ori_status":
		return w.State()
	case "ori_open":
		info, e := w.StartWeb(ctx)
		if e != nil {
			return nil, e
		}
		return map[string]any{"url": info.OpenURL(), "pid": info.PID}, nil
	case "ori_build":
		var req BuildRequest
		if e = Decode(a.Request, &req); e != nil {
			return nil, e
		}
		return w.Build(ctx, req)
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

// ServeMCP uses MCP's newline-delimited stdio transport. Logs go to stderr only.
func ServeMCP(ctx context.Context, root string, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), 64<<20)
	encoder := json.NewEncoder(out)
	for scanner.Scan() {
		if e := ctx.Err(); e != nil {
			return e
		}
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if !json.Valid(scanner.Bytes()) {
			e := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}})
			if e != nil {
				return e
			}
			continue
		}
		invalidRequest := json.Unmarshal(scanner.Bytes(), &req) != nil || req.JSONRPC != "2.0" || req.Method == ""
		if len(req.ID) != 0 {
			var id any
			if json.Unmarshal(req.ID, &id) != nil {
				invalidRequest = true
			}
			switch id.(type) {
			case nil, string, float64:
			default:
				invalidRequest = true
				req.ID = nil
			}
		}
		if invalidRequest {
			var id any
			if len(req.ID) != 0 {
				id = req.ID
			}
			e := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32600, "message": "Invalid Request"}})
			if e != nil {
				return e
			}
			continue
		}
		if len(req.ID) == 0 {
			// Notifications never execute request methods or receive responses.
			continue
		}
		response := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		var result any
		var rpcError any
		var params map[string]json.RawMessage
		if len(req.Params) != 0 {
			if e := json.Unmarshal(req.Params, &params); e != nil || params == nil {
				rpcError = map[string]any{"code": -32602, "message": "Params must be an object"}
			}
		}
		if rpcError == nil {
			switch req.Method {
			case "initialize":
				var p struct {
					ProtocolVersion string `json:"protocolVersion"`
				}
				if e := json.Unmarshal(req.Params, &p); e != nil || p.ProtocolVersion == "" {
					rpcError = map[string]any{"code": -32602, "message": "initialize requires a protocolVersion string"}
					break
				}
				version := p.ProtocolVersion
				switch version {
				case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25":
				default:
					version = "2025-06-18"
				}
				result = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]bool{"listChanged": false}}, "serverInfo": map[string]string{"name": "ori", "version": Version}, "instructions": "Graph files in Git are authoritative. Search and inspect affected context before proposing changes. Semantic review is a deliberate agent/human action. Source receipts are tied to immutable inputs."}
			case "ping":
				result = map[string]any{}
			case "tools/list":
				result = map[string]any{"tools": toolCatalog()}
			case "tools/call":
				var p struct {
					Name      string                     `json:"name"`
					Arguments json.RawMessage            `json:"arguments"`
					Meta      map[string]json.RawMessage `json:"_meta,omitempty"`
				}
				if e := Decode(req.Params, &p); e != nil || p.Name == "" {
					rpcError = map[string]any{"code": -32602, "message": "tools/call requires name and valid arguments"}
					break
				}
				v, e := callTool(ctx, root, p.Name, p.Arguments)
				var invalid *toolInputError
				if errors.As(e, &invalid) {
					rpcError = map[string]any{"code": -32602, "message": e.Error()}
					break
				}
				content := ""
				if e != nil {
					content = e.Error()
				} else {
					content = string(JSON(v))
				}
				result = map[string]any{"content": []map[string]string{{"type": "text", "text": content}}, "isError": e != nil}
			default:
				rpcError = map[string]any{"code": -32601, "message": "Method not found"}
			}
		}
		if rpcError != nil {
			response["error"] = rpcError
		} else {
			response["result"] = result
		}
		if e := encoder.Encode(response); e != nil {
			return e
		}
	}
	return scanner.Err()
}
