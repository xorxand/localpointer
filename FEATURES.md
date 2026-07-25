# LocalPointer — FEATURES

Implemented Cursor-like capabilities on a Code-OSS fork, powered only by local Ollama.

## Shipped

| Feature | How to use | Implementation |
|---------|------------|----------------|
| Branded IDE | Window title **LocalPointer Dev** | `code-oss/product.json` |
| AI Chat panel | Activity bar LocalPointer icon, or `Ctrl+L` | `extensions/localpointer-ai` webview |
| Native Chat models | Chat model picker → LocalPointer (Ollama) | `LanguageModelChatProvider` |
| `@localpointer` agent | Chat participant with workspace tools | Daemon SSE agent loop |
| Inline edit | Select code → `Ctrl+K` | `/api/inline-edit` + decorations |
| Agent edit | `Ctrl+Shift+Enter` | Instruction → rewrite selection/file |
| Tab completions | Type in editor | `InlineCompletionItemProvider` |
| Model picker | Status bar / command | Ollama `/api/tags` |
| Why panel | Command: LocalPointer: Show Why | Tokens / tools / timing |
| Approvals | Allow/Deny on mutating tools | Daemon + UI prompts |
| Local-only | Defaults to loopback | No cloud LLM APIs |

## Daemon tools (agent)

`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_terminal`, `git_status`, `git_diff`, `git_log`, `git_commit`, `get_current_time`

## Not yet (future forks)

- Shadow-workspace speculative Tab teleport
- Full multi-file Composer canvas with live multi-diff chrome
- Semantic codebase index / RAG (can port from localchat)
- Upstream merge automation
