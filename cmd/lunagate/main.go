package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/FelippeTN/LunaGate/internal/docker"
	"github.com/FelippeTN/LunaGate/internal/httpapi"
	"github.com/FelippeTN/LunaGate/internal/reconcile"
	"github.com/FelippeTN/LunaGate/internal/store"
	"github.com/FelippeTN/LunaGate/web"
)

func main() {
	addr := flag.String("addr", ":8080", "administration API address")
	dbPath := flag.String("db", "lunagate.db", "SQLite database path")
	interval := flag.Duration("reconcile-interval", 5*time.Second, "reconciler tick interval")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	token := os.Getenv("LUNAGATE_ADMIN_TOKEN")
	if len(token) < 32 {
		logger.Error("LUNAGATE_ADMIN_TOKEN must have at least 32 characters")
		os.Exit(1)
	}

	db, err := store.Open(*dbPath)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	dockerClient, err := docker.New()
	if err != nil {
		logger.Error("create docker client", "error", err)
		os.Exit(1)
	}
	defer dockerClient.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reconciler := reconcile.New(dockerClient, db, logger, *interval)
	go reconciler.Run(ctx)

	envs := docker.NewManager(dockerClient)
	api := httpapi.New(db, dockerClient, envs, token, logger)
	mux := http.NewServeMux()
	mux.Handle("/v1/", api)
	mux.Handle("/healthz", api)
	mux.Handle("/readyz", api)
	mux.Handle("/", staticSite(logger))

	server := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      0, // log streaming (SSE) needs an unbounded write deadline
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		logger.Info("LunaGate listening", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "error", err)
	}
}

// staticSite serves the embedded frontend. Deep links are not needed — the UI
// is a single page — so a plain file server is enough.
func staticSite(logger *slog.Logger) http.Handler {
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		logger.Error("embed frontend", "error", err)
		os.Exit(1)
	}
	return http.FileServerFS(dist)
}
