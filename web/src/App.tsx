import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Laptop,
  Layers,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  Sun,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import {
  clearToken,
  createDeployment,
  createEnvironment,
  deleteDeployment,
  deleteEnvironment,
  getToken,
  listDeployments,
  listEnvironments,
  listHostContainers,
  listImages,
  logsURL,
  redeploy,
  setToken,
  webhookURL,
  type Deployment,
  type Environment,
  type HostContainer,
  type Image as DockerImage,
  type NewDeployment,
} from "@/api";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@/components/ui";
import { cn } from "@/lib/utils";

const THEME_KEY = "lunagate_theme";

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "dark",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;
  return (
    <Dashboard
      onLogout={() => {
        clearToken();
        setAuthed(false);
      }}
    />
  );
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError("");
    setToken(value.trim());
    try {
      // Verify before entering, so a bad token fails here instead of on every
      // panel inside the dashboard.
      await listDeployments();
      onDone();
    } catch (err) {
      clearToken();
      const message = (err as Error).message;
      setError(
        message.toLowerCase().includes("token") || message.includes("401")
          ? "That token was rejected. Check LUNAGATE_ADMIN_TOKEN on the server."
          : message,
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-primary/15">
            <Boxes className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">LunaGate</h1>
            <p className="text-xs text-muted-foreground">Container control plane</p>
          </div>
        </div>
        <Card className="p-5">
          <form onSubmit={submit}>
            <Label htmlFor="token">Admin token</Label>
            <Input
              id="token"
              type="password"
              className="mt-2"
              autoFocus
              placeholder="LUNAGATE_ADMIN_TOKEN"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!!error || undefined}
              aria-describedby={error ? "token-error" : undefined}
            />
            {error && (
              <p id="token-error" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="mt-4 w-full" disabled={!value.trim() || checking}>
              {checking ? "Verifying…" : "Continue"}
            </Button>
          </form>
        </Card>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          The token is the value the server was started with.
        </p>
      </div>
    </div>
  );
}

type Tab = "deployments" | "containers" | "images";

const TABS: { id: Tab; label: string; icon: typeof Boxes; description: string }[] = [
  {
    id: "deployments",
    label: "Deployments",
    icon: Boxes,
    description: "Desired state this control plane keeps running.",
  },
  {
    id: "containers",
    label: "Host containers",
    icon: Server,
    description: "Every container on this machine, managed here or not.",
  },
  {
    id: "images",
    label: "Images",
    icon: Layers,
    description: "Images in this host's local Docker store.",
  },
];

const LOCAL_ENV: Environment = { id: "local", name: "This machine", kind: "local" };

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("deployments");
  const [navOpen, setNavOpen] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [localContainers, setLocalContainers] = useState<HostContainer[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<Deployment | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);
  const { theme, toggle } = useTheme();

  const [environments, setEnvironments] = useState<Environment[]>([LOCAL_ENV]);
  const [envId, setEnvId] = useState("local");

  const refreshEnvironments = useCallback(async () => {
    try {
      setEnvironments(await listEnvironments());
    } catch {
      // Keep the last known list; the picker still works for envs already loaded.
    }
  }, []);

  // Deployments and the summary strip are always local — the reconciler only
  // ever manages containers on this machine. Host containers carry their
  // deployment label, so replica tallies come from this listing rather than
  // one request per deployment.
  const refresh = useCallback(async () => {
    const [d, c] = await Promise.allSettled([listDeployments(), listHostContainers("local")]);
    if (d.status === "fulfilled") setDeployments(d.value);
    if (c.status === "fulfilled") setLocalContainers(c.value);
    const failed = [d, c].find((r) => r.status === "rejected");
    setError(failed ? (failed as PromiseRejectedResult).reason.message : "");
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    refreshEnvironments();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, refreshEnvironments]);

  const runningByDeployment = new Map<string, number>();
  for (const c of localContainers) {
    if (!c.deployment || c.state !== "running") continue;
    runningByDeployment.set(c.deployment, (runningByDeployment.get(c.deployment) ?? 0) + 1);
  }
  const desiredReplicas = deployments.reduce((n, d) => n + d.replicas, 0);
  const runningReplicas = deployments.reduce((n, d) => n + (runningByDeployment.get(d.id) ?? 0), 0);
  const runningContainers = localContainers.filter((c) => c.state === "running").length;

  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="min-h-screen bg-background">
      {/* Off-canvas scrim, mobile only */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 px-4">
          <div className="grid size-8 place-items-center rounded-lg bg-primary/15">
            <Boxes className="size-4.5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">LunaGate</p>
            <p className="truncate text-[11px] text-muted-foreground">Control plane</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </Button>
        </div>

        <Separator className="bg-sidebar-border" />

        <nav className="flex-1 space-y-0.5 p-2">
          {TABS.map(({ id, label, icon: Icon }) => {
            const isActive = id === tab;
            return (
              <button
                key={id}
                onClick={() => {
                  setTab(id);
                  setNavOpen(false);
                }}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", isActive && "text-primary")} />
                {label}
              </button>
            );
          })}
        </nav>

        <Separator className="bg-sidebar-border" />

        <div className="flex items-center gap-1 p-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            onClick={onLogout}
          >
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{active.label}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">
              {active.description}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refresh()}>
              <RefreshCw className="size-4" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {tab === "deployments" && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                <span className="hidden sm:inline">New deployment</span>
              </Button>
            )}
          </div>
        </header>

        <main className="space-y-4 p-4 sm:p-6">
          <SummaryBar
            loading={loading}
            stats={[
              { label: "Deployments", value: String(deployments.length) },
              {
                label: "Replicas",
                value: `${runningReplicas}/${desiredReplicas}`,
                tone:
                  desiredReplicas === 0
                    ? "neutral"
                    : runningReplicas >= desiredReplicas
                      ? "good"
                      : "bad",
              },
              {
                label: "This machine",
                value: `${runningContainers}/${localContainers.length}`,
              },
              { label: "Environments", value: String(environments.length) },
            ]}
          />

          {error && (
            <Card className="border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </Card>
          )}

          {tab === "deployments" && (
            <DeploymentsPanel
              deployments={deployments}
              running={runningByDeployment}
              loading={loading}
              onLogs={setLogsFor}
              onRedeploy={async (d) => {
                await redeploy(d.id).catch((e) => setError((e as Error).message));
                refresh();
              }}
              onDelete={async (d) => {
                if (!confirm(`Delete "${d.name}" and stop its containers?`)) return;
                await deleteDeployment(d.id).catch((e) => setError((e as Error).message));
                refresh();
              }}
              onCreate={() => setCreating(true)}
            />
          )}
          {(tab === "containers" || tab === "images") && (
            <EnvironmentPicker
              environments={environments}
              selected={envId}
              onSelect={setEnvId}
              onChanged={refreshEnvironments}
            />
          )}
          {tab === "containers" && <HostContainersPanel envId={envId} />}
          {tab === "images" && <ImagesPanel envId={envId} />}
        </main>
      </div>

      {creating && (
        <NewDeploymentDialog
          onClose={() => setCreating(false)}
          onCreated={(d) => {
            setCreating(false);
            setCreated(d);
            refresh();
          }}
        />
      )}
      {created && <WebhookInfo deployment={created} onClose={() => setCreated(null)} />}
      {logsFor && <LogsPanel deployment={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

type Stat = { label: string; value: string; tone?: "good" | "bad" | "neutral" };

function SummaryBar({ stats, loading }: { stats: Stat[]; loading: boolean }) {
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

function DeploymentsPanel({
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
  }, [envId]);

  return { items, error, loading };
}

function HostContainersPanel({ envId }: { envId: string }) {
  const { items: containers, error, loading } = useEnvScopedData(envId, listHostContainers);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Host containers</CardTitle>
          <CardDescription>
            Read-only. LunaGate never stops a container it does not own.
          </CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {containers.filter((c) => c.managed).length} managed
        </Badge>
      </CardHeader>
      {error && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Owner</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={5} />}
          {!loading && !error && containers.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="h-auto py-12 text-center">
                <p className="text-sm font-medium">No containers on this host</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Nothing is running under this Docker daemon yet.
                </p>
              </TableCell>
            </TableRow>
          )}
          {containers.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">
                {c.names[0]?.replace(/^\//, "") ?? c.id.slice(0, 12)}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
                {c.image}
              </TableCell>
              <TableCell>
                <Badge variant={stateTone(c.state)}>{c.status || c.state}</Badge>
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function ImagesPanel({ envId }: { envId: string }) {
  const { items: images, error, loading } = useEnvScopedData(envId, listImages);
  const total = images.reduce((n, i) => n + i.size, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Images</CardTitle>
          <CardDescription>Local image store on the selected environment.</CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {formatSize(total)} on disk
        </Badge>
      </CardHeader>
      {error && (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag</TableHead>
            <TableHead>ID</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <SkeletonRows cols={4} />}
          {!loading && !error && images.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-auto py-12 text-center">
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function EnvironmentPicker({
  environments,
  selected,
  onSelect,
  onChanged,
}: {
  environments: Environment[];
  selected: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Environment | null>(null);

  async function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    if (selected === id) onSelect("local");
    await deleteEnvironment(id).catch(() => {});
    onChanged();
  }

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {environments.map((env) => {
        const isSelected = env.id === selected;
        const Icon = env.kind === "local" ? Laptop : Wifi;
        return (
          <button
            key={env.id}
            onClick={() => onSelect(env.id)}
            aria-current={isSelected ? "true" : undefined}
            className={cn(
              "group relative flex min-w-40 items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? "border-foreground/30 bg-accent"
                : "border-border bg-card hover:bg-accent/60",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{env.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {env.kind === "local" ? "localhost" : env.ssh_host}
              </p>
            </div>
            {env.kind === "ssh" && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting(env);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.stopPropagation();
                  e.preventDefault();
                  setDeleting(env);
                }}
                aria-label={`Remove ${env.name}`}
                className="ml-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </span>
            )}
          </button>
        );
      })}

      <button
        onClick={() => setAdding(true)}
        className="flex min-w-40 items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3.5 py-2.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-4" /> Add environment
      </button>

      {adding && (
        <AddEnvironmentDialog
          onClose={() => setAdding(false)}
          onCreated={(env) => {
            setAdding(false);
            onChanged();
            onSelect(env.id);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Remove "${deleting.name}"?`}
          description="LunaGate stops polling this environment. It doesn't touch anything on the remote machine."
          confirmLabel="Remove"
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function AddEnvironmentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (env: Environment) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => ref.current?.showModal(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      onCreated(await createEnvironment(name.trim(), sshHost.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/60"
    >
      <form onSubmit={submit}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">Add environment</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => ref.current?.close()}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-xs text-muted-foreground">
            LunaGate connects using this server's own SSH configuration — its keys and{" "}
            <code className="rounded bg-muted px-1 py-0.5">~/.ssh/config</code>. No password or
            key is entered here; make sure the server can already <code>ssh</code> into the
            target non-interactively.
          </p>
          <Field label="Name" hint="Shown on the card.">
            <Input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Staging"
            />
          </Field>
          <Field
            label="SSH target"
            hint="A bare host works when ~/.ssh/config already defines its User."
          >
            <Input
              required
              className="font-mono"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="10.0.0.5 or deploy@10.0.0.5"
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button type="button" variant="outline" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Connecting…" : "Add environment"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-xl backdrop:bg-black/60"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => ref.current?.close()}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            ref.current?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
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

function NewDeploymentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (d: Deployment) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    image: "",
    replicas: 1,
    env: "",
    ports: "",
  });

  useEffect(() => ref.current?.showModal(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: NewDeployment = {
        name: form.name,
        slug: form.slug,
        image: form.image,
        replicas: Number(form.replicas),
        env: parseEnv(form.env),
        ports: parsePorts(form.ports),
      };
      onCreated(await createDeployment(body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/60"
    >
      <form onSubmit={submit}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">New deployment</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => ref.current?.close()}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Shown in this panel.">
              <Input required value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Slug" hint="Lowercase and hyphens.">
              <Input
                required
                value={form.slug}
                onChange={(e) => set("slug", e.target.value)}
                placeholder="my-app"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field label="Image" hint="Pulled on every redeploy.">
              <Input
                required
                className="font-mono"
                value={form.image}
                onChange={(e) => set("image", e.target.value)}
                placeholder="nginx:latest"
              />
            </Field>
            <Field label="Replicas">
              <Input
                type="number"
                min={0}
                max={50}
                className="tabular"
                value={form.replicas}
                onChange={(e) => set("replicas", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Environment" hint="One KEY=value per line.">
            <Textarea
              value={form.env}
              onChange={(e) => set("env", e.target.value)}
              placeholder={"LOG_LEVEL=info\nPORT=80"}
            />
          </Field>
          <Field label="Ports" hint="One host:container per line.">
            <Textarea
              value={form.ports}
              onChange={(e) => set("ports", e.target.value)}
              placeholder="8080:80"
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button type="button" variant="outline" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create deployment"}
          </Button>
        </div>
      </form>
    </dialog>
  );

  function set(k: keyof typeof form, v: string | number) {
    setForm((f) => ({ ...f, [k]: v }));
  }
}

function WebhookInfo({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
  return (
    <Card className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-md p-4 shadow-xl sm:w-full">
      <div className="mb-1 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">“{deployment.name}” created</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The reconciler starts pulling within a few seconds.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Dismiss">
          <X className="size-4" />
        </Button>
      </div>
      <Separator className="my-3" />
      <p className="mb-2 text-xs text-muted-foreground">
        To redeploy from CI, point a webhook here and sign the body with the secret.
      </p>
      <Label className="text-xs">Webhook URL</Label>
      <code className="mt-1 mb-2.5 block break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
        {webhookURL(deployment.id)}
      </code>
      <Label className="text-xs">Secret</Label>
      <code className="mt-1 block break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
        {deployment.webhook_secret}
      </code>
      <p className="mt-2 text-xs text-muted-foreground">
        This secret is only shown now. Copy it before dismissing.
      </p>
    </Card>
  );
}

function LogsPanel({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(logsURL(deployment.id));
    es.onmessage = (e) => setLines((l) => [...l.slice(-500), e.data]);
    es.onerror = () => setEnded(true);
    return () => es.close();
  }, [deployment.id]);

  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [lines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 p-0 sm:items-center sm:justify-center sm:p-4">
      <Card className="flex h-[80vh] w-full flex-col overflow-hidden rounded-b-none sm:h-[70vh] sm:max-w-3xl sm:rounded-xl">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="truncate">Logs — {deployment.name}</CardTitle>
            <CardDescription>
              {ended ? "Stream ended." : "Following the first running replica."}
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close logs">
            <X className="size-4" />
          </Button>
        </CardHeader>
        <div
          ref={boxRef}
          className="flex-1 overflow-auto bg-background p-3 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="text-muted-foreground">
              {ended ? "No output — the deployment may have no running container." : "Waiting for output…"}
            </p>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {l}
              </div>
            ))
          )}
          {ended && lines.length > 0 && (
            <p className="mt-2 text-muted-foreground">— stream ended —</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
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

function timeAgo(unixSeconds: number) {
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// KEY=value per line -> object. Blank lines ignored.
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

// host:container per line -> Port[]. Blank/invalid lines ignored.
function parsePorts(text: string) {
  const ports = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [host, container] = t.split(":").map((n) => parseInt(n, 10));
    if (host > 0 && container > 0) ports.push({ host, container });
  }
  return ports;
}
