// Package reconcile holds LunaGate's control loop: it repeatedly compares the
// real containers against the desired deployments and converges the two.
package reconcile

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/store"
)

// Runtime is the slice of the Docker wrapper the reconciler needs. Kept small
// so tests can fake it.
type Runtime interface {
	PullImage(ctx context.Context, ref string) error
	RunContainer(ctx context.Context, spec docker.Spec) (string, error)
	StopAndRemove(ctx context.Context, id string) error
	ListByDeployment(ctx context.Context, deploymentID string) ([]docker.Container, error)
}

// Lister supplies the desired state.
type Lister interface {
	ListDeployments(ctx context.Context) ([]store.Deployment, error)
}

type Reconciler struct {
	rt       Runtime
	store    Lister
	logger   *slog.Logger
	interval time.Duration
}

func New(rt Runtime, s Lister, logger *slog.Logger, interval time.Duration) *Reconciler {
	return &Reconciler{rt: rt, store: s, logger: logger, interval: interval}
}

// Run ticks until ctx is cancelled. It reconciles once immediately, then every
// interval.
func (r *Reconciler) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		r.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Tick reconciles every deployment once.
//
// ponytail: global reconcile in a single tick, no per-deployment worker.
//           Recreates all replicas at once on a redeploy (brief downtime);
//           upgrade to rolling one-at-a-time for zero-downtime (roadmap item 2).
func (r *Reconciler) Tick(ctx context.Context) {
	deployments, err := r.store.ListDeployments(ctx)
	if err != nil {
		r.logger.Error("reconcile: list deployments", "error", err)
		return
	}
	for _, d := range deployments {
		if err := r.reconcileOne(ctx, d); err != nil {
			r.logger.Error("reconcile: deployment", "deployment", d.ID, "error", err)
		}
	}
}

func (r *Reconciler) reconcileOne(ctx context.Context, d store.Deployment) error {
	containers, err := r.rt.ListByDeployment(ctx, d.ID)
	if err != nil {
		return err
	}

	// A container is "good" if it runs the desired image and is running. Any
	// other container (stale image, exited, dead) is removed so it stops
	// counting toward the replica goal.
	var good []docker.Container
	for _, c := range containers {
		if c.Image == d.Image && c.State == "running" {
			good = append(good, c)
			continue
		}
		if err := r.rt.StopAndRemove(ctx, c.ID); err != nil {
			return err
		}
	}

	switch {
	case len(good) < d.Replicas:
		spec, err := specFor(d)
		if err != nil {
			return err
		}
		if err := r.rt.PullImage(ctx, d.Image); err != nil {
			return err
		}
		for i := len(good); i < d.Replicas; i++ {
			spec.Replica = i
			if _, err := r.rt.RunContainer(ctx, spec); err != nil {
				return err
			}
			r.logger.Info("reconcile: started replica", "deployment", d.ID, "image", d.Image)
		}
	case len(good) > d.Replicas:
		for _, c := range good[d.Replicas:] {
			if err := r.rt.StopAndRemove(ctx, c.ID); err != nil {
				return err
			}
			r.logger.Info("reconcile: removed extra replica", "deployment", d.ID)
		}
	}
	return nil
}

// specFor builds a container spec from a deployment's stored JSON fields.
func specFor(d store.Deployment) (docker.Spec, error) {
	spec := docker.Spec{DeploymentID: d.ID, Image: d.Image}
	if d.Env != "" {
		if err := json.Unmarshal([]byte(d.Env), &spec.Env); err != nil {
			return docker.Spec{}, err
		}
	}
	if d.Ports != "" {
		if err := json.Unmarshal([]byte(d.Ports), &spec.Ports); err != nil {
			return docker.Spec{}, err
		}
	}
	return spec, nil
}
