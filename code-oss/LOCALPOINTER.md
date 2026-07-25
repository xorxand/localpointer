# LocalPointer (Code-OSS fork)

This tree is Microsoft’s [Code-OSS](https://github.com/microsoft/vscode) with LocalPointer branding and the built-in `extensions/localpointer-ai` extension.

See the parent [README](../README.md) for build/run instructions.

## Local changes vs upstream

- `product.json` — branded as LocalPointer; **no** `defaultChatAgent` / Copilot entitlements / voice cloud URL
- `extensions/localpointer-ai/` — Cursor-like local Ollama AI (chat, Ctrl+K, Tab, agent)
- `extensions/copilot/` — **removed** (upstream GitHub Copilot Chat)
- `package.json` / `build/npm/dirs.ts` — Copilot compile/watch scripts and install dir removed
- `chat.agentHost.enabled` defaults to `false` (Agent Host Copilot CLI off)
- `build/gulpfile.extensions.ts` / `build/npm/dirs.ts` — register localpointer-ai for compile/install

Upstream merges: rebase/merge `microsoft/vscode` periodically; keep Copilot deleted and re-apply the files above.
