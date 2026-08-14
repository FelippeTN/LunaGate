import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import {
  createDeployment,
  logsURL,
  webhookURL,
  type Deployment,
  type NewDeployment,
} from "@/api";
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Textarea,
} from "@/components/ui";
import { Field } from "@/components/Field";

export function NewDeploymentDialog({
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

  async function submit(e: FormEvent) {
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

export function WebhookInfo({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
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

export function LogsPanel({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
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

