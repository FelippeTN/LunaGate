package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
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
func (stubDocker) Logs(context.Context, string, bool) (docker.LogStream, error) {
	return docker.LogStream{ReadCloser: io.NopCloser(strings.NewReader(""))}, nil
}
func (stubDocker) ListAllContainers(context.Context) ([]docker.HostContainer, error) {
	return nil, nil
}
func (stubDocker) ListImages(context.Context) ([]docker.Image, error) { return nil, nil }
func (stubDocker) StartContainer(context.Context, string) error       { return nil }
func (stubDocker) StopContainer(context.Context, string) error        { return nil }
func (stubDocker) RestartContainer(context.Context, string) error     { return nil }
func (stubDocker) RemoveContainer(context.Context, string) error      { return nil }

type gatewayDocker struct {
	stubDocker
	containers     []docker.Container
	hostContainers []docker.HostContainer
}

func (d *gatewayDocker) ListByDeployment(context.Context, string) ([]docker.Container, error) {
	return d.containers, nil
}

func (d *gatewayDocker) ListAllContainers(context.Context) ([]docker.HostContainer, error) {
	return d.hostContainers, nil
}

type gatewayEnvironments struct{ remote docker.ContainerOps }

func (e gatewayEnvironments) Remote(string, string) (docker.ContainerOps, error) {
	return e.remote, nil
}
func (gatewayEnvironments) Forget(string) {}
func (gatewayEnvironments) DialContext(ctx context.Context, _, _, target string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", target)
}

type actionDocker struct {
	stubDocker
	actions []string
}

func (d *actionDocker) StartContainer(_ context.Context, id string) error {
	d.actions = append(d.actions, "start:"+id)
	return nil
}
func (d *actionDocker) StopContainer(_ context.Context, id string) error {
	d.actions = append(d.actions, "stop:"+id)
	return nil
}
func (d *actionDocker) RestartContainer(_ context.Context, id string) error {
	d.actions = append(d.actions, "restart:"+id)
	return nil
}
func (d *actionDocker) RemoveContainer(_ context.Context, id string) error {
	d.actions = append(d.actions, "remove:"+id)
	return nil
}
func (d *actionDocker) Logs(context.Context, string, bool) (docker.LogStream, error) {
	d.actions = append(d.actions, "logs:container")
	return docker.LogStream{ReadCloser: io.NopCloser(strings.NewReader("hello\n"))}, nil
}

func TestAPILifecycle(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	server := httptest.NewServer(httpapi.New(db, stubDocker{}, nil, "secret", slog.New(slog.NewTextHandler(io.Discard, nil))))
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

func TestOnlyRunningContainerRequestsAreCounted(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/hello?x=1" && r.URL.RequestURI() != "/remote?x=2" {
			t.Errorf("upstream request URI = %q", r.URL.RequestURI())
		}
		writeJSON := json.NewEncoder(w)
		w.WriteHeader(http.StatusCreated)
		_ = writeJSON.Encode(map[string]bool{"ok": true})
	}))
	defer upstream.Close()
	port, err := strconv.Atoi(strings.TrimPrefix(upstream.URL, "http://127.0.0.1:"))
	if err != nil {
		t.Fatal(err)
	}
	ports, _ := json.Marshal([]docker.Port{{Host: port, Container: 80}})
	deployment, err := db.CreateDeployment(context.Background(), store.Deployment{
		Name: "App", Slug: "app", Image: "app:latest", Replicas: 1, Env: "{}", Ports: string(ports),
	})
	if err != nil {
		t.Fatal(err)
	}
	environment, err := db.CreateEnvironment(context.Background(), store.Environment{
		Name: "Remote", SSHHost: "deploy@example", SSHPassword: "",
	})
	if err != nil {
		t.Fatal(err)
	}
	dockerOps := &gatewayDocker{containers: []docker.Container{{ID: "running", State: "running"}}}
	remoteOps := &gatewayDocker{hostContainers: []docker.HostContainer{{
		ID: "remote-running", State: "running", Ports: []string{fmt.Sprintf("%d:80/tcp", port)},
	}}}
	envs := gatewayEnvironments{remote: remoteOps}
	server := httptest.NewServer(httpapi.New(db, dockerOps, envs, "secret", slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer server.Close()

	request := func(path string, authenticated bool) (*http.Response, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if authenticated {
			req.Header.Set("Authorization", "Bearer secret")
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return response, body
	}

	request("/healthz", false)
	request("/readyz", false)
	request("/v1/deployments", true)
	request("/v1/deployments", false)
	request("/gateway/missing/hello", false)
	_, metrics := request("/v1/container-metrics", true)
	if metrics["container_requests_total"] != float64(0) || metrics["container_requests_last_minute"] != float64(0) {
		t.Fatalf("LunaGate requests were counted: %#v", metrics)
	}

	response, body := request("/gateway/app/hello?x=1", false)
	if response.StatusCode != http.StatusCreated || body["ok"] != true {
		t.Fatalf("gateway status = %d, body = %#v", response.StatusCode, body)
	}
	_, metrics = request("/v1/container-metrics", true)

	if metrics["container_requests_total"] != float64(1) || metrics["container_requests_last_minute"] != float64(1) {
		t.Fatalf("unexpected request counts: %#v", metrics)
	}
	statuses := metrics["last_minute"].(map[string]any)
	if statuses["success"] != float64(1) || statuses["client_error"] != float64(0) || statuses["server_error"] != float64(0) {
		t.Fatalf("unexpected status counts: %#v", statuses)
	}
	response, body = request("/gateway/ssh/"+environment.ID+"/remote-running/remote?x=2", false)
	if response.StatusCode != http.StatusCreated || body["ok"] != true {
		t.Fatalf("SSH gateway status = %d, body = %#v", response.StatusCode, body)
	}
	_, metrics = request("/v1/container-metrics", true)
	if metrics["container_requests_total"] != float64(2) {
		t.Fatalf("remote container request was not counted: %#v", metrics)
	}

	remoteOps.hostContainers[0].State = "exited"
	response, _ = request("/gateway/ssh/"+environment.ID+"/remote-running/remote", false)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("stopped remote container status = %d", response.StatusCode)
	}

	upstream.Close()
	response, _ = request("/gateway/app/hello", false)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("unreachable container status = %d", response.StatusCode)
	}
	_, metrics = request("/v1/container-metrics", true)
	if metrics["container_requests_total"] != float64(2) {
		t.Fatalf("request rejected by the container was counted: %#v", metrics)
	}

	dockerOps.containers = []docker.Container{{ID: deployment.ID, State: "exited"}}
	response, _ = request("/gateway/app/hello", false)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("stopped deployment status = %d", response.StatusCode)
	}
	_, metrics = request("/v1/container-metrics", true)
	if metrics["container_requests_total"] != float64(2) {
		t.Fatalf("stopped deployment was counted: %#v", metrics)
	}
}

func TestLocalAndRemoteContainerActionsAndLogs(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	environment, err := db.CreateEnvironment(context.Background(), store.Environment{Name: "Remote", SSHHost: "deploy@example"})
	if err != nil {
		t.Fatal(err)
	}
	local := &actionDocker{}
	remote := &actionDocker{}
	server := httptest.NewServer(httpapi.New(
		db, local, gatewayEnvironments{remote: remote}, "secret", slog.New(slog.NewTextHandler(io.Discard, nil)),
	))
	defer server.Close()

	exercise := func(query string) {
		t.Helper()
		for _, action := range []struct{ method, suffix string }{
			{http.MethodPost, "/start"},
			{http.MethodPost, "/stop"},
			{http.MethodPost, "/restart"},
			{http.MethodDelete, ""},
		} {
			req, err := http.NewRequest(action.method, server.URL+"/v1/host/containers/container"+action.suffix+query, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer secret")
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("%s %s status = %d", action.method, action.suffix, response.StatusCode)
			}
		}

		separator := "?"
		if query != "" {
			separator = "&"
		}
		response, err := http.Get(server.URL + "/v1/host/containers/container/logs" + query + separator + "token=secret")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("logs status = %d", response.StatusCode)
		}
		if !strings.Contains(string(body), "data: hello") {
			t.Fatalf("logs body = %q", body)
		}
	}

	exercise("")
	exercise("?env=" + environment.ID)
	want := []string{"start:container", "stop:container", "restart:container", "remove:container", "logs:container"}
	if strings.Join(local.actions, ",") != strings.Join(want, ",") {
		t.Fatalf("local actions = %#v, want %#v", local.actions, want)
	}
	if strings.Join(remote.actions, ",") != strings.Join(want, ",") {
		t.Fatalf("remote actions = %#v, want %#v", remote.actions, want)
	}
}
