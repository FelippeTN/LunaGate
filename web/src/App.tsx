import { useEffect, useRef, useState } from "react";
import { Boxes, LogOut, Plus, RefreshCw, ScrollText, Trash2, X } from "lucide-react";
import {
  clearToken,
  createDeployment,
  deleteDeployment,
  getToken,
  listContainers,
  listDeployments,
  logsURL,
  redeploy,
  setToken,
  webhookURL,
  type Container,
  type Deployment,
  type NewDeployment,
} from "@/api";
import { Badge, Button, Card, Input, Label, Textarea } from "@/components/ui";

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;
  return <Dashboard onLogout={() => { clearToken(); setAuthed(false); }} />;
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-2">
          <Boxes className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">LunaGate</h1>
        </div>
        <p className="mb-4 text-sm text-muted">Enter your admin token to continue.</p>
        <Input
          type="password"
          placeholder="LUNAGATE_ADMIN_TOKEN"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Button className="mt-4 w-full" onClick={submit} disabled={value.length < 1}>
          Continue
        </Button>
      </Card>
    </div>
  );
  function submit() {
    setToken(value.trim());
    onDone();
  }
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<Deployment | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);

  async function refresh() {
    try {
      const items = await listDeployments();
      setDeployments(items);
      setError("");
      const entries = await Promise.all(
        items.map(async (d) => {
          const c = await listContainers(d.id).catch(() => [] as Container[]);
          return [d.id, c.filter((x) => x.state === "running").length] as const;
        }),
      );
      setCounts(Object.fromEntries(entries));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Boxes className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">LunaGate</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New deployment
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      {error && (
        <Card className="mb-4 border-destructive p-3 text-sm text-destructive">{error}</Card>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted">
            <tr>
              <th className="p-3 font-medium">Name</th>
              <th className="p-3 font-medium">Image</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {deployments.length === 0 && (
              <tr>
                <td colSpan={4} className="p-8 text-center text-muted">
                  No deployments yet. Create one to get started.
                </td>
              </tr>
            )}
            {deployments.map((d) => {
              const running = counts[d.id] ?? 0;
              const healthy = running >= d.replicas;
              return (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{d.name}</td>
                  <td className="p-3 font-mono text-xs text-muted">{d.image}</td>
                  <td className="p-3">
                    <Badge className={healthy ? "text-primary" : "text-destructive"}>
                      {running}/{d.replicas} running
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => setLogsFor(d)}>
                        <ScrollText className="size-4" /> Logs
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => onRedeploy(d)}>
                        <RefreshCw className="size-4" /> Redeploy
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(d)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

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

  async function onRedeploy(d: Deployment) {
    await redeploy(d.id).catch((e) => setError((e as Error).message));
    refresh();
  }
  async function onDelete(d: Deployment) {
    if (!confirm(`Delete deployment "${d.name}" and its containers?`)) return;
    await deleteDeployment(d.id).catch((e) => setError((e as Error).message));
    refresh();
  }
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
    try {
      const body: NewDeployment = {
        name: form.name,
        slug: form.slug,
        image: form.image,
        replicas: Number(form.replicas),
        env: parseEnv(form.env),
        ports: parsePorts(form.ports),
      };
      const d = await createDeployment(body);
      onCreated(d);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-lg rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
    >
      <form onSubmit={submit} className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New deployment</h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => ref.current?.close()}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="space-y-3">
          <Field label="Name">
            <Input required value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Slug (lowercase, hyphens)">
            <Input required value={form.slug} onChange={(e) => set("slug", e.target.value)} placeholder="my-app" />
          </Field>
          <Field label="Image">
            <Input required value={form.image} onChange={(e) => set("image", e.target.value)} placeholder="nginx:latest" />
          </Field>
          <Field label="Replicas">
            <Input type="number" min={0} max={50} value={form.replicas} onChange={(e) => set("replicas", e.target.value)} />
          </Field>
          <Field label="Env (KEY=value per line)">
            <Textarea value={form.env} onChange={(e) => set("env", e.target.value)} placeholder={"LOG_LEVEL=info\nPORT=80"} />
          </Field>
          <Field label="Ports (host:container per line)">
            <Textarea value={form.ports} onChange={(e) => set("ports", e.target.value)} placeholder={"8080:80"} />
          </Field>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button type="submit">Create</Button>
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
    <Card className="fixed bottom-4 right-4 z-50 max-w-md p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Deployment created</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <p className="mb-2 text-sm text-muted">
        Point a GitHub push webhook (content-type JSON) at this URL, using the secret below for
        signature verification:
      </p>
      <Label>Webhook URL</Label>
      <code className="mb-2 block break-all rounded bg-background p-2 text-xs">{webhookURL(deployment.id)}</code>
      <Label>Secret</Label>
      <code className="block break-all rounded bg-background p-2 text-xs">{deployment.webhook_secret}</code>
    </Card>
  );
}

function LogsPanel({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(logsURL(deployment.id));
    es.onmessage = (e) => setLines((l) => [...l.slice(-500), e.data]);
    es.onerror = () => setLines((l) => [...l, "— log stream ended —"]);
    return () => es.close();
  }, [deployment.id]);

  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [lines]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 sm:items-center sm:justify-center">
      <Card className="flex h-[70vh] w-full flex-col sm:max-w-3xl">
        <div className="flex items-center justify-between border-b border-border p-3">
          <h3 className="font-semibold">Logs — {deployment.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div ref={boxRef} className="flex-1 overflow-auto bg-background p-3 font-mono text-xs">
          {lines.length === 0 ? (
            <span className="text-muted">Waiting for output…</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
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
