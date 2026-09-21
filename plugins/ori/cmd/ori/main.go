package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	assets "github.com/blackbone/codex-marketplace/plugins/ori"
	"github.com/blackbone/codex-marketplace/plugins/ori/internal/ori"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if e := run(ctx, os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, "ori:", e)
		os.Exit(1)
	}
}
func flags(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(os.Stderr)
	return f
}
func parse(f *flag.FlagSet, args []string) error {
	if e := f.Parse(args); e != nil {
		return e
	}
	if f.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(f.Args(), " "))
	}
	return nil
}
func readJSON(file string, v any) error {
	if file == "" {
		return errors.New("--file or --projection is required")
	}
	var r io.Reader = os.Stdin
	if file != "-" {
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		defer f.Close()
		r = f
	}
	b, e := io.ReadAll(io.LimitReader(r, 64<<20+1))
	if e != nil {
		return e
	}
	if len(b) > 64<<20 {
		return errors.New("JSON file exceeds 64 MiB")
	}
	return ori.Decode(b, v)
}
func run(ctx context.Context, args []string, out io.Writer) error {
	global := flags("ori")
	root := global.String("root", ".", "Git repository with Ori configuration")
	if e := global.Parse(args); e != nil {
		return e
	}
	args = global.Args()
	emit := func(v any) error { enc := json.NewEncoder(out); enc.SetIndent("", "  "); return enc.Encode(v) }
	if len(args) == 0 || args[0] == "help" {
		_, e := fmt.Fprintln(out, `Ori — graph → projection → sources

ori [--root REPO] COMMAND [OPTIONS]
  install                      Install Ori setup and chat instructions in this repo
  init                         Initialize or repair local Ori scaffolding
  doctor                       Check graph, setup files and Git ignore rules
  graph [--ref working|REF]     Read the validated graph snapshot
  validate                     Validate the working graph
  find --query TEXT [--lexical] Search components and entities
  impact --ids ID,ID           Follow links, owners and constraints
  project --id ID [--out FILE] Export a portable immutable projection
  change propose --file JSON   Stage a graph changeset
  change review --id ID --file JSON
  change apply --id ID         Apply a reviewed, current changeset
  change list|show --id ID|recover
  build --projection FILE --source REPO [--base REF] [--previous FILE]
  status                       Show graph, changes and source runs
  model                        Download and verify the local search model
  web [--port PORT] [--no-open] Run local web UI in foreground
  open                         Start/reuse a background local web UI
  mcp                          Run the stdio MCP server
  hook                         Read lifecycle event JSON and emit chat context
  version                      Print version

All data commands return JSON. Use --root before the command.`)
		return e
	}
	command, rest := args[0], args[1:]
	if command == "hook" {
		if len(rest) != 0 {
			return errors.New("hook takes no options")
		}
		return ori.HookContext(ctx, os.Stdin, out)
	}
	if command == "version" {
		if len(rest) != 0 {
			return errors.New("version takes no options")
		}
		return emit(map[string]string{"version": ori.Version})
	}
	if command == "mcp" {
		if len(rest) != 0 {
			return errors.New("mcp takes no options")
		}
		return ori.ServeMCP(ctx, *root, os.Stdin, out)
	}
	if command == "init" || command == "install" {
		if len(rest) > 0 {
			return fmt.Errorf("%s takes no options", command)
		}
		w, e := ori.Init(*root)
		if e != nil {
			return e
		}
		if command == "install" {
			report, err := w.Doctor()
			if err != nil {
				return err
			}
			if err = emit(report); err != nil {
				return err
			}
			if !report.Ready {
				return errors.New("project setup needs attention; inspect failed checks above")
			}
			return nil
		}
		return emit(map[string]any{"root": w.Root, "config": w.Config})
	}
	if command == "model" {
		if len(rest) > 0 {
			return errors.New("model takes no options")
		}
		p, e := ori.DownloadModel(ctx)
		if e != nil {
			return e
		}
		return emit(map[string]string{"path": p, "fingerprint": ori.EmbeddingFingerprint})
	}
	w, e := ori.Open(*root)
	if e != nil {
		return e
	}
	switch command {
	case "doctor":
		if len(rest) != 0 {
			return errors.New("doctor takes no options")
		}
		report, err := w.Doctor()
		if err != nil {
			return err
		}
		if err = emit(report); err != nil {
			return err
		}
		if !report.Ready {
			return errors.New("project setup needs attention; run ori init to repair scaffolding and inspect failed checks")
		}
		return nil
	case "graph", "validate":
		f := flags(command)
		ref := f.String("ref", "working", "Git ref or working")
		if e = parse(f, rest); e != nil {
			return e
		}
		s, e := w.Snapshot(*ref)
		if e != nil {
			return e
		}
		if command == "validate" {
			return emit(map[string]any{"valid": true, "revision": s.Revision, "entities": len(s.Entities), "components": len(s.Components), "relations": len(s.Relations)})
		}
		return emit(s)
	case "find":
		f := flags(command)
		q := f.String("query", "", "Search text")
		limit := f.Int("limit", 20, "Maximum results")
		lexical := f.Bool("lexical", false, "Skip local embeddings")
		ref := f.String("ref", "working", "Git ref or working")
		if e = parse(f, rest); e != nil {
			return e
		}
		s, e := w.Snapshot(*ref)
		if e != nil {
			return e
		}
		v, e := w.Search(ctx, s, *q, *limit, *lexical)
		if e != nil {
			return e
		}
		return emit(v)
	case "impact":
		f := flags(command)
		ids := f.String("ids", "", "Comma-separated entity/component IDs")
		max := f.Int("limit", 1000, "Maximum affected nodes")
		if e = parse(f, rest); e != nil {
			return e
		}
		if *ids == "" || *max < 1 {
			return errors.New("impact requires IDs and a positive limit")
		}
		s, e := w.Snapshot("working")
		if e != nil {
			return e
		}
		return emit(ori.FindImpact(s, strings.Split(*ids, ","), *max))
	case "project":
		f := flags(command)
		id := f.String("id", "all", "Projection selector ID")
		ref := f.String("ref", "working", "Git ref or working")
		file := f.String("out", "", "Output JSON file")
		if e = parse(f, rest); e != nil {
			return e
		}
		s, e := w.Snapshot(*ref)
		if e != nil {
			return e
		}
		p, e := ori.Project(s, *id)
		if e != nil {
			return e
		}
		if *file != "" {
			if e = ori.AtomicWrite(*file, ori.JSON(p)); e != nil {
				return e
			}
			return emit(map[string]string{"path": *file, "digest": p.Digest, "graphRevision": p.GraphRevision})
		}
		return emit(p)
	case "change":
		if len(rest) == 0 {
			return errors.New("change requires propose, review, apply, list, show or recover")
		}
		sub := rest[0]
		f := flags("change " + sub)
		id := f.String("id", "", "Changeset ID")
		file := f.String("file", "", "Request JSON file, or - for stdin")
		if e = parse(f, rest[1:]); e != nil {
			return e
		}
		switch sub {
		case "propose":
			var req ori.ChangeRequest
			if e = readJSON(*file, &req); e != nil {
				return e
			}
			v, e := w.ProposeChange(ctx, req)
			if e != nil {
				return e
			}
			return emit(v)
		case "review":
			var req ori.ReviewRequest
			if e = readJSON(*file, &req); e != nil {
				return e
			}
			v, e := w.ReviewChange(ctx, *id, req)
			if e != nil {
				return e
			}
			return emit(v)
		case "apply":
			v, e := w.ApplyChange(ctx, *id)
			if e != nil {
				return e
			}
			return emit(v)
		case "list":
			v, e := w.Records("changes")
			if e != nil {
				return e
			}
			return emit(v)
		case "show":
			var v ori.Change
			if e = w.Record("changes", *id, &v); e != nil {
				return e
			}
			return emit(v)
		case "recover":
			if e = w.RecoverChanges(ctx); e != nil {
				return e
			}
			return emit(map[string]bool{"recovered": true})
		default:
			return errors.New("unknown change command")
		}
	case "build":
		f := flags(command)
		file := f.String("projection", "", "Portable projection JSON file")
		source := f.String("source", "", "Target source Git repository")
		base := f.String("base", "HEAD", "Source Git base ref")
		previous := f.String("previous", "", "Previous projection for accumulated diff")
		intent := f.String("intent", "", "Human clarification or answers for this run")
		if e = parse(f, rest); e != nil {
			return e
		}
		var p ori.Projection
		if e = readJSON(*file, &p); e != nil {
			return e
		}
		req := ori.BuildRequest{Projection: p, SourceRoot: *source, BaseRef: *base, Intent: *intent}
		if *previous != "" {
			var p ori.Projection
			if e = readJSON(*previous, &p); e != nil {
				return e
			}
			req.Previous = &p
		}
		v, e := w.Build(ctx, req)
		if e != nil {
			_ = emit(v)
			return e
		}
		return emit(v)
	case "status":
		if len(rest) != 0 {
			return errors.New("status takes no options")
		}
		v, e := w.State()
		if e != nil {
			return e
		}
		return emit(v)
	case "web":
		f := flags(command)
		port := f.Int("port", 0, "Local port, 0 selects free")
		noOpen := f.Bool("no-open", false, "Do not launch a browser")
		if e = parse(f, rest); e != nil {
			return e
		}
		return w.Serve(ctx, assets.Web(), *port, !*noOpen, func(i ori.WebInfo) { _ = emit(map[string]any{"url": i.OpenURL(), "pid": i.PID}) })
	case "open":
		if len(rest) != 0 {
			return errors.New("open takes no options")
		}
		info, e := w.StartWeb(ctx)
		if e != nil {
			return e
		}
		_ = ori.OpenBrowser(info.OpenURL())
		return emit(map[string]any{"url": info.OpenURL(), "pid": info.PID})
	default:
		return fmt.Errorf("unknown command %q; run ori help", command)
	}
}
