// Package docker is a thin wrapper over the Docker Engine API. LunaGate owns
// only the containers it labels; it never touches anything else on the host.
package docker

import (
	"context"
	"io"
	"strconv"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

// Ownership labels. Every container LunaGate starts carries these.
const (
	labelManaged    = "lunagate.managed"
	labelDeployment = "lunagate.deployment"
	labelReplica    = "lunagate.replica"
	labelImage      = "lunagate.image"
)

type Client struct{ cli *client.Client }

// Port maps a container port to a host port.
type Port struct {
	Container int `json:"container"`
	Host      int `json:"host"`
}

// Spec is everything needed to start one replica of a deployment.
type Spec struct {
	DeploymentID string
	Replica      int
	Image        string
	Env          map[string]string
	Ports        []Port
}

// Container is the subset of a running container LunaGate reports on.
type Container struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Image string `json:"image"`
}

func New() (*Client, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
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

// PullImage pulls the image and drains the progress stream to completion.
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

// RunContainer creates and starts one replica from spec.
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

// ListByDeployment returns all containers LunaGate owns for a deployment.
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

// Logs streams a container's combined stdout/stderr. Caller must close.
func (c *Client) Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error) {
	return c.cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     follow,
		Tail:       "200",
	})
}
