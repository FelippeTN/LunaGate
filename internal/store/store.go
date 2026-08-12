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
		);`); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize schema: %w", err)
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
