import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  HardDrive,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network as NetworkIcon,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  Sun,
  X,
} from "lucide-react";
import {
  deleteDeployment,
  getContainerMetrics,
  listDeployments,
  listEnvironments,
  listHostContainers,
  redeploy,
  type Deployment,
  type Environment,
  type HostContainer,
  type ContainerMetrics,
} from "@/api";
import { Button, Card, Separator } from "@/components/ui";
import { cn } from "@/lib/utils";
import { OverviewPanel, SummaryBar } from "./OverviewPanel";
import {
  ContainerLogsPage,
  DeploymentsPanel,
  HostContainersPanel,
  ImagesPanel,
  NetworksPanel,
  VolumesPanel,
} from "./ResourcePanels";
import { EnvironmentPicker } from "./EnvironmentPicker";
import {
  LogsPanel,
  NewDeploymentDialog,
  WebhookInfo,
} from "./DeploymentDialogs";

const THEME_KEY = "lunagate_theme";

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "dark",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((value) => (value === "dark" ? "light" : "dark")) };
}

type Tab = "overview" | "deployments" | "containers" | "images" | "volumes" | "networks" | "logs";

const TABS: { id: Tab; label: string; icon: typeof Boxes; description: string }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Health and workload across your LunaGate environments.",
  },
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
  {
    id: "volumes",
    label: "Volumes",
    icon: HardDrive,
    description: "Named volumes on this host's Docker store.",
  },
  {
    id: "networks",
    label: "Networks",
    icon: NetworkIcon,
    description: "Docker networks on the selected environment.",
  },
  {
    id: "logs",
    label: "Logs",
    icon: ScrollText,
    description: "Live output from containers on local and SSH environments.",
  },
];

const LOCAL_ENV: Environment = { id: "local", name: "This machine", kind: "local" };

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [localContainers, setLocalContainers] = useState<HostContainer[]>([]);
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<Deployment | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);
  const [overviewRefresh, setOverviewRefresh] = useState(0);
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
    const [d, c, m] = await Promise.allSettled([
      listDeployments(),
      listHostContainers("local"),
      getContainerMetrics(),
    ]);
    if (d.status === "fulfilled") setDeployments(d.value);
    if (c.status === "fulfilled") setLocalContainers(c.value);
    if (m.status === "fulfilled") setMetrics(m.value);
    const failed = [d, c, m].find((r) => r.status === "rejected");
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
  const healthyDeployments = deployments.filter(
    (d) => (runningByDeployment.get(d.id) ?? 0) >= d.replicas,
  ).length;

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
          <img src="/lunagate.svg" alt="" className="size-8 rounded-lg" />
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refresh();
                setOverviewRefresh((value) => value + 1);
              }}
            >
              <RefreshCw className="size-4" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {(tab === "overview" || tab === "deployments") && (
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
              {
                label: "Healthy deployments",
                value: `${healthyDeployments}/${deployments.length}`,
                tone:
                  deployments.length === 0
                    ? "neutral"
                    : healthyDeployments === deployments.length
                      ? "good"
                      : "bad",
              },
              {
                label: "Managed replicas",
                value: `${runningReplicas}/${desiredReplicas}`,
                tone:
                  desiredReplicas === 0
                    ? "neutral"
                    : runningReplicas >= desiredReplicas
                      ? "good"
                      : "bad",
              },
              {
                label: "Local containers",
                value: `${runningContainers}/${localContainers.length}`,
              },
              { label: "Servers", value: String(environments.length) },
            ]}
          />

          {error && (
            <Card className="border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </Card>
          )}

          {tab === "overview" && (
            <OverviewPanel
              deployments={deployments}
              running={runningByDeployment}
              environments={environments}
              localContainers={localContainers}
              metrics={metrics}
              loading={loading}
              refreshKey={overviewRefresh}
            />
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
          {(tab === "containers" ||
            tab === "images" ||
            tab === "volumes" ||
            tab === "networks" ||
            tab === "logs") && (
            <EnvironmentPicker
              environments={environments}
              selected={envId}
              onSelect={setEnvId}
              onChanged={refreshEnvironments}
            />
          )}
          {tab === "containers" && <HostContainersPanel envId={envId} />}
          {tab === "images" && <ImagesPanel envId={envId} />}
          {tab === "volumes" && <VolumesPanel envId={envId} />}
          {tab === "networks" && <NetworksPanel envId={envId} />}
          {tab === "logs" && <ContainerLogsPage key={envId} envId={envId} />}
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

