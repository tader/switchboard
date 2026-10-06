export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const unauthorized = new EventTarget();

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
    signal: opts.signal,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorized.dispatchEvent(new Event('401'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  disabled: boolean;
  hasPassword: boolean;
  createdAt: number;
}

export interface Field {
  key: string;
  label: string;
  type?: 'text' | 'secret' | 'url' | 'textarea' | 'select' | 'boolean';
  description?: string;
  placeholder?: string;
  required?: boolean;
  default?: string | boolean;
  options?: { value: string; label: string }[];
  advanced?: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  fields: Field[];
  unavailable?: string;
}

export interface Service {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  docsUrl?: string;
  pluginId: string;
  methods: AuthMethod[];
  /** Setup guides for this service. */
  guides: { id: string; title: string }[];
}

export interface Connection {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  methodId: string;
  methodName: string;
  account: { id?: string; label: string; avatarUrl?: string } | null;
  config: Record<string, any>;
  status: 'ok' | 'error' | 'unavailable';
  statusMessage: string | null;
  baseUrl: string | null;
  hasOpenapi: boolean;
  canIssueToken: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export type FlowResult =
  | { status: 'connected'; connection: Connection }
  | { status: 'redirect'; flowId: string; url: string }
  | { status: 'device'; flowId: string; device: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn?: number; interval: number } };

export interface Pair {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface SavedCall {
  id: string;
  name: string;
  connectionId: string | null;
  method: string;
  url: string;
  pathParams: Record<string, string>;
  query: Pair[];
  headers: Pair[];
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface CallResult {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  durationMs: number;
  size: number;
  bodyEncoding: 'utf8' | 'base64';
  body: string;
  /** What Switchboard sent upstream; credentials it added are masked. */
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string; byHub: boolean }[];
    retried: boolean;
    body: string;
    bodyEncoding: 'utf8' | 'base64';
    size: number;
    truncated: boolean;
  };
}

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  type?: string;
  enum?: string[];
  example?: string;
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tag: string;
  deprecated?: boolean;
  params: Param[];
  body?: { contentType: string; example?: string; required: boolean };
}

export interface ApiDescription {
  title?: string;
  version?: string;
  server: string;
  operations: Operation[];
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  connectionIds: string[] | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  audience: string | null;
  clientName: string | null;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  dependencies: string[];
  dependents: string[];
  origin: 'builtin' | 'installed';
  overridesBuiltin: boolean;
  source?: { type: 'github'; repo: string; ref?: string; path: string; commit: string };
  enabled: boolean;
  status: 'active' | 'error' | 'disabled' | 'blocked';
  error?: string;
  hasSettings: boolean;
  services: { id: string; name: string; methods: { id: string; name: string; unavailable?: string }[] }[];
  icon?: string;
  loadedAt?: number;
  logs?: { at: number; level: string; message: string }[];
}

export interface AdminUser extends User {
  connections: number;
  inviteExpiresAt: number | null;
}

export interface Info {
  publicUrl: string;
  callbackUrl: string;
}
