package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestRunAgentReturnsAnswerAfterRepeatedToolFailures(t *testing.T) {
	toolRequests := 0
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body string
		switch request.URL.Path {
		case "/api/tags":
			body = `{"models":[{"name":"test:4b","capabilities":["tools"]}]}`
		case "/api/chat":
			var chatRequest ollamaChatRequest
			if err := json.NewDecoder(request.Body).Decode(&chatRequest); err != nil {
				return nil, err
			}
			if len(chatRequest.Tools) > 0 {
				toolRequests++
				body = `{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"/etc/passwd"}}}]},"done":true}`
			} else {
				body = "{\"message\":{\"content\":\"I could not inspect that path.\"},\"done\":false}\n{\"message\":{},\"done\":true}\n"
			}
		default:
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Body:       io.NopCloser(strings.NewReader("not found")),
				Header:     make(http.Header),
				Request:    request,
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})

	fs, err := newWorkspaceFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	client := newOllamaClient()
	client.baseURL = "http://ollama.test"
	client.httpClient = &http.Client{Transport: transport}
	srv := &Server{ollama: client}
	var streamed strings.Builder

	result, err := srv.runAgent(
		context.Background(),
		"test:4b",
		[]map[string]any{{"role": "user", "content": "answer a question"}},
		fs,
		nil,
		false,
		"answer a question",
		true,
		func(map[string]any) error { return nil },
		func(token string) error {
			streamed.WriteString(token)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("runAgent: %v", err)
	}
	if result.Content != "I could not inspect that path." {
		t.Fatalf("content %q", result.Content)
	}
	if streamed.String() != result.Content {
		t.Fatalf("streamed %q, want %q", streamed.String(), result.Content)
	}
	if toolRequests != 4 {
		t.Fatalf("tool requests %d, want 4", toolRequests)
	}
}
