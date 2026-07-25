package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type Workspace struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	Model        string    `json:"model"`
	SystemPrompt string    `json:"system_prompt"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Conversation struct {
	ID          int64     `json:"id"`
	WorkspaceID int64     `json:"workspace_id"`
	Title       string    `json:"title"`
	Model       string    `json:"model"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Message struct {
	ID             int64     `json:"id"`
	ConversationID int64     `json:"conversation_id"`
	Role           string    `json:"role"`
	Content        string    `json:"content"`
	CreatedAt      time.Time `json:"created_at"`
}

func openStore() (*Store, error) {
	dir := "data"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dir, "localprogrammer.db")
	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'New Agent',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)
	return err
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, _ = time.Parse(time.RFC3339, s)
	}
	return t
}

func (s *Store) ListWorkspaces() ([]Workspace, error) {
	rows, err := s.db.Query(`SELECT id, name, path, model, system_prompt, created_at, updated_at FROM workspaces ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Workspace
	for rows.Next() {
		var w Workspace
		var cAt, uAt string
		if err := rows.Scan(&w.ID, &w.Name, &w.Path, &w.Model, &w.SystemPrompt, &cAt, &uAt); err != nil {
			return nil, err
		}
		w.CreatedAt = parseTime(cAt)
		w.UpdatedAt = parseTime(uAt)
		out = append(out, w)
	}
	if out == nil {
		out = []Workspace{}
	}
	return out, rows.Err()
}

func (s *Store) GetWorkspace(id int64) (Workspace, error) {
	var w Workspace
	var cAt, uAt string
	err := s.db.QueryRow(`SELECT id, name, path, model, system_prompt, created_at, updated_at FROM workspaces WHERE id = ?`, id).
		Scan(&w.ID, &w.Name, &w.Path, &w.Model, &w.SystemPrompt, &cAt, &uAt)
	if err != nil {
		return w, err
	}
	w.CreatedAt = parseTime(cAt)
	w.UpdatedAt = parseTime(uAt)
	return w, nil
}

func (s *Store) CreateWorkspace(name, path, model string) (Workspace, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Workspace{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Workspace{}, err
	}
	if !info.IsDir() {
		return Workspace{}, fmt.Errorf("path is not a directory")
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(abs)
	}
	ts := nowISO()
	res, err := s.db.Exec(`INSERT INTO workspaces (name, path, model, system_prompt, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)`,
		name, abs, model, ts, ts)
	if err != nil {
		return Workspace{}, err
	}
	id, _ := res.LastInsertId()
	return s.GetWorkspace(id)
}

func (s *Store) UpdateWorkspace(id int64, name, model, systemPrompt *string) (Workspace, error) {
	w, err := s.GetWorkspace(id)
	if err != nil {
		return w, err
	}
	if name != nil {
		w.Name = *name
	}
	if model != nil {
		w.Model = *model
	}
	if systemPrompt != nil {
		w.SystemPrompt = *systemPrompt
	}
	_, err = s.db.Exec(`UPDATE workspaces SET name=?, model=?, system_prompt=?, updated_at=? WHERE id=?`,
		w.Name, w.Model, w.SystemPrompt, nowISO(), id)
	if err != nil {
		return w, err
	}
	return s.GetWorkspace(id)
}

func (s *Store) TouchWorkspace(id int64) {
	_, _ = s.db.Exec(`UPDATE workspaces SET updated_at=? WHERE id=?`, nowISO(), id)
}

func (s *Store) DeleteWorkspace(id int64) error {
	_, err := s.db.Exec(`DELETE FROM workspaces WHERE id=?`, id)
	return err
}

func (s *Store) ListConversations(workspaceID int64) ([]Conversation, error) {
	rows, err := s.db.Query(`SELECT id, workspace_id, title, model, created_at, updated_at FROM conversations WHERE workspace_id=? ORDER BY updated_at DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Conversation
	for rows.Next() {
		var c Conversation
		var cAt, uAt string
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.Model, &cAt, &uAt); err != nil {
			return nil, err
		}
		c.CreatedAt = parseTime(cAt)
		c.UpdatedAt = parseTime(uAt)
		out = append(out, c)
	}
	if out == nil {
		out = []Conversation{}
	}
	return out, rows.Err()
}

func (s *Store) GetConversation(id int64) (Conversation, error) {
	var c Conversation
	var cAt, uAt string
	err := s.db.QueryRow(`SELECT id, workspace_id, title, model, created_at, updated_at FROM conversations WHERE id=?`, id).
		Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.Model, &cAt, &uAt)
	if err != nil {
		return c, err
	}
	c.CreatedAt = parseTime(cAt)
	c.UpdatedAt = parseTime(uAt)
	return c, nil
}

func (s *Store) CreateConversation(workspaceID int64, title, model string) (Conversation, error) {
	if title == "" {
		title = "New Agent"
	}
	ts := nowISO()
	res, err := s.db.Exec(`INSERT INTO conversations (workspace_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		workspaceID, title, model, ts, ts)
	if err != nil {
		return Conversation{}, err
	}
	id, _ := res.LastInsertId()
	s.TouchWorkspace(workspaceID)
	return s.GetConversation(id)
}

func (s *Store) UpdateConversation(id int64, title, model *string) (Conversation, error) {
	c, err := s.GetConversation(id)
	if err != nil {
		return c, err
	}
	if title != nil {
		c.Title = *title
	}
	if model != nil {
		c.Model = *model
	}
	_, err = s.db.Exec(`UPDATE conversations SET title=?, model=?, updated_at=? WHERE id=?`, c.Title, c.Model, nowISO(), id)
	if err != nil {
		return c, err
	}
	return s.GetConversation(id)
}

func (s *Store) DeleteConversation(id int64) error {
	_, err := s.db.Exec(`DELETE FROM conversations WHERE id=?`, id)
	return err
}

func (s *Store) ListMessages(conversationID int64) ([]Message, error) {
	rows, err := s.db.Query(`SELECT id, conversation_id, role, content, created_at FROM messages WHERE conversation_id=? ORDER BY id ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var cAt string
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &cAt); err != nil {
			return nil, err
		}
		m.CreatedAt = parseTime(cAt)
		out = append(out, m)
	}
	if out == nil {
		out = []Message{}
	}
	return out, rows.Err()
}

func (s *Store) AddMessage(conversationID int64, role, content string) (Message, error) {
	ts := nowISO()
	res, err := s.db.Exec(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
		conversationID, role, content, ts)
	if err != nil {
		return Message{}, err
	}
	id, _ := res.LastInsertId()
	_, _ = s.db.Exec(`UPDATE conversations SET updated_at=? WHERE id=?`, ts, conversationID)
	return Message{ID: id, ConversationID: conversationID, Role: role, Content: content, CreatedAt: parseTime(ts)}, nil
}

func (s *Store) GetSetting(key, fallback string) string {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err != nil {
		return fallback
	}
	return v
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) GetJSONSetting(key string, dest any) error {
	raw := s.GetSetting(key, "")
	if raw == "" {
		return sql.ErrNoRows
	}
	return json.Unmarshal([]byte(raw), dest)
}
