import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from './config.ts';
import { HttpError, forbidden } from './http.ts';
import { type ApiToken, type User, createSession, isApiToken, sessionUser, tokenUser } from './users.ts';

export type Env = {
  Variables: {
    user: User;
    token?: ApiToken;
    sessionToken?: string;
  };
};

export const COOKIE = config.secure ? '__Host-switchboard_session' : 'switchboard_session';
/** The cookie's name before the rename to Switchboard; still read so nobody is signed out. */
const LEGACY_COOKIE = config.secure ? '__Host-hub_session' : 'hub_session';

export function sessionCookie(c: Context): string | undefined {
  return getCookie(c, COOKIE) ?? getCookie(c, LEGACY_COOKIE);
}

export function startSession(c: Context, userId: string) {
  const token = createSession(userId);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.sessionTtlSecs,
  });
  return token;
}

export function endSession(c: Context) {
  deleteCookie(c, COOKIE, { path: '/', secure: config.secure });
  deleteCookie(c, LEGACY_COOKIE, { path: '/', secure: config.secure });
}

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  // X-Hub-Token is the header's name from before the rename to Switchboard.
  return c.req.header('x-switchboard-token') ?? c.req.header('x-hub-token') ?? undefined;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves the caller from an API token or the session cookie. */
export function identify(c: Context<Env>): boolean {
  const secret = bearer(c);
  if (isApiToken(secret)) {
    const found = tokenUser(secret);
    if (!found) throw new HttpError(401, 'Invalid or expired API token');
    // Tokens an MCP client got through OAuth are bound to the MCP endpoint (RFC 8707 audience).
    if (found.token.audience === 'mcp') throw new HttpError(401, 'This token is only valid for the MCP endpoint');
    c.set('user', found.user);
    c.set('token', found.token);
    return true;
  }
  const session = sessionCookie(c);
  if (!session) return false;
  const user = sessionUser(session);
  if (!user) return false;
  // Cookies are sent cross-site on top-level navigations, so state-changing requests must come from our own pages.
  const site = c.req.header('sec-fetch-site');
  if (!SAFE.has(c.req.method)) {
    const origin = c.req.header('origin');
    const ok = site ? site === 'same-origin' : origin === new URL(config.publicUrl).origin;
    if (!ok) throw forbidden('Cross-site request blocked');
  } else if (c.req.path.startsWith('/proxy/') && site && site !== 'same-origin' && site !== 'none') {
    // Some APIs have GET endpoints with side effects; other sites must not trigger them.
    throw forbidden('Cross-site request blocked');
  }
  c.set('user', user);
  c.set('sessionToken', session);
  return true;
}

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  if (!identify(c)) throw new HttpError(401, 'Sign in or pass an API token');
  await next();
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('user')?.role !== 'admin') throw forbidden('Administrators only');
  if (c.get('token')?.connectionIds) throw forbidden('This token is limited to specific connections');
  await next();
};

/** Tokens limited to specific connections may only use those connections. */
export const requireFullAccess: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('token')?.connectionIds) throw forbidden('This token is limited to specific connections');
  await next();
};

export function assertConnectionAccess(c: Context<Env>, connectionId: string) {
  const ids = c.get('token')?.connectionIds;
  if (ids && !ids.includes(connectionId)) throw forbidden('This token cannot use that connection');
}

// Very small brute-force protection for the login form.
const failures = new Map<string, { count: number; until: number }>();

export function loginAllowed(key: string) {
  const f = failures.get(key);
  return !f || f.count < 5 || f.until < Date.now();
}

export function loginFailed(key: string) {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  if (f.until < Date.now() && f.count >= 5) f.count = 0;
  f.count++;
  f.until = Date.now() + 60_000 * Math.min(15, 2 ** Math.max(0, f.count - 5));
  failures.set(key, f);
}

export function loginSucceeded(key: string) {
  failures.delete(key);
}
