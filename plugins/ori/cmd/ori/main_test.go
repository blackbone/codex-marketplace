package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/blackbone/codex-marketplace/plugins/ori/internal/ori"
)

func TestCLIInitGraphProjectAndReview(t *testing.T) {
	root := t.TempDir()
	if b, e := exec.Command("git", "-C", root, "init").CombinedOutput(); e != nil {
		t.Fatalf("git: %s %v", b, e)
	}
	call := func(args ...string) []byte {
		t.Helper()
		var out bytes.Buffer
		if e := run(context.Background(), append([]string{"--root", root}, args...), &out); e != nil {
			t.Fatalf("%v: %v %s", args, e, &out)
		}
		return out.Bytes()
	}
	call("init")
	var health ori.DoctorReport
	if e := json.Unmarshal(call("doctor"), &health); e != nil || !health.Ready {
		t.Fatalf("doctor: %+v %v", health, e)
	}
	if e := json.Unmarshal(call("install"), &health); e != nil || !health.Ready {
		t.Fatalf("repeat install: %+v %v", health, e)
	}
	call("validate")
	var snapshot ori.Snapshot
	if e := json.Unmarshal(call("graph"), &snapshot); e != nil {
		t.Fatal(e)
	}
	proposal := ori.ChangeRequest{Intent: "Add CLI entity", BaseRevision: snapshot.Revision, Operations: []ori.Operation{{Path: "entities/cli.json", Content: string(ori.JSON(ori.Entity{ID: "cli", Name: "CLI product"}))}}}
	p := filepath.Join(root, "proposal.json")
	if e := os.WriteFile(p, ori.JSON(proposal), 0600); e != nil {
		t.Fatal(e)
	}
	var c ori.Change
	if e := json.Unmarshal(call("change", "propose", "--file", p), &c); e != nil {
		t.Fatal(e)
	}
	review := ori.ReviewRequest{BaseRevision: c.BaseRevision, ProposalDigest: c.ProposalDigest, Reviewer: "CLI test", Summary: "New independent entity and default projection remain consistent", Approved: true, Questions: []string{}}
	r := filepath.Join(root, "review.json")
	if e := os.WriteFile(r, ori.JSON(review), 0600); e != nil {
		t.Fatal(e)
	}
	call("change", "review", "--id", c.ID, "--file", r)
	call("change", "apply", "--id", c.ID)
	file := filepath.Join(root, "projection.json")
	call("project", "--out", file)
	var projection ori.Projection
	if e := readJSON(file, &projection); e != nil {
		t.Fatal(e)
	}
	if e := ori.ValidateProjection(projection); e != nil {
		t.Fatal(e)
	}
	var hits ori.SearchResult
	if e := json.Unmarshal(call("find", "--query", "CLI", "--lexical"), &hits); e != nil {
		t.Fatal(e)
	}
	if len(hits.Hits) != 1 || hits.Hits[0].ID != "cli" {
		t.Fatalf("hits: %+v", hits)
	}
	var out bytes.Buffer
	if e := run(context.Background(), []string{"--root", root, "find", "--typo"}, &out); e == nil {
		t.Fatal("unknown flag accepted")
	}
	if e := run(context.Background(), []string{"version", "unexpected"}, &out); e == nil {
		t.Fatal("extra arg accepted")
	}
}
