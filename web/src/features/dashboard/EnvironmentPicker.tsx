import { useEffect, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Laptop, Plus, Trash2, Wifi, X } from "lucide-react";
import {
  createEnvironment,
  deleteEnvironment,
  type Environment,
} from "@/api";
import { Button, Input } from "@/components/ui";
import { Field } from "@/components/Field";
import { cn } from "@/lib/utils";

export function EnvironmentPicker({
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
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => ref.current?.showModal(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      onCreated(await createEnvironment(name.trim(), sshHost.trim(), password));
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
            Use the server's SSH key/config, or enter the account password below. Passwords are
            encrypted before being stored and are never returned by the API.
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
          <Field
            label="SSH password (optional)"
            hint="For password login, include the user in the target: user@host."
          >
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to use an SSH key"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
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

