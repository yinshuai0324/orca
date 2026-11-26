package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"

	"github.com/go-filesystems/smb"
)

func main() {
	if len(os.Args) != 3 {
		log.Fatal("expected a project directory and SMB user")
	}
	if err := serve(os.Args[1], os.Args[2], os.Stdin); err != nil {
		log.Fatal(err)
	}
}

func serve(directory, username string, stdin io.Reader) error {
	input := bufio.NewReader(stdin)
	password, err := input.ReadString('\n')
	if err != nil || len(password) != 49 {
		return errors.New("missing SMB session credential")
	}
	root, err := os.Open(directory)
	if err != nil {
		return err
	}
	var firstSave sync.Once
	project := &projectFS{root: root, save: func() { firstSave.Do(func() { fmt.Println("saved") }) }}
	srv := smb.New()
	srv.RequireSigning = true
	srv.AddUser(username, strings.TrimSuffix(password, "\n"))
	if err = srv.Share("project", project); err != nil {
		root.Close()
		return err
	}
	defer srv.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	fmt.Printf("port %d\n", listener.Addr().(*net.TCPAddr).Port)
	go func() {
		// Closing Orca's pipe also stops the server if the parent process crashes.
		_, _ = io.Copy(io.Discard, input)
		_ = listener.Close()
	}()
	if err = srv.Serve(listener); errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
