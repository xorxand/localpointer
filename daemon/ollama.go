package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MessageImage is a base64-encoded image attached to a chat message.
type MessageImage struct {
	Data string `json:"data"`
	MIME string `json:"mime,omitempty"`
}

type OllamaClient struct {
	baseURL    string
	httpClient *http.Client
	ctxCache   sync.Map // model name -> int context length
}

type ollamaTagsResponse struct {
	Models []map[string]any `json:"models"`
}

type ollamaChatRequest struct {
	Model    string           `json:"model"`
	Messages []map[string]any `json:"messages"`
	Stream   bool             `json:"stream"`
	Tools    []map[string]any `json:"tools,omitempty"`
	Format   any              `json:"format,omitempty"`
	Options  map[string]any   `json:"options,omitempty"`
}

// buildOptions returns Ollama request options for a temperature, or nil when
// temperature is unset (<= 0).
func buildOptions(temperature float64) map[string]any {
	if temperature <= 0 {
		return nil
	}
	return map[string]any{"temperature": temperature}
}

type ollamaChatChunk struct {
	Message struct {
		Content   string           `json:"content"`
		ToolCalls []ollamaToolCall `json:"tool_calls"`
	} `json:"message"`
	Done            bool  `json:"done"`
	PromptEvalCount int   `json:"prompt_eval_count"`
	EvalCount       int   `json:"eval_count"`
	TotalDuration   int64 `json:"total_duration"`
	LoadDuration    int64 `json:"load_duration"`
}

type ollamaToolCall struct {
	Function struct {
		Name      string `json:"name"`
		Arguments any    `json:"arguments"`
	} `json:"function"`
}

// ChatStats captures token and timing metadata reported by Ollama on the final
// chunk of a chat response. Durations are converted to milliseconds.
type ChatStats struct {
	PromptTokens     int   `json:"prompt_tokens"`
	CompletionTokens int   `json:"completion_tokens"`
	LoadMs           int64 `json:"load_ms"`
	TotalMs          int64 `json:"total_ms"`
}

// Add merges another set of stats into this one, accumulating across multiple
// model calls in a single turn (e.g. tool rounds + final answer).
func (s *ChatStats) Add(other ChatStats) {
	s.PromptTokens += other.PromptTokens
	s.CompletionTokens += other.CompletionTokens
	s.TotalMs += other.TotalMs
	if other.LoadMs > s.LoadMs {
		s.LoadMs = other.LoadMs
	}
}

func statsFromChunk(chunk ollamaChatChunk) ChatStats {
	return ChatStats{
		PromptTokens:     chunk.PromptEvalCount,
		CompletionTokens: chunk.EvalCount,
		LoadMs:           chunk.LoadDuration / 1_000_000,
		TotalMs:          chunk.TotalDuration / 1_000_000,
	}
}

type OllamaToolChatResponse struct {
	Content   string
	ToolCalls []ollamaToolCall
	Stats     ChatStats
}

func newOllamaClient() *OllamaClient {
	baseURL := os.Getenv("OLLAMA_BASE_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:11434"
	}
	return &OllamaClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 0,
		},
	}
}

func (c *OllamaClient) CheckHealth() bool {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(c.baseURL + "/api/tags")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (c *OllamaClient) ListModels() ([]map[string]any, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(c.baseURL + "/api/tags")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama returned status %d", resp.StatusCode)
	}

	var data ollamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}

	models := data.Models
	sort.Slice(models, func(i, j int) bool {
		speedI := modelSpeedScore(models[i])
		speedJ := modelSpeedScore(models[j])
		if speedI != speedJ {
			return speedI < speedJ
		}
		nameI, _ := models[i]["name"].(string)
		nameJ, _ := models[j]["name"].(string)
		return nameI < nameJ
	})
	return models, nil
}

func parseParameterSizeB(raw string) float64 {
	raw = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(raw, "B"), "b"))
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return value
}

func modelSpeedScore(model map[string]any) float64 {
	if details, ok := model["details"].(map[string]any); ok {
		if raw, ok := details["parameter_size"].(string); ok {
			if value := parseParameterSizeB(raw); value > 0 {
				return value
			}
		}
	}

	switch size := model["size"].(type) {
	case float64:
		return size / 1e9
	case int64:
		return float64(size) / 1e9
	case int:
		return float64(size) / 1e9
	default:
		return 0
	}
}

func (c *OllamaClient) ModelSupportsVision(modelName string) (bool, error) {
	models, err := c.ListModels()
	if err != nil {
		return false, err
	}
	for _, model := range models {
		name, _ := model["name"].(string)
		if name != modelName {
			continue
		}
		caps, _ := model["capabilities"].([]any)
		for _, cap := range caps {
			if capName, ok := cap.(string); ok && capName == "vision" {
				return true, nil
			}
		}
		return false, nil
	}
	return false, fmt.Errorf("model %q not found", modelName)
}

func (c *OllamaClient) ModelSupportsTools(modelName string) (bool, error) {
	models, err := c.ListModels()
	if err != nil {
		return false, err
	}
	for _, model := range models {
		name, _ := model["name"].(string)
		if name != modelName {
			continue
		}
		caps, _ := model["capabilities"].([]any)
		for _, cap := range caps {
			if capName, ok := cap.(string); ok && capName == "tools" {
				return true, nil
			}
		}
		return modelLikelySupportsTools(modelName), nil
	}
	return false, fmt.Errorf("model %q not found", modelName)
}

const defaultContextLength = 8192

// ModelContextLength returns the model's context window size in tokens, cached
// per model. Returns 0 when it cannot be determined.
func (c *OllamaClient) ModelContextLength(model string) int {
	if v, ok := c.ctxCache.Load(model); ok {
		return v.(int)
	}
	n := c.fetchContextLength(model)
	c.ctxCache.Store(model, n)
	return n
}

func (c *OllamaClient) fetchContextLength(model string) int {
	payload, err := json.Marshal(map[string]any{"model": model})
	if err != nil {
		return 0
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(c.baseURL+"/api/show", "application/json", bytes.NewReader(payload))
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	var data struct {
		ModelInfo map[string]any `json:"model_info"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0
	}
	for k, v := range data.ModelInfo {
		if strings.HasSuffix(k, ".context_length") {
			if n, ok := v.(float64); ok && n > 0 {
				return int(n)
			}
		}
	}
	return 0
}

// contextBudget returns the token budget available for history, reserving
// headroom for the model's reply.
func (c *OllamaClient) contextBudget(model string) int {
	ctxLen := c.ModelContextLength(model)
	if ctxLen <= 0 {
		ctxLen = defaultContextLength
	}
	reserve := ctxLen / 4
	if reserve < 1024 {
		reserve = 1024
	}
	budget := ctxLen - reserve
	if budget < 1024 {
		budget = 1024
	}
	return budget
}

func modelLikelySupportsTools(modelName string) bool {
	name := strings.ToLower(modelName)
	prefixes := []string{
		"qwen2.5", "qwen3", "llama3.1", "llama3.2", "mistral", "mixtral",
		"command-r", "phi3", "gemma2", "deepseek",
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func toolCallsForMessage(calls []ollamaToolCall) []map[string]any {
	if len(calls) == 0 {
		return nil
	}
	out := make([]map[string]any, len(calls))
	for i, call := range calls {
		out[i] = map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":      call.Function.Name,
				"arguments": call.Function.Arguments,
			},
		}
	}
	return out
}

func (c *OllamaClient) ChatWithTools(ctx context.Context, model string, messages []map[string]any, tools []map[string]any, options map[string]any) (OllamaToolChatResponse, error) {
	payload, err := json.Marshal(ollamaChatRequest{
		Model:    model,
		Messages: messages,
		Stream:   false,
		Tools:    tools,
		Options:  options,
	})
	if err != nil {
		return OllamaToolChatResponse{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return OllamaToolChatResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return OllamaToolChatResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return OllamaToolChatResponse{}, fmt.Errorf("ollama returned status %d: %s", resp.StatusCode, string(body))
	}

	var chunk ollamaChatChunk
	if err := json.NewDecoder(resp.Body).Decode(&chunk); err != nil {
		return OllamaToolChatResponse{}, err
	}

	return OllamaToolChatResponse{
		Content:   chunk.Message.Content,
		ToolCalls: chunk.Message.ToolCalls,
		Stats:     statsFromChunk(chunk),
	}, nil
}

type ollamaEmbedRequest struct {
	Model string `json:"model"`
	Input any    `json:"input"`
}

type ollamaEmbedResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
}

// Embed returns one embedding vector per input string using Ollama's /api/embed.
func (c *OllamaClient) Embed(ctx context.Context, model string, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, nil
	}
	payload, err := json.Marshal(ollamaEmbedRequest{Model: model, Input: inputs})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/embed", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama embed returned status %d: %s", resp.StatusCode, string(body))
	}

	var data ollamaEmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	if len(data.Embeddings) != len(inputs) {
		return nil, fmt.Errorf("expected %d embeddings, got %d", len(inputs), len(data.Embeddings))
	}
	return data.Embeddings, nil
}

func buildOllamaMessage(role, content string, images []MessageImage) map[string]any {
	msg := map[string]any{
		"role":    role,
		"content": content,
	}
	if len(images) == 0 {
		return msg
	}

	rawImages := make([]string, len(images))
	for i, image := range images {
		rawImages[i] = image.Data
	}
	msg["images"] = rawImages
	if strings.TrimSpace(content) == "" {
		msg["content"] = "What's in this image?"
	}
	return msg
}

func (c *OllamaClient) Chat(model string, messages []map[string]any) (string, error) {
	return c.ChatWithContext(context.Background(), model, messages)
}

func (c *OllamaClient) ChatWithContext(ctx context.Context, model string, messages []map[string]any) (string, error) {
	payload, err := json.Marshal(ollamaChatRequest{
		Model:    model,
		Messages: messages,
		Stream:   false,
	})
	if err != nil {
		return "", err
	}

	client := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama returned status %d: %s", resp.StatusCode, string(body))
	}

	var chunk ollamaChatChunk
	if err := json.NewDecoder(resp.Body).Decode(&chunk); err != nil {
		return "", err
	}
	return chunk.Message.Content, nil
}

// ChatJSON performs a non-streaming chat constrained to the given JSON schema
// (Ollama's structured output). Returns the raw JSON content.
func (c *OllamaClient) ChatJSON(ctx context.Context, model string, messages []map[string]any, format any) (string, error) {
	payload, err := json.Marshal(ollamaChatRequest{
		Model:    model,
		Messages: messages,
		Stream:   false,
		Format:   format,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama returned status %d: %s", resp.StatusCode, string(body))
	}

	var chunk ollamaChatChunk
	if err := json.NewDecoder(resp.Body).Decode(&chunk); err != nil {
		return "", err
	}
	return chunk.Message.Content, nil
}

func (c *OllamaClient) StreamChat(ctx context.Context, model string, messages []map[string]any, options map[string]any, onToken func(string) error) (string, ChatStats, error) {
	payload, err := json.Marshal(ollamaChatRequest{
		Model:    model,
		Messages: messages,
		Stream:   true,
		Options:  options,
	})
	if err != nil {
		return "", ChatStats{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return "", ChatStats{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", ChatStats{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", ChatStats{}, fmt.Errorf("ollama returned status %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var fullResponse string
	var stats ChatStats
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return fullResponse, stats, err
		}

		line := scanner.Text()
		if line == "" {
			continue
		}

		var chunk ollamaChatChunk
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			return fullResponse, stats, err
		}

		if chunk.Message.Content != "" {
			fullResponse += chunk.Message.Content
			if onToken != nil {
				if err := onToken(chunk.Message.Content); err != nil {
					return fullResponse, stats, err
				}
			}
		}
		if chunk.Done {
			stats = statsFromChunk(chunk)
			break
		}
	}

	if err := ctx.Err(); err != nil {
		return fullResponse, stats, err
	}

	return fullResponse, stats, scanner.Err()
}
