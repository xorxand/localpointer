package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestListModelsExcludesCloudModels(t *testing.T) {
	client := newOllamaClient()
	client.baseURL = "http://ollama.test"
	client.httpClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body := `{"models":[
			{"name":"qwen3.5:4b"},
			{"name":"kimi-k3:cloud"},
			{"name":"gpt-oss:120b-cloud"}
		]}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}

	models, err := client.ListModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0]["name"] != "qwen3.5:4b" {
		t.Fatalf("models %#v, want only local model", models)
	}
}
