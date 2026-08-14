import { Fragment, useEffect, useRef, useState } from "react";
import {
  Eraser,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from "lucide-react";
import {
  hostLogsURL,
  listContainerStats,
  listHostContainers,
  listImages,
  listNetworks,
  listVolumes,
  pruneImages,
  removeContainer,
  removeImage,
  removeNetwork,
  removeVolume,
  restartContainer,
  startContainer,
  stopContainer,
  type Deployment,
  type HostContainer,
  type Image,
  type Network,
  type Volume,
} from "@/api";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

export function DeploymentsPanel({
  deployments,
  running,
  loading,
  onLogs,
  onRedeploy,
  onDelete,
  onCreate,
}: {
  deployments: Deployment[];
  running: Map<string, number>;
  loading: boolean;
  onLogs: (d: Deployment) => void;
  onRedeploy: (d: Deployment) => void;
  onDelete: (d: Deployment) => void;
  onCreate: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Deployments</CardTitle>
          <CardDescription>
            The reconciler pulls each image and holds the replica count.
          </CardDescription>
        </div>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Replicas</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={4} />}
          {!loading && deployments.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No deployments yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                  Declare an image and a replica count, and the reconciler keeps that many
                  containers running — restarting them if they die.
                </p>
                <Button size="sm" className="mt-4" onClick={onCreate}>
                  <Plus className="size-4" /> New deployment
                </Button>
              </TableCell>
            </TableRow>
          )}
          {deployments.map((d) => {
            const live = running.get(d.id) ?? 0;
            const healthy = live >= d.replicas;
            return (
              <TableRow key={d.id}>
                <TableCell className="font-medium">
                  {d.name}
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground">{d.slug}</span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{d.image}</TableCell>
                <TableCell>
                  <Badge variant={healthy ? "success" : "warning"}>
                    <span className="tabular">
                      {live}/{d.replicas}
                    </span>
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onLogs(d)}>
                      <ScrollText className="size-4" />
                      <span className="hidden md:inline">Logs</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onRedeploy(d)}>
                      <RefreshCw className="size-4" />
                      <span className="hidden md:inline">Redeploy</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => onDelete(d)}
                      aria-label={`Delete ${d.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// useEnvScopedData polls a host listing every 5s for the selected
// environment, refetching immediately when the selection changes.
function useEnvScopedData<T>(envId: string, loader: (env: string) => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    async function tick() {
      try {
        const data = await loader(envId);
        if (!alive) return;
        setItems(data);
        setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId, revision]);

  return { items, error, loading, refresh: () => setRevision((value) => value + 1) };
}

export function HostContainersPanel({ envId }: { envId: string }) {
  const { items: containers, error, loading, refresh } = useEnvScopedData(envId, listHostContainers);
  const { items: stats } = useEnvScopedData(envId, listContainerStats);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const sortedContainers = sortContainers(containers);
  const statsById = new Map(stats.map((s) => [s.id, s]));

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setActionError("");
    try {
      await action();
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Host containers</CardTitle>
          <CardDescription>
            Grouped by Compose project (-p), then name. Managed containers still follow deployment desired state.
          </CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {containers.length} containers · by project
        </Badge>
      </CardHeader>
      {(error || actionError) && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error || actionError}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">CPU</TableHead>
            <TableHead className="text-right">Mem</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Gateway</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={9} />}
          {!loading && !error && containers.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No containers on this host</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Nothing is running under this Docker daemon yet.
                </p>
              </TableCell>
            </TableRow>
          )}
          {sortedContainers.map((c, index) => (
            <Fragment key={c.id}>
              {(index === 0 || sortedContainers[index - 1].project !== c.project) && (
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableCell colSpan={9} className="py-2 text-xs font-semibold">
                    {c.project || "Standalone containers"}
                  </TableCell>
                </TableRow>
              )}
              <TableRow>
              <TableCell className="font-medium">
                {c.names[0]?.replace(/^\//, "") ?? c.id.slice(0, 12)}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
                {c.image}
              </TableCell>
              <TableCell>
                <Badge variant={stateTone(c.state)}>{c.status || c.state}</Badge>
              </TableCell>
              <TableCell className="tabular text-right text-xs text-muted-foreground">
                {statsById.get(c.id) ? `${statsById.get(c.id)!.cpu_percent.toFixed(1)}%` : "—"}
              </TableCell>
              <TableCell className="tabular text-right text-xs text-muted-foreground">
                {statsById.get(c.id)
                  ? `${formatSize(statsById.get(c.id)!.mem_usage)} / ${formatSize(statsById.get(c.id)!.mem_limit)}`
                  : "—"}
              </TableCell>
              <TableCell className="tabular font-mono text-xs text-muted-foreground">
                {c.ports.length ? c.ports.join(", ") : "—"}
              </TableCell>
              <TableCell className="text-xs">
                {c.managed ? (
                  <span className="text-primary">LunaGate</span>
                ) : (
                  <span className="text-muted-foreground">External</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {c.state === "running" && hasPublishedTCPPort(c) ? (
                  <a
                    className="font-medium text-primary hover:underline"
                    href={containerGatewayURL(envId, c.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  {c.state === "running" ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy === c.id}
                        onClick={() => run(c.id, () => stopContainer(envId, c.id))}
                        aria-label={`Stop ${containerName(c)}`}
                        title="Stop"
                      >
                        <Square className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy === c.id}
                        onClick={() => run(c.id, () => restartContainer(envId, c.id))}
                        aria-label={`Restart ${containerName(c)}`}
                        title="Restart"
                      >
                        <RotateCw className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy === c.id}
                      onClick={() => run(c.id, () => startContainer(envId, c.id))}
                      aria-label={`Start ${containerName(c)}`}
                      title="Start"
                    >
                      <Play className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy === c.id || c.state === "running"}
                    onClick={() => {
                      if (confirm(`Remove "${containerName(c)}"?`)) {
                        run(c.id, () => removeContainer(envId, c.id));
                      }
                    }}
                    aria-label={`Remove ${containerName(c)}`}
                    title={c.state === "running" ? "Stop before removing" : "Remove"}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
              </TableRow>
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function ContainerLogsPage({ envId }: { envId: string }) {
  const { items: containers, error, loading } = useEnvScopedData(envId, listHostContainers);
  const sorted = sortContainers(containers);
  const [selected, setSelected] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sorted.some((container) => container.id === selected)) {
      setSelected(sorted[0]?.id ?? "");
    }
  }, [containers, selected]);

  useEffect(() => {
    if (!selected) {
      setLines([]);
      return;
    }
    setLines([]);
    setEnded(false);
    const stream = new EventSource(hostLogsURL(envId, selected));
    stream.onmessage = (event) => setLines((current) => [...current.slice(-1000), event.data]);
    stream.onerror = () => {
      setEnded(true);
      stream.close();
    };
    return () => stream.close();
  }, [envId, selected]);

  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [lines]);

  return (
    <Card className="flex min-h-[32rem] flex-col overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Container logs</CardTitle>
          <CardDescription>Live stdout and stderr from local or SSH containers.</CardDescription>
        </div>
        <select
          className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          value={selected}
          disabled={loading || sorted.length === 0}
          onChange={(event) => setSelected(event.target.value)}
          aria-label="Container"
        >
          {sorted.length === 0 && <option value="">No containers</option>}
          {sorted.map((container) => (
            <option key={container.id} value={container.id}>
              {container.project ? `${container.project} / ` : ""}{containerName(container)} · {container.state}
            </option>
          ))}
        </select>
      </CardHeader>
      {error && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div ref={boxRef} className="flex-1 overflow-auto bg-background p-3 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-muted-foreground">
            {loading ? "Loading containers…" : ended ? "Stream ended or no logs available." : selected ? "Waiting for output…" : "Select an environment with containers."}
          </p>
        ) : (
          lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap break-all">{line}</div>
          ))
        )}
        {ended && lines.length > 0 && <p className="mt-2 text-muted-foreground">— stream ended —</p>}
      </div>
    </Card>
  );
}

export function ImagesPanel({ envId }: { envId: string }) {
  const { items: images, error, loading, refresh } = useEnvScopedData(envId, listImages);
  const total = images.reduce((n, i) => n + i.size, 0);
  const [actionError, setActionError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [pruning, setPruning] = useState(false);

  async function handleRemove(img: Image) {
    const label = img.repo_tags.length ? img.repo_tags.join(", ") : img.id.slice(0, 12);
    if (!confirm(`Remove image "${label}"?`)) return;
    setBusy(img.id);
    setActionError("");
    setStatusMessage("");
    try {
      await removeImage(envId, img.id);
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function handlePrune() {
    if (!confirm("Remove all unused (<none>) images on this environment?")) return;
    setPruning(true);
    setActionError("");
    setStatusMessage("");
    try {
      const result = await pruneImages(envId);
      setStatusMessage(`Removed ${result.deleted} image(s), reclaimed ${formatSize(result.reclaimed_bytes)}.`);
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setPruning(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Images</CardTitle>
          <CardDescription>Local image store on the selected environment.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="muted" className="tabular">
            {formatSize(total)} on disk
          </Badge>
          <Button variant="outline" size="sm" disabled={pruning} onClick={handlePrune}>
            <Eraser className="size-4" />
            <span className="hidden sm:inline">Prune unused</span>
          </Button>
        </div>
      </CardHeader>
      {(error || actionError) && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error || actionError}
        </p>
      )}
      {!error && !actionError && statusMessage && (
        <p className="border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          {statusMessage}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag</TableHead>
            <TableHead>ID</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={5} />}
          {!loading && !error && images.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No images pulled yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Creating a deployment pulls its image and it will appear here.
                </p>
              </TableCell>
            </TableRow>
          )}
          {images.map((img) => (
            <TableRow key={img.id}>
              <TableCell className="font-medium">
                {img.repo_tags.length ? (
                  img.repo_tags.join(", ")
                ) : (
                  <span className="text-muted-foreground">&lt;none&gt;</span>
                )}
              </TableCell>
              <TableCell className="tabular font-mono text-xs text-muted-foreground">
                {img.id.replace(/^sha256:/, "").slice(0, 12)}
              </TableCell>
              <TableCell className="tabular text-right text-xs text-muted-foreground">
                {formatSize(img.size)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{timeAgo(img.created)}</TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy === img.id}
                    onClick={() => handleRemove(img)}
                    aria-label={`Remove ${img.id.slice(0, 12)}`}
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function VolumesPanel({ envId }: { envId: string }) {
  const { items: volumes, error, loading, refresh } = useEnvScopedData(envId, listVolumes);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");

  async function handleRemove(v: Volume) {
    if (!confirm(`Remove volume "${v.name}"?`)) return;
    setBusy(v.name);
    setActionError("");
    try {
      await removeVolume(envId, v.name);
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Volumes</CardTitle>
          <CardDescription>Named volumes on the selected environment.</CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {volumes.length} volumes
        </Badge>
      </CardHeader>
      {(error || actionError) && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error || actionError}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Driver</TableHead>
            <TableHead>Mountpoint</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={4} />}
          {!loading && !error && volumes.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No volumes on this host</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Volumes created by containers will appear here.
                </p>
              </TableCell>
            </TableRow>
          )}
          {volumes.map((v) => (
            <TableRow key={v.name}>
              <TableCell className="font-medium">{v.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{v.driver}</TableCell>
              <TableCell className="max-w-[24rem] truncate font-mono text-xs text-muted-foreground">
                {v.mountpoint}
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy === v.name}
                    onClick={() => handleRemove(v)}
                    aria-label={`Remove ${v.name}`}
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function NetworksPanel({ envId }: { envId: string }) {
  const { items: networks, error, loading, refresh } = useEnvScopedData(envId, listNetworks);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");

  async function handleRemove(n: Network) {
    if (!confirm(`Remove network "${n.name}"?`)) return;
    setBusy(n.id);
    setActionError("");
    try {
      await removeNetwork(envId, n.id);
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Networks</CardTitle>
          <CardDescription>Docker networks on the selected environment.</CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {networks.length} networks
        </Badge>
      </CardHeader>
      {(error || actionError) && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error || actionError}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Driver</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={4} />}
          {!loading && !error && networks.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No networks on this host</p>
              </TableCell>
            </TableRow>
          )}
          {networks.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium">{n.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{n.driver}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{n.scope}</TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy === n.id || n.builtin}
                    onClick={() => handleRemove(n)}
                    aria-label={`Remove ${n.name}`}
                    title={n.builtin ? "Built-in network" : "Remove"}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1, 2].map((r) => (
        <TableRow key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <TableCell key={c}>
              <Skeleton className="h-4" style={{ width: `${[60, 45, 35, 50, 40][c] ?? 40}%` }} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function stateTone(state: string) {
  if (state === "running") return "success" as const;
  if (state === "exited" || state === "dead") return "destructive" as const;
  if (state === "created" || state === "paused" || state === "restarting") return "warning" as const;
  return "muted" as const;
}

function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function hasPublishedTCPPort(container: HostContainer) {
  return container.ports.some((port) => /^\d+:\d+\/tcp$/.test(port));
}

function containerName(container: HostContainer) {
  return container.names[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
}

function sortContainers(containers: HostContainer[]) {
  return [...containers].sort((a, b) =>
    (a.project || "\uffff").localeCompare(b.project || "\uffff") ||
    containerName(a).localeCompare(containerName(b)),
  );
}

function containerGatewayURL(environment: string, container: string) {
  return environment === "local"
    ? `/gateway/local/${encodeURIComponent(container)}/`
    : `/gateway/ssh/${encodeURIComponent(environment)}/${encodeURIComponent(container)}/`;
}

function timeAgo(unixSeconds: number) {
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
