# LocalPointer (Code-OSS fork)

This tree is Microsoft’s [Code-OSS](https://github.com/microsoft/vscode) with LocalPointer branding and the built-in `extensions/localpointer-ai` extension.

See the parent [README](../README.md) for build/run instructions.

## Local changes vs upstream

- `product.json` — branded as LocalPointer (`.localpointer` data dir, `localpointer` protocol)
- `extensions/localpointer-ai/` — Cursor-like local Ollama AI (chat, Ctrl+K, Tab, agent)
- `build/gulpfile.extensions.ts` / `build/npm/dirs.ts` — register the extension for compile/install

Upstream merges: rebase/merge `microsoft/vscode` periodically; resolve conflicts in the files above.
