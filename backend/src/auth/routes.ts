/**
 * EPIC AI — маршруты авторизации.
 *
 * Поток в Electron:
 *   Splash → нет сессии → окно Auth (загружает GET /login)
 *   → «Войти через Discord» (OAuth) / «Войти через Telegram» (Login Widget)
 *   → backend создаёт сессию (cookie в партиции Electron)
 *   → страница /auth/done → main-процесс закрывает окно и открывает оверлей.
 */
import type { FastifyInstance } from 'fastify';
import config from '../config/index.js';
import { getDb, type Row } from '../db/index.js';
import { attachSession, clearSessionCookie, revokeSession, authenticate, assertClientHeader } from './session.js';
import { findOrCreateUserByIdentity, linkIdentity, getUserProfile, serializeUserProfile } from '../users/service.js';
import { computeEffectivePermissions } from '../permissions/catalog.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import * as discord from './discord.js';
import * as telegram from './telegram.js';
import { renderLoginPage, renderDonePage, renderErrorPage } from './pages.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- Страница входа  ---------------- */
  app.get('/login', async (req, reply) => {
    const auth = await authenticate(req);
    if (auth && auth.user.status === 'active') {
      return reply.type('text/html; charset=utf-8').send(renderDonePage('Вы уже вошли', true));
    }
    const state = discord.makeState();
    return reply.type('text/html; charset=utf-8').send(
      renderLoginPage({
        discordEnabled: config.discord.enabled && Boolean(config.discord.clientId && config.discord.clientSecret),
        discordUrl: discord.buildAuthorizeUrl(state),
        telegramEnabled: config.telegram.enabled && Boolean(config.telegram.botUsername && config.telegram.botToken),
        telegramWidget: telegram.telegramWidgetScript(`${config.publicUrl}/auth/telegram`),
        blocked: false,
      }),
    );
  });

  /**
   * POST /login/dev — локальный вход со страницы входа (только development).
   *
   * Зачем: cookie-сессия живёт в партиции Electron, поэтому dev-login через
   * curl клиенту НЕ помогает — вход должен произойти внутри окна Auth.
   * Защищено двумя условиями: NODE_ENV !== production и запрос с loopback.
   * Пользователь должен существовать (создаётся bootstrap'ом) и не быть заблокирован.
   */
  app.post('/login/dev', async (req, reply) => {
    if (config.isProd) return reply.code(404).send({ error: 'not_found', message: 'Маршрут не найден' });
    const ip = String(req.ip ?? '');
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
    if (!loopback) {
      return reply.code(403).send({ error: 'loopback_only', message: 'Локальный вход доступен только с этой машины' });
    }
    const body = (req.body ?? {}) as { username?: string };
    const username = String(body.username ?? '').trim();
    if (!username) return reply.code(400).send({ error: 'bad_request', message: 'Введите имя пользователя' });

    const db = await getDb();
    const user = await db.get<Row>(
      `SELECT u.* FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.username = ? ORDER BY COALESCE(r.level, 0) DESC, u.id ASC LIMIT 1`,
      [username],
    );
    if (!user) {
      return reply.code(404).send({
        error: 'user_not_found',
        message: `Пользователь «${username}» не найден. Создайте: npm run bootstrap:developer -- --local ${username}`,
      });
    }
    if (String(user.status) === 'blocked') {
      return reply.code(403).send({ error: 'blocked', message: 'Аккаунт заблокирован' });
    }
    await attachSession(reply, Number(user.id), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? 'dev-login-form') });
    await audit({
      actorId: Number(user.id), actorName: String(user.username),
      action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: Number(user.id),
      meta: { provider: 'dev-login-form' }, ip: req.ip,
    });
    return reply.redirect('/auth/done');
  });

  app.get('/auth/done', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderDonePage('Вход выполнен', true)));

  /* ---------------- Discord OAuth2 ---------------- */
  app.get('/auth/discord/start', async (req, reply) => {
    if (!config.discord.enabled) return reply.type('text/html; charset=utf-8').code(400).send(renderErrorPage('Discord-авторизация отключена'));
    const state = discord.makeState();
    return reply.redirect(discord.buildAuthorizeUrl(state));
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.error) {
      return reply.type('text/html; charset=utf-8').code(400).send(renderErrorPage(`Discord вернул ошибку: ${q.error}`));
    }
    if (!config.discord.enabled) return reply.type('text/html; charset=utf-8').code(400).send(renderErrorPage('Discord-авторизация отключена'));
    if (!discord.consumeState(q.state)) {
      return reply.type('text/html; charset=utf-8').code(400).send(renderErrorPage('Недействительный state. Попробуйте войти ещё раз.'));
    }
    try {
      const tokens = await discord.exchangeCode(q.code);
      const dUser = await discord.fetchDiscordUser(tokens.access_token);
      const identity = discord.toIdentity(dUser);

      // Если пользователь уже авторизован — привязываем Discord к текущему аккаунту 
      const current = await authenticate(req);
      let userRow: Row;
      let created = false;
      if (current && current.user.status === 'active') {
        await linkIdentity(current.user.id, identity);
        userRow = (await getDb().then((db) => db.get<Row>('SELECT * FROM users WHERE id = ?', [current.user.id])))!;
      } else {
        const r = await findOrCreateUserByIdentity(identity);
        userRow = r.user; created = r.created;
      }

      const userId = Number(userRow.id);
      if (String(userRow.status) === 'blocked') {
        await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN_FAILED, entityType: 'user', entityId: userId, meta: { provider: 'discord', reason: 'blocked' }, ip: req.ip });
        return reply.type('text/html; charset=utf-8').code(403).send(renderErrorPage('Аккаунт заблокирован. Использование Epic AI запрещено.'));
      }

      await attachSession(reply, userId, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: userId, meta: { provider: 'discord', created, discordId: identity.providerUserId }, ip: req.ip });
      return reply.type('text/html; charset=utf-8').send(renderDonePage('Вход выполнен', true));
    } catch (e: any) {
      req.log.error(e);
      return reply.type('text/html; charset=utf-8').code(500).send(renderErrorPage(`Ошибка входа через Discord: ${e.message}`));
    }
  });

  /* ---------------- Telegram Login Widget ---------------- */
  app.get('/auth/telegram', async (req, reply) => {
    const data = (req.query ?? {}) as unknown as telegram.TelegramAuthData;
    const check = telegram.verifyTelegramHash(data);
    if (!check.ok) {
      return reply.type('text/html; charset=utf-8').code(400).send(renderErrorPage(`Telegram-авторизация отклонена: ${check.reason}`));
    }
    const identity = telegram.toIdentity(data);
    const current = await authenticate(req);
    let userRow: Row; let created = false;
    if (current && current.user.status === 'active') {
      await linkIdentity(current.user.id, identity);
      userRow = (await getDb().then((db) => db.get<Row>('SELECT * FROM users WHERE id = ?', [current.user.id])))!;
    } else {
      const r = await findOrCreateUserByIdentity(identity);
      userRow = r.user; created = r.created;
    }
    const userId = Number(userRow.id);
    if (String(userRow.status) === 'blocked') {
      await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN_FAILED, entityType: 'user', entityId: userId, meta: { provider: 'telegram', reason: 'blocked' }, ip: req.ip });
      return reply.type('text/html; charset=utf-8').code(403).send(renderErrorPage('Аккаунт заблокирован. Использование Epic AI запрещено.'));
    }
    await attachSession(reply, userId, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: userId, meta: { provider: 'telegram', created, telegramId: identity.providerUserId }, ip: req.ip });
    return reply.type('text/html; charset=utf-8').send(renderDonePage('Вход выполнен', true));
  });

  app.post('/auth/telegram', async (req, reply) => {
    const data = (req.body ?? {}) as telegram.TelegramAuthData;
    const check = telegram.verifyTelegramHash(data);
    if (!check.ok) return reply.code(401).send({ error: 'telegram_auth_failed', message: check.reason });
    const identity = telegram.toIdentity(data);
    const current = await authenticate(req);
    let userRow: Row; let created = false;
    if (current && current.user.status === 'active') {
      await linkIdentity(current.user.id, identity);
      userRow = (await getDb().then((db) => db.get<Row>('SELECT * FROM users WHERE id = ?', [current.user.id])))!;
    } else {
      const r = await findOrCreateUserByIdentity(identity);
      userRow = r.user; created = r.created;
    }
    const userId = Number(userRow.id);
    if (String(userRow.status) === 'blocked') return reply.code(403).send({ error: 'blocked', message: 'Аккаунт заблокирован' });
    await attachSession(reply, userId, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: userId, meta: { provider: 'telegram', created }, ip: req.ip });
    return reply.send({ ok: true, userId });
  });

  /* ---------------- API сессии ---------------- */

  /**
   * GET /api/auth/me — текущий пользователь + роль + permissions.
   * Используется splash-экраном.
   */
  app.get('/api/auth/me', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ authenticated: false });
    if (auth.user.status === 'blocked') {
      const profile = await getUserProfile(auth.user.id);
      return reply.code(403).send({
        authenticated: true,
        blocked: true,
        message: 'Аккаунт заблокирован',
        user: profile ? { id: profile.id, username: profile.username, blockedReason: profile.blockedReason } : null,
      });
    }
    const profile = await getUserProfile(auth.user.id);
    return reply.send({
      authenticated: true,
      blocked: false,
      user: profile ? serializeUserProfile(profile) : auth.user,
      permissions: [...auth.permissions.codes].sort(),
      permissionsDetail: { fromRoles: auth.permissions.fromRoles, extra: auth.permissions.extra, denied: auth.permissions.denied },
      maxRoleLevel: auth.permissions.maxLevel,
      isDeveloper: auth.permissions.isDeveloper,
    });
  });

  /** POST /api/auth/logout */
  app.post('/api/auth/logout', async (req, reply) => {
    assertClientHeader(req);
    const auth = await authenticate(req);
    if (auth) {
      await revokeSession(auth.sessionId, 'logout');
      await audit({ actorId: auth.user.id, actorName: auth.user.username, action: AUDIT_ACTIONS.LOGOUT, entityType: 'user', entityId: auth.user.id, ip: req.ip });
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  /** GET /api/auth/providers — какие способы входа включены (для страницы Auth). */
  app.get('/api/auth/providers', async (_req, reply) => reply.send({
    discord: config.discord.enabled && Boolean(config.discord.clientId),
    telegram: config.telegram.enabled && Boolean(config.telegram.botUsername),
    devLogin: !config.isProd,
    // Имя cookie нужно Electron'у, чтобы найти токен сессии в своей партиции
    // и отдать его renderer'у через IPC (см. epic:session:token).
    sessionCookie: config.session.cookie,
  }));

  /**
   * POST /api/auth/dev-login — локальный вход БЕЗ OAuth, только для разработки.
   * Работает лишь когда NODE_ENV !== 'production' и передан SESSION_SECRET.
   * Пользователя создаёт `npm run bootstrap:developer -- --local <name>`.
   */
  app.post('/api/auth/dev-login', async (req, reply) => {
    if (config.isProd) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { token?: string; userId?: number; username?: string };
    if (!config.session.secret || config.session.secret === 'change-me') {
      return reply.code(403).send({ error: 'dev_login_disabled', message: 'Задайте SESSION_SECRET в backend/.env' });
    }
    if (String(body.token ?? '') !== config.session.secret) {
      return reply.code(403).send({ error: 'invalid_token', message: 'Неверный токен разработчика' });
    }

    const db = await getDb();
    let user: Row | null = null;
    if (body.userId) user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [Number(body.userId)]);
    else if (body.username) {
      // При совпадении имён берём пользователя с наивысшей ролью:
      // это делает dev-login предсказуемым для bootstrap-аккаунта разработчика.
      user = await db.get<Row>(
        `SELECT u.* FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.username = ?
          ORDER BY COALESCE(r.level, 0) DESC, u.id ASC LIMIT 1`,
        [String(body.username)],
      );
      if (!user) {
        // возможно, пользователь уже создан bootstrap'ом с другой идентичностью
        user = await db.get<Row>(
          `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id
            WHERE i.provider = 'discord' AND i.provider_user_id = ?`,
          [`local-${String(body.username)}`],
        );
      }
      if (!user) {
        // возможно, пользователь уже создан bootstrap'ом с другой идентичностью
        user = await db.get<Row>(
          `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id
            WHERE i.provider = 'discord' AND i.provider_user_id = ?`,
          [`local-${String(body.username)}`],
        );
      }
      if (!user) {
        // создаём локального тестового пользователя с ролью Игрок
        const { findOrCreateUserByIdentity } = await import('../users/service.js');
        const r = await findOrCreateUserByIdentity({
          provider: 'discord',
          providerUserId: `local-${String(body.username)}`,
          username: String(body.username),
          displayName: String(body.username),
        });
        user = r.user;
      }
    }
    if (!user) return reply.code(404).send({ error: 'user_not_found', message: 'Создайте пользователя: npm run bootstrap:developer -- --local <name>' });
    if (String(user.status) === 'blocked') return reply.code(403).send({ error: 'blocked', message: 'Аккаунт заблокирован' });

    await attachSession(reply, Number(user.id), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? 'dev-login') });
    await audit({ actorId: Number(user.id), actorName: String(user.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: Number(user.id), meta: { provider: 'dev-login' }, ip: req.ip });
    return reply.send({ ok: true, userId: Number(user.id), username: String(user.username) });
  });
}

/** Вспомогательный: получить профиль + permissions по userId (используется в admin). */
export async function loadAuthContext(userId: number) {
  const db = await getDb();
  const user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const permissions = await computeEffectivePermissions(db, userId);
  return { user, permissions };
}
