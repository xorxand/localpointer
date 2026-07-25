# LocalPointer — Plan

Open-source, Cursor-like IDE: Code-OSS fork + local Ollama only.

## Why a fork (not only an extension)

Cursor forked because the extension API cannot deeply control editor rendering (inline diffs), UI chrome, terminal streams, or process boundaries. We fork for the same headroom, but ship AI first as a **built-in extension** plus small workbench patches so we stay mergeable.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  LocalPointer (Code-OSS fork)                           │
│  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │ Workbench patches│  │ localpointer-ai (built-in)  │  │
│  │ brand, keybinds, │──│ chat · Ctrl+K · Tab · agent │  │
│  │ default layout   │  └──────────────┬──────────────┘  │
└─────────────────────┴─────────────────┼─────────────────┘
                                        │ HTTP/SSE
                          ┌─────────────▼─────────────┐
                          │  localpointer-daemon (Go) │
                          │  Ollama client · tools    │
                          │  agent loop · approvals   │
                          └─────────────┬─────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │  Ollama (local models)    │
                          └───────────────────────────┘
```

## Cursor-like features (v1)

| Feature | Approach |
|---------|----------|
| AI Chat (Ctrl+L) | Side panel webview → daemon SSE |
| Inline edit (Ctrl+K) | Quick input + stream → apply edit |
| Agent / Composer | Multi-tool loop (read/write/edit/grep/terminal/git) |
| Tab completions | `InlineCompletionItemProvider` → Ollama |
| Apply / reject diffs | WorkspaceEdit + decorations |
| Model picker | `/api/tags` via daemon |
| Why panel | Token/tool/timing traces from daemon |
| @-file context | Attach open/selected files to prompts |
| Local-only | `OLLAMA_BASE_URL` only — no cloud LLM APIs |

## Execution order

1. ~~Clone `microsoft/vscode` → `code-oss/`~~
2. ~~Brand `product.json` as LocalPointer~~
3. ~~Port Go daemon from `localprogrammer` / `localchat`~~
4. ~~Built-in extension `extensions/localpointer-ai`~~
5. ~~Keybindings, commands, default AI activity~~
6. ~~Build & smoke-test~~ (IDE launches; extension activates; daemon healthy)

## Status

**v1 scaffold is runnable.** See [README.md](README.md) and [FEATURES.md](FEATURES.md).

```bash
./scripts/build.sh          # daemon
./scripts/build.sh --ide    # first-time Code-OSS compile (if needed)
./scripts/start-localpointer.sh
```
