import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { COOKIE, type Env, endSession, loginAllowed, loginFailed, loginSucceeded, requireFullAccess, requireUser, startSession } from '../auth.ts';
import { HttpError, badRequest } from '../http.ts';
import {
  acceptInvite, checkLogin, createToken, deleteOtherSessions, deleteSession, deleteToken, inviteUser, listTokens, setPassword, updateToken,
} from '../users.ts';
import { verifyPassword } from '../crypto.ts';
import { one } from '../db.ts';
import { listConnections } from '../connections.ts';
import { callbackUrl, config } from '../config.ts';

export const account = new Hono<Env>();

account.get('/info', (c) => c.json({ publicUrl: config.publicUrl, callbackUrl }));

account.post('/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  const key = `${(username ?? '').toLowerCase()}|${c.req.header('x-forwarded-for')?.split(',')[0] ?? ''}`;
  if (!loginAllowed(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const user = username && password ? checkLogin(username, password) : undefined;
  if (!user) {
    loginFailed(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  loginSucceeded(key);
  startSession(c, user.id);
  return c.json(user);
});

account.post('/auth/logout', (c) => {
  const cookie = getCookie(c, COOKIE);
  if (cookie) deleteSession(cookie);
  endSession(c);
  return c.json({ ok: true });
});

account.get('/auth/invite/:token', (c) => {
  const user = inviteUser(c.req.param('token'));
  if (!user) throw badRequest('This link is invalid or has expired');
  return c.json({ username: user.username, hasPassword: user.hasPassword });
});

account.post('/auth/invite', async (c) => {
  const { token, password } = await c.req.json<{ token: string; password: string }>();
  const user = acceptInvite(token, password ?? '');
  startSession(c, user.id);
  return c.json(user);
});

account.use('/me', requireUser);
account.use('/me/*', requireUser);
account.use('/tokens', requireUser, requireFullAccess);
account.use('/tokens/*', requireUser, requireFullAccess);

account.get('/me', (c) => {
  const token = c.get('token');
  return c.json({ ...c.get('user'), token: token ? { id: token.id, name: token.name, connectionIds: token.connectionIds } : undefined });
});

account.put('/me/password', requireFullAccess, async (c) => {
  const { current, password } = await c.req.json<{ current: string; password: string }>();
  const user = c.get('user');
  const row = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!verifyPassword(current ?? '', row?.password_hash ?? null)) throw badRequest('Your current password is not correct');
  setPassword(user.id, password ?? '');
  deleteOtherSessions(user.id, c.get('sessionToken'));
  return c.json({ ok: true });
});

account.get('/tokens', (c) => c.json(listTokens(c.get('user').id)));

function checkConnectionIds(userId: string, ids: unknown): string[] | null {
  if (ids === null || ids === undefined) return null;
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Choose at least one connection');
  const own = new Set(listConnections(userId).map((x) => x.id));
  for (const id of ids) if (!own.has(id)) throw badRequest(`Unknown connection ${id}`);
  return ids as string[];
}

account.post('/tokens', async (c) => {
  const body = await c.req.json<{ name: string; connectionIds?: string[] | null; expiresInDays?: number | null }>();
  const user = c.get('user');
  return c.json(createToken(user.id, body.name ?? '', checkConnectionIds(user.id, body.connectionIds), body.expiresInDays), 201);
});

account.patch('/tokens/:id', async (c) => {
  const body = await c.req.json<{ name?: string; connectionIds?: string[] | null }>();
  const user = c.get('user');
  const patch: { name?: string; connectionIds?: string[] | null } = { name: body.name };
  if ('connectionIds' in body) patch.connectionIds = checkConnectionIds(user.id, body.connectionIds);
  return c.json(updateToken(user.id, c.req.param('id'), patch));
});

account.delete('/tokens/:id', (c) => {
  deleteToken(c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});
