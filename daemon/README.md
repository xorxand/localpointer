# LocalPointer daemon

HTTP/SSE agent backend for the LocalPointer IDE. Talks only to local Ollama.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Daemon + Ollama status |
| `GET /api/models` | Ollama tags |
| `GET /api/tools` | Agent tool catalog |
| `POST /api/complete` | Tab-style completion |
| `POST /api/inline-edit` | Ctrl+K rewrite (SSE or JSON) |
| `POST /api/chat` | Agent chat (SSE, tools) |
| `POST /api/approve` | Allow/deny/edit pending tool |
| Workspaces / files / git / conversations | Same shape as localprogrammer |

Default listen: `127.0.0.1:9477`

```bash
go build -o localpointer-daemon .
HOST=127.0.0.1 PORT=9477 ./localpointer-daemon
```
