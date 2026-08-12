// Thin API client. The admin bearer token lives in localStorage.
const TOKEN_KEY = "lunagate_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export type Deployment = {
  id: string;
  name: string;
  slug: string;
  image: string;
  replicas: number;
  env: string; // JSON string
  ports: string; // JSON string
  webhook_secret?: string;
  created_at: number;
  updated_at: number;
};

export type Container = { id: string; state: string; image: string };

export type Port = { container: number; host: number };

export type NewDeployment = {
  name: string;
  slug: string;
  image: string;
  replicas: number;
  env: Record<string, string>;
  ports: Port[];
};

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch("/v1" + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

export const listDeployments = () =>
  req<{ items: Deployment[] }>("/deployments").then((d) => d.items);

export const createDeployment = (body: NewDeployment) =>
  req<Deployment>("/deployments", { method: "POST", body: JSON.stringify(body) });

export const deleteDeployment = (id: string) =>
  req<null>(`/deployments/${id}`, { method: "DELETE" });

export const redeploy = (id: string) =>
  req<unknown>(`/deployments/${id}/redeploy`, { method: "POST" });

export const listContainers = (id: string) =>
  req<{ items: Container[] }>(`/deployments/${id}/containers`).then((d) => d.items);

// EventSource can't send headers, so the token rides as a query param.
export const logsURL = (id: string) =>
  `/v1/deployments/${id}/logs?token=${encodeURIComponent(getToken())}`;

export const webhookURL = (id: string) => `${location.origin}/v1/webhooks/${id}`;
