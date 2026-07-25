# LocalPointer

**LocalPointer** is an open-source, Cursor-like IDE: a branded [Code-OSS](https://github.com/microsoft/vscode) fork with deep local-AI integrations. Every model call goes to **your Ollama instance** — never OpenAI, Anthropic, or other cloud LLM APIs.

## Why a fork?

Cursor forked VS Code because the extension API cannot deeply control editor rendering (inline diffs), chrome, or terminal streams. LocalPointer forks for the same headroom, then ships AI as a **built-in extension** plus a Go daemon so most of the agent engine stays editor-agnostic and mergeable.

## Architecture

```
LocalPointer (Code-OSS) ── built-in localpointer-ai extension
        │
        ├── Chat panel (Ctrl+L) / @localpointer agent
        ├── Inline edit (Ctrl+K)
        ├── Tab completions
        ├── Language Model provider (native Chat model picker)
        │
        └── localpointer-daemon (Go) ──► Ollama (local models)
                 agent tools: read/write/edit/grep/terminal/git
```

Ollama client patterns are adapted from [localchat](../localchat) and the agent loop from [localprogrammer](../localprogrammer).

## Features (v1)

| Feature | Shortcut | Notes |
|---------|----------|-------|
| AI Chat side panel | `Ctrl+L` / `Cmd+L` | Streaming + model picker + why/stats |
| Inline edit | `Ctrl+K` / `Cmd+K` (with selection) | Replace selection from instruction |
| Agent edit | `Ctrl+Shift+Enter` | Multi-tool coding agent |
| Tab completions | automatic | Debounced ghost text via Ollama |
| Model picker | status bar / command | Lists local Ollama tags |
| Why panel | command palette | Tokens, tools, timing |
| Native Chat models | Chat view | Vendor `localpointer` (Ollama) |

## Prerequisites

- Node.js **24.x** (see `code-oss/.nvmrc`)
- Go 1.22+
- Build deps: `pkg-config libx11-dev libxkbfile-dev libsecret-1-dev` (+ typical Electron deps)
- [Ollama](https://ollama.com) with at least one tools-capable model, e.g.:

```bash
ollama pull qwen2.5:7b
# or
ollama pull qwen3.5:4b
```

## Quick start

```bash
# 1) Build the Go daemon (fast)
./scripts/build.sh

# 2) First-time Code-OSS install + compile (slow: 10–40+ min)
./scripts/build.sh --ide

# 3) Launch
./scripts/start-localpointer.sh
```

Or run pieces separately:

```bash
# Daemon only
cd daemon && go run .

# IDE only (expects compiled out/ + daemon)
cd code-oss && ./scripts/code.sh
```

## Configuration

In the IDE: **Settings → LocalPointer**

| Setting | Default | Meaning |
|---------|---------|---------|
| `localpointer.daemonUrl` | `http://127.0.0.1:9477` | Go daemon |
| `localpointer.ollamaUrl` | `http://127.0.0.1:11434` | Ollama |
| `localpointer.model` | _(auto)_ | Preferred model name |
| `localpointer.completions.enabled` | `true` | Tab completions |
| `localpointer.autoApprove` | `false` | Skip tool approval prompts |

Environment for the daemon:

| Variable | Default |
|----------|---------|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `HOST` / `PORT` | `127.0.0.1` / `9477` |

## Repo layout

```
localpointer/
├── PLAN.md
├── README.md
├── scripts/
│   ├── build.sh
│   └── start-localpointer.sh
├── daemon/                 # Go agent + Ollama API (from localprogrammer patterns)
│   └── localpointer-daemon
└── code-oss/               # Microsoft vscode fork (branded LocalPointer)
    ├── product.json        # nameShort/applicationName = LocalPointer
    └── extensions/localpointer-ai/
```

## Local-only promise

The extension and daemon talk only to `localpointer.*` URLs you configure (defaults are loopback Ollama/daemon). There is no Cursor account, no cloud model routing, and no telemetry added by LocalPointer AI.

## License

- Code-OSS: MIT (Microsoft)
- LocalPointer daemon + `localpointer-ai` extension: MIT
