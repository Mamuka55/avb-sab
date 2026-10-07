/**
 * EPIC AI — серверные страницы авторизации.
 * Отдаются backend'ом и показываются в отдельном окне Electron «Auth».
 * Стили — инлайновые, чтобы не зависеть от внешних ресурсов.
 */
import { COLORS, GLASS } from '../shared.js';

const base = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://telegram.org; connect-src 'self' https://api.telegram.org; img-src https: data:; frame-src https://oauth.telegram.org;" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: ${COLORS.bgBase};
    color: ${COLORS.textPrimary};
    font-family: "Segoe UI", "Inter", system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; user-select: none;
  }
 .card {
    width: 420px; padding: 34px 32px 28px;
    background: ${GLASS.panel};
    border: 1px solid ${GLASS.stroke};
    border-radius: 14px;
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
    text-align: center;
  }
 .logo { font-size: 26px; font-weight: 700; letter-spacing:.18em; }
 .logo b { color: ${COLORS.accent}; font-weight: 700; }
 .sub { margin-top: 8px; font-size: 12px; color: ${COLORS.textMuted}; letter-spacing:.04em; }
 .divider { height: 1px; background: ${GLASS.stroke}; margin: 24px 0 20px; }
 .btn {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; height: 44px; margin-bottom: 12px;
    border-radius: 10px; border: 1px solid ${GLASS.stroke};
    background: ${COLORS.bgSurface}; color: ${COLORS.textPrimary};
    font-size: 13px; font-weight: 600; letter-spacing:.06em;
    text-decoration: none; cursor: pointer; transition:.16s ease;
  }
 .btn:hover { border-color: ${COLORS.accentBright}; color: ${COLORS.accentBright}; }
 .btn.discord:hover { border-color: #5865F2; color: #8b95ff; }
 .btn.telegram:hover { border-color: #2AABEE; color: #58c6f5; }
 .btn svg { width: 18px; height: 18px; flex: none; }
 .foot { margin-top: 20px; font-size: 11px; color: ${COLORS.textSubtle}; line-height: 1.6; }
 .ok { color: ${COLORS.accent}; font-size: 34px; margin-bottom: 10px; }
 .err { color: ${COLORS.danger}; font-size: 30px; margin-bottom: 10px; }
 .msg { font-size: 13px; color: ${COLORS.textMuted}; line-height: 1.6; }
 .disabled { opacity:.38; pointer-events: none; }
  #tg-wrap { display:flex; justify-content:center; min-height: 46px; }
</style>
</head>
<body>
  ${body}
</body>
</html>`;

const discordIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.336 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0.031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1.078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0.084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;

const telegramIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;

export interface LoginPageOptions {
  discordEnabled: boolean;
  discordUrl: string;
  telegramEnabled: boolean;
  telegramWidget: string;
  blocked?: boolean;
}

export function renderLoginPage(o: LoginPageOptions): string {
  const noProviders = !o.discordEnabled && !o.telegramEnabled;
  return base('EPIC AI — Вход', `
  <div class="card">
    <div class="logo">EPIC <b>AI</b></div>
    <div class="sub">Официальный помощник EpicRP</div>
    <div class="divider"></div>

    ${o.discordEnabled
      ? `<a class="btn discord" href="${o.discordUrl}">${discordIcon} ВОЙТИ ЧЕРЕЗ DISCORD</a>`
      : `<div class="btn discord disabled">${discordIcon} DISCORD НЕ НАСТРОЕН</div>`}

    ${o.telegramEnabled
      ? `<div id="tg-wrap">${o.telegramWidget}</div>`
      : `<div class="btn telegram disabled">${telegramIcon} TELEGRAM НЕ НАСТРОЕН</div>`}

    ${noProviders
      ? `<div class="msg" style="margin-top:14px;color:${COLORS.warning}">
           Ни один способ входа не настроен.<br>
           Заполните DISCORD_* или TELEGRAM_* в <b>backend/.env</b>.
         </div>`
      : ''}

  </div>
  <script>
    window.onTelegramAuth = function (user) {
      var q = new URLSearchParams();
      Object.keys(user).forEach(function (k) { q.set(k, user[k]); });
      location.href = '/auth/telegram?' + q.toString();
    };
  </script>`);
}

export function renderDonePage(message: string, autoClose: boolean): string {
  return base('EPIC AI', `
  <div class="card">
    <div class="ok">✓</div>
    <div class="logo" style="font-size:20px">EPIC <b>AI</b></div>
    <div class="divider"></div>
    <div class="msg">${message}</div>
    <div class="foot">${autoClose ? 'Окно закроется автоматически…' : ''}</div>
  </div>
  ${autoClose ? `<script>
    (function () {
      try { if (window.opener) window.opener.postMessage({ type: 'epic-ai:auth-success' }, '*'); } catch (e) {}
      setTimeout(function () { try { window.close(); } catch (e) {} }, 900);
    })();
  </script>` : ''}`);
}

export function renderErrorPage(message: string): string {
  return base('EPIC AI — Ошибка', `
  <div class="card">
    <div class="err">✕</div>
    <div class="logo" style="font-size:20px">EPIC <b>AI</b></div>
    <div class="divider"></div>
    <div class="msg" style="color:${COLORS.warning}">${message}</div>
    <div class="divider"></div>
    <a class="btn" href="/login">ВЕРНУТЬСЯ КО ВХОДУ</a>
  </div>`);
}
