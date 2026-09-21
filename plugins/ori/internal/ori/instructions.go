package ori

import (
	"bytes"
	"fmt"
	"os"
	"strings"
)

// InstructionContext is static hook context. Repository content is never
// interpolated into it; the assistant reads applicable instructions separately.
const InstructionContext = `This repository uses Ori. Read .ori/INSTRUCTIONS.md before Ori work. Graph JSON/Markdown is the product source of truth; projections are explicit snapshots and generated sources are a separate layer. Use $ori:change for reviewed product intent changes, $ori:project for projections, and $ori:build for source generation from an explicit projection. A graph edit does not authorize source edits. Preserve the user's requested scope; explicit user instructions take precedence. Use $ori:find for context, $ori:open for the interface, and $ori:doctor for setup diagnostics.`

const oriInstructions = `# Ori project workflow

Read .ori/config.json for the graph location and project settings.

## Graph → projection → sources

The graph's JSON and Markdown files are the product source of truth. Edit product
intent through $ori:change: inspect the proposed diff, review it, and apply the
reviewed change. Preserve unrelated graph content and repository changes.

$ori:project creates an explicit, portable projection of the graph. A projection
can be consumed later or on another machine; its graph revision need not match
the current source revision. Use $ori:build with an explicit projection for source
generation. Keep graph changes and source changes within the requested scope:
a request to edit the graph does not authorize automatic source edits, commits,
merges, or deployment. Explicit user instructions take precedence.

## Skills

- $ori:install: prepare the runtime and install Ori's local project setup.
- $ori:init: restore missing setup files while preserving project content.
- $ori:doctor: diagnose setup and Git ignore rules without changing them.
- $ori:open: open the local graph and project interface.
- $ori:find: search graph context.
- $ori:change: propose, review, and apply graph changes.
- $ori:project: select and export a graph projection.
- $ori:build: generate sources from an explicit projection.
- $ori:status: inspect workspace and execution state.

Commit the graph, .ori/config.json, .ori/INSTRUCTIONS.md, .ori/README.md,
.ori/.gitignore, and repository instruction files. Keep local state, caches,
logs, binaries, and exported projections ignored by Git.
`

const oriBegin = "<!-- ori:begin -->"
const oriEnd = "<!-- ori:end -->"
const oriAgentBlock = oriBegin + `
## Ori

Read [.ori/INSTRUCTIONS.md](.ori/INSTRUCTIONS.md) before Ori work. Use $ori:change
for graph intent, $ori:project for projections, and $ori:build for source generation.
Preserve the user's requested graph/source scope; explicit user instructions win.
` + oriEnd

type instructionEdit struct {
	path    string
	before  []byte
	after   []byte
	existed bool
}

// managedInstructionBlock preserves every byte outside the owned marker pair.
func managedInstructionBlock(content []byte) ([]byte, bool, error) {
	s := string(content)
	starts, ends := strings.Count(s, oriBegin), strings.Count(s, oriEnd)
	if starts == 0 && ends == 0 && !strings.Contains(s, "<!-- ori:") {
		separator := ""
		if len(s) > 0 {
			separator = "\n"
			if !strings.HasSuffix(s, "\n") {
				separator = "\n\n"
			}
		}
		return []byte(s + separator + oriAgentBlock + "\n"), false, nil
	}
	if starts != 1 || ends != 1 || strings.Count(s, "<!-- ori:") != 2 {
		return nil, false, fmt.Errorf("malformed or duplicate Ori instruction markers")
	}
	start, end := strings.Index(s, oriBegin), strings.Index(s, oriEnd)
	standalone := func(at int, marker string) bool {
		after := s[at+len(marker):]
		return (at == 0 || s[at-1] == '\n') && (after == "" || strings.HasPrefix(after, "\n") || strings.HasPrefix(after, "\r\n"))
	}
	if end < start || !standalone(start, oriBegin) || !standalone(end, oriEnd) {
		return nil, false, fmt.Errorf("Ori instruction markers must be ordered and on separate lines")
	}
	return []byte(s[:start] + oriAgentBlock + s[end+len(oriEnd):]), true, nil
}

func prepareInstructions(root string) ([]instructionEdit, error) {
	var edits []instructionEdit
	for _, rel := range []string{"AGENTS.md", "AGENTS.override.md"} {
		path, err := SafePath(root, rel)
		if err != nil {
			return nil, err
		}
		st, err := os.Lstat(path)
		existed := err == nil
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if !existed && rel == "AGENTS.override.md" {
			continue
		}
		if existed && !st.Mode().IsRegular() {
			return nil, fmt.Errorf("expected regular instruction file: %s", rel)
		}
		var content []byte
		if existed {
			content, err = os.ReadFile(path)
			if err != nil {
				return nil, err
			}
		}
		after, _, err := managedInstructionBlock(content)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", rel, err)
		}
		edits = append(edits, instructionEdit{path: path, before: content, after: after, existed: existed})
	}
	return edits, nil
}

func applyInstructions(edits []instructionEdit) error {
	for _, edit := range edits {
		if bytes.Equal(edit.before, edit.after) {
			continue
		}
		if !edit.existed {
			if err := writeMissing(edit.path, edit.after); err != nil {
				return err
			}
			continue
		}
		current, err := os.ReadFile(edit.path)
		if err != nil {
			return err
		}
		if !bytes.Equal(current, edit.before) {
			return fmt.Errorf("instruction file changed during initialization: %s; retry ori init", edit.path)
		}
		if err := AtomicWrite(edit.path, edit.after); err != nil {
			return err
		}
	}
	return nil
}
