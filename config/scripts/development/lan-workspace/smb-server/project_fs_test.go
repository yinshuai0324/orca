package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectShareKeepsPrivateFilesAndLinksLocal(t *testing.T) {
	directory := t.TempDir()
	root, err := os.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	project := &projectFS{root: root, save: func() {}}
	defer project.Close()

	for _, name := range []string{".env.local", "source.ts"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("original"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(directory, "node_modules"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".env.local", filepath.Join(directory, "sym")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(directory, ".env.local"), filepath.Join(directory, "hard")); err != nil {
		t.Fatal(err)
	}
	entries, err := project.ListDir("/")
	if err != nil || len(entries) != 1 || entries[0].Name() != "source.ts" {
		t.Fatalf("listing should contain just source.ts, got %v, %v", entries, err)
	}
	for _, name := range []string{"/.ENV.LoCal", "/sym", "/hard", "/sub/../.env.local", "/node_modules/dependency"} {
		if _, err := project.ReadFile(name); err == nil {
			t.Fatalf("read should reject %s", name)
		}
		if err := project.WriteFile(name, []byte("changed"), 0o600); err == nil {
			t.Fatalf("write should reject %s", name)
		}
	}
	if err := project.Rename("/source.ts", "/.env.local"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("rename should reject the private destination: %v", err)
	}
	private, err := os.ReadFile(filepath.Join(directory, ".env.local"))
	if err != nil || string(private) != "original" {
		t.Fatalf("the local environment file changed: %q, %v", private, err)
	}
}
