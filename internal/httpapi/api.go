package httpapi

import (
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/store"
	"github.com/docker/docker/pkg/stdcopy"
)

type environmentManager interface {
	Remote(sshHost, password string) (docker.ContainerOps, error)
	DialContext(ctx context.Context, sshHost, password, target string) (net.Conn, error)
	Forget(sshHost string)
}

const maxBodySize = 1 << 20

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type handler struct {
	store     *store.Store
	docker    docker.ContainerOps
	envs      environmentManager
	adminHash [32]byte
	logger    *slog.Logger
	metrics   requestMetrics
}

type metricBucket struct {
	second   int64
	requests uint64
	latency  time.Duration
	status   [3]uint64
}

type requestMetrics struct {
	mu      sync.Mutex
	total   uint64
	buckets [60]metricBucket
}

type apiInput struct {
	Name        string          `json:"name"`
	Slug        string          `json:"slug"`
	Description string          `json:"description"`
	Spec        json.RawMessage `json:"spec"`
}

// envs resolves non-local environments (?env=<id> beyond "local"); it may be
// nil if the caller never needs remote hosts.
func New(db *store.Store, dockerOps docker.ContainerOps, envs environmentManager, adminToken string, logger *slog.Logger) http.Handler {
	h := &handler{store: db, docker: dockerOps, envs: envs, adminHash: sha256.Sum256([]byte(adminToken)), logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
	mux.HandleFunc("/gateway/{slug}", h.gateway)
	mux.HandleFunc("/gateway/{slug}/{path...}", h.gateway)
	mux.HandleFunc("/gateway/ssh/{environment}/{container}", h.sshGateway)
	mux.HandleFunc("/gateway/ssh/{environment}/{container}/{path...}", h.sshGateway)
	mux.Handle("GET /v1/apis", h.authenticate(http.HandlerFunc(h.listAPIs)))
	mux.Handle("POST /v1/apis", h.authenticate(http.HandlerFunc(h.createAPI)))
	mux.Handle("GET /v1/apis/{id}", h.authenticate(http.HandlerFunc(h.getAPI)))
	mux.Handle("PUT /v1/apis/{id}", h.authenticate(http.HandlerFunc(h.updateAPI)))
	mux.Handle("DELETE /v1/apis/{id}", h.authenticate(http.HandlerFunc(h.deleteAPI)))

	mux.Handle("GET /v1/deployments", h.authenticate(http.HandlerFunc(h.listDeployments)))
	mux.Handle("POST /v1/deployments", h.authenticate(http.HandlerFunc(h.createDeployment)))
	mux.Handle("GET /v1/deployments/{id}", h.authenticate(http.HandlerFunc(h.getDeployment)))
	mux.Handle("PUT /v1/deployments/{id}", h.authenticate(http.HandlerFunc(h.updateDeployment)))
	mux.Handle("DELETE /v1/deployments/{id}", h.authenticate(http.HandlerFunc(h.deleteDeployment)))
	mux.Handle("POST /v1/deployments/{id}/redeploy", h.authenticate(http.HandlerFunc(h.redeployDeployment)))
	mux.Handle("GET /v1/deployments/{id}/containers", h.authenticate(http.HandlerFunc(h.deploymentContainers)))

	mux.Handle("GET /v1/host/containers", h.authenticate(http.HandlerFunc(h.hostContainers)))
	mux.Handle("GET /v1/host/images", h.authenticate(http.HandlerFunc(h.hostImages)))
	mux.Handle("POST /v1/host/containers/{id}/start", h.authenticate(http.HandlerFunc(h.startHostContainer)))
	mux.Handle("POST /v1/host/containers/{id}/stop", h.authenticate(http.HandlerFunc(h.stopHostContainer)))
	mux.Handle("POST /v1/host/containers/{id}/restart", h.authenticate(http.HandlerFunc(h.restartHostContainer)))
	mux.Handle("DELETE /v1/host/containers/{id}", h.authenticate(http.HandlerFunc(h.removeHostContainer)))
	mux.Handle("DELETE /v1/host/images/{id}", h.authenticate(http.HandlerFunc(h.removeHostImage)))
	mux.HandleFunc("GET /v1/host/containers/{id}/logs", h.hostContainerLogs)
	mux.Handle("GET /v1/container-metrics", h.authenticate(http.HandlerFunc(h.getContainerMetrics)))

	mux.Handle("GET /v1/environments", h.authenticate(http.HandlerFunc(h.listEnvironments)))
	mux.Handle("POST /v1/environments", h.authenticate(http.HandlerFunc(h.createEnvironment)))
	mux.Handle("DELETE /v1/environments/{id}", h.authenticate(http.HandlerFunc(h.deleteEnvironment)))
	// Logs use EventSource, which cannot set headers, so this route does its own
	// token check (header or ?token=) instead of the authenticate middleware.
	mux.HandleFunc("GET /v1/deployments/{id}/logs", h.deploymentLogs)
	// Webhook is public; it authenticates via per-deployment HMAC signature.
	mux.HandleFunc("POST /v1/webhooks/{id}", h.webhook)
	return h.logRequests(mux)
}

func (h *handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *handler) ready(w http.ResponseWriter, r *http.Request) {
	if err := h.store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) createAPI(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeInput(w, r)
	if !ok {
		return
	}
	api := input.toAPI("")
	if message := validate(api); message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	api, err := h.store.CreateAPI(r.Context(), api)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "slug_conflict", "slug already exists")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/apis/"+api.ID)
	writeJSON(w, http.StatusCreated, api)
}

func (h *handler) listAPIs(w http.ResponseWriter, r *http.Request) {
	apis, err := h.store.ListAPIs(r.Context())
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": apis})
}

func (h *handler) getAPI(w http.ResponseWriter, r *http.Request) {
	api, err := h.store.GetAPI(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "API not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api)
}

func (h *handler) updateAPI(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeInput(w, r)
	if !ok {
		return
	}
	api := input.toAPI(r.PathValue("id"))
	if message := validate(api); message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	api, err := h.store.UpdateAPI(r.Context(), api)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "API not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "slug_conflict", "slug already exists")
	case err != nil:
		h.internalError(w, err)
	default:
		writeJSON(w, http.StatusOK, api)
	}
}

func (h *handler) deleteAPI(w http.ResponseWriter, r *http.Request) {
	err := h.store.DeleteAPI(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "API not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type deploymentInput struct {
	Name     string            `json:"name"`
	Slug     string            `json:"slug"`
	Image    string            `json:"image"`
	Replicas int               `json:"replicas"`
	Env      map[string]string `json:"env"`
	Ports    []docker.Port     `json:"ports"`
}

func (h *handler) createDeployment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeDeployment(w, r)
	if !ok {
		return
	}
	d, message := in.toDeployment("")
	if message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	d, err := h.store.CreateDeployment(r.Context(), d)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "slug_conflict", "slug already exists")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/deployments/"+d.ID)
	writeJSON(w, http.StatusCreated, d)
}

func (h *handler) listDeployments(w http.ResponseWriter, r *http.Request) {
	deployments, err := h.store.ListDeployments(r.Context())
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": deployments})
}

func (h *handler) getDeployment(w http.ResponseWriter, r *http.Request) {
	d, err := h.store.GetDeployment(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "deployment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (h *handler) updateDeployment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeDeployment(w, r)
	if !ok {
		return
	}
	d, message := in.toDeployment(r.PathValue("id"))
	if message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	d, err := h.store.UpdateDeployment(r.Context(), d)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "deployment not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "slug_conflict", "slug already exists")
	case err != nil:
		h.internalError(w, err)
	default:
		writeJSON(w, http.StatusOK, d)
	}
}

func (h *handler) deleteDeployment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := h.store.DeleteDeployment(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "deployment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	// Row is gone, so the reconciler won't recreate; reap the live containers.
	h.reap(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

// redeployDeployment removes the current containers; the reconciler pulls the
// (possibly updated) image and recreates them on its next tick. This handles a
// moved tag such as :latest, where the image reference is unchanged.
func (h *handler) redeployDeployment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.store.GetDeployment(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "deployment not found")
			return
		}
		h.internalError(w, err)
		return
	}
	h.reap(r.Context(), id)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "redeploying"})
}

func (h *handler) deploymentContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := h.docker.ListByDeployment(r.Context(), r.PathValue("id"))
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": containers})
}

func (h *handler) hostContainers(w http.ResponseWriter, r *http.Request) {
	ops, ok := h.resolveEnv(w, r)
	if !ok {
		return
	}
	containers, err := ops.ListAllContainers(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": containers})
}

func (h *handler) hostImages(w http.ResponseWriter, r *http.Request) {
	ops, ok := h.resolveEnv(w, r)
	if !ok {
		return
	}
	images, err := ops.ListImages(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": images})
}

func (h *handler) startHostContainer(w http.ResponseWriter, r *http.Request) {
	h.containerAction(w, r, "start", docker.ContainerOps.StartContainer)
}

func (h *handler) stopHostContainer(w http.ResponseWriter, r *http.Request) {
	h.containerAction(w, r, "stop", docker.ContainerOps.StopContainer)
}

func (h *handler) restartHostContainer(w http.ResponseWriter, r *http.Request) {
	h.containerAction(w, r, "restart", docker.ContainerOps.RestartContainer)
}

func (h *handler) removeHostContainer(w http.ResponseWriter, r *http.Request) {
	h.containerAction(w, r, "remove", docker.ContainerOps.RemoveContainer)
}

func (h *handler) removeHostImage(w http.ResponseWriter, r *http.Request) {
	ops, ok := h.resolveEnv(w, r)
	if !ok {
		return
	}
	if err := ops.RemoveImage(r.Context(), r.PathValue("id")); err != nil {
		writeError(w, http.StatusBadGateway, "image_remove_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

func (h *handler) containerAction(w http.ResponseWriter, r *http.Request, action string, run func(docker.ContainerOps, context.Context, string) error) {
	ops, ok := h.resolveEnv(w, r)
	if !ok {
		return
	}
	if err := run(ops, r.Context(), r.PathValue("id")); err != nil {
		writeError(w, http.StatusBadGateway, "container_action_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": action})
}

func (h *handler) getContainerMetrics(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.metrics.snapshot(time.Now()))
}

func (h *handler) gateway(w http.ResponseWriter, r *http.Request) {
	d, err := h.store.GetDeploymentBySlug(r.Context(), r.PathValue("slug"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "deployment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	containers, err := h.docker.ListByDeployment(r.Context(), d.ID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "docker_unavailable", "could not check container state")
		return
	}
	running := false
	for _, container := range containers {
		if container.State == "running" {
			running = true
			break
		}
	}
	if !running {
		writeError(w, http.StatusServiceUnavailable, "deployment_unavailable", "deployment has no running containers")
		return
	}
	var ports []docker.Port
	if err := json.Unmarshal([]byte(d.Ports), &ports); err != nil {
		h.internalError(w, err)
		return
	}
	if len(ports) == 0 {
		writeError(w, http.StatusServiceUnavailable, "port_unavailable", "deployment has no published port")
		return
	}

	h.proxyContainer(w, r, d.ID, &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", ports[0].Host),
	}, nil)
}

func (h *handler) sshGateway(w http.ResponseWriter, r *http.Request) {
	if h.envs == nil {
		writeError(w, http.StatusServiceUnavailable, "environment_unavailable", "remote environments are unavailable")
		return
	}
	env, err := h.store.GetEnvironment(r.Context(), r.PathValue("environment"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "environment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	password, err := h.openCredential(env.SSHPassword)
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", "could not decrypt the SSH password")
		return
	}
	ops, err := h.envs.Remote(env.SSHHost, password)
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", err.Error())
		return
	}
	containers, err := ops.ListAllContainers(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", err.Error())
		return
	}
	var container *docker.HostContainer
	for i := range containers {
		if containers[i].ID == r.PathValue("container") {
			container = &containers[i]
			break
		}
	}
	if container == nil {
		writeError(w, http.StatusNotFound, "not_found", "container not found")
		return
	}
	if container.State != "running" {
		writeError(w, http.StatusServiceUnavailable, "container_unavailable", "container is not running")
		return
	}
	port, ok := firstPublishedTCPPort(container.Ports)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "port_unavailable", "container has no published TCP port")
		return
	}
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return h.envs.DialContext(ctx, env.SSHHost, password, target)
	}}
	defer transport.CloseIdleConnections()
	h.proxyContainer(w, r, container.ID, &url.URL{Scheme: "http", Host: "remote-container"}, transport)
}

func firstPublishedTCPPort(ports []string) (int, bool) {
	for _, binding := range ports {
		public, rest, ok := strings.Cut(binding, ":")
		if !ok || !strings.HasSuffix(rest, "/tcp") {
			continue
		}
		port, err := strconv.Atoi(public)
		if err == nil && port > 0 && port <= 65535 {
			return port, true
		}
	}
	return 0, false
}

func (h *handler) proxyContainer(w http.ResponseWriter, r *http.Request, container string, target *url.URL, transport http.RoundTripper) {
	originalPath, originalRawPath := r.URL.Path, r.URL.RawPath
	r.URL.Path = "/" + r.PathValue("path")
	r.URL.RawPath = ""
	proxy := httputil.NewSingleHostReverseProxy(target)
	if transport != nil {
		proxy.Transport = transport
	}
	proxyFailed := false
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		proxyFailed = true
		h.logger.Error("gateway request failed", "container", container, "error", err)
		writeError(w, http.StatusBadGateway, "upstream_unavailable", "running container did not accept the request")
	}
	started := time.Now()
	response := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	proxy.ServeHTTP(response, r)
	r.URL.Path, r.URL.RawPath = originalPath, originalRawPath
	if !proxyFailed {
		h.metrics.record(time.Now(), response.status, time.Since(started))
	}
}

// resolveEnv picks the container operations for ?env=<id>, defaulting to "local".
// It writes the error response itself and returns ok=false on failure.
func (h *handler) resolveEnv(w http.ResponseWriter, r *http.Request) (docker.ContainerOps, bool) {
	id := r.URL.Query().Get("env")
	if id == "" || id == "local" {
		return h.docker, true
	}
	env, err := h.store.GetEnvironment(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "environment not found")
		return nil, false
	}
	if err != nil {
		h.internalError(w, err)
		return nil, false
	}
	if h.envs == nil {
		h.internalError(w, errors.New("no environment manager configured"))
		return nil, false
	}
	password, err := h.openCredential(env.SSHPassword)
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", "could not decrypt the SSH password; remove and add this environment again")
		return nil, false
	}
	cli, err := h.envs.Remote(env.SSHHost, password)
	if err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", err.Error())
		return nil, false
	}
	return cli, true
}

func (h *handler) listEnvironments(w http.ResponseWriter, r *http.Request) {
	envs, err := h.store.ListEnvironments(r.Context())
	if err != nil {
		h.internalError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(envs)+1)
	items = append(items, map[string]any{"id": "local", "name": "This machine", "kind": "local"})
	for _, e := range envs {
		items = append(items, map[string]any{
			"id": e.ID, "name": e.Name, "kind": "ssh", "ssh_host": e.SSHHost, "created_at": e.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type environmentInput struct {
	Name     string `json:"name"`
	SSHHost  string `json:"ssh_host"`
	Password string `json:"password"`
}

// The user part is optional: a bare host lets ~/.ssh/config supply User (and
// HostName, Port, IdentityFile), which is how most people already reach these
// machines from a terminal.
var sshHostPattern = regexp.MustCompile(`^([\w.-]+@)?[\w.-]+(:\d{1,5})?$`)

func (h *handler) createEnvironment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	var in environmentInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.SSHHost = strings.TrimSpace(in.SSHHost)
	if in.Name == "" || len(in.Name) > 120 {
		writeError(w, http.StatusBadRequest, "validation_error", "name is required and must have at most 120 characters")
		return
	}
	if !sshHostPattern.MatchString(in.SSHHost) {
		writeError(w, http.StatusBadRequest, "validation_error", "ssh_host must look like host, user@host or user@host:port")
		return
	}
	if in.Password != "" && !strings.Contains(in.SSHHost, "@") {
		writeError(w, http.StatusBadRequest, "validation_error", "password authentication requires user@host")
		return
	}
	if len(in.Password) > 4096 {
		writeError(w, http.StatusBadRequest, "validation_error", "password must have at most 4096 characters")
		return
	}
	if err := docker.Verify(r.Context(), in.SSHHost, in.Password); err != nil {
		writeError(w, http.StatusBadGateway, "environment_unreachable", "could not connect: "+err.Error())
		return
	}
	secret, err := h.sealCredential(in.Password)
	if err != nil {
		h.internalError(w, err)
		return
	}
	env, err := h.store.CreateEnvironment(r.Context(), store.Environment{Name: in.Name, SSHHost: in.SSHHost, SSHPassword: secret})
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, env)
}

func (h *handler) sealCredential(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	block, err := aes.NewCipher(h.adminHash[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (h *handler) openCredential(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	payload, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(h.adminHash[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(payload) < gcm.NonceSize() {
		return "", errors.New("invalid encrypted credential")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], nil)
	return string(plain), err
}

func (h *handler) deleteEnvironment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "local" {
		writeError(w, http.StatusBadRequest, "validation_error", "the local environment cannot be removed")
		return
	}
	env, err := h.store.GetEnvironment(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "environment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}
	if err := h.store.DeleteEnvironment(r.Context(), id); err != nil {
		h.internalError(w, err)
		return
	}
	if h.envs != nil {
		h.envs.Forget(env.SSHHost)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) deploymentLogs(w http.ResponseWriter, r *http.Request) {
	if !h.validLogToken(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "valid token required")
		return
	}

	containers, err := h.docker.ListByDeployment(r.Context(), r.PathValue("id"))
	if err != nil {
		h.internalError(w, err)
		return
	}
	if len(containers) == 0 {
		writeError(w, http.StatusNotFound, "no_containers", "deployment has no running containers")
		return
	}
	h.streamContainerLogs(w, r, h.docker, containers[0].ID)
}

func (h *handler) hostContainerLogs(w http.ResponseWriter, r *http.Request) {
	if !h.validLogToken(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "valid token required")
		return
	}
	ops, ok := h.resolveEnv(w, r)
	if !ok {
		return
	}
	h.streamContainerLogs(w, r, ops, r.PathValue("id"))
}

func (h *handler) validLogToken(r *http.Request) bool {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	return h.validToken(token)
}

func (h *handler) streamContainerLogs(w http.ResponseWriter, r *http.Request, ops docker.ContainerOps, id string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.internalError(w, errors.New("streaming unsupported"))
		return
	}

	logs, err := ops.Logs(r.Context(), id, true)
	if err != nil {
		h.internalError(w, err)
		return
	}
	defer logs.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	var reader io.Reader = logs
	if logs.Multiplexed {
		pr, pw := io.Pipe()
		go func() {
			_, _ = stdcopy.StdCopy(pw, pw, logs)
			pw.Close()
		}()
		reader = pr
	}
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fmt.Fprintf(w, "data: %s\n\n", scanner.Text())
		flusher.Flush()
	}
}

func (h *handler) webhook(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, err := h.store.GetDeployment(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "deployment not found")
		return
	}
	if err != nil {
		h.internalError(w, err)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "could not read request body")
		return
	}
	if !validSignature(d.WebhookSecret, r.Header.Get("X-Hub-Signature-256"), body) {
		writeError(w, http.StatusUnauthorized, "invalid_signature", "signature verification failed")
		return
	}
	h.reap(r.Context(), id)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "redeploying"})
}

func (h *handler) reap(ctx context.Context, deploymentID string) {
	containers, err := h.docker.ListByDeployment(ctx, deploymentID)
	if err != nil {
		h.logger.Error("reap: list containers", "deployment", deploymentID, "error", err)
		return
	}
	for _, c := range containers {
		if err := h.docker.StopAndRemove(ctx, c.ID); err != nil {
			h.logger.Error("reap: remove container", "container", c.ID, "error", err)
		}
	}
}

// validSignature verifies a GitHub-style sha256=<hex> HMAC over the body.
func validSignature(secret, header string, body []byte) bool {
	const prefix = "sha256="
	if secret == "" || !strings.HasPrefix(header, prefix) {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := mac.Sum(nil)
	got, err := hex.DecodeString(strings.TrimPrefix(header, prefix))
	if err != nil {
		return false
	}
	return hmac.Equal(expected, got)
}

func decodeDeployment(w http.ResponseWriter, r *http.Request) (deploymentInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var in deploymentInput
	if err := decoder.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
		return deploymentInput{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return deploymentInput{}, false
	}
	return in, true
}

func (in deploymentInput) toDeployment(id string) (store.Deployment, string) {
	d := store.Deployment{
		ID:       id,
		Name:     strings.TrimSpace(in.Name),
		Slug:     strings.TrimSpace(in.Slug),
		Image:    strings.TrimSpace(in.Image),
		Replicas: in.Replicas,
	}
	if d.Name == "" || len(d.Name) > 120 {
		return store.Deployment{}, "name is required and must have at most 120 characters"
	}
	if len(d.Slug) > 63 || !slugPattern.MatchString(d.Slug) {
		return store.Deployment{}, "slug must contain lowercase letters, numbers and single hyphens"
	}
	if d.Image == "" || len(d.Image) > 300 {
		return store.Deployment{}, "image is required and must have at most 300 characters"
	}
	if d.Replicas < 0 || d.Replicas > 50 {
		return store.Deployment{}, "replicas must be between 0 and 50"
	}
	for _, p := range in.Ports {
		if p.Container < 1 || p.Container > 65535 || p.Host < 1 || p.Host > 65535 {
			return store.Deployment{}, "ports must be between 1 and 65535"
		}
	}
	env, err := json.Marshal(orEmptyMap(in.Env))
	if err != nil {
		return store.Deployment{}, "env must be a valid string map"
	}
	ports, err := json.Marshal(orEmptyPorts(in.Ports))
	if err != nil {
		return store.Deployment{}, "ports must be valid"
	}
	d.Env = string(env)
	d.Ports = string(ports)
	return d, ""
}

func orEmptyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func orEmptyPorts(p []docker.Port) []docker.Port {
	if p == nil {
		return []docker.Port{}
	}
	return p
}

func (h *handler) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !h.validToken(token) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// validToken compares a presented token against the admin token in constant time.
func (h *handler) validToken(token string) bool {
	if token == "" {
		return false
	}
	provided := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(provided[:], h.adminHash[:]) == 1
}

func (h *handler) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.logger.Info("http request", "method", r.Method, "path", r.URL.Path, "remote", r.RemoteAddr)
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *statusWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (m *requestMetrics) record(now time.Time, status int, latency time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()

	class := statusClass(status)
	m.total++
	second := now.Unix()
	bucket := &m.buckets[second%int64(len(m.buckets))]
	if bucket.second != second {
		*bucket = metricBucket{second: second}
	}
	bucket.requests++
	bucket.latency += latency
	bucket.status[class]++
}

func (m *requestMetrics) snapshot(now time.Time) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()

	var requests uint64
	var latency time.Duration
	var statuses [3]uint64
	cutoff := now.Unix() - 59
	for _, bucket := range m.buckets {
		if bucket.second < cutoff {
			continue
		}
		requests += bucket.requests
		latency += bucket.latency
		for i := range statuses {
			statuses[i] += bucket.status[i]
		}
	}
	averageLatency := float64(0)
	if requests > 0 {
		averageLatency = float64(latency.Microseconds()) / 1000 / float64(requests)
	}
	return map[string]any{
		"container_requests_total":       m.total,
		"container_requests_last_minute": requests,
		"container_average_latency_ms":   averageLatency,
		"last_minute": map[string]uint64{
			"success": statuses[0], "client_error": statuses[1], "server_error": statuses[2],
		},
	}
}

func statusClass(status int) int {
	if status >= 500 {
		return 2
	}
	if status >= 400 {
		return 1
	}
	return 0
}

func (h *handler) internalError(w http.ResponseWriter, err error) {
	h.logger.Error("request failed", "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
}

func decodeInput(w http.ResponseWriter, r *http.Request) (apiInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input apiInput
	if err := decoder.Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
		return apiInput{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return apiInput{}, false
	}
	return input, true
}

func (in apiInput) toAPI(id string) store.API {
	return store.API{
		ID:          id,
		Name:        strings.TrimSpace(in.Name),
		Slug:        strings.TrimSpace(in.Slug),
		Description: strings.TrimSpace(in.Description),
		Spec:        string(in.Spec),
	}
}

func validate(api store.API) string {
	if api.Name == "" || len(api.Name) > 120 {
		return "name is required and must have at most 120 characters"
	}
	if len(api.Slug) > 63 || !slugPattern.MatchString(api.Slug) {
		return "slug must contain lowercase letters, numbers and single hyphens"
	}
	if len(api.Description) > 2000 {
		return "description must have at most 2000 characters"
	}
	if api.Spec != "" && !json.Valid([]byte(api.Spec)) {
		return "spec must be a valid JSON document"
	}
	return ""
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
