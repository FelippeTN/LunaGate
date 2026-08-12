package reconcile

import (
	"context"
	"io"
	"log/slog"
	"strconv"
	"testing"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/store"
)

type fakeRuntime struct {
	containers []docker.Container
	nextID     int
	pulls      int
}

func (f *fakeRuntime) PullImage(_ context.Context, _ string) error { f.pulls++; return nil }

func (f *fakeRuntime) RunContainer(_ context.Context, spec docker.Spec) (string, error) {
	f.nextID++
	id := "c" + strconv.Itoa(f.nextID)
	f.containers = append(f.containers, docker.Container{ID: id, State: "running", Image: spec.Image})
	return id, nil
}

func (f *fakeRuntime) StopAndRemove(_ context.Context, id string) error {
	kept := f.containers[:0]
	for _, c := range f.containers {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	f.containers = kept
	return nil
}

func (f *fakeRuntime) ListByDeployment(_ context.Context, _ string) ([]docker.Container, error) {
	return f.containers, nil
}

type fakeLister struct{ deployments []store.Deployment }

func (f *fakeLister) ListDeployments(_ context.Context) ([]store.Deployment, error) {
	return f.deployments, nil
}

func newReconciler(rt Runtime, l Lister) *Reconciler {
	return New(rt, l, slog.New(slog.NewTextHandler(io.Discard, nil)), 0)
}

func TestConvergesToDesiredReplicas(t *testing.T) {
	rt := &fakeRuntime{}
	lister := &fakeLister{deployments: []store.Deployment{{ID: "d1", Image: "nginx:1", Replicas: 2}}}
	r := newReconciler(rt, lister)
	ctx := context.Background()

	r.Tick(ctx)
	if len(rt.containers) != 2 {
		t.Fatalf("want 2 containers, got %d", len(rt.containers))
	}

	// Idempotent: a second tick changes nothing.
	r.Tick(ctx)
	if len(rt.containers) != 2 {
		t.Fatalf("want 2 stable containers, got %d", len(rt.containers))
	}
}

func TestSelfHealsRemovedContainer(t *testing.T) {
	rt := &fakeRuntime{}
	lister := &fakeLister{deployments: []store.Deployment{{ID: "d1", Image: "nginx:1", Replicas: 2}}}
	r := newReconciler(rt, lister)
	ctx := context.Background()

	r.Tick(ctx)
	rt.StopAndRemove(ctx, rt.containers[0].ID) // simulate a crash
	r.Tick(ctx)
	if len(rt.containers) != 2 {
		t.Fatalf("want reconciler to restore 2 containers, got %d", len(rt.containers))
	}
}

func TestRedeployReplacesStaleImage(t *testing.T) {
	rt := &fakeRuntime{}
	lister := &fakeLister{deployments: []store.Deployment{{ID: "d1", Image: "nginx:1", Replicas: 1}}}
	r := newReconciler(rt, lister)
	ctx := context.Background()

	r.Tick(ctx)
	lister.deployments[0].Image = "nginx:2" // redeploy
	r.Tick(ctx)

	if len(rt.containers) != 1 {
		t.Fatalf("want 1 container, got %d", len(rt.containers))
	}
	if rt.containers[0].Image != "nginx:2" {
		t.Fatalf("want image nginx:2, got %s", rt.containers[0].Image)
	}
}

func TestScalesDown(t *testing.T) {
	rt := &fakeRuntime{}
	lister := &fakeLister{deployments: []store.Deployment{{ID: "d1", Image: "nginx:1", Replicas: 3}}}
	r := newReconciler(rt, lister)
	ctx := context.Background()

	r.Tick(ctx)
	lister.deployments[0].Replicas = 1
	r.Tick(ctx)
	if len(rt.containers) != 1 {
		t.Fatalf("want 1 container after scale-down, got %d", len(rt.containers))
	}
}
