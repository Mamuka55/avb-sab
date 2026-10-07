/**
 * EPIC AI — Discord OAuth2.
 *
 * Секреты (DISCORD_CLIENT_SECRET) остаются только на backend.
 * Electron открывает /login в отдельном окне, Discord редиректит на backend,
 * backend создаёт сессию и отдаёт страницу-«успех», которая закрывает окно.
 */
import { createHash, randomBytes } from 'node:crypto';
import config from '../config/index.js';
import type { IdentityInput } from '../users/service.js';

const AUTH_BASE = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';
const CDN = 'https://cdn.discordapp.com';

const SCOPES = ['identify'];

/** Кратковременное хранилище state (защита от CSRF в OAuth). */
const states = new Map<string, number>();

export function makeState(): string {
  const s = randomBytes(16).toString('hex');
  states.set(s, Date.now() + 10 * 60_000);
  for (const [k, exp] of states) if (exp < Date.now()) states.delete(k);
  return s;
}

export function consumeState(s: string | undefined | null): boolean {
  if (!s) return false;
  const exp = states.get(s);
  if (!exp) return false;
  states.delete(s);
  return exp > Date.now();
}

export function buildAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Discord token exchange failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
  email?: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed (${res.status})`);
  return (await res.json()) as DiscordUser;
}

/**
 * Данные, которые автоматически записываются в Epic AI :
 * User ID, username/display name, avatar.
 */
export function toIdentity(u: DiscordUser): IdentityInput {
  const avatarUrl = u.avatar
    ? `${CDN}/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `${CDN}/embed/avatars/${Number(u.discriminator ?? 0) % 5}.png`;
  const displayName = u.global_name || u.display_name || u.username;
  return {
    provider: 'discord',
    providerUserId: u.id,
    username: u.username,
    displayName,
    avatarUrl,
    raw: { id: u.id, username: u.username, global_name: u.global_name ?? null, discriminator: u.discriminator ?? null },
  };
}

export const discordFingerprint = (userId: string): string => createHash('sha256').update(`discord:${userId}`).digest('hex').slice(0, 16);
