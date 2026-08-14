import { useEffect, useState } from "react";
import { Activity, Laptop, Wifi } from "lucide-react";
import {
  listHostContainers,
  type ContainerMetrics,
  type Deployment,
  type Environment,
  type HostContainer,
} from "@/api";
import {
  Badge,
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
}: {
  deployments: Deployment[];
  running: Map<string, number>;
  environments: Environment[];
  localContainers: HostContainer[];
  metrics: ContainerMetrics | null;
  loading: boolean;
  refreshKey: number;
}) {
  const [remoteSnapshots, setRemoteSnapshots] = useState<
    Record<string, { containers: HostContainer[]; error?: string }>
  >({});

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

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="overflow-hidden xl:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Running container traffic</CardTitle>
            <CardDescription>
              Only responses from running local or SSH containers reached through their gateway URL.
            </CardDescription>
          </div>
          <Badge variant="success">Containers only</Badge>
        </CardHeader>
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
          {loading || !metrics ? (
            Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="bg-card p-4">
                <Skeleton className="h-10 w-24" />
              </div>
            ))
          ) : (
            <>
              <TrafficStat label="Container requests · 60s" value={String(metrics.container_requests_last_minute)} />
              <TrafficStat label="Container requests · total" value={String(metrics.container_requests_total)} />
              <TrafficStat label="Container latency · 60s" value={`${metrics.container_average_latency_ms.toFixed(1)} ms`} />
              <TrafficStat
                label="Container errors · 60s"
                value={`${metrics.last_minute.server_error} (${errorRate(metrics)}%)`}
                bad={metrics.last_minute.server_error > 0}
              />
            </>
          )}
        </div>
        {metrics && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
            <span><span className="text-success">2xx/3xx</span> {metrics.last_minute.success}</span>
            <span><span className="text-warning">4xx</span> {metrics.last_minute.client_error}</span>
            <span><span className="text-destructive">5xx</span> {metrics.last_minute.server_error}</span>
          </div>
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

function errorRate(metrics: ContainerMetrics) {
  const total = Object.values(metrics.last_minute).reduce((sum, value) => sum + value, 0);
  return total ? ((metrics.last_minute.server_error / total) * 100).toFixed(1) : "0.0";
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

