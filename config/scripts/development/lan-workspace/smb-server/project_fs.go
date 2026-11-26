package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
	"sync/atomic"

	filesystem "github.com/go-filesystems/interface"
	"golang.org/x/sys/unix"
)

type projectFS struct {
	root *os.File
	save func()
}

type projectFile struct {
	*os.File
	size  int64
	save  func()
	dirty atomic.Bool
}

func (f *projectFile) Size() int64 { return f.size }

func (f *projectFile) WriteAt(data []byte, offset int64) (int, error) {
	n, err := f.File.WriteAt(data, offset)
	if n > 0 {
		f.dirty.Store(true)
	}
	return n, err
}

func (f *projectFile) Close() error {
	err := f.File.Close()
	if err == nil && f.dirty.Load() {
		f.save()
	}
	return err
}

func privateName(name string) bool {
	name = strings.ToLower(name)
	return name == ".git" || name == "node_modules" || name == ".env" || strings.HasPrefix(name, ".env.")
}

func visibleEntry(stat unix.Stat_t) bool {
	kind := stat.Mode & unix.S_IFMT
	return kind == unix.S_IFDIR || (kind == unix.S_IFREG && stat.Nlink == 1)
}

func (project *projectFS) Close() error { return project.root.Close() }

// Walk each directory relative to its open parent so a symlink swap cannot redirect SMB I/O.
func (project *projectFS) parent(path string) (int, string, error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 1 && parts[0] == "" {
		parts[0] = "."
	} else {
		for _, part := range parts {
			if part == "" || part == "." || part == ".." || privateName(part) {
				return -1, "", fs.ErrPermission
			}
		}
	}
	dir, err := unix.Openat(int(project.root.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, "", err
	}
	for _, part := range parts[:len(parts)-1] {
		child, err := unix.Openat(dir, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(dir)
		if err != nil {
			return -1, "", err
		}
		dir = child
	}
	return dir, parts[len(parts)-1], nil
}

func statEntry(dir int, name string) (unix.Stat_t, error) {
	var result unix.Stat_t
	err := unix.Fstatat(dir, name, &result, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil && !visibleEntry(result) {
		err = fs.ErrPermission
	}
	return result, err
}

func (project *projectFS) open(path string, flags int, perm os.FileMode) (*projectFile, error) {
	dir, name, err := project.parent(path)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	fd, err := unix.Openat(dir, name, flags|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, uint32(perm.Perm()))
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	err = unix.Fstat(fd, &stat)
	if err == nil && (stat.Mode&unix.S_IFMT != unix.S_IFREG || !visibleEntry(stat)) {
		err = fs.ErrPermission
	}
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &projectFile{File: os.NewFile(uintptr(fd), name), size: stat.Size, save: project.save}, nil
}

func (project *projectFS) OpenFile(path string) (filesystem.File, error) {
	return project.open(path, unix.O_RDWR, 0)
}

func (project *projectFS) ReadFile(path string) ([]byte, error) {
	file, err := project.open(path, unix.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	const limit = 16 << 20
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if len(data) > limit {
		return nil, unix.EFBIG
	}
	return data, err
}

func (project *projectFS) WriteFile(path string, data []byte, perm os.FileMode) error {
	file, err := project.open(path, unix.O_WRONLY|unix.O_CREAT, perm)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Truncate(0); err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	_, err = file.WriteAt(data, 0)
	return err
}

func (project *projectFS) Truncate(path string, size int64) error {
	file, err := project.open(path, unix.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Truncate(size)
}

func (project *projectFS) Stat(path string) (filesystem.Stat, error) {
	dir, name, err := project.parent(path)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	stat, err := statEntry(dir, name)
	if err != nil {
		return nil, err
	}
	return filesystem.NewStat(stat.Mode, uint64(stat.Size), stat.Ino), nil
}

func (project *projectFS) ListDir(path string) ([]filesystem.DirEntry, error) {
	dir, name, err := project.parent(path)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	fd, err := unix.Openat(dir, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	names, err := file.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	entries := make([]filesystem.DirEntry, 0, len(names))
	for _, child := range names {
		if !privateName(child) {
			if stat, err := statEntry(fd, child); err == nil {
				entries = append(entries, filesystem.NewDirEntry(stat.Ino, child, uint8(stat.Mode>>12)))
			}
		}
	}
	return entries, nil
}

func (project *projectFS) ReadLink(_ string) (string, error) { return "", fs.ErrPermission }

func (project *projectFS) MkDir(path string, mode os.FileMode) error {
	dir, name, err := project.parent(path)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	return unix.Mkdirat(dir, name, uint32(mode.Perm()))
}

func (project *projectFS) DeleteFile(path string) error { return project.remove(path, 0) }
func (project *projectFS) DeleteDir(path string) error {
	return project.remove(path, unix.AT_REMOVEDIR)
}

func (project *projectFS) remove(path string, flags int) error {
	dir, name, err := project.parent(path)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	if name == "." {
		return fs.ErrPermission
	}
	if _, err := statEntry(dir, name); err != nil {
		return err
	}
	return unix.Unlinkat(dir, name, flags)
}

func (project *projectFS) Rename(from, to string) error {
	oldDir, oldName, err := project.parent(from)
	if err != nil {
		return err
	}
	defer unix.Close(oldDir)
	newDir, newName, err := project.parent(to)
	if err != nil {
		return err
	}
	defer unix.Close(newDir)
	if oldName == "." || newName == "." {
		return fs.ErrPermission
	}
	if _, err := statEntry(oldDir, oldName); err != nil {
		return err
	}
	if _, err := statEntry(newDir, newName); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := unix.Renameat(oldDir, oldName, newDir, newName); err != nil {
		return err
	}
	project.save()
	return nil
}
