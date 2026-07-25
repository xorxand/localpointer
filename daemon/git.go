package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// GitRepo wraps git CLI operations scoped to a workspace root.
type GitRepo struct {
	root string
}

func newGitRepo(root string) *GitRepo {
	return &GitRepo{root: root}
}

func (g *GitRepo) run(ctx context.Context, args ...string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = g.root
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

func (g *GitRepo) IsRepo(ctx context.Context) bool {
	out, err := g.run(ctx, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

func (g *GitRepo) Root(ctx context.Context) (string, error) {
	out, err := g.run(ctx, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return filepath.Clean(out), nil
}

type GitStatus struct {
	IsRepo   bool     `json:"is_repo"`
	Branch   string   `json:"branch"`
	Upstream string   `json:"upstream,omitempty"`
	Ahead    int      `json:"ahead"`
	Behind   int      `json:"behind"`
	Staged   []string `json:"staged"`
	Changed  []string `json:"changed"`
	Untracked []string `json:"untracked"`
	Clean    bool     `json:"clean"`
}

func (g *GitRepo) Status(ctx context.Context) (GitStatus, error) {
	var st GitStatus
	if !g.IsRepo(ctx) {
		return st, nil
	}
	st.IsRepo = true

	branch, err := g.run(ctx, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		st.Branch = "HEAD"
	} else {
		st.Branch = branch
	}

	porcelain, err := g.run(ctx, "status", "--porcelain=v1", "-uall")
	if err != nil {
		return st, err
	}
	for _, line := range strings.Split(porcelain, "\n") {
		if line == "" {
			continue
		}
		if len(line) < 3 {
			continue
		}
		xy := line[:2]
		path := strings.TrimSpace(line[3:])
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		switch {
		case xy == "??":
			st.Untracked = append(st.Untracked, path)
		case xy[0] != ' ' && xy[0] != '?':
			st.Staged = append(st.Staged, path)
			if xy[1] != ' ' && xy[1] != '?' {
				st.Changed = append(st.Changed, path)
			}
		default:
			st.Changed = append(st.Changed, path)
		}
	}
	st.Clean = len(st.Staged) == 0 && len(st.Changed) == 0 && len(st.Untracked) == 0

	// ahead/behind vs upstream if set
	if up, err := g.run(ctx, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
		st.Upstream = up
		counts, err := g.run(ctx, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
		if err == nil {
			var a, b int
			fmt.Sscanf(counts, "%d\t%d", &a, &b)
			st.Ahead, st.Behind = a, b
		}
	}
	return st, nil
}

func (g *GitRepo) Diff(ctx context.Context, staged bool, path string) (string, error) {
	args := []string{"diff", "--no-color"}
	if staged {
		args = append(args, "--cached")
	}
	if strings.TrimSpace(path) != "" {
		args = append(args, "--", path)
	}
	out, err := g.run(ctx, args...)
	if err != nil {
		return "", err
	}
	if out == "" {
		return "(no diff)", nil
	}
	return out, nil
}

func (g *GitRepo) Log(ctx context.Context, n int) (string, error) {
	if n <= 0 {
		n = 20
	}
	return g.run(ctx, "log", fmt.Sprintf("-%d", n), "--pretty=format:%h %ad %an %s", "--date=short")
}

func (g *GitRepo) Stage(ctx context.Context, paths []string) error {
	if len(paths) == 0 {
		_, err := g.run(ctx, "add", "-A")
		return err
	}
	args := append([]string{"add", "--"}, paths...)
	_, err := g.run(ctx, args...)
	return err
}

func (g *GitRepo) Unstage(ctx context.Context, paths []string) error {
	args := []string{"restore", "--staged"}
	if len(paths) == 0 {
		args = append(args, ".")
	} else {
		args = append(args, "--")
		args = append(args, paths...)
	}
	_, err := g.run(ctx, args...)
	return err
}

func (g *GitRepo) Commit(ctx context.Context, message string) (string, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return "", fmt.Errorf("commit message is required")
	}
	out, err := g.run(ctx, "commit", "-m", message)
	if err != nil {
		return "", err
	}
	return out, nil
}

func (g *GitRepo) Init(ctx context.Context) error {
	_, err := g.run(ctx, "init")
	return err
}

// Shell runs a command in the workspace with a timeout. Dangerous — gated by approval.
func runShell(ctx context.Context, root, command string, timeout time.Duration) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", fmt.Errorf("command is required")
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-lc", command)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	out := strings.TrimRight(stdout.String(), "\n")
	errOut := strings.TrimRight(stderr.String(), "\n")
	combined := out
	if errOut != "" {
		if combined != "" {
			combined += "\n"
		}
		combined += errOut
	}
	if len(combined) > 80_000 {
		combined = combined[:80_000] + "\n… truncated"
	}
	if err != nil {
		if combined == "" {
			combined = err.Error()
		}
		return combined, fmt.Errorf("exit error: %w", err)
	}
	if combined == "" {
		combined = "(no output)"
	}
	return combined, nil
}
