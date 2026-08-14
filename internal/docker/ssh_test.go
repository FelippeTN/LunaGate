package docker

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestPasswordSSHConnectsToDockerDialStdio(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	knownHosts := t.TempDir() + "/known_hosts"
	line := knownhosts.Line([]string{knownhosts.Normalize(listener.Addr().String())}, hostSigner.PublicKey())
	if err := os.WriteFile(knownHosts, []byte(line+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	oldKnownHostsFile := knownHostsFile
	knownHostsFile = func() (string, error) { return knownHosts, nil }
	t.Cleanup(func() { knownHostsFile = oldKnownHostsFile })

	serverConfig := &ssh.ServerConfig{PasswordCallback: func(metadata ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if metadata.User() == "deploy" && string(password) == "secret" {
			return nil, nil
		}
		return nil, fmt.Errorf("password rejected")
	}}
	serverConfig.AddHostKey(hostSigner)
	serverDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		_, channels, requests, err := ssh.NewServerConn(connection, serverConfig)
		if err != nil {
			serverDone <- err
			return
		}
		go ssh.DiscardRequests(requests)
		newChannel := <-channels
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		request := <-channelRequests
		var command struct{ Value string }
		ssh.Unmarshal(request.Payload, &command)
		if request.Type != "exec" || command.Value != "docker system dial-stdio" {
			serverDone <- fmt.Errorf("unexpected command %q", command.Value)
			return
		}
		request.Reply(true, nil)
		reader := bufio.NewReader(channel)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				serverDone <- err
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, err = channel.Write([]byte("HTTP/1.1 200 OK\r\nApi-Version: 1.47\r\nContent-Length: 0\r\n\r\n"))
		channel.Close()
		serverDone <- err
	}()

	host := "deploy@" + listener.Addr().String()
	client, err := NewSSH(host, "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if _, err := NewSSH(strings.TrimPrefix(host, "deploy@"), "secret"); err == nil {
		t.Fatal("password authentication accepted a target without a user")
	}
}

func TestDialSSHForwardsTCPWithPassword(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	sshListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sshListener.Close()
	echoListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoListener.Close()
	go func() {
		connection, err := echoListener.Accept()
		if err == nil {
			defer connection.Close()
			_, _ = io.Copy(connection, connection)
		}
	}()

	knownHosts := t.TempDir() + "/known_hosts"
	line := knownhosts.Line([]string{knownhosts.Normalize(sshListener.Addr().String())}, hostSigner.PublicKey())
	if err := os.WriteFile(knownHosts, []byte(line+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	oldKnownHostsFile := knownHostsFile
	knownHostsFile = func() (string, error) { return knownHosts, nil }
	t.Cleanup(func() { knownHostsFile = oldKnownHostsFile })

	serverConfig := &ssh.ServerConfig{PasswordCallback: func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if string(password) == "secret" {
			return nil, nil
		}
		return nil, fmt.Errorf("password rejected")
	}}
	serverConfig.AddHostKey(hostSigner)
	serverDone := make(chan error, 1)
	go func() {
		tcp, err := sshListener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		_, channels, requests, err := ssh.NewServerConn(tcp, serverConfig)
		if err != nil {
			serverDone <- err
			return
		}
		go ssh.DiscardRequests(requests)
		newChannel := <-channels
		if newChannel.ChannelType() != "direct-tcpip" {
			serverDone <- fmt.Errorf("unexpected channel %q", newChannel.ChannelType())
			return
		}
		var target struct {
			Host       string
			Port       uint32
			OriginHost string
			OriginPort uint32
		}
		if err := ssh.Unmarshal(newChannel.ExtraData(), &target); err != nil {
			serverDone <- err
			return
		}
		upstream, err := net.Dial("tcp", net.JoinHostPort(target.Host, fmt.Sprint(target.Port)))
		if err != nil {
			serverDone <- err
			return
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			upstream.Close()
			serverDone <- err
			return
		}
		go ssh.DiscardRequests(channelRequests)
		go func() { _, _ = io.Copy(channel, upstream) }()
		_, err = io.Copy(upstream, channel)
		upstream.Close()
		channel.Close()
		serverDone <- err
	}()

	connection, err := DialSSH(context.Background(), "deploy@"+sshListener.Addr().String(), "secret", echoListener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(connection, response); err != nil {
		t.Fatal(err)
	}
	if string(response) != "ping" {
		t.Fatalf("tunnel response = %q", response)
	}
	connection.Close()
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SSH forwarding server did not stop")
	}
}
