package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	maxReadBytes   = 2 * 1024 * 1024
	maxWriteBytes  = 2 * 1024 * 1024
	maxListEntries = 500
	maxTreeDepth   = 8
	maxTreeNodes   = 2000
)

// WorkspaceFS provides sandboxed file access under a single root directory.
type WorkspaceFS struct {
	root string
}

func newWorkspaceFS(root string) (*WorkspaceFS, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("workspace path: %w", err)
	}
	info, err := os.Stat(absRoot)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a directory", absRoot)
	}
	return &WorkspaceFS{root: absRoot}, nil
}

func (w *WorkspaceFS) Root() string { return w.root }

func pathWithinRoot(path, root string) bool {
	path = filepath.Clean(path)
	root = filepath.Clean(root)
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

func (w *WorkspaceFS) resolve(rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		rel = "."
	}
	rel = filepath.FromSlash(rel)
	rootAbs, err := filepath.Abs(w.root)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(rel) {
		absolute := filepath.Clean(rel)
		if !pathWithinRoot(absolute, rootAbs) {
			return "", fmt.Errorf("absolute path %q is outside workspace %q", absolute, rootAbs)
		}
		rel, err = filepath.Rel(rootAbs, absolute)
		if err != nil {
			return "", err
		}
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}

	abs, err := filepath.Abs(filepath.Join(rootAbs, clean))
	if err != nil {
		return "", err
	}
	if !pathWithinRoot(abs, rootAbs) {
		return "", fmt.Errorf("path escapes workspace")
	}

	if _, err := os.Lstat(abs); err == nil {
		real, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return "", err
		}
		real, err = filepath.Abs(real)
		if err != nil {
			return "", err
		}
		if !pathWithinRoot(real, rootAbs) {
			return "", fmt.Errorf("path escapes workspace")
		}
		return real, nil
	}
	return abs, nil
}

func (w *WorkspaceFS) RelPath(abs string) string {
	rel, err := filepath.Rel(w.root, abs)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

func (w *WorkspaceFS) ReadRaw(path string) ([]byte, error) {
	abs, err := w.resolve(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%q is a directory", path)
	}
	if info.Size() > maxReadBytes {
		return nil, fmt.Errorf("file too large (%d bytes, max %d)", info.Size(), maxReadBytes)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("file is not valid UTF-8 text")
	}
	return data, nil
}

func (w *WorkspaceFS) ReadFile(path string) (string, error) {
	data, err := w.ReadRaw(path)
	if err != nil {
		return "", err
	}
	rel := w.RelPath(mustAbs(w.root, path))
	if rel == "" {
		rel = filepath.Base(path)
	}
	return fmt.Sprintf("File: %s (%d bytes)\n\n%s", rel, len(data), string(data)), nil
}

func mustAbs(root, path string) string {
	abs, err := filepath.Abs(filepath.Join(root, path))
	if err != nil {
		return path
	}
	return abs
}

func (w *WorkspaceFS) WriteFile(path, content string, appendMode bool) (string, error) {
	if len(content) > maxWriteBytes {
		return "", fmt.Errorf("content too large (%d bytes, max %d)", len(content), maxWriteBytes)
	}
	abs, err := w.resolve(path)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(abs); err == nil && info.IsDir() {
		return "", fmt.Errorf("%q is a directory", path)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}

	flags := os.O_WRONLY | os.O_CREATE
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(abs, flags, 0o644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	n, err := io.WriteString(f, content)
	if err != nil {
		return "", err
	}
	action := "Wrote"
	if appendMode {
		action = "Appended"
	}
	rel := w.RelPath(abs)
	if rel == "" {
		rel = filepath.Base(abs)
	}
	return fmt.Sprintf("%s %d bytes to %s", action, n, rel), nil
}

// EditFile replaces oldStr with newStr in a file. If replaceAll is false, oldStr
// must appear exactly once.
func (w *WorkspaceFS) EditFile(path, oldStr, newStr string, replaceAll bool) (string, error) {
	data, err := w.ReadRaw(path)
	if err != nil {
		return "", err
	}
	content := string(data)
	if oldStr == "" {
		return "", fmt.Errorf("old_string is required")
	}
	count := strings.Count(content, oldStr)
	if count == 0 {
		return "", fmt.Errorf("old_string not found in %s", path)
	}
	if !replaceAll && count > 1 {
		return "", fmt.Errorf("old_string found %d times; set replace_all or make it unique", count)
	}
	var updated string
	if replaceAll {
		updated = strings.ReplaceAll(content, oldStr, newStr)
	} else {
		updated = strings.Replace(content, oldStr, newStr, 1)
	}
	msg, err := w.WriteFile(path, updated, false)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Edited %s (%d replacement(s)). %s", path, count, msg), nil
}

func (w *WorkspaceFS) Delete(path string) error {
	abs, err := w.resolve(path)
	if err != nil {
		return err
	}
	rootAbs, _ := filepath.Abs(w.root)
	if abs == rootAbs {
		return fmt.Errorf("cannot delete workspace root")
	}
	return os.RemoveAll(abs)
}

func (w *WorkspaceFS) Mkdir(path string) error {
	abs, err := w.resolve(path)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o755)
}

func (w *WorkspaceFS) Rename(from, to string) error {
	absFrom, err := w.resolve(from)
	if err != nil {
		return err
	}
	absTo, err := w.resolve(to)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(absTo), 0o755); err != nil {
		return err
	}
	return os.Rename(absFrom, absTo)
}

// DirEntry is a structured directory entry.
type DirEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"` // "file" or "dir"
	Path string `json:"path"`
}

func (w *WorkspaceFS) ListDirEntries(path string) (string, []DirEntry, error) {
	abs, err := w.resolve(path)
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() {
		return "", nil, fmt.Errorf("%q is not a directory", path)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return "", nil, err
	}
	rel := w.RelPath(abs)
	if rel == "" {
		rel = "."
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldHide(name) {
			continue
		}
		kind := "file"
		if entry.IsDir() {
			kind = "dir"
		}
		child := name
		if rel != "." {
			child = rel + "/" + name
		}
		out = append(out, DirEntry{Name: name, Kind: kind, Path: child})
	}
	return rel, out, nil
}

func (w *WorkspaceFS) ListDir(path string) (string, error) {
	rel, entries, err := w.ListDirEntries(path)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Directory: %s (%d entries)\n\n", rel, len(entries))
	limit := len(entries)
	if limit > maxListEntries {
		limit = maxListEntries
	}
	for i := 0; i < limit; i++ {
		fmt.Fprintf(&b, "- %s (%s)\n", entries[i].Name, entries[i].Kind)
	}
	if len(entries) > maxListEntries {
		fmt.Fprintf(&b, "\n… %d more entries not shown", len(entries)-maxListEntries)
	}
	return b.String(), nil
}

// TreeNode is a recursive directory tree node for the explorer.
type TreeNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"`
	Kind     string      `json:"kind"`
	Children []*TreeNode `json:"children,omitempty"`
}

func shouldHide(name string) bool {
	switch name {
	case ".git", "node_modules", ".venv", "__pycache__", ".DS_Store":
		return true
	default:
		return false
	}
}

func (w *WorkspaceFS) Tree(path string, depth int) (*TreeNode, error) {
	if depth <= 0 {
		depth = maxTreeDepth
	}
	abs, err := w.resolve(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	rel := w.RelPath(abs)
	name := filepath.Base(abs)
	if rel == "" {
		name = filepath.Base(w.root)
		rel = ""
	}
	root := &TreeNode{Name: name, Path: rel, Kind: "dir"}
	if !info.IsDir() {
		root.Kind = "file"
		return root, nil
	}
	count := 0
	var walk func(node *TreeNode, absPath string, d int) error
	walk = func(node *TreeNode, absPath string, d int) error {
		if d <= 0 || count >= maxTreeNodes {
			return nil
		}
		entries, err := os.ReadDir(absPath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if count >= maxTreeNodes {
				break
			}
			name := entry.Name()
			if shouldHide(name) {
				continue
			}
			childRel := name
			if node.Path != "" {
				childRel = node.Path + "/" + name
			}
			child := &TreeNode{Name: name, Path: childRel}
			if entry.IsDir() {
				child.Kind = "dir"
				count++
				if err := walk(child, filepath.Join(absPath, name), d-1); err != nil {
					return err
				}
			} else {
				child.Kind = "file"
				count++
			}
			node.Children = append(node.Children, child)
		}
		return nil
	}
	if err := walk(root, abs, depth); err != nil {
		return nil, err
	}
	return root, nil
}

// Grep searches files under path for a substring (case-insensitive optional).
func (w *WorkspaceFS) Grep(query, path string, caseSensitive bool, maxHits int) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query is required")
	}
	if maxHits <= 0 {
		maxHits = 50
	}
	abs, err := w.resolve(path)
	if err != nil {
		return "", err
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	var hits []string
	err = filepath.Walk(abs, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		if info.IsDir() {
			if shouldHide(info.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Size() > maxReadBytes || info.Size() == 0 {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil || !utf8.Valid(data) {
			return nil
		}
		rel := w.RelPath(p)
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			hay := line
			if !caseSensitive {
				hay = strings.ToLower(line)
			}
			if strings.Contains(hay, needle) {
				trimmed := strings.TrimRight(line, "\r")
				if len(trimmed) > 200 {
					trimmed = trimmed[:200] + "…"
				}
				hits = append(hits, fmt.Sprintf("%s:%d:%s", rel, i+1, trimmed))
				if len(hits) >= maxHits {
					return io.EOF
				}
			}
		}
		return nil
	})
	if err != nil && err != io.EOF {
		return "", err
	}
	if len(hits) == 0 {
		return fmt.Sprintf("No matches for %q", query), nil
	}
	return fmt.Sprintf("Found %d match(es) for %q:\n\n%s", len(hits), query, strings.Join(hits, "\n")), nil
}
