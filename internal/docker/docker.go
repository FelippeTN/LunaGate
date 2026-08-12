// Package docker is a thin wrapper over the Docker Engine API. LunaGate owns
// only the containers it labels; it never touches anything else on the host.
package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/docker/cli/cli/connhelper"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

const (
	labelManaged    = "lunagate.managed"
	labelDeployment = "lunagate.deployment"
	labelReplica    = "lunagate.replica"
	labelImage      = "lunagate.image"
)

type Client struct{ cli *client.Client }

type Port struct {
	Container int `json:"container"`
	Host      int `json:"host"`
}

type Spec struct {
	DeploymentID string
	Replica      int
	Image        string
	Env          map[string]string
	Ports        []Port
}

type Container struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Image string `json:"image"`
}

type HostContainer struct {
	ID      string   `json:"id"`
	Names   []string `json:"names"`
	Image   string   `json:"image"`
	State   string   `json:"state"`
	Status  string   `json:"status"`
	Ports   []string `json:"ports"`
	Created int64    `json:"created"`
	Managed bool     `json:"managed"`
	// Deployment lets a caller tally replicas per deployment from this one
	// listing instead of one request per deployment.
	Deployment string `json:"deployment,omitempty"`
}

type Image struct {
	ID       string   `json:"id"`
	RepoTags []string `json:"repo_tags"`
	Size     int64    `json:"size"`
	Created  int64    `json:"created"`
}

func New() (*Client, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	return &Client{cli: cli}, nil
}

// sshCandidates are the usual install locations, tried when ssh is missing
// from PATH.
//
// The Sysnative and ProgramW6432 entries matter for a 32-bit build on 64-bit
// Windows: WOW64 redirects System32 to SysWOW64 (no OpenSSH there) and points
// ProgramFiles at the x86 tree, so such a process cannot reach the real ssh.exe
// through the paths PATH advertises. Sysnative and ProgramW6432 are the
// documented escapes, and exist only for that case.
var sshCandidates = []string{
	filepath.Join(os.Getenv("SystemRoot"), "Sysnative", "OpenSSH", "ssh.exe"),
	filepath.Join(os.Getenv("SystemRoot"), "System32", "OpenSSH", "ssh.exe"),
	filepath.Join(os.Getenv("ProgramW6432"), "Git", "usr", "bin", "ssh.exe"),
	filepath.Join(os.Getenv("ProgramFiles"), "Git", "usr", "bin", "ssh.exe"),
	filepath.Join(os.Getenv("ProgramW6432"), "OpenSSH", "ssh.exe"),
	filepath.Join(os.Getenv("ProgramFiles"), "OpenSSH", "ssh.exe"),
}

var ensureSSHOnce = sync.OnceValue(func() error {
	if _, err := exec.LookPath("ssh"); err == nil {
		return nil
	}
	for _, candidate := range sshCandidates {
		if _, err := os.Stat(candidate); err != nil {
			continue
		}
		// connhelper shells out to bare "ssh", so the directory has to be on
		// PATH; pointing at the binary directly is not an option it offers.
		os.Setenv("PATH", filepath.Dir(candidate)+string(os.PathListSeparator)+os.Getenv("PATH"))
		return nil
	}
	return errors.New("no ssh client found: install OpenSSH, or restart LunaGate from a shell where `ssh` works")
})

// NewSSH dials a remote Docker daemon over SSH, using the calling process's
// own SSH config, known_hosts and agent (~/.ssh) — LunaGate never handles a
// password or private key itself. sshHost is a plain target like
// "user@host" or "user@host:2222".
func NewSSH(sshHost string) (*Client, error) {
	if err := ensureSSHOnce(); err != nil {
		return nil, err
	}
	helper, err := connhelper.GetConnectionHelper("ssh://" + sshHost)
	if err != nil {
		return nil, err
	}
	cli, err := client.NewClientWithOpts(
		client.WithHTTPClient(&http.Client{Transport: &http.Transport{DialContext: helper.Dialer}}),
		client.WithHost(helper.Host),
		client.WithDialContext(helper.Dialer),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, err
	}
	return &Client{cli: cli}, nil
}

func (c *Client) Close() error { return c.cli.Close() }

func (c *Client) Ping(ctx context.Context) error {
	_, err := c.cli.Ping(ctx)
	return err
}

// Manager hands out the local client plus one cached client per SSH target.
// Caching matters here because the dashboard polls host state every few
// seconds; without it, every poll would pay a fresh SSH handshake.
type Manager struct {
	local *Client
	mu    sync.Mutex
	cache map[string]*Client
}

func NewManager(local *Client) *Manager {
	return &Manager{local: local, cache: map[string]*Client{}}
}

func (m *Manager) Local() *Client { return m.local }

func (m *Manager) Remote(sshHost string) (*Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[sshHost]; ok {
		return c, nil
	}
	c, err := NewSSH(sshHost)
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", sshHost, err)
	}
	m.cache[sshHost] = c
	return c, nil
}

// Forget closes and evicts a cached remote client, e.g. when its environment
// is deleted. A no-op if nothing was cached for sshHost.
func (m *Manager) Forget(sshHost string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[sshHost]; ok {
		c.Close()
		delete(m.cache, sshHost)
	}
}

// Verify dials sshHost and pings it, without caching the connection. Used to
// fail an environment's creation immediately if it's unreachable, rather
// than the user discovering that on the first poll.
func Verify(ctx context.Context, sshHost string) error {
	c, err := NewSSH(sshHost)
	if err != nil {
		return err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return c.Ping(ctx)
}

// PullImage drains the progress stream to completion; the API requires it
// read even when the progress itself is unused.
func (c *Client) PullImage(ctx context.Context, ref string) error {
	// ponytail: no registry auth yet; add image.PullOptions.RegistryAuth when
	//           private registries are needed (roadmap item 6).
	rc, err := c.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return err
	}
	defer rc.Close()
	_, err = io.Copy(io.Discard, rc)
	return err
}

func (c *Client) RunContainer(ctx context.Context, spec Spec) (string, error) {
	env := make([]string, 0, len(spec.Env))
	for k, v := range spec.Env {
		env = append(env, k+"="+v)
	}

	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range spec.Ports {
		port, err := nat.NewPort("tcp", strconv.Itoa(p.Container))
		if err != nil {
			return "", err
		}
		exposed[port] = struct{}{}
		bindings[port] = []nat.PortBinding{{HostIP: "0.0.0.0", HostPort: strconv.Itoa(p.Host)}}
	}

	cfg := &container.Config{
		Image:        spec.Image,
		Env:          env,
		ExposedPorts: exposed,
		Labels: map[string]string{
			labelManaged:    "true",
			labelDeployment: spec.DeploymentID,
			labelReplica:    strconv.Itoa(spec.Replica),
			labelImage:      spec.Image,
		},
	}
	hostCfg := &container.HostConfig{
		PortBindings:  bindings,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
	}
	// Empty name lets Docker auto-generate; ownership is tracked by label, so
	// we never risk a name collision between replicas or redeploys.
	created, err := c.cli.ContainerCreate(ctx, cfg, hostCfg, nil, nil, "")
	if err != nil {
		return "", err
	}
	if err := c.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", err
	}
	return created.ID, nil
}

func (c *Client) StopAndRemove(ctx context.Context, id string) error {
	// Force-remove stops and deletes in one call, tolerating already-stopped.
	return c.cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
}

func (c *Client) ListByDeployment(ctx context.Context, deploymentID string) ([]Container, error) {
	args := filters.NewArgs(
		filters.Arg("label", labelManaged+"=true"),
		filters.Arg("label", labelDeployment+"="+deploymentID),
	)
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: args})
	if err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(list))
	for _, item := range list {
		out = append(out, Container{
			ID:    item.ID,
			State: item.State,
			Image: item.Labels[labelImage],
		})
	}
	return out, nil
}

// ListAllContainers is read-only: it never mutates a container LunaGate
// doesn't own.
func (c *Client) ListAllContainers(ctx context.Context) ([]HostContainer, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	out := make([]HostContainer, 0, len(list))
	for _, item := range list {
		ports := make([]string, 0, len(item.Ports))
		for _, p := range item.Ports {
			if p.PublicPort == 0 {
				ports = append(ports, strconv.Itoa(int(p.PrivatePort))+"/"+p.Type)
				continue
			}
			ports = append(ports, strconv.Itoa(int(p.PublicPort))+":"+strconv.Itoa(int(p.PrivatePort))+"/"+p.Type)
		}
		out = append(out, HostContainer{
			ID:         item.ID,
			Names:      item.Names,
			Image:      item.Image,
			State:      item.State,
			Status:     item.Status,
			Ports:      ports,
			Created:    item.Created,
			Managed:    item.Labels[labelManaged] == "true",
			Deployment: item.Labels[labelDeployment],
		})
	}
	return out, nil
}

func (c *Client) ListImages(ctx context.Context) ([]Image, error) {
	list, err := c.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]Image, 0, len(list))
	for _, item := range list {
		tags := item.RepoTags
		if tags == nil {
			tags = []string{}
		}
		out = append(out, Image{
			ID:       item.ID,
			RepoTags: tags,
			Size:     item.Size,
			Created:  item.Created,
		})
	}
	return out, nil
}

// Logs streams a container's combined stdout/stderr. Caller must close.
func (c *Client) Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error) {
	return c.cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     follow,
		Tail:       "200",
	})
}
