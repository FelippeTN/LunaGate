import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
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
  X,
} from "lucide-react";
import {
  clearToken,
  createDeployment,
  deleteDeployment,
  getToken,
  listDeployments,
  listHostContainers,
  listImages,
  logsURL,
  redeploy,
  setToken,
  webhookURL,
  type Deployment,
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

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("deployments");
  const [navOpen, setNavOpen] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [hostContainers, setHostContainers] = useState<HostContainer[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<Deployment | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);
  const { theme, toggle } = useTheme();

  // One pass fetches everything the shell needs. Host containers carry their
  // deployment label, so replica tallies come from this listing rather than one
  // request per deployment.
  const refresh = useCallback(async () => {
    const [d, c, i] = await Promise.allSettled([
      listDeployments(),
      listHostContainers(),
      listImages(),
    ]);
    if (d.status === "fulfilled") setDeployments(d.value);
    if (c.status === "fulfilled") setHostContainers(c.value);
    if (i.status === "fulfilled") setImages(i.value);
    const failed = [d, c, i].find((r) => r.status === "rejected");
    setError(failed ? (failed as PromiseRejectedResult).reason.message : "");
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const runningByDeployment = new Map<string, number>();
  for (const c of hostContainers) {
    if (!c.deployment || c.state !== "running") continue;
    runningByDeployment.set(c.deployment, (runningByDeployment.get(c.deployment) ?? 0) + 1);
  }
  const desiredReplicas = deployments.reduce((n, d) => n + d.replicas, 0);
  const runningReplicas = deployments.reduce((n, d) => n + (runningByDeployment.get(d.id) ?? 0), 0);
  const runningContainers = hostContainers.filter((c) => c.state === "running").length;

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
                label: "Host containers",
                value: `${runningContainers}/${hostContainers.length}`,
              },
              { label: "Images", value: String(images.length) },
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
          {tab === "containers" && (
            <HostContainersPanel containers={hostContainers} loading={loading} />
          )}
          {tab === "images" && <ImagesPanel images={images} loading={loading} />}
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

function HostContainersPanel({
  containers,
  loading,
}: {
  containers: HostContainer[];
  loading: boolean;
}) {
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
          {!loading && containers.length === 0 && (
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

function ImagesPanel({ images, loading }: { images: DockerImage[]; loading: boolean }) {
  const total = images.reduce((n, i) => n + i.size, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>Images</CardTitle>
          <CardDescription>Local image store on the machine running LunaGate.</CardDescription>
        </div>
        <Badge variant="muted" className="tabular">
          {formatSize(total)} on disk
        </Badge>
      </CardHeader>
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
          {!loading && images.length === 0 && (
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
