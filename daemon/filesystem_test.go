package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAcceptsAbsolutePathInsideWorkspace(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "README.md")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs, err := newWorkspaceFS(root)
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := fs.resolve(file)
	if err != nil {
		t.Fatalf("resolve absolute workspace path: %v", err)
	}
	if resolved != file {
		t.Fatalf("resolved %q, want %q", resolved, file)
	}
}

func TestResolveRejectsAbsolutePathOutsideWorkspace(t *testing.T) {
	fs, err := newWorkspaceFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := fs.resolve(filepath.Join(string(filepath.Separator), "etc", "passwd")); err == nil {
		t.Fatal("expected path outside workspace to be rejected")
	}
}
