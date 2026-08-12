package httpapi

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/store"
	"github.com/docker/docker/pkg/stdcopy"
)

type containerOps interface {
	ListByDeployment(ctx context.Context, deploymentID string) ([]docker.Container, error)
	StopAndRemove(ctx context.Context, id string) error
	Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error)
	ListAllContainers(ctx context.Context) ([]docker.HostContainer, error)
	ListImages(ctx context.Context) ([]docker.Image, error)
}

const maxBodySize = 1 << 20

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type handler struct {
	store     *store.Store
	docker    containerOps
	adminHash [32]byte
	logger    *slog.Logger
}

type apiInput struct {
	Name        string          `json:"name"`
	Slug        string          `json:"slug"`
	Description string          `json:"description"`
	Spec        json.RawMessage `json:"spec"`
}

func New(db *store.Store, dockerOps containerOps, adminToken string, logger *slog.Logger) http.Handler {
	h := &handler{store: db, docker: dockerOps, adminHash: sha256.Sum256([]byte(adminToken)), logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
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
	containers, err := h.docker.ListAllContainers(r.Context())
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": containers})
}

func (h *handler) hostImages(w http.ResponseWriter, r *http.Request) {
	images, err := h.docker.ListImages(r.Context())
	if err != nil {
		h.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": images})
}

func (h *handler) deploymentLogs(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if !h.validToken(token) {
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
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.internalError(w, errors.New("streaming unsupported"))
		return
	}

	logs, err := h.docker.Logs(r.Context(), containers[0].ID, true)
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

	// Container logs are multiplexed (no TTY); demux stdout+stderr into a pipe
	// and forward line by line as SSE events.
	pr, pw := io.Pipe()
	go func() {
		_, _ = stdcopy.StdCopy(pw, pw, logs)
		pw.Close()
	}()
	scanner := bufio.NewScanner(pr)
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
