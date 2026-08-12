package httpapi

import (
	"crypto/sha256"
	"strings"
	"testing"
)

func TestCredentialEncryption(t *testing.T) {
	h := &handler{adminHash: sha256.Sum256([]byte("admin-token"))}
	encoded, err := h.sealCredential("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if encoded == "" || strings.Contains(encoded, "correct horse") {
		t.Fatalf("password was not encrypted: %q", encoded)
	}
	plain, err := h.openCredential(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "correct horse battery staple" {
		t.Fatalf("decrypted password = %q", plain)
	}

	other := &handler{adminHash: sha256.Sum256([]byte("different-token"))}
	if _, err := other.openCredential(encoded); err == nil {
		t.Fatal("credential decrypted with a different admin token")
	}
}
