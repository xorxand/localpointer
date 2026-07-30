package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	store  *Store
	ollama *OllamaClient
	static string

	mu               sync.Mutex
	fsCache          map[int64]*WorkspaceFS // workspace id -> fs
	approvalMu       sync.Mutex
	pendingApprovals map[string]chan approvalDecision
}

type approvalDecision struct {
	Decision string
	Args     map[string]any
}

func (s *Server) registerApproval(id string) chan approvalDecision {
	ch := make(chan approvalDecision, 1)
	s.approvalMu.Lock()
	if s.pendingApprovals == nil {
		s.pendingApprovals = map[string]chan approvalDecision{}
	}
	s.pendingApprovals[id] = ch
	s.approvalMu.Unlock()
	return ch
}

func (s *Server) resolveApproval(id string, dec approvalDecision) bool {
	s.approvalMu.Lock()
	ch, ok := s.pendingApprovals[id]
	if ok {
		delete(s.pendingApprovals, id)
	}
	s.approvalMu.Unlock()
	if !ok {
		return false
	}
	ch <- dec
	return true
}

func (s *Server) clearApproval(id string) {
	s.approvalMu.Lock()
	delete(s.pendingApprovals, id)
	s.approvalMu.Unlock()
}

func newApprovalID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("appr-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *Server) awaitApproval(ctx context.Context, tool string, args map[string]any, writeSSE sseWriter) (approvalDecision, bool, error) {
	id := newApprovalID()
	ch := s.registerApproval(id)
	defer s.clearApproval(id)
	_ = writeSSE(map[string]any{
		"status": "approval_required",
		"id":     id,
		"tool":   tool,
		"args":   summarizeToolArgsForUI(args),
	})
	select {
	case <-ctx.Done():
		return approvalDecision{}, false, ctx.Err()
	case dec := <-ch:
		if dec.Decision == "deny" {
			return dec, true, nil
		}
		_ = writeSSE(map[string]any{"status": "approved", "tool": tool})
		return dec, false, nil
	}
}

func main() {
	store, err := openStore()
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()

	staticDir := "static"
	// Static UI is optional — LocalPointer IDE embeds the client; daemon is API-first.

	// Ensure default workspace exists.
	ensureDefaultWorkspace(store)

	srv := &Server{
		store:   store,
		ollama:  newOllamaClient(),
		static:  staticDir,
		fsCache: map[int64]*WorkspaceFS{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", srv.handleIndex)
	if _, err := os.Stat(staticDir); err == nil {
		mux.Handle("/static/", noCache(http.StripPrefix("/static/", http.FileServer(http.Dir(staticDir)))))
	}

	mux.HandleFunc("GET /api/health", srv.handleHealth)
	mux.HandleFunc("GET /api/models", srv.handleModels)
	mux.HandleFunc("GET /api/tools", srv.handleTools)
	mux.HandleFunc("POST /api/complete", srv.handleComplete)
	mux.HandleFunc("POST /api/inline-edit", srv.handleInlineEdit)

	mux.HandleFunc("GET /api/workspaces", srv.handleListWorkspaces)
	mux.HandleFunc("POST /api/workspaces", srv.handleCreateWorkspace)
	mux.HandleFunc("GET /api/workspaces/{id}", srv.handleGetWorkspace)
	mux.HandleFunc("PATCH /api/workspaces/{id}", srv.handleUpdateWorkspace)
	mux.HandleFunc("DELETE /api/workspaces/{id}", srv.handleDeleteWorkspace)

	mux.HandleFunc("GET /api/workspaces/{id}/tree", srv.handleTree)
	mux.HandleFunc("GET /api/workspaces/{id}/files", srv.handleListFiles)
	mux.HandleFunc("GET /api/workspaces/{id}/file", srv.handleReadFile)
	mux.HandleFunc("PUT /api/workspaces/{id}/file", srv.handleWriteFile)
	mux.HandleFunc("POST /api/workspaces/{id}/mkdir", srv.handleMkdir)
	mux.HandleFunc("POST /api/workspaces/{id}/rename", srv.handleRename)
	mux.HandleFunc("DELETE /api/workspaces/{id}/file", srv.handleDeleteFile)
	mux.HandleFunc("GET /api/workspaces/{id}/search", srv.handleSearch)

	mux.HandleFunc("GET /api/workspaces/{id}/git/status", srv.handleGitStatus)
	mux.HandleFunc("GET /api/workspaces/{id}/git/diff", srv.handleGitDiff)
	mux.HandleFunc("GET /api/workspaces/{id}/git/log", srv.handleGitLog)
	mux.HandleFunc("POST /api/workspaces/{id}/git/stage", srv.handleGitStage)
	mux.HandleFunc("POST /api/workspaces/{id}/git/unstage", srv.handleGitUnstage)
	mux.HandleFunc("POST /api/workspaces/{id}/git/commit", srv.handleGitCommit)
	mux.HandleFunc("POST /api/workspaces/{id}/git/init", srv.handleGitInit)

	mux.HandleFunc("GET /api/workspaces/{id}/conversations", srv.handleListConversations)
	mux.HandleFunc("POST /api/workspaces/{id}/conversations", srv.handleCreateConversation)
	mux.HandleFunc("GET /api/conversations/{id}", srv.handleGetConversation)
	mux.HandleFunc("PATCH /api/conversations/{id}", srv.handleUpdateConversation)
	mux.HandleFunc("DELETE /api/conversations/{id}", srv.handleDeleteConversation)
	mux.HandleFunc("GET /api/conversations/{id}/messages", srv.handleListMessages)

	mux.HandleFunc("POST /api/chat", srv.handleChat)
	mux.HandleFunc("POST /api/approve", srv.handleApprove)

	mux.HandleFunc("GET /api/settings", srv.handleGetSettings)
	mux.HandleFunc("PUT /api/settings", srv.handlePutSettings)

	host := envOr("HOST", "127.0.0.1")
	port := envOr("PORT", "9477")
	addr := host + ":" + port
	log.Printf("LocalPointer daemon listening on http://%s (Ollama: %s)", addr, srv.ollama.baseURL)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func ensureDefaultWorkspace(store *Store) {
	list, err := store.ListWorkspaces()
	if err != nil || len(list) > 0 {
		return
	}
	root := envOr("LOCALPOINTER_WORKSPACE", envOr("LOCALPROGRAMMER_WORKSPACE", "workspace"))
	abs, err := filepath.Abs(root)
	if err != nil {
		return
	}
	_ = os.MkdirAll(abs, 0o755)
	// Seed a hello file so the IDE isn't empty.
	readme := filepath.Join(abs, "README.md")
	if _, err := os.Stat(readme); os.IsNotExist(err) {
		_ = os.WriteFile(readme, []byte("# LocalPointer workspace\n\nOpened by the LocalPointer daemon for agent file tools.\n\nAll AI calls go to your local Ollama models only.\n"), 0o644)
	}
	_, _ = store.CreateWorkspace("Workspace", abs, "")
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, dest any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dest)
}

func pathID(r *http.Request, key string) (int64, error) {
	return strconv.ParseInt(r.PathValue(key), 10, 64)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	index := filepath.Join(s.static, "index.html")
	if _, err := os.Stat(index); err == nil {
		http.ServeFile(w, r, index)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service": "localpointer-daemon",
		"docs":    "API-only daemon for LocalPointer IDE. See /api/health",
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "localpointer-daemon",
		"ollama":  s.ollama.CheckHealth(),
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.ollama.ListModels()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func (s *Server) handleTools(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tools": toolCatalog})
}

// handleComplete returns a short inline code completion (Tab).
func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model  string `json:"model"`
		Prefix string `json:"prefix"`
		Suffix string `json:"suffix"`
		Lang   string `json:"language"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	model, err := s.resolveModel(req.Model)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	prefix := req.Prefix
	if len(prefix) > 4000 {
		prefix = prefix[len(prefix)-4000:]
	}
	suffix := req.Suffix
	if len(suffix) > 1500 {
		suffix = suffix[:1500]
	}
	lang := req.Lang
	if lang == "" {
		lang = "code"
	}
	system := "You are a code completion engine inside LocalPointer. Continue the code at the cursor. Output ONLY the completion text to insert — no markdown fences, no explanations."
	user := fmt.Sprintf("Language: %s\n\n<<<PREFIX>>>\n%s\n<<<SUFFIX>>>\n%s\n<<<END>>>\n\nWrite the next tokens that belong between PREFIX and SUFFIX.", lang, prefix, suffix)
	messages := []map[string]any{
		{"role": "system", "content": system},
		{"role": "user", "content": user},
	}
	out, stats, err := s.ollama.StreamChat(r.Context(), model, messages, map[string]any{"temperature": 0.2, "num_predict": 128}, nil, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	out = stripCodeFence(strings.TrimSpace(out))
	writeJSON(w, http.StatusOK, map[string]any{
		"completion": out,
		"model":      model,
		"stats":      stats,
	})
}

// handleInlineEdit rewrites a selected code region given a natural-language instruction (Ctrl+K).
func (s *Server) handleInlineEdit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model       string `json:"model"`
		Instruction string `json:"instruction"`
		Selection   string `json:"selection"`
		Path        string `json:"path"`
		FilePath    string `json:"file_path"`
		Language    string `json:"language"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.Path == "" {
		req.Path = req.FilePath
	}
	req.Instruction = strings.TrimSpace(req.Instruction)
	if req.Instruction == "" || strings.TrimSpace(req.Selection) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "instruction and selection required"})
		return
	}
	model, err := s.resolveModel(req.Model)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	lang := req.Language
	if lang == "" {
		lang = "text"
	}
	system := "You are LocalPointer inline edit. Rewrite the selected code per the user's instruction. Output ONLY the replacement code — no markdown fences, no commentary."
	user := fmt.Sprintf("File: %s\nLanguage: %s\nInstruction: %s\n\nSelected code:\n%s", req.Path, lang, req.Instruction, req.Selection)
	messages := []map[string]any{
		{"role": "system", "content": system},
		{"role": "user", "content": user},
	}

	// Prefer JSON for IDE clients unless they explicitly ask for SSE.
	wantStream := r.URL.Query().Get("stream") == "1" || strings.Contains(r.Header.Get("Accept"), "text/event-stream")
	if !wantStream {
		text, stats, err := s.ollama.StreamChat(r.Context(), model, messages, map[string]any{"temperature": 0.2}, nil, nil)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"text": stripCodeFence(text), "model": model, "stats": stats})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		text, stats, err := s.ollama.StreamChat(r.Context(), model, messages, map[string]any{"temperature": 0.2}, nil, nil)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"text": stripCodeFence(text), "model": model, "stats": stats})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	writeSSE := func(payload map[string]any) error {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	_ = writeSSE(map[string]any{"status": "started", "model": model})
	var full strings.Builder
	stats, err := func() (ChatStats, error) {
		text, st, err := s.ollama.StreamChat(r.Context(), model, messages, map[string]any{"temperature": 0.2}, func(tok string) error {
			full.WriteString(tok)
			return writeSSE(map[string]any{"token": tok})
		}, nil)
		if full.Len() == 0 {
			full.WriteString(text)
		}
		return st, err
	}()
	if err != nil && !errors.Is(err, context.Canceled) {
		_ = writeSSE(map[string]any{"error": err.Error()})
		return
	}
	_ = writeSSE(map[string]any{
		"done":  true,
		"text":  stripCodeFence(full.String()),
		"model": model,
		"stats": stats,
	})
}

func (s *Server) resolveModel(requested string) (string, error) {
	model := strings.TrimSpace(requested)
	if model != "" {
		return model, nil
	}
	model = s.store.GetSetting("default_model", "")
	if model != "" {
		return model, nil
	}
	models, err := s.ollama.ListModels()
	if err != nil || len(models) == 0 {
		return "", fmt.Errorf("no local Ollama models available")
	}
	return pickDefaultModel(models), nil
}

func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```")
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	if j := strings.LastIndex(s, "```"); j >= 0 {
		s = s[:j]
	}
	return strings.TrimSpace(s)
}

func (s *Server) workspaceFS(id int64) (*WorkspaceFS, Workspace, error) {
	ws, err := s.store.GetWorkspace(id)
	if err != nil {
		return nil, ws, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if fs, ok := s.fsCache[id]; ok && fs.Root() == ws.Path {
		return fs, ws, nil
	}
	fs, err := newWorkspaceFS(ws.Path)
	if err != nil {
		return nil, ws, err
	}
	s.fsCache[id] = fs
	return fs, ws, nil
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListWorkspaces()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": list})
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		Model string `json:"model"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	ws, err := s.store.CreateWorkspace(req.Name, req.Path, req.Model)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, ws)
}

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	ws, err := s.store.GetWorkspace(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	var req struct {
		Name         *string `json:"name"`
		Model        *string `json:"model"`
		SystemPrompt *string `json:"system_prompt"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	ws, err := s.store.UpdateWorkspace(id, req.Name, req.Model, req.SystemPrompt)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	s.mu.Lock()
	delete(s.fsCache, id)
	s.mu.Unlock()
	if err := s.store.DeleteWorkspace(id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	depth, _ := strconv.Atoi(r.URL.Query().Get("depth"))
	tree, err := fs.Tree(r.URL.Query().Get("path"), depth)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	rel, entries, err := fs.ListDirEntries(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": rel, "entries": entries})
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	path := r.URL.Query().Get("path")
	data, err := fs.ReadRaw(path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "content": string(data)})
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	msg, err := fs.WriteFile(req.Path, req.Content, false)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if err := fs.Mkdir(req.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if err := fs.Rename(req.From, req.To); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "path required"})
		return
	}
	if err := fs.Delete(path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	q := r.URL.Query().Get("q")
	out, err := fs.Grep(q, r.URL.Query().Get("path"), r.URL.Query().Get("case") == "1", 100)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": out})
}

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	st, err := newGitRepo(fs.Root()).Status(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	staged := r.URL.Query().Get("staged") == "1"
	out, err := newGitRepo(fs.Root()).Diff(r.Context(), staged, r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"diff": out})
}

func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	out, err := newGitRepo(fs.Root()).Log(r.Context(), n)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"log": out})
}

func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	s.gitPathsAction(w, r, true)
}

func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	s.gitPathsAction(w, r, false)
}

func (s *Server) gitPathsAction(w http.ResponseWriter, r *http.Request, stage bool) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	var req struct {
		Paths []string `json:"paths"`
	}
	_ = readJSON(r, &req)
	git := newGitRepo(fs.Root())
	if stage {
		err = git.Stage(r.Context(), req.Paths)
	} else {
		err = git.Unstage(r.Context(), req.Paths)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	var req struct {
		Message string   `json:"message"`
		Paths   []string `json:"paths"`
		Stage   bool     `json:"stage"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	git := newGitRepo(fs.Root())
	if req.Stage || len(req.Paths) > 0 {
		if err := git.Stage(r.Context(), req.Paths); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
	}
	out, err := git.Commit(r.Context(), req.Message)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleGitInit(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	fs, _, err := s.workspaceFS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	if err := newGitRepo(fs.Root()).Init(r.Context()); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	list, err := s.store.ListConversations(id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": list})
}

func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	var req struct {
		Title string `json:"title"`
		Model string `json:"model"`
	}
	_ = readJSON(r, &req)
	c, err := s.store.CreateConversation(id, req.Title, req.Model)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleGetConversation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	c, err := s.store.GetConversation(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleUpdateConversation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	var req struct {
		Title *string `json:"title"`
		Model *string `json:"model"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	c, err := s.store.UpdateConversation(id, req.Title, req.Model)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	if err := s.store.DeleteConversation(id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	msgs, err := s.store.ListMessages(id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       string         `json:"id"`
		Decision string         `json:"decision"`
		Args     map[string]any `json:"args"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.ID == "" || (req.Decision != "allow" && req.Decision != "deny" && req.Decision != "edit") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id and decision required"})
		return
	}
	if !s.resolveApproval(req.ID, approvalDecision{Decision: req.Decision, Args: req.Args}) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown approval"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"auto_approve":  s.store.GetSetting("auto_approve", "false") == "true",
		"default_model": s.store.GetSetting("default_model", ""),
	})
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AutoApprove  *bool   `json:"auto_approve"`
		DefaultModel *string `json:"default_model"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.AutoApprove != nil {
		v := "false"
		if *req.AutoApprove {
			v = "true"
		}
		_ = s.store.SetSetting("auto_approve", v)
	}
	if req.DefaultModel != nil {
		_ = s.store.SetSetting("default_model", *req.DefaultModel)
	}
	s.handleGetSettings(w, r)
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConversationID int64  `json:"conversation_id"`
		WorkspaceID    int64  `json:"workspace_id"`
		Message        string `json:"message"`
		Model          string `json:"model"`
		ActiveFile     string `json:"active_file"`
		Selection      string `json:"selection"`
		AutoApprove    bool   `json:"auto_approve"`
		Plan           bool   `json:"plan"`
	}
	if err := readJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "message required"})
		return
	}

	fs, ws, err := s.workspaceFS(req.WorkspaceID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "workspace required"})
		return
	}

	var conv Conversation
	if req.ConversationID > 0 {
		conv, err = s.store.GetConversation(req.ConversationID)
		if err != nil || conv.WorkspaceID != ws.ID {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid conversation"})
			return
		}
	} else {
		conv, err = s.store.CreateConversation(ws.ID, truncateTitle(req.Message), req.Model)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
	}

	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = conv.Model
	}
	if model == "" {
		model = ws.Model
	}
	if model == "" {
		model = s.store.GetSetting("default_model", "")
	}
	if model == "" {
		models, err := s.ollama.ListModels()
		if err != nil || len(models) == 0 {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "no local Ollama models available"})
			return
		}
		// Prefer a tools-capable mid-size model.
		model = pickDefaultModel(models)
	}

	userContent := req.Message
	if req.ActiveFile != "" {
		userContent += fmt.Sprintf("\n\n[Active editor file: %s]", req.ActiveFile)
	}
	if req.Selection != "" {
		userContent += fmt.Sprintf("\n\n[Selected text]\n```\n%s\n```", req.Selection)
	}

	if _, err := s.store.AddMessage(conv.ID, "user", req.Message); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if conv.Title == "New Agent" {
		title := truncateTitle(req.Message)
		_, _ = s.store.UpdateConversation(conv.ID, &title, &model)
	} else if conv.Model != model {
		_, _ = s.store.UpdateConversation(conv.ID, nil, &model)
	}

	history, err := s.store.ListMessages(conv.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	system := ideSystemPrompt
	if strings.TrimSpace(ws.SystemPrompt) != "" {
		system += "\n\n" + ws.SystemPrompt
	}
	system += fmt.Sprintf("\n\nWorkspace root: %s", ws.Path)

	messages := []map[string]any{{"role": "system", "content": system}}
	for _, m := range history {
		if m.Role == "user" || m.Role == "assistant" {
			content := m.Content
			// Use enriched content only for the latest user message.
			if m.Role == "user" && m.ID == history[len(history)-1].ID {
				content = userContent
			}
			messages = append(messages, map[string]any{"role": m.Role, "content": content})
		}
	}

	autoApprove := req.AutoApprove || s.store.GetSetting("auto_approve", "false") == "true"

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	writeSSE := func(payload map[string]any) error {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}

	_ = writeSSE(map[string]any{
		"status":          "started",
		"conversation_id": conv.ID,
		"model":           model,
	})

	ctx := r.Context()
	var full strings.Builder
	onToken := func(tok string) error {
		full.WriteString(tok)
		return writeSSE(map[string]any{"token": tok})
	}

	result, err := s.runAgent(ctx, model, messages, fs, nil, req.Plan, req.Message, autoApprove, writeSSE, onToken)
	if err != nil && !errors.Is(err, context.Canceled) {
		// SSE headers are already committed, so an error-only event can leave
		// the chat with no rendered response. Always provide visible turn text.
		message := "The local model could not finish this request: " + err.Error()
		_ = onToken(message)
		result.Content = message
	}
	content := full.String()
	if content == "" {
		content = result.Content
	}
	if content != "" {
		_, _ = s.store.AddMessage(conv.ID, "assistant", content)
	}
	_ = writeSSE(map[string]any{
		"done":            true,
		"conversation_id": conv.ID,
		"model":           model,
		"stats":           result.Stats,
		"trace":           result.Trace,
	})
}

func truncateTitle(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) > 48 {
		return s[:48] + "…"
	}
	if s == "" {
		return "New Agent"
	}
	return s
}

func pickDefaultModel(models []map[string]any) string {
	preferred := []string{"qwen3.5:9b", "qwen2.5:7b", "qwen3.5:4b", "llama3.1:8b", "qwen2.5:3b"}
	names := map[string]bool{}
	var first string
	for _, m := range models {
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		if first == "" {
			first = name
		}
		names[name] = true
		caps, _ := m["capabilities"].([]any)
		hasTools := false
		for _, c := range caps {
			if cs, ok := c.(string); ok && cs == "tools" {
				hasTools = true
			}
		}
		_ = hasTools
	}
	for _, p := range preferred {
		if names[p] {
			return p
		}
	}
	// Prefer any tools-capable model.
	for _, m := range models {
		name, _ := m["name"].(string)
		caps, _ := m["capabilities"].([]any)
		for _, c := range caps {
			if cs, ok := c.(string); ok && cs == "tools" {
				return name
			}
		}
	}
	return first
}
