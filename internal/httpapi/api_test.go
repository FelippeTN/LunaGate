package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/httpapi"
	"github.com/FelippeTN/LunaGate/internal/store"
)

// stubDocker satisfies the container ops the API needs; the API-catalog tests
// never touch containers.
type stubDocker struct{}

func (stubDocker) ListByDeployment(context.Context, string) ([]docker.Container, error) {
	return nil, nil
}
func (stubDocker) StopAndRemove(context.Context, string) error { return nil }
func (stubDocker) Logs(context.Context, string, bool) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func TestAPILifecycle(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	server := httptest.NewServer(httpapi.New(db, stubDocker{}, "secret", slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer server.Close()

	request := func(method, path, body string, authenticated bool) (*http.Response, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if authenticated {
			req.Header.Set("Authorization", "Bearer secret")
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var decoded map[string]any
		if response.StatusCode != http.StatusNoContent {
			if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
				t.Fatal(err)
			}
		}
		return response, decoded
	}

	response, _ := request(http.MethodGet, "/v1/apis", "", false)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", response.StatusCode)
	}

	response, created := request(http.MethodPost, "/v1/apis", `{
		"name":"Orders", "slug":"orders", "description":"Orders API",
		"spec":{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}
	}`, true)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d, body = %#v", response.StatusCode, created)
	}
	id, _ := created["id"].(string)
	if id == "" || response.Header.Get("Location") != "/v1/apis/"+id {
		t.Fatalf("invalid created resource: %#v", created)
	}

	response, conflict := request(http.MethodPost, "/v1/apis", `{"name":"Other","slug":"orders"}`, true)
	if response.StatusCode != http.StatusConflict || !strings.Contains(conflict["error"].(map[string]any)["code"].(string), "conflict") {
		t.Fatalf("conflict status = %d, body = %#v", response.StatusCode, conflict)
	}

	response, listed := request(http.MethodGet, "/v1/apis", "", true)
	if response.StatusCode != http.StatusOK || len(listed["items"].([]any)) != 1 {
		t.Fatalf("list status = %d, body = %#v", response.StatusCode, listed)
	}

	response, updated := request(http.MethodPut, "/v1/apis/"+id, `{"name":"Orders v2","slug":"orders-v2"}`, true)
	if response.StatusCode != http.StatusOK || updated["slug"] != "orders-v2" {
		t.Fatalf("update status = %d, body = %#v", response.StatusCode, updated)
	}

	response, _ = request(http.MethodDelete, "/v1/apis/"+id, "", true)
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d", response.StatusCode)
	}

	response, _ = request(http.MethodGet, "/v1/apis/"+id, "", true)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted resource status = %d", response.StatusCode)
	}
}
