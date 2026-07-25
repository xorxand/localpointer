package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
)

const maxToolRounds = 20

const ideSystemPrompt = `You are LocalPointer, a coding agent inside a local Code-OSS fork. You run entirely on the user's machine and talk only to their local Ollama models — never remote cloud LLMs.

You have tools to explore and edit the open workspace, run shell commands, and use git. The IDE executes tools and returns results.

Guidelines:
- Prefer read_file, list_dir, and grep to understand code before editing.
- Use edit_file for surgical changes (exact string replace). Use write_file for new files or full rewrites.
- Keep changes minimal and focused on the user's request.
- Use run_terminal for builds, tests, and inspection. Prefer non-interactive commands.
- Use git_status, git_diff, git_log, and git_commit for version control. Never force-push or rewrite published history unless asked.
- Paths are relative to the workspace root.
- After tool results, continue until the task is done, then give a concise summary of what you changed.
- Do not invent file contents — read them first.
- You only have access to local Ollama models listed by the host. Never suggest calling OpenAI, Anthropic, or other cloud APIs.`

type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

var toolCatalog = []ToolInfo{
	{Name: "read_file", Description: "Read a UTF-8 text file from the workspace."},
	{Name: "write_file", Description: "Create or overwrite a UTF-8 text file."},
	{Name: "edit_file", Description: "Replace an exact string in a file."},
	{Name: "list_dir", Description: "List files and folders in a directory."},
	{Name: "grep", Description: "Search workspace files for a substring."},
	{Name: "run_terminal", Description: "Run a shell command in the workspace."},
	{Name: "git_status", Description: "Show git status for the workspace."},
	{Name: "git_diff", Description: "Show a git diff (working tree or staged)."},
	{Name: "git_log", Description: "Show recent commits."},
	{Name: "git_commit", Description: "Stage paths (optional) and create a commit."},
	{Name: "get_current_time", Description: "Get the current date/time."},
}

type toolRunResult struct {
	Content string
	Kind    string
	Data    any
}

type traceEntry struct {
	Tool       string `json:"tool"`
	Args       string `json:"args,omitempty"`
	DurationMs int64  `json:"duration_ms"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
}

type agentResult struct {
	Content string
	Trace   []traceEntry
	Stats   ChatStats
}

type sseWriter func(map[string]any) error

func toolRequiresApproval(name string) bool {
	switch name {
	case "write_file", "edit_file", "run_terminal", "git_commit":
		return true
	default:
		return false
	}
}

func toolDefinition(name string) map[string]any {
	switch name {
	case "read_file":
		return fn("read_file", "Read a UTF-8 text file. Paths are relative to the workspace root.",
			reqProps("path"), map[string]any{
				"path": prop("string", "Workspace-relative file path"),
			})
	case "write_file":
		return fn("write_file", "Write UTF-8 text to a file. Creates parent directories. Prefer edit_file for small changes.",
			reqProps("path", "content"), map[string]any{
				"path":    prop("string", "Workspace-relative file path"),
				"content": prop("string", "Full file contents to write"),
				"append":  prop("boolean", "If true, append instead of overwrite"),
			})
	case "edit_file":
		return fn("edit_file", "Replace an exact occurrence of old_string with new_string in a file.",
			reqProps("path", "old_string", "new_string"), map[string]any{
				"path":        prop("string", "Workspace-relative file path"),
				"old_string":  prop("string", "Exact text to find"),
				"new_string":  prop("string", "Replacement text"),
				"replace_all": prop("boolean", "Replace all occurrences (default false = exactly one)"),
			})
	case "list_dir":
		return fn("list_dir", "List files and subdirectories.",
			nil, map[string]any{
				"path": prop("string", "Directory path (default: workspace root)"),
			})
	case "grep":
		return fn("grep", "Search files for a substring. Returns path:line:content matches.",
			reqProps("query"), map[string]any{
				"query":           prop("string", "Text to search for"),
				"path":            prop("string", "Subdirectory to search (default: workspace root)"),
				"case_sensitive":  prop("boolean", "Case-sensitive search (default false)"),
			})
	case "run_terminal":
		return fn("run_terminal", "Run a bash command in the workspace root. Prefer non-interactive commands.",
			reqProps("command"), map[string]any{
				"command": prop("string", "Shell command to run"),
			})
	case "git_status":
		return fn("git_status", "Show branch, staged/unstaged/untracked files.", nil, map[string]any{})
	case "git_diff":
		return fn("git_diff", "Show git diff for the working tree or staged index.",
			nil, map[string]any{
				"staged": prop("boolean", "If true, show staged diff"),
				"path":   prop("string", "Optional path filter"),
			})
	case "git_log":
		return fn("git_log", "Show recent commit history.",
			nil, map[string]any{
				"limit": prop("integer", "Number of commits (default 20)"),
			})
	case "git_commit":
		return fn("git_commit", "Stage optional paths (or all) and create a commit with the given message.",
			reqProps("message"), map[string]any{
				"message": prop("string", "Commit message"),
				"paths": map[string]any{
					"type":        "array",
					"description": "Optional paths to stage; omit to stage all changes",
					"items":       map[string]any{"type": "string"},
				},
			})
	case "get_current_time":
		return fn("get_current_time", "Return the current local date and time.",
			nil, map[string]any{
				"timezone": prop("string", "Optional IANA timezone"),
			})
	default:
		return nil
	}
}

func fn(name, desc string, required []string, props map[string]any) map[string]any {
	params := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		params["required"] = required
	}
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": desc,
			"parameters":   params,
		},
	}
}

func prop(typ, desc string) map[string]any {
	return map[string]any{"type": typ, "description": desc}
}

func reqProps(names ...string) []string { return names }

func allToolDefs() []map[string]any {
	var defs []map[string]any
	for _, t := range toolCatalog {
		if def := toolDefinition(t.Name); def != nil {
			defs = append(defs, def)
		}
	}
	return defs
}

func parseToolArguments(raw any) (map[string]any, error) {
	switch v := raw.(type) {
	case map[string]any:
		return v, nil
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return map[string]any{}, nil
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(v), &out); err != nil {
			return nil, err
		}
		return out, nil
	default:
		if raw == nil {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("unsupported tool arguments type %T", raw)
	}
}

func summarizeArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	// Avoid dumping huge file contents into the trace.
	safe := map[string]any{}
	for k, v := range args {
		if k == "content" || k == "old_string" || k == "new_string" {
			s, _ := v.(string)
			if len(s) > 80 {
				safe[k] = s[:80] + "…"
			} else {
				safe[k] = s
			}
			continue
		}
		safe[k] = v
	}
	data, err := json.Marshal(safe)
	if err != nil {
		return ""
	}
	s := string(data)
	if len(s) > 240 {
		s = s[:240] + "…"
	}
	return s
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type toolExecutor struct {
	fs  *WorkspaceFS
	git *GitRepo
}

func (e *toolExecutor) runTool(ctx context.Context, name string, args map[string]any) (toolRunResult, error) {
	switch name {
	case "read_file":
		path, _ := args["path"].(string)
		content, err := e.fs.ReadFile(path)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: content, Kind: "file", Data: map[string]any{"path": path}}, nil
	case "write_file":
		path, _ := args["path"].(string)
		content, _ := args["content"].(string)
		appendMode, _ := args["append"].(bool)
		msg, err := e.fs.WriteFile(path, content, appendMode)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: msg, Kind: "file_write", Data: map[string]any{"path": path, "message": msg}}, nil
	case "edit_file":
		path, _ := args["path"].(string)
		oldStr, _ := args["old_string"].(string)
		newStr, _ := args["new_string"].(string)
		replaceAll, _ := args["replace_all"].(bool)
		msg, err := e.fs.EditFile(path, oldStr, newStr, replaceAll)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: msg, Kind: "file_edit", Data: map[string]any{"path": path, "message": msg}}, nil
	case "list_dir":
		path, _ := args["path"].(string)
		rel, entries, err := e.fs.ListDirEntries(path)
		if err != nil {
			return toolRunResult{}, err
		}
		listing, _ := e.fs.ListDir(path)
		return toolRunResult{Content: listing, Kind: "listing", Data: map[string]any{"path": rel, "entries": entries}}, nil
	case "grep":
		query, _ := args["query"].(string)
		path, _ := args["path"].(string)
		caseSensitive, _ := args["case_sensitive"].(bool)
		out, err := e.fs.Grep(query, path, caseSensitive, 50)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: out, Kind: "grep", Data: map[string]any{"query": query}}, nil
	case "run_terminal":
		command, _ := args["command"].(string)
		out, err := runShell(ctx, e.fs.Root(), command, 90*time.Second)
		if err != nil {
			// Still return stdout/stderr so the model can diagnose failures.
			return toolRunResult{Content: out + "\n\n(command failed: " + err.Error() + ")", Kind: "terminal", Data: map[string]any{"command": command, "ok": false}}, nil
		}
		return toolRunResult{Content: out, Kind: "terminal", Data: map[string]any{"command": command, "ok": true}}, nil
	case "git_status":
		st, err := e.git.Status(ctx)
		if err != nil {
			return toolRunResult{}, err
		}
		if !st.IsRepo {
			return toolRunResult{Content: "Not a git repository.", Kind: "git_status", Data: st}, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "Branch: %s\n", st.Branch)
		if st.Upstream != "" {
			fmt.Fprintf(&b, "Upstream: %s (ahead %d, behind %d)\n", st.Upstream, st.Ahead, st.Behind)
		}
		fmt.Fprintf(&b, "Clean: %v\n", st.Clean)
		if len(st.Staged) > 0 {
			b.WriteString("\nStaged:\n")
			for _, p := range st.Staged {
				fmt.Fprintf(&b, "  %s\n", p)
			}
		}
		if len(st.Changed) > 0 {
			b.WriteString("\nModified:\n")
			for _, p := range st.Changed {
				fmt.Fprintf(&b, "  %s\n", p)
			}
		}
		if len(st.Untracked) > 0 {
			b.WriteString("\nUntracked:\n")
			for _, p := range st.Untracked {
				fmt.Fprintf(&b, "  %s\n", p)
			}
		}
		return toolRunResult{Content: b.String(), Kind: "git_status", Data: st}, nil
	case "git_diff":
		staged, _ := args["staged"].(bool)
		path, _ := args["path"].(string)
		out, err := e.git.Diff(ctx, staged, path)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: out, Kind: "git_diff", Data: map[string]any{"staged": staged, "path": path}}, nil
	case "git_log":
		limit := 20
		switch v := args["limit"].(type) {
		case float64:
			limit = int(v)
		case int:
			limit = v
		}
		out, err := e.git.Log(ctx, limit)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: out, Kind: "git_log"}, nil
	case "git_commit":
		message, _ := args["message"].(string)
		var paths []string
		if raw, ok := args["paths"].([]any); ok {
			for _, p := range raw {
				if s, ok := p.(string); ok && strings.TrimSpace(s) != "" {
					paths = append(paths, s)
				}
			}
		}
		if err := e.git.Stage(ctx, paths); err != nil {
			return toolRunResult{}, err
		}
		out, err := e.git.Commit(ctx, message)
		if err != nil {
			return toolRunResult{}, err
		}
		return toolRunResult{Content: out, Kind: "git_commit", Data: map[string]any{"message": message}}, nil
	case "get_current_time":
		now := time.Now()
		if tz, ok := args["timezone"].(string); ok && strings.TrimSpace(tz) != "" {
			if loc, err := time.LoadLocation(strings.TrimSpace(tz)); err == nil {
				now = now.In(loc)
			} else {
				return toolRunResult{}, fmt.Errorf("unknown timezone %q", tz)
			}
		}
		formatted := now.Format(time.RFC1123)
		return toolRunResult{Content: formatted, Kind: "time", Data: map[string]any{"time": formatted}}, nil
	default:
		return toolRunResult{}, fmt.Errorf("unknown tool %q", name)
	}
}

func (s *Server) generatePlan(ctx context.Context, model, userMessage string) ([]string, error) {
	format := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"steps": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
		"required": []string{"steps"},
	}
	messages := []map[string]any{
		{"role": "system", "content": "Break the coding task into 2-6 concrete steps. Respond only with JSON."},
		{"role": "user", "content": userMessage},
	}
	raw, err := s.ollama.ChatJSON(ctx, model, messages, format)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Steps []string `json:"steps"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, err
	}
	var steps []string
	for _, st := range parsed.Steps {
		if strings.TrimSpace(st) != "" {
			steps = append(steps, strings.TrimSpace(st))
		}
	}
	return steps, nil
}

func (s *Server) runAgent(
	ctx context.Context,
	model string,
	messages []map[string]any,
	fs *WorkspaceFS,
	options map[string]any,
	plan bool,
	userMessage string,
	autoApprove bool,
	writeSSE sseWriter,
	onToken func(string) error,
) (agentResult, error) {
	tools := allToolDefs()
	supports, err := s.ollama.ModelSupportsTools(model)
	if err != nil || !supports {
		content, stats, err := s.ollama.StreamChat(ctx, model, messages, options, onToken)
		return agentResult{Content: content, Stats: stats}, err
	}

	executor := &toolExecutor{fs: fs, git: newGitRepo(fs.Root())}
	var trace []traceEntry
	var stats ChatStats
	working := append([]map[string]any(nil), messages...)

	if plan {
		if steps, err := s.generatePlan(ctx, model, userMessage); err == nil && len(steps) > 0 {
			_ = writeSSE(map[string]any{"status": "plan", "steps": steps})
			working = append(working, map[string]any{
				"role":    "system",
				"content": "Follow this plan using tools as needed:\n- " + strings.Join(steps, "\n- "),
			})
		}
	}

	for round := 0; round < maxToolRounds; round++ {
		if err := ctx.Err(); err != nil {
			return agentResult{}, err
		}
		resp, err := s.ollama.ChatWithTools(ctx, model, working, tools, options)
		if err != nil {
			return agentResult{}, err
		}
		stats.Add(resp.Stats)

		if len(resp.ToolCalls) == 0 {
			if strings.TrimSpace(resp.Content) == "" {
				return agentResult{}, fmt.Errorf("model returned an empty response")
			}
			if err := streamTextChunks(ctx, resp.Content, onToken); err != nil {
				return agentResult{Content: resp.Content, Trace: trace, Stats: stats}, err
			}
			return agentResult{Content: resp.Content, Trace: trace, Stats: stats}, nil
		}

		working = append(working, map[string]any{
			"role":       "assistant",
			"content":    resp.Content,
			"tool_calls": toolCallsForMessage(resp.ToolCalls),
		})

		for _, call := range resp.ToolCalls {
			args, err := parseToolArguments(call.Function.Arguments)
			if err != nil {
				errMsg := fmt.Sprintf("invalid tool arguments: %v", err)
				_ = writeSSE(map[string]any{"status": "tool_error", "tool": call.Function.Name, "error": errMsg})
				working = append(working, map[string]any{"role": "tool", "tool_name": call.Function.Name, "content": errMsg})
				continue
			}

			_ = writeSSE(map[string]any{"status": "tool_call", "tool": call.Function.Name, "args": summarizeToolArgsForUI(args)})

			if toolRequiresApproval(call.Function.Name) && !autoApprove {
				decision, denied, aborted := s.awaitApproval(ctx, call.Function.Name, args, writeSSE)
				if aborted != nil {
					return agentResult{Trace: trace, Stats: stats}, aborted
				}
				if denied {
					trace = append(trace, traceEntry{Tool: call.Function.Name, Args: summarizeArgs(args), OK: false, Error: "denied by user"})
					_ = writeSSE(map[string]any{"status": "tool_denied", "tool": call.Function.Name})
					working = append(working, map[string]any{"role": "tool", "tool_name": call.Function.Name, "content": "The user denied this tool call."})
					continue
				}
				if decision.Args != nil {
					args = decision.Args
				}
			} else if toolRequiresApproval(call.Function.Name) {
				_ = writeSSE(map[string]any{"status": "approved", "tool": call.Function.Name, "auto": true})
			}

			start := time.Now()
			result, err := executor.runTool(ctx, call.Function.Name, args)
			trace = append(trace, traceEntry{
				Tool:       call.Function.Name,
				Args:       summarizeArgs(args),
				DurationMs: time.Since(start).Milliseconds(),
				OK:         err == nil,
				Error:      errString(err),
			})
			if err != nil {
				log.Printf("tool %s failed: %v", call.Function.Name, err)
				_ = writeSSE(map[string]any{"status": "tool_error", "tool": call.Function.Name, "error": err.Error()})
				working = append(working, map[string]any{"role": "tool", "tool_name": call.Function.Name, "content": "Tool error: " + err.Error()})
				continue
			}

			event := map[string]any{"status": "tool_result", "tool": call.Function.Name}
			if result.Kind != "" {
				event["kind"] = result.Kind
			}
			if result.Data != nil {
				event["data"] = result.Data
			}
			_ = writeSSE(event)

			// Notify UI to refresh explorer/editor when files change.
			if data, ok := result.Data.(map[string]any); ok {
				if path, _ := data["path"].(string); path != "" {
					_ = writeSSE(map[string]any{"status": "file_changed", "path": path})
				}
			}

			working = append(working, map[string]any{"role": "tool", "tool_name": call.Function.Name, "content": result.Content})
		}
	}
	return agentResult{}, fmt.Errorf("tool loop exceeded %d rounds", maxToolRounds)
}

func summarizeToolArgsForUI(args map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		if k == "content" || k == "old_string" || k == "new_string" {
			s, _ := v.(string)
			if len(s) > 120 {
				out[k] = s[:120] + "…"
				out[k+"_len"] = len(s)
			} else {
				out[k] = s
			}
			continue
		}
		out[k] = v
	}
	return out
}

func streamTextChunks(ctx context.Context, text string, onToken func(string) error) error {
	if onToken == nil || text == "" {
		return nil
	}
	const chunkSize = 24
	runes := []rune(text)
	for i := 0; i < len(runes); i += chunkSize {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := i + chunkSize
		if end > len(runes) {
			end = len(runes)
		}
		if err := onToken(string(runes[i:end])); err != nil {
			return err
		}
	}
	return nil
}
