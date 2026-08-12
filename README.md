# LunaGate

LunaGate is a small, single-node container control plane written in Go — a
minimal OpenShift-style panel. It is the *brain*: you declare **deployments**
(image, replicas, env, ports) and a reconciliation loop keeps the real
containers matching the desired state (auto-restart, auto-heal). The **Docker
Engine API** is the *executor* — LunaGate never reimplements a runtime. It also
ships an authenticated admin API, a persistent catalog backed by SQLite, and a
React/Tailwind web UI.

Requirements: Go 1.25+, and a running Docker daemon (Docker Desktop on Windows)
for the deployment features.

## Run

Requirements: Go 1.25 or newer.

```powershell
$env:LUNAGATE_ADMIN_TOKEN = "replace-with-a-random-token-of-32+-characters"
go run ./cmd/lunagate -addr :8080 -db lunagate.db
```

Health checks are public:

```powershell
Invoke-RestMethod http://localhost:8080/healthz
Invoke-RestMethod http://localhost:8080/readyz
```

Create and list APIs:

```powershell
$headers = @{ Authorization = "Bearer $env:LUNAGATE_ADMIN_TOKEN" }
$body = @{
  name = "Orders"
  slug = "orders"
  description = "Orders API"
  spec = @{ openapi = "3.1.0"; info = @{ title = "Orders"; version = "1" }; paths = @{} }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri http://localhost:8080/v1/apis -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod http://localhost:8080/v1/apis -Headers $headers
```

## Deployments

Declare a deployment; the reconciler pulls the image and keeps `replicas`
containers running. LunaGate only touches containers it labels
(`lunagate.deployment=<id>`), never anything else on the host.

```powershell
$headers = @{ Authorization = "Bearer $env:LUNAGATE_ADMIN_TOKEN" }
$body = @{
  name = "Web"; slug = "web"; image = "nginx:latest"; replicas = 2
  env = @{ LOG_LEVEL = "info" }
  ports = @(@{ host = 8080; container = 80 })
} | ConvertTo-Json -Depth 5

$d = Invoke-RestMethod -Method Post -Uri http://localhost:8080/v1/deployments -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod http://localhost:8080/v1/deployments/$($d.id)/containers -Headers $headers   # live status
Invoke-RestMethod -Method Post http://localhost:8080/v1/deployments/$($d.id)/redeploy -Headers $headers
```

Endpoints (all under `/v1`, bearer-authenticated unless noted):

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET/POST` | `/deployments` | list / create |
| `GET/PUT/DELETE` | `/deployments/{id}` | read / update / delete (delete reaps containers) |
| `POST` | `/deployments/{id}/redeploy` | remove containers; reconciler recreates with a fresh pull |
| `GET` | `/deployments/{id}/containers` | live container status |
| `GET` | `/deployments/{id}/logs` | SSE log stream (token via header **or** `?token=`) |
| `POST` | `/webhooks/{id}` | **public**; GitHub `X-Hub-Signature-256` HMAC triggers a redeploy |
| `GET` | `/metrics` | request volume, latency, status classes, and process uptime |
| `ANY` | `/gateway/{deployment-slug}/*` | public proxy to a running deployment |

Each deployment gets a `webhook_secret` on creation. Configure a GitHub push
webhook (JSON content type) pointing at `/v1/webhooks/{id}` with that secret to
redeploy automatically on CI image pushes.

Request metrics cover only application traffic sent through the gateway while
the deployment has a running container. The gateway forwards to the first
published host port and preserves the path after the deployment slug. Requests
to stopped deployments are rejected and not counted. Counters live in memory
and restart with the LunaGate process; traffic sent directly to a container's
host port bypasses the gateway and cannot be observed.

## Web UI

The frontend (React + Tailwind v4 + TypeScript, shadcn-style components) lives in
`web/` and is embedded into the Go binary from `web/dist`.

```powershell
cd web
npm install
npm run build          # outputs web/dist, which `go build` embeds
```

Then the UI is served at `http://localhost:8080/`. For frontend development with
hot reload, run the Go server and Vite side by side (Vite proxies `/v1` to
`:8080`):

```powershell
npm run dev            # in web/, serves http://localhost:5173
```

Remote environments can authenticate with the server's SSH key/agent or with
an SSH password entered in the UI. For password authentication, use a target
such as `user@host`; the password is encrypted with the admin token before it
is stored. The host must already exist in the LunaGate server user's
`~/.ssh/known_hosts`, and the remote user must be allowed to run Docker.

## Development

```powershell
go test ./...
go vet ./...
```

Next slices (roadmap): rollback, zero-downtime rolling deploys, resource limits +
metrics, a traffic gateway exposing deployments on subdomains, private registry
auth, and multi-user RBAC.
