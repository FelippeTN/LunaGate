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

export type HostContainer = {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  ports: string[];
  created: number;
  managed: boolean;
  project?: string;
  deployment?: string;
};

export type Image = {
  id: string;
  repo_tags: string[];
  size: number;
  created: number;
};

export type Environment = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  ssh_host?: string;
  created_at?: number;
};

export type ContainerMetrics = {
  container_requests_total: number;
  container_requests_last_minute: number;
  container_average_latency_ms: number;
  last_minute: {
    success: number;
    client_error: number;
    server_error: number;
  };
};

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

export const listHostContainers = (env: string) =>
  req<{ items: HostContainer[] }>(`/host/containers?env=${encodeURIComponent(env)}`).then(
    (d) => d.items,
  );

export const startContainer = (env: string, id: string) =>
  req<unknown>(`/host/containers/${id}/start?env=${encodeURIComponent(env)}`, { method: "POST" });

export const stopContainer = (env: string, id: string) =>
  req<unknown>(`/host/containers/${id}/stop?env=${encodeURIComponent(env)}`, { method: "POST" });

export const restartContainer = (env: string, id: string) =>
  req<unknown>(`/host/containers/${id}/restart?env=${encodeURIComponent(env)}`, { method: "POST" });

export const removeContainer = (env: string, id: string) =>
  req<unknown>(`/host/containers/${id}?env=${encodeURIComponent(env)}`, { method: "DELETE" });

export const listImages = (env: string) =>
  req<{ items: Image[] }>(`/host/images?env=${encodeURIComponent(env)}`).then((d) => d.items);

export const removeImage = (env: string, id: string) =>
  req<unknown>(`/host/images/${id}?env=${encodeURIComponent(env)}`, { method: "DELETE" });

export const listEnvironments = () =>
  req<{ items: Environment[] }>("/environments").then((d) => d.items);

export const getContainerMetrics = () => req<ContainerMetrics>("/container-metrics");

export const createEnvironment = (name: string, sshHost: string, password: string) =>
  req<Environment>("/environments", {
    method: "POST",
    body: JSON.stringify({ name, ssh_host: sshHost, password }),
  });

export const deleteEnvironment = (id: string) =>
  req<null>(`/environments/${id}`, { method: "DELETE" });

// EventSource can't send headers, so the token rides as a query param.
export const logsURL = (id: string) =>
  `/v1/deployments/${id}/logs?token=${encodeURIComponent(getToken())}`;

export const hostLogsURL = (env: string, id: string) =>
  `/v1/host/containers/${id}/logs?env=${encodeURIComponent(env)}&token=${encodeURIComponent(getToken())}`;

export const webhookURL = (id: string) => `${location.origin}/v1/webhooks/${id}`;
