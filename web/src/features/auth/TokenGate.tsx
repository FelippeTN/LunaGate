import { useState, type FormEvent } from "react";
import { clearToken, listDeployments, setToken } from "@/api";
import { Button, Card, Input, Label } from "@/components/ui";

export function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit(e: FormEvent) {
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
          <img src="/lunagate.svg" alt="" className="size-9 rounded-lg" />
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

