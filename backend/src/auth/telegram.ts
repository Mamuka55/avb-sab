/**
 * EPIC AI — Telegram Login Widget.
 *
 * Проверка подписи по официальному алгоритму Telegram:
 *   secret_key = SHA256(bot_token)
 *   data_check_string = отсортированные по ключу пары "k=v" (без hash), через \n
 *   hmac = HMAC_SHA256(data_check_string, secret_key)  ==  hash
 *
 * TELEGRAM_BOT_TOKEN хранится только на backend.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import type { IdentityInput } from '../users/service.js';

export interface TelegramAuthData {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string | number;
  hash: string;
  [key: string]: unknown;
}

export class TelegramAuthError extends Error {
  constructor(message: string, public code = 'telegram_auth_failed') { super(message); }
}

export function verifyTelegramHash(data: TelegramAuthData): { ok: boolean; reason?: string } {
  if (!config.telegram.enabled) return { ok: false, reason: 'Telegram-авторизация отключена на сервере' };
  if (!config.telegram.botToken) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN не задан' };
  if (!data?.hash) return { ok: false, reason: 'Отсутствует hash' };
  if (!data?.id) return { ok: false, reason: 'Отсутствует id' };

  const authDate = Number(data.auth_date ?? 0);
  if (!authDate) return { ok: false, reason: 'Отсутствует auth_date' };
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > config.telegram.hashMaxAge) return { ok: false, reason: 'auth_hash устарел' };
  if (ageSec < -60) return { ok: false, reason: 'auth_date в будущем' };

  const checkString = Object.keys(data)
   .filter((k) => k !== 'hash')
   .sort()
   .map((k) => `${k}=${String(data[k])}`)
   .join('\n');

  const secret = createHash('sha256').update(config.telegram.botToken, 'utf8').digest();
  const hmac = createHmac('sha256', secret).update(checkString, 'utf8').digest();
  const provided = Buffer.from(String(data.hash), 'hex');

  if (provided.length !== hmac.length || !timingSafeEqual(provided, hmac)) {
    return { ok: false, reason: 'Недействительная подпись' };
  }
  return { ok: true };
}

/**
 * Данные, автоматически записываемые в Epic AI :
 * Telegram User ID, username, имя, фамилия, avatar.
 */
export function toIdentity(data: TelegramAuthData): IdentityInput {
  const firstName = data.first_name ? String(data.first_name) : null;
  const lastName = data.last_name ? String(data.last_name) : null;
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || data.username || `tg_${data.id}`;
  return {
    provider: 'telegram',
    providerUserId: String(data.id),
    username: data.username ? String(data.username) : null,
    firstName,
    lastName,
    displayName,
    avatarUrl: data.photo_url ? String(data.photo_url) : null,
    raw: { id: String(data.id), username: data.username ?? null, first_name: firstName, last_name: lastName, auth_date: data.auth_date },
  };
}

/** Скрипт Telegram Login Widget для встраивания в страницу /login. */
export function telegramWidgetScript(onAuthUrl: string): string {
  if (!config.telegram.enabled || !config.telegram.botUsername) return '';
  return `<script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${escapeAttr(config.telegram.botUsername)}"
    data-size="large" data-radius="6" data-userpic="true"
    data-request-access="write"
    data-onauth="onTelegramAuth(user)"
    data-auth-url="${escapeAttr(onAuthUrl)}"></script>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
