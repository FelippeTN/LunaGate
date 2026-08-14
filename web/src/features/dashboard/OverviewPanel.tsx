import { useEffect, useState } from "react";
import { Activity, Copy, Laptop, Wifi } from "lucide-react";
import {
  listHostContainers,
  startContainerTracking,
  type ContainerMetrics,
  type Deployment,
  type Environment,
  type HostContainer,
} from "@/api";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";

type EnvironmentSnapshot = {
  environment: Environment;
  containers: HostContainer[];
  error?: string;
  loading: boolean;
};

export function OverviewPanel({
  deployments,
  running,
  environments,
  localContainers,
  metrics,
  loading,
  refreshKey,
  onMetricsChange,
}: {
  deployments: Deployment[];
  running: Map<string, number>;
  environments: Environment[];
  localContainers: HostContainer[];
  metrics: ContainerMetrics | null;
  loading: boolean;
  refreshKey: number;
  onMetricsChange: (metrics: ContainerMetrics) => void;
}) {
  const [remoteSnapshots, setRemoteSnapshots] = useState<
    Record<string, { containers: HostContainer[]; error?: string }>
  >({});
  const [selectedContainer, setSelectedContainer] = useState("");
  const [trackingError, setTrackingError] = useState("");
  const [startingTracking, setStartingTracking] = useState(false);
  const [gatewayCopied, setGatewayCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const remotes = environments.filter((environment) => environment.id !== "local");

    async function refreshRemotes() {
      const results = await Promise.all(
        remotes.map(async (environment) => {
          try {
            return [environment.id, { containers: await listHostContainers(environment.id) }] as const;
          } catch (error) {
            return [
              environment.id,
              { containers: [], error: (error as Error).message },
            ] as const;
          }
        }),
      );
      if (alive) setRemoteSnapshots(Object.fromEntries(results));
    }

    refreshRemotes();
    const timer = setInterval(refreshRemotes, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [environments, refreshKey]);

  const snapshots: EnvironmentSnapshot[] = environments.map((environment) => {
    if (environment.id === "local") {
      return { environment, containers: localContainers, loading };
    }
    const snapshot = remoteSnapshots[environment.id];
    return {
      environment,
      containers: snapshot?.containers ?? [],
      error: snapshot?.error,
      loading: !snapshot,
    };
  });
  const trackableContainers = snapshots.flatMap(({ environment, containers }) =>
    containers
      .filter((container) => container.state === "running" && hasPublishedTCPPort(container))
      .map((container) => ({
        key: `${environment.id}:${container.id}`,
        environment,
        container,
      })),
  );
  const trackingKey = metrics?.tracking
    ? `${metrics.tracking.environment_id}:${metrics.tracking.container_id}`
    : "";
  const optionKeys = trackableContainers.map((option) => option.key).join("|");
  const containersLoading = snapshots.some((snapshot) => snapshot.loading);

  useEffect(() => {
    if (containersLoading) return;
    if (selectedContainer && trackableContainers.some((option) => option.key === selectedContainer)) return;
    setSelectedContainer(
      trackableContainers.some((option) => option.key === trackingKey)
        ? trackingKey
        : trackableContainers[0]?.key ?? "",
    );
  }, [containersLoading, optionKeys, selectedContainer, trackingKey]);

  async function startTracking() {
    const selected = trackableContainers.find((option) => option.key === selectedContainer);
    if (!selected) return;
    setStartingTracking(true);
    setTrackingError("");
    try {
      onMetricsChange(await startContainerTracking(selected.environment.id, selected.container.id));
    } catch (error) {
      setTrackingError((error as Error).message);
    } finally {
      setStartingTracking(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="overflow-hidden xl:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Container request tracking</CardTitle>
            <CardDescription>
              Choose one container and track requests through its gateway for seven days.
            </CardDescription>
          </div>
          <Badge variant={metrics?.tracking?.active ? "success" : "muted"}>
            {metrics?.tracking?.active ? "Tracking active" : "7-day window"}
          </Badge>
        </CardHeader>
        <div className="border-b border-border p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={selectedContainer}
              onChange={(event) => setSelectedContainer(event.target.value)}
              disabled={trackableContainers.length === 0 || startingTracking}
              aria-label="Container to track"
            >
              {trackableContainers.length === 0 && <option value="">No running container with a published TCP port</option>}
              {trackableContainers.map(({ key, environment, container }) => (
                <option key={key} value={key}>
                  {environment.name} · {containerName(container)}
                </option>
              ))}
            </select>
            <Button onClick={startTracking} disabled={!selectedContainer || startingTracking}>
              {startingTracking ? "Starting…" : metrics?.tracking ? "Restart 7-day tracking" : "Start 7-day tracking"}
            </Button>
          </div>
          {trackingError && <p className="mt-2 text-xs text-destructive">{trackingError}</p>}
          {metrics?.tracking ? (
            <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                <span className="font-medium text-foreground">{metrics.tracking.container_name}</span>
                {metrics.tracking.active
                  ? ` · tracking until ${formatDateTime(metrics.tracking.ends_at)}`
                  : " · tracking period completed"}
              </span>
              <div className="flex min-w-0 items-center gap-2">
                <a
                  className="truncate font-mono text-primary hover:underline"
                  href={trackedGatewayPath(metrics.tracking)}
                  target="_blank"
                  rel="noreferrer"
                  title="Requests are counted only through this URL"
                >
                  Gateway: {trackedGatewayPath(metrics.tracking)}
                </a>
                <button
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(location.origin + trackedGatewayPath(metrics.tracking!));
                      setGatewayCopied(true);
                      setTimeout(() => setGatewayCopied(false), 1500);
                    } catch {
                      setGatewayCopied(false);
                    }
                  }}
                  title="Copy gateway URL"
                  aria-label="Copy gateway URL"
                >
                  <Copy className="size-3" /> {gatewayCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Select a container to begin. Requests sent directly to its Docker port cannot be counted.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
          {loading || !metrics ? (
            Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="bg-card p-4">
                <Skeleton className="h-10 w-24" />
              </div>
            ))
          ) : (
            <>
              <TrafficStat label="Tracked requests · total" value={String(metrics.requests_total)} />
              <TrafficStat label="Tracked requests · current hour" value={String(metrics.requests_last_hour)} />
              <TrafficStat label="Average latency · tracked period" value={`${metrics.average_latency_ms.toFixed(1)} ms`} />
              <TrafficStat
                label="Container errors · tracked period"
                value={`${metrics.status.server_error} (${errorRate(metrics)}%)`}
                bad={metrics.status.server_error > 0}
              />
            </>
          )}
        </div>
        {metrics?.tracking && (
          <>
            <TrafficChart values={metrics.requests_per_hour} />
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
              <span><span className="text-success">2xx/3xx</span> {metrics.status.success}</span>
              <span><span className="text-warning">4xx</span> {metrics.status.client_error}</span>
              <span><span className="text-destructive">5xx</span> {metrics.status.server_error}</span>
            </div>
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Deployment capacity</CardTitle>
            <CardDescription>Running replicas compared with the desired state.</CardDescription>
          </div>
          <Activity className="size-4 text-muted-foreground" />
        </CardHeader>
        <div className="space-y-5 p-4">
          {loading && Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
          {!loading && deployments.length === 0 && (
            <EmptyOverview
              title="No workload to chart"
              description="Create a deployment to start tracking replica health here."
            />
          )}
          {deployments.map((deployment) => {
            const live = running.get(deployment.id) ?? 0;
            const healthy = live >= deployment.replicas;
            const percentage = Math.min(100, (live / Math.max(1, deployment.replicas)) * 100);
            return (
              <div key={deployment.id}>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{deployment.name}</span>
                    <span className="ml-2 truncate font-mono text-muted-foreground">
                      {deployment.slug}
                    </span>
                  </div>
                  <Badge variant={healthy ? "success" : "warning"} className="tabular shrink-0">
                    {live}/{deployment.replicas}
                  </Badge>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={`${deployment.name}: ${live} of ${deployment.replicas} replicas running`}
                  aria-valuemin={0}
                  aria-valuemax={deployment.replicas}
                  aria-valuenow={live}
                >
                  <div
                    className={cn("h-full rounded-full", healthy ? "bg-success" : "bg-warning")}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Containers by server</CardTitle>
            <CardDescription>Live workload across local and SSH environments.</CardDescription>
          </div>
          <Badge variant="muted" className="tabular">
            {snapshots.filter((item) => !item.loading && !item.error).length}/{snapshots.length} online
          </Badge>
        </CardHeader>
        <div className="space-y-4 p-4">
          {snapshots.map(({ environment, containers, error, loading: serverLoading }) => {
            const runningCount = containers.filter((container) => container.state === "running").length;
            const stoppedCount = containers.length - runningCount;
            const Icon = environment.kind === "local" ? Laptop : Wifi;
            return (
              <div key={environment.id}>
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{environment.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {environment.kind === "local" ? "localhost" : environment.ssh_host}
                    </p>
                  </div>
                  {serverLoading ? (
                    <Skeleton className="h-5 w-14" />
                  ) : error ? (
                    <Badge variant="destructive">Offline</Badge>
                  ) : (
                    <span className="tabular text-xs text-muted-foreground">
                      {runningCount}/{containers.length} running
                    </span>
                  )}
                </div>
                {error ? (
                  <p className="truncate pl-6 text-xs text-destructive" title={error}>
                    {error}
                  </p>
                ) : serverLoading ? (
                  <Skeleton className="ml-6 h-2 w-[calc(100%-1.5rem)]" />
                ) : (
                  <div className="ml-6 flex h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-success"
                      style={{ width: `${(runningCount / Math.max(1, containers.length)) * 100}%` }}
                    />
                    <div
                      className="bg-warning"
                      style={{ width: `${(stoppedCount / Math.max(1, containers.length)) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" /> Running
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" /> Stopped
          </span>
        </div>
      </Card>
    </div>
  );
}

function EmptyOverview({ title, description }: { title: string; description: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function TrafficStat({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular mt-1 text-xl font-semibold", bad && "text-destructive")}>{value}</p>
    </div>
  );
}

function TrafficChart({ values }: { values: number[] }) {
  const width = 600;
  const height = 112;
  const peak = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - (value / peak) * (height - 8);
    return `${x},${y}`;
  });
  const area = `0,${height} ${points.join(" ")} ${width},${height}`;

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>Requests per hour</span>
        <span className="tabular">7 days · peak {Math.max(0, ...values)} req/h</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-28 w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Container requests per hour over seven days; peak ${Math.max(0, ...values)}`}
      >
        <line x1="0" y1={height} x2={width} y2={height} className="stroke-border" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="stroke-border/50" vectorEffect="non-scaling-stroke" strokeDasharray="3 4" />
        <polygon points={area} className="fill-primary/10" />
        <polyline points={points.join(" ")} className="fill-none stroke-primary" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function errorRate(metrics: ContainerMetrics) {
  const total = Object.values(metrics.status).reduce((sum, value) => sum + value, 0);
  return total ? ((metrics.status.server_error / total) * 100).toFixed(1) : "0.0";
}

function hasPublishedTCPPort(container: HostContainer) {
  return container.ports.some((port) => /^\d+:\d+\/tcp$/.test(port));
}

function containerName(container: HostContainer) {
  return container.names[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
}

function trackedGatewayPath(tracking: NonNullable<ContainerMetrics["tracking"]>) {
  return tracking.environment_id === "local"
    ? `/gateway/local/${encodeURIComponent(tracking.container_id)}/`
    : `/gateway/ssh/${encodeURIComponent(tracking.environment_id)}/${encodeURIComponent(tracking.container_id)}/`;
}

function formatDateTime(unixSeconds: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(unixSeconds * 1000);
}

type Stat = { label: string; value: string; tone?: "good" | "bad" | "neutral" };

export function SummaryBar({ stats, loading }: { stats: Stat[]; loading: boolean }) {
  return (
    <Card className="grid grid-cols-2 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={cn("px-4 py-3", i % 2 === 1 && "border-l border-border sm:border-l-0")}
        >
          <p className="text-xs text-muted-foreground">{s.label}</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p
              className={cn(
                "tabular mt-0.5 text-xl font-semibold tracking-tight",
                s.tone === "good" && "text-success",
                s.tone === "bad" && "text-warning",
              )}
            >
              {s.value}
            </p>
          )}
        </div>
      ))}
    </Card>
  );
}
