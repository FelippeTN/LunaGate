package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

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
