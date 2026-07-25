# LocalPointer AI

Built-in VS Code extension for the LocalPointer IDE. All AI runs **locally** via [Ollama](https://ollama.com) and the LocalPointer Go daemon — no cloud LLM APIs.

## Features

- **Side panel chat** (`Ctrl+L` / `Cmd+L`) — Cursor-like webview with model picker, agent mode, and transparency stats
- **Chat participant** (`@localpointer`) — workspace-aware agent with tool traces in the built-in chat UI
- **Language model provider** — Ollama models appear in VS Code's model picker as **LocalPointer (Ollama)**
- **Inline edit** (`Ctrl+K` / `Cmd+K` on selection) — edit selected code with preview and apply/reject
- **Agent edit** (`Ctrl+Shift+Enter`) — whole-file or selection edits via the daemon or Ollama
- **Inline completions** — debounced prefix/suffix completions (FIM or chat fallback)
- **Status bar** — current model and Ollama health; click to change model

## Architecture

```
Extension  ──HTTP/SSE──►  Go daemon (:9477)  ──►  Ollama (:11434)
     │                         │
     └──── direct Ollama ──────┘   (fallback when daemon unavailable)
```

On activation the extension tries to reach the daemon at `localpointer.daemonUrl`. If unhealthy, it attempts to spawn `localpointer-daemon` from the configured path, next to the repo, or `PATH`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `localpointer.daemonUrl` | `http://127.0.0.1:9477` | Go daemon base URL |
| `localpointer.ollamaUrl` | `http://127.0.0.1:11434` | Ollama base URL |
| `localpointer.model` | *(empty)* | Default model; empty = auto |
| `localpointer.completions.enabled` | `true` | Inline completions |
| `localpointer.completions.debounceMs` | `400` | Completion debounce |
| `localpointer.autoApprove` | `false` | Skip tool approval prompts |
| `localpointer.daemonPath` | *(empty)* | Path to daemon binary |

## Build

From the `code-oss` tree:

```bash
gulp compile-extension:localpointer-ai
```

Or watch during development:

```bash
npm run watch --prefix extensions/localpointer-ai
```

## Notes

- Daemon endpoints `/api/inline-edit` and `/api/complete` are used when present; otherwise the extension falls back to direct Ollama calls.
- Transparency data (model, stats, trace) is available via **LocalPointer: Show Transparency Panel** or the chat webview **Why / stats** toggle.
