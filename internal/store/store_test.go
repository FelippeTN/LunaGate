package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestOpenMigratesEnvironmentPasswords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE environments (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, ssh_host TEXT NOT NULL, created_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	created, err := db.CreateEnvironment(context.Background(), Environment{
		Name: "Remote", SSHHost: "deploy@example.com", SSHPassword: "encrypted",
	})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := db.GetEnvironment(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SSHPassword != "encrypted" {
		t.Fatalf("migrated password = %q", loaded.SSHPassword)
	}
}

func TestContainerTrackingPersistsForSevenDays(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	started := time.Unix(1_800_000_000, 0).UTC()
	if _, err := db.StartContainerTracking(ctx, "local", "chosen", "web", started); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordContainerRequest(ctx, "local", "other", started, 0, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordContainerRequest(ctx, "local", "chosen", started.Add(time.Hour), 2, 25*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	metrics, err := db.ContainerMetrics(ctx, started.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if metrics.Tracking == nil || !metrics.Tracking.Active || metrics.RequestsTotal != 1 || metrics.RequestsPerHour[1] != 1 || metrics.Status[2] != 1 {
		t.Fatalf("unexpected persisted metrics: %#v", metrics)
	}
	if err := db.RecordContainerRequest(ctx, "local", "chosen", started.Add(7*24*time.Hour), 0, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	metrics, err = db.ContainerMetrics(ctx, started.Add(7*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if metrics.Tracking.Active || metrics.RequestsTotal != 1 {
		t.Fatalf("tracking did not stop after seven days: %#v", metrics)
	}
}
