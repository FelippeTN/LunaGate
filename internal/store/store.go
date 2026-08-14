package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type API struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Spec        string `json:"spec,omitempty"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

// Deployment is the desired state of a set of containers the reconciler keeps
// running. Env and Ports are stored as JSON blobs (map and array respectively).
type Deployment struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	Image         string `json:"image"`
	Replicas      int    `json:"replicas"`
	Env           string `json:"env"`   // JSON object: {"KEY":"value"}
	Ports         string `json:"ports"` // JSON array: [{"container":80,"host":8080}]
	WebhookSecret string `json:"webhook_secret,omitempty"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

// Environment is a remote Docker host reachable over SSH. Passwords are
// optional and stored only as authenticated ciphertext.
type Environment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	SSHHost     string `json:"ssh_host"` // e.g. "deploy@10.0.0.5" or "user@host:2222"
	SSHPassword string `json:"-"`        // AES-GCM ciphertext; never returned by the API
	CreatedAt   int64  `json:"created_at"`
}

type ContainerTracking struct {
	EnvironmentID string `json:"environment_id"`
	ContainerID   string `json:"container_id"`
	ContainerName string `json:"container_name"`
	StartedAt     int64  `json:"started_at"`
	EndsAt        int64  `json:"ends_at"`
	Active        bool   `json:"active"`
}

type ContainerMetrics struct {
	Tracking         *ContainerTracking `json:"tracking"`
	RequestsTotal    uint64             `json:"requests_total"`
	RequestsLastHour uint64             `json:"requests_last_hour"`
	AverageLatencyMS float64            `json:"average_latency_ms"`
	RequestsPerHour  []uint64           `json:"requests_per_hour"`
	Status           [3]uint64          `json:"-"`
}

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// ponytail: one connection is enough for a single-node control plane;
	// raise this only after measuring database contention.
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(0)

	if _, err = db.Exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS apis (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			description TEXT NOT NULL DEFAULT '',
			spec TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS deployments (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			image TEXT NOT NULL,
			replicas INTEGER NOT NULL DEFAULT 1,
			env TEXT NOT NULL DEFAULT '{}',
			ports TEXT NOT NULL DEFAULT '[]',
			webhook_secret TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS environments (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			ssh_host TEXT NOT NULL,
			ssh_password TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS container_tracking (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			environment_id TEXT NOT NULL,
			container_id TEXT NOT NULL,
			container_name TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			ends_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS container_request_hours (
			tracking_started_at INTEGER NOT NULL,
			bucket INTEGER NOT NULL,
			requests INTEGER NOT NULL DEFAULT 0,
			latency_us INTEGER NOT NULL DEFAULT 0,
			success INTEGER NOT NULL DEFAULT 0,
			client_error INTEGER NOT NULL DEFAULT 0,
			server_error INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (tracking_started_at, bucket)
		);`); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize schema: %w", err)
	}
	// Existing databases predate password authentication.
	if _, err = db.Exec(`ALTER TABLE environments ADD COLUMN ssh_password TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, fmt.Errorf("migrate environments: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) CreateAPI(ctx context.Context, api API) (API, error) {
	api.ID = newID()
	api.CreatedAt = time.Now().UTC().Unix()
	api.UpdatedAt = api.CreatedAt
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO apis (id, name, slug, description, spec, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		api.ID, api.Name, api.Slug, api.Description, api.Spec, api.CreatedAt, api.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return API{}, ErrConflict
		}
		return API{}, err
	}
	return api, nil
}

func (s *Store) ListAPIs(ctx context.Context) ([]API, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, slug, description, spec, created_at, updated_at
		FROM apis ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	apis := make([]API, 0)
	for rows.Next() {
		var api API
		if err := scanAPI(rows, &api); err != nil {
			return nil, err
		}
		apis = append(apis, api)
	}
	return apis, rows.Err()
}

func (s *Store) GetAPI(ctx context.Context, id string) (API, error) {
	var api API
	err := scanAPI(s.db.QueryRowContext(ctx, `
		SELECT id, name, slug, description, spec, created_at, updated_at
		FROM apis WHERE id = ?`, id), &api)
	if errors.Is(err, sql.ErrNoRows) {
		return API{}, ErrNotFound
	}
	return api, err
}

func (s *Store) UpdateAPI(ctx context.Context, api API) (API, error) {
	api.UpdatedAt = time.Now().UTC().Unix()
	result, err := s.db.ExecContext(ctx, `
		UPDATE apis SET name = ?, slug = ?, description = ?, spec = ?, updated_at = ?
		WHERE id = ?`, api.Name, api.Slug, api.Description, api.Spec, api.UpdatedAt, api.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return API{}, ErrConflict
		}
		return API{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return API{}, err
	}
	if count == 0 {
		return API{}, ErrNotFound
	}
	return s.GetAPI(ctx, api.ID)
}

func (s *Store) DeleteAPI(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM apis WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreateDeployment(ctx context.Context, d Deployment) (Deployment, error) {
	d.ID = newID()
	d.WebhookSecret = newID() + newID() // 32 bytes hex
	d.CreatedAt = time.Now().UTC().Unix()
	d.UpdatedAt = d.CreatedAt
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO deployments (id, name, slug, image, replicas, env, ports, webhook_secret, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.Name, d.Slug, d.Image, d.Replicas, d.Env, d.Ports, d.WebhookSecret, d.CreatedAt, d.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return Deployment{}, ErrConflict
		}
		return Deployment{}, err
	}
	return d, nil
}

func (s *Store) ListDeployments(ctx context.Context) ([]Deployment, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, slug, image, replicas, env, ports, webhook_secret, created_at, updated_at
		FROM deployments ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	deployments := make([]Deployment, 0)
	for rows.Next() {
		var d Deployment
		if err := scanDeployment(rows, &d); err != nil {
			return nil, err
		}
		deployments = append(deployments, d)
	}
	return deployments, rows.Err()
}

func (s *Store) GetDeployment(ctx context.Context, id string) (Deployment, error) {
	var d Deployment
	err := scanDeployment(s.db.QueryRowContext(ctx, `
		SELECT id, name, slug, image, replicas, env, ports, webhook_secret, created_at, updated_at
		FROM deployments WHERE id = ?`, id), &d)
	if errors.Is(err, sql.ErrNoRows) {
		return Deployment{}, ErrNotFound
	}
	return d, err
}

func (s *Store) GetDeploymentBySlug(ctx context.Context, slug string) (Deployment, error) {
	var d Deployment
	err := scanDeployment(s.db.QueryRowContext(ctx, `
		SELECT id, name, slug, image, replicas, env, ports, webhook_secret, created_at, updated_at
		FROM deployments WHERE slug = ?`, slug), &d)
	if errors.Is(err, sql.ErrNoRows) {
		return Deployment{}, ErrNotFound
	}
	return d, err
}

// UpdateDeployment updates the mutable desired-state fields. It preserves the
// existing webhook secret and created_at.
func (s *Store) UpdateDeployment(ctx context.Context, d Deployment) (Deployment, error) {
	d.UpdatedAt = time.Now().UTC().Unix()
	result, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET name = ?, slug = ?, image = ?, replicas = ?, env = ?, ports = ?, updated_at = ?
		WHERE id = ?`, d.Name, d.Slug, d.Image, d.Replicas, d.Env, d.Ports, d.UpdatedAt, d.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return Deployment{}, ErrConflict
		}
		return Deployment{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return Deployment{}, err
	}
	if count == 0 {
		return Deployment{}, ErrNotFound
	}
	return s.GetDeployment(ctx, d.ID)
}

func (s *Store) DeleteDeployment(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM deployments WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreateEnvironment(ctx context.Context, e Environment) (Environment, error) {
	e.ID = newID()
	e.CreatedAt = time.Now().UTC().Unix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO environments (id, name, ssh_host, ssh_password, created_at) VALUES (?, ?, ?, ?, ?)`,
		e.ID, e.Name, e.SSHHost, e.SSHPassword, e.CreatedAt)
	if err != nil {
		return Environment{}, err
	}
	return e, nil
}

func (s *Store) ListEnvironments(ctx context.Context) ([]Environment, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, ssh_host, ssh_password, created_at FROM environments ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	envs := make([]Environment, 0)
	for rows.Next() {
		var e Environment
		if err := rows.Scan(&e.ID, &e.Name, &e.SSHHost, &e.SSHPassword, &e.CreatedAt); err != nil {
			return nil, err
		}
		envs = append(envs, e)
	}
	return envs, rows.Err()
}

func (s *Store) GetEnvironment(ctx context.Context, id string) (Environment, error) {
	var e Environment
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, ssh_host, ssh_password, created_at FROM environments WHERE id = ?`, id).
		Scan(&e.ID, &e.Name, &e.SSHHost, &e.SSHPassword, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Environment{}, ErrNotFound
	}
	return e, err
}

func (s *Store) DeleteEnvironment(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM environments WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) StartContainerTracking(ctx context.Context, environmentID, containerID, containerName string, now time.Time) (ContainerMetrics, error) {
	startedAt := now.UTC().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ContainerMetrics{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM container_request_hours`); err != nil {
		return ContainerMetrics{}, err
	}
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO container_tracking (singleton, environment_id, container_id, container_name, started_at, ends_at)
		VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(singleton) DO UPDATE SET environment_id=excluded.environment_id,
		container_id=excluded.container_id, container_name=excluded.container_name,
		started_at=excluded.started_at, ends_at=excluded.ends_at`,
		environmentID, containerID, containerName, startedAt, startedAt+7*24*60*60); err != nil {
		return ContainerMetrics{}, err
	}
	if err = tx.Commit(); err != nil {
		return ContainerMetrics{}, err
	}
	return s.ContainerMetrics(ctx, now)
}

func (s *Store) RecordContainerRequest(ctx context.Context, environmentID, containerID string, now time.Time, statusClass int, latency time.Duration) error {
	status := [3]int{}
	status[statusClass] = 1
	unix := now.UTC().Unix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO container_request_hours
			(tracking_started_at, bucket, requests, latency_us, success, client_error, server_error)
		SELECT started_at, CAST((? - started_at) / 3600 AS INTEGER), 1, ?, ?, ?, ?
		FROM container_tracking
		WHERE singleton = 1 AND environment_id = ? AND container_id = ? AND ? >= started_at AND ? < ends_at
		ON CONFLICT(tracking_started_at, bucket) DO UPDATE SET
			requests=requests+1, latency_us=latency_us+excluded.latency_us,
			success=success+excluded.success, client_error=client_error+excluded.client_error,
			server_error=server_error+excluded.server_error`,
		unix, latency.Microseconds(), status[0], status[1], status[2], environmentID, containerID, unix, unix)
	return err
}

func (s *Store) ContainerMetrics(ctx context.Context, now time.Time) (ContainerMetrics, error) {
	metrics := ContainerMetrics{RequestsPerHour: make([]uint64, 7*24)}
	var tracking ContainerTracking
	err := s.db.QueryRowContext(ctx, `
		SELECT environment_id, container_id, container_name, started_at, ends_at
		FROM container_tracking WHERE singleton = 1`).Scan(
		&tracking.EnvironmentID, &tracking.ContainerID, &tracking.ContainerName, &tracking.StartedAt, &tracking.EndsAt)
	if errors.Is(err, sql.ErrNoRows) {
		return metrics, nil
	}
	if err != nil {
		return ContainerMetrics{}, err
	}
	tracking.Active = now.UTC().Unix() >= tracking.StartedAt && now.UTC().Unix() < tracking.EndsAt
	metrics.Tracking = &tracking

	rows, err := s.db.QueryContext(ctx, `
		SELECT bucket, requests, latency_us, success, client_error, server_error
		FROM container_request_hours WHERE tracking_started_at = ? ORDER BY bucket`, tracking.StartedAt)
	if err != nil {
		return ContainerMetrics{}, err
	}
	defer rows.Close()
	var latencyUS uint64
	currentBucket := (now.UTC().Unix() - tracking.StartedAt) / 3600
	for rows.Next() {
		var bucket int
		var requests, bucketLatency uint64
		var status [3]uint64
		if err := rows.Scan(&bucket, &requests, &bucketLatency, &status[0], &status[1], &status[2]); err != nil {
			return ContainerMetrics{}, err
		}
		if bucket >= 0 && bucket < len(metrics.RequestsPerHour) {
			metrics.RequestsPerHour[bucket] = requests
		}
		metrics.RequestsTotal += requests
		latencyUS += bucketLatency
		for i := range status {
			metrics.Status[i] += status[i]
		}
		if int64(bucket) == currentBucket {
			metrics.RequestsLastHour = requests
		}
	}
	if err := rows.Err(); err != nil {
		return ContainerMetrics{}, err
	}
	if metrics.RequestsTotal > 0 {
		metrics.AverageLatencyMS = float64(latencyUS) / 1000 / float64(metrics.RequestsTotal)
	}
	return metrics, nil
}

func scanDeployment(row scanner, d *Deployment) error {
	return row.Scan(&d.ID, &d.Name, &d.Slug, &d.Image, &d.Replicas, &d.Env, &d.Ports, &d.WebhookSecret, &d.CreatedAt, &d.UpdatedAt)
}

type scanner interface{ Scan(...any) error }

func scanAPI(row scanner, api *API) error {
	return row.Scan(&api.ID, &api.Name, &api.Slug, &api.Description, &api.Spec, &api.CreatedAt, &api.UpdatedAt)
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
