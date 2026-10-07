/**
 * EPIC AI — логика основной панели.
 *
 * Поведение оверлея:
 *  — без запроса приложение представляет собой только горизонтальную панель;
 *  — после запроса окно источников открывается ОТДЕЛЬНО справа;
 *  — ответ AI: вердикт / объяснение / основание / источники;
 *  — 👍 / 👎 под ответом, форма ошибки при дизлайке;
 *  — настройки разворачивают панель вниз; ответ и настройки не показываются вместе.
 */
import { el, clear, $, toast, openExternal, initials, streamerName, streamerAvatarNode } from './util.js';
import { Ai, Kb, Auth, Settings as SettingsApi, setBackendUrl, ApiError, initAuth } from './api.js';
import { initSettings, renderSettings, applyVisualSettings } from './settings.js';
import { buildUpdatesView, buildHistoryView } from './kbview.js';

const COLLAPSED = 56;
// Ответ должен помещаться ЦЕЛИКОМ: предел поднят до 2000 px — окно растёт
// под любой ответ (выше экрана всё равно не уйдёт: main process клампует
// высоту по workArea). Раньше было 1200, и длинные ответы обрезались.
const MAX_EXPANDED = 2000;

const state = {
  user: null,
  permissions: [],
  isDeveloper: false,
  settings: {},
  serverSettings: {},
  mode: 'rules',
  busy: false,
  pane: 'none',            // none | answer | settings
  menuOpen: false,         // раскрыто ли выпадающее меню пользователя
  section: 'main',
  updatesDay: null,
  kbTab: 'updates',        // pane-kb: 'updates' | 'history'
  kbDay: null,
  answer: null,
  vote: null,
  categories: [],
  runtime: null,
};

/* ------------------------------------------------------------------ */
/*  Инициализация                                                       */
/* ------------------------------------------------------------------ */

async function boot() {
  // Токен сессии — до первых запросов к API (file:// не отправляет cookie)
  await initAuth();
  bindChrome();
  bindModes();
  bindQuery();
  bindExpander();

  // Данные из main process: backendUrl, пользователь, локальные настройки
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  state.runtime = runtime;
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);
  if (runtime?.settings) {
    state.settings = runtime.settings;
    applyVisualSettings(state.settings);
    syncPin();
  }

  window.epicAI?.on('main:init', (payload) => {
    if (!payload) return;
    state.user = payload.user;
    state.permissions = payload.permissions ?? [];
    state.isDeveloper = Boolean(payload.isDeveloper);
    if (payload.backendUrl) setBackendUrl(payload.backendUrl);
    if (payload.settings) { state.settings = payload.settings; applyVisualSettings(payload.settings); syncPin(); }
    applyIdentity();
    void syncServerSettings();
    void refreshKbChip();
  });

  window.epicAI?.on('main:open-settings', (open) => {
    if (open) openPane('settings'); else openPane('none');
  });

  // База знаний из других окон (админка, tray, IPC epic:kb:open)
  window.epicAI?.on('main:open-kb', ({ tab, day } = {}) => {
    state.kbTab = tab === 'history' ? 'history' : 'updates';
    state.kbDay = typeof day === 'string' ? day : null;
    openPane('kb');
  });

  // Клик по записи в окне истории → открыть старый ответ в панели
  window.epicAI?.on('main:open-history-item', (id) => {
    if (Number.isFinite(id)) void openHistoryItem(id);
  });

  window.epicAI?.on('settings:changed', (s) => {
    state.settings = {...state.settings,...s };
    applyVisualSettings(state.settings);
    applyIdentity();   // стример-режим меняет ник в пилюле
    syncPin();         // глобальное сочетание Ctrl+P меняет закрепление из main process
    if (state.pane === 'settings') renderCurrentSection();
  });

  window.epicAI?.on('overlay:visibility', ({ visible }) => {
    if (visible) setTimeout(() => $('#query-input')?.focus(), 60);
  });

  // Если main process не прислал init (например, окно открыто напрямую) — тянем сами
  if (!state.user) {
    try {
      const me = await Auth.me();
      if (me?.authenticated) {
        state.user = me.user;
        state.permissions = me.permissions ?? [];
        state.isDeveloper = Boolean(me.isDeveloper);
        applyIdentity();
      }
    } catch { /* нет сессии — main process покажет окно входа */ }
  }

  applyIdentity();
  void syncServerSettings();
  void refreshKbChip();
  setInterval(() => void refreshKbChip(), 60_000);
  setMode(state.settings.rememberMode ? (state.settings.defaultMode ?? 'rules') : 'rules', { silent: true });

  // Перехват клавиш: Esc закрывает меню, сворачивает панель, скрывает overlay.
  // Подтверждение «Спросить ИИ?» живёт в отдельном окне и свои клавиши ловит само.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#user-menu').hidden) { closeUserMenu(); return; }
      if (state.pane !== 'none') openPane('none');
      else window.epicAI?.invoke('epic:window:hide').catch(() => {});
    }
  });
}

/** Локальные настройки клиента ← серверные (единый аккаунт → единые настройки). */
async function syncServerSettings() {
  try {
    const res = await SettingsApi.get();
    if (!res?.settings) return;
    state.serverSettings = res.settings;
    const patch = {};
    for (const [k, v] of Object.entries(res.settings)) {
      if (state.settings[k] !== v) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      await window.epicAI?.invoke('epic:settings:set', patch).catch(() => {});
      state.settings = {...state.settings,...patch };
      applyVisualSettings(state.settings);
      if (!patch.defaultMode && state.settings.rememberMode) setMode(state.settings.defaultMode ?? state.mode, { silent: true });
    }
  } catch { /* offline — работаем на локальных настройках */ }
}

/* ------------------------------------------------------------------ */
/*  Панель                                                              */
/* ------------------------------------------------------------------ */

function bindChrome() {
  $('#settings-btn').addEventListener('click', () => {
    closeUserMenu(false);
    openPane(state.pane === 'settings' ? 'none' : 'settings');
  });

  // История ответов ИИ — ОТДЕЛЬНОЕ окно в стиле окна источников
  $('#history-btn').addEventListener('click', () => {
    closeUserMenu(false);
    void openHistoryWindow();
  });

  /* --- пилюля пользователя и меню --- */
  $('#user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#user-menu');
    if (menu.hidden) {
      // Меню не должно перекрывать раскрытые области (ответ/настройки/БЗ):
      // сначала сворачиваем панель, затем раскрываем dropdown.
      if (state.pane !== 'none') openPane('none');
      openUserMenu();
    } else {
      closeUserMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (!$('#user-menu').hidden && !e.target.closest('#user-menu')) closeUserMenu();
  });
  // Шапка меню (аватар + имя + @ник) — кнопка «Профиль и аккаунт»: открывает
  // ОТДЕЛЬНОЕ окно профиля (вкладка «Профиль» из настроек убрана).
  const menuHead = $('#menu-head');
  menuHead?.addEventListener('click', () => { closeUserMenu(); void openProfileWindow(); });
  menuHead?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeUserMenu(); void openProfileWindow(); }
  });
  for (const item of document.querySelectorAll('#user-menu .menu__item')) {
    item.addEventListener('click', () => {
      const act = item.dataset.act;
      closeUserMenu();
      if (act === 'profile') void openProfileWindow();
      if (act === 'admin') window.epicAI?.invoke('epic:admin:open').catch((e) => toast(e.message ?? 'Нет доступа'));
      if (act === 'logout') void doLogout();
    });
  }

  /* --- звёздочка: закрепить поверх игры --- */
  const pin = $('#pin-btn');
  syncPin();
  pin.addEventListener('click', async () => {
    const on = pin.getAttribute('aria-pressed') !== 'true';
    const res = await window.epicAI?.invoke('epic:always-on-top', on).catch(() => null);
    // ВАЖНО: false здесь — это НОВОЕ СОСТОЯНИЕ «откреплено», а не ошибка.
    // Ошибка — только когда main process вообще не ответил (null/undefined).
    if (typeof res !== 'boolean') { toast('Не удалось закрепить окно'); return; }
    state.settings = {...state.settings, alwaysOnTop: res };
    void SettingsApi.save({ alwaysOnTop: res }).catch(() => {});   // единый аккаунт
    syncPin();
    toast(res ? 'Окно закреплено поверх игры' : 'Закрепление выключено');
  });

  bindMic();

  /* --- перетаскивание панели ЗА ЛЮБОЕ СВОБОДНОЕ МЕСТО (требование
     пользователя: раньше панель тянулась только за логотип). Исключения —
     интерактивные элементы, поля ввода/выделения текста, меню и прокручиваемые
     области: за них drag не начинается, чтобы не мешать кликам и скроллу. --- */
  let drag = null;
  const DRAG_EXCLUDE = 'input, textarea, select, button, a, label, .selectable, .menu, '
    + '.expander__body, .set-main, .upd-list, .upd-detail, .kbpane__body';
  document.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(DRAG_EXCLUDE)) return;
    if (!e.target.closest('#panel, #expander')) return;
    const b = await window.epicAI?.invoke('epic:panel:geometry').catch(() => null);
    if (!b) return;
    drag = { dx: e.screenX - b.x, dy: e.screenY - b.y };
  });
  // Перетаскивание: не более одного IPC-вызова за кадр (rAF-троттлинг) —
  // без этого mousemove спамил invoke и панель лагала.
  let dragRaf = 0;
  let dragNext = null;
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    dragNext = { x: e.screenX - drag.dx, y: e.screenY - drag.dy };
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      if (!drag || !dragNext) return;
      window.epicAI?.invoke('epic:panel:move', dragNext.x, dragNext.y).catch(() => {});
    });
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    dragNext = null;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  });
}

/** Окно профиля: отдельный BrowserWindow (открывается из меню пользователя). */
function openProfileWindow() {
  return window.epicAI?.invoke('epic:profile:open').catch((e) => toast(e?.message ?? 'Не удалось открыть профиль'));
}

/**
 * Есть ли доступ к админ-панели. У роли «игрок» кнопка НЕ показывается
 * никогда, даже если backend прислал какие-то permissions.
 */
function canAdmin() {
  const code = String(state.user?.primaryRole?.code ?? '').toLowerCase();
  if (code === 'player' || !state.user) return false;
  return (state.permissions ?? []).some((p) => ['users.view', 'ai.reports.view', 'knowledge.view', 'system.logs'].includes(p));
}

/** Отображаемое имя: в режиме стримера — случайный ник из настроек. */
function displayName() {
  const u = state.user ?? {};
  if (state.settings.streamerMode) return state.settings.streamerNick || streamerName();
  return u.displayName || u.username || '—';
}

function openUserMenu() {
  const u = state.user ?? {};
  const ava = $('#menu-ava');
  clear(ava);
  // Режим стримера: вместо фото/инициалов — нейтральная заглушка (без blur).
  if (state.settings.streamerMode) ava.appendChild(streamerAvatarNode('menu-ava-img'));
  else if (u.avatarUrl) ava.appendChild(el('img', { src: u.avatarUrl, alt: '' }));
  else ava.textContent = initials(u.displayName || u.username || '?');
  $('#menu-name').textContent = displayName();
  $('#menu-nick').textContent = state.settings.streamerMode ? '@••••••' : `@${u.username ?? '—'}`;
  const role = $('#menu-role');
  clear(role);
  if (u.primaryRole) role.appendChild(el('span', { class: 'role-pill', style: { color: u.primaryRole.color } }, [el('span', { class: 'dot' }), u.primaryRole.name]));
  $('#menu-admin').hidden = !canAdmin();
  const menu = $('#user-menu');
  menu.hidden = false;
  state.menuOpen = true;
  // Меню рисуется ПОД баром, а свёрнутое окно имеет высоту 56 px — без
  // раскрытия окна dropdown просто не виден. Растим окно вниз под размер меню
  // (только растим: если панель уже развёрнута ответом/настройками — не сжимаем).
  requestAnimationFrame(() => {
    if (menu.hidden) return;
    const need = COLLAPSED + menu.offsetHeight + 18;
    resizeTo(Math.max(state.viewHeight ?? COLLAPSED, need));
  });
}

/**
 * Закрыть меню пользователя.
 * @param {boolean} [withResize=true] вернуть высоту окна под текущую панель.
 */
function closeUserMenu(withResize = true) {
  const menu = $('#user-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  state.menuOpen = false;
  if (!withResize) return;
  if (state.pane === 'none') resizeTo(COLLAPSED);
  else if (state.pane === 'settings') renderCurrentSection();
  else resize();
}

/** Состояние звёздочки = настройка alwaysOnTop. */
function syncPin() {
  $('#pin-btn').setAttribute('aria-pressed', state.settings.alwaysOnTop !== false ? 'true' : 'false');
}

async function doLogout() {
  // Приложение НЕ закрывается: main process отзывает сессию, закрывает окна
  // оверлея и снова поднимает окно авторизации (splash → boot → auth).
  await window.epicAI?.invoke('epic:account:logout').catch(() => {});
}

/**
 * Голосовой ввод: запись микрофона (MediaRecorder) → распознавание на backend
 * (Groq Whisper, бесплатный API; ключ не уходит в клиент — ).
 * Web Speech API Chromium в Electron не работает (нет сервисов Google),
 * поэтому запись обрабатывает сервер: POST /api/ai/transcribe.
 *
 * Управление: клик по микрофону — начало записи, повторный клик — стоп и
 * распознавание. Авто-стоп через 60 секунд.
 */
function bindMic() {
  const btn = $('#mic-btn');
  const supported = typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
  if (!supported) { btn.hidden = true; return; }

  let rec = null;
  let chunks = [];
  let on = false;
  let timer = null;

  const stop = () => {
    if (!on) return;
    on = false;
    clearTimeout(timer);
    btn.classList.remove('is-on');
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  btn.addEventListener('click', async () => {
    if (on) { stop(); return; }
    let stream;
    // Устройство микрофона выбирается в настройках («Основное» → «Микрофон»):
    // micDeviceId = deviceId из enumerateDevices; пусто — системное по умолчанию.
    const devId = state.settings.micDeviceId;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: devId ? { deviceId: { exact: devId } } : true,
      });
    } catch {
      // Выбранное устройство могло исчезнуть (отключили гарнитуру) —
      // пробуем системное по умолчанию.
      if (!devId) { toast('Нет доступа к микрофону — проверьте разрешения Windows'); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { toast('Нет доступа к микрофону — проверьте разрешения Windows'); return; }
    }
    try {
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void transcribe();
      };
      rec.start();
      on = true;
      btn.classList.add('is-on');
      toast('Слушаю… нажмите на микрофон ещё раз, чтобы завершить');
      timer = setTimeout(stop, 60_000);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      toast('Не удалось начать запись');
    }
  });

  async function transcribe() {
    const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' });
    chunks = [];
    if (!blob.size) { toast('Запись пуста'); return; }
    btn.disabled = true;
    try {
      const r = await Ai.transcribe(blob);
      const input = $('#query-input');
      const cur = input.value.trim();
      input.value = cur ? `${cur} ${r.text}`.trim() : r.text;
      syncClearBtn();
      input.focus();
    } catch (e) {
      toast(e?.message ?? 'Не удалось распознать речь');
    } finally {
      btn.disabled = false;
    }
  }
}

function applyIdentity() {
  const u = state.user;
  const pill = $('#user-btn');
  if (!u) {
    pill.hidden = true;
    $('#query-input').placeholder = 'Войдите, чтобы задать вопрос…';
    return;
  }
  pill.hidden = false;
  const ava = $('#user-ava');
  clear(ava);
  // Режим стримера: вместо фото/инициалов — нейтральная заглушка (без blur).
  if (state.settings.streamerMode) ava.appendChild(streamerAvatarNode('userpill__ava-img'));
  else if (u.avatarUrl) ava.appendChild(el('img', { src: u.avatarUrl, alt: '' }));
  else ava.textContent = initials(u.displayName || u.username || '?');
  $('#user-name').textContent = displayName();
  $('#query-input').placeholder = 'Вопрос, ситуация, пункт или номер статьи…';
}

function bindModes() {
  for (const btn of document.querySelectorAll('.mode')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
}

/**
 * Локальные сочетания Ctrl+H / Ctrl+O / Ctrl+P БОЛЬШЕ НЕ обрабатываются
 * renderer'ом: они зарегистрированы в main process через globalShortcut
 * (см. electron/main/ipc.js#registerComboShortcuts) и поэтому работают
 * глобально — даже когда фокус в игре, а не на панели.
 */

/** Окно истории ответов: отдельное окно СЛЕВА от панели (источники — справа). */
function openHistoryWindow() {
  return window.epicAI?.invoke('epic:history:open').catch((e) => toast(e?.message ?? 'Не удалось открыть историю'));
}

function setMode(mode, { silent = false } = {}) {
  if (mode !== 'rules' && mode !== 'laws') mode = 'rules';
  state.mode = mode;
  for (const btn of document.querySelectorAll('.mode')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  const flag = $('#answer-mode');
  if (flag) flag.textContent = mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА';
  if (!silent && state.settings.rememberMode) {
    void SettingsApi.save({ defaultMode: mode }).catch(() => {});
    void window.epicAI?.invoke('epic:settings:set', { defaultMode: mode }).catch(() => {});
  }
  if (!silent && state.pane === 'answer' && state.answer) {
    // Режим сменился — старый ответ к нему не относится
    if (state.settings.clearPreviousAnswer !== false) openPane('none');
  }
}

function bindQuery() {
  const input = $('#query-input');
  const box = $('#query');

  input.addEventListener('focus', () => box.classList.add('is-focused'));
  input.addEventListener('blur', () => box.classList.remove('is-focused'));
  input.addEventListener('input', syncClearBtn);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void submitQuery(); }   // Enter — отправка 
  });
  $('#query-clear').addEventListener('click', () => {
    input.value = '';
    syncClearBtn();
    input.focus();
    if (state.settings.clearPreviousAnswer !== false) openPane('none');
  });
}

function syncClearBtn() {
  $('#query-clear').hidden = !$('#query-input').value.trim();
}

/**
 * Подтверждение вопроса «Спросить ИИ?» — ОТДЕЛЬНОЕ окно (требование
 * пользователя: inline-модалка внутри панели убрана). Панель вызывает
 * main process ('epic:ask:confirm'), тот открывает confirm.html поверх
 * панели и ждёт результата окна; Enter — спросить, Esc — отмена.
 * Полностью отключается настройкой «Подтверждать вопрос» (confirmAiAsk).
 * @returns {Promise<boolean>} true — пользователь подтвердил отправку.
 */
function confirmAskWindow() {
  return window.epicAI?.invoke('epic:ask:confirm').then(
    (ok) => Boolean(ok),
    // Окно подтверждения не открылось (сбой IPC) — не блокируем вопрос
    () => true,
  ) ?? Promise.resolve(true);
}

async function submitQuery() {
  const input = $('#query-input');
  const question = input.value.trim();
  if (!question) { input.focus(); return; }
  if (state.busy) return;
  if (question.length < 3) { toast('Слишком короткий запрос'); return; }
  if (!state.user) { toast('Требуется вход в Epic AI'); void window.epicAI?.invoke('epic:auth:open').catch(() => {}); return; }

  if (state.settings.confirmAiAsk !== false) {
    const ok = await confirmAskWindow();
    if (!ok) return;
  }

  setBusy(true);
  try {
    const answer = await Ai.ask(state.mode, question);
    state.answer = answer;
    state.vote = null;
    renderAnswer(answer);
    openPane('answer');
    openSourcesWindow();          // : отдельное окно источников справа
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      toast(e.status === 403 ? 'Аккаунт заблокирован' : 'Требуется вход');
      void window.epicAI?.invoke('epic:auth:open').catch(() => {});
    } else {
      toast(e.message ?? 'Ошибка запроса');
      renderError(e.message ?? 'Ошибка запроса');
      openPane('answer');
    }
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  $('#panel').classList.toggle('is-busy', busy);
  $('#query-input').disabled = busy;
}

/* ------------------------------------------------------------------ */
/*  Развёрнутая область: ответ ИЛИ настройки                     */
/* ------------------------------------------------------------------ */

function bindExpander() {
  $('#answer-close').addEventListener('click', () => openPane('none'));

  /* --- база знаний: вкладки и «закрыть» в шапке pane-kb --- */
  $('#kb-tab-updates').addEventListener('click', () => { state.kbTab = 'updates'; renderKbPane(); });
  $('#kb-tab-history').addEventListener('click', () => { state.kbTab = 'history'; renderKbPane(); });
  $('#kb-close').addEventListener('click', () => openPane('none'));

  initSettings({
    get settings() { return state.settings; },
    get user() { return state.user; },
    get permissions() { return state.permissions; },
    get appVersion() { return state.runtime?.version ?? '1.0.0'; },
    get backendUrl() { return state.runtime?.backendUrl ?? ''; },
    get canAdmin() { return canAdmin(); },
    get updatesDay() { return state.updatesDay; },
    set updatesDay(v) { state.updatesDay = v; },
    onChange: async (key, value) => {
      // 1) СНАЧАЛА локальные настройки клиента: окно должно среагировать
      //    немедленно, даже если сервер недоступен или отвечает медленно.
      try { await window.epicAI?.invoke('epic:settings:set', { [key]: value }); }
      catch (e) { console.warn('[epic-ai] settings:set failed:', e?.message ?? e); }
      // 2) серверные настройки (единый аккаунт) — фоном, не блокируя UI
      void SettingsApi.save({ [key]: value }).catch(() => {});
      state.settings = {...state.settings, [key]: value };
      applyVisualSettings(state.settings);
      applyIdentity();   // стример-ник / обычный ник в пилюле
      if (key === 'alwaysOnTop') $('#pin-btn').setAttribute('aria-pressed', value ? 'true' : 'false');
      renderCurrentSection();
    },
    onNavigate: (section) => { state.section = section; renderCurrentSection(); },
    onResize: (h) => resizeTo(h),
    onOpenHistoryItem: (id) => void openHistoryItem(id),
    onLogout: () => void doLogout(),
    onOpenAdmin: () => window.epicAI?.invoke('epic:admin:open').catch(() => {}),
    // «Посмотреть» / «История изменений» — ВНЕ настроек: выпадающая область
    // панели (pane-kb) со списком изменений слева и diff справа (референс).
    onOpenKb: (tab, day) => {
      state.kbTab = tab === 'history' ? 'history' : 'updates';
      state.kbDay = typeof day === 'string' ? day : null;
      openPane('kb');
    },
  });
}

/** Открыть старый ответ из истории (раздел «Ответы ИИ»). */
async function openHistoryItem(id) {
  try {
    const r = await Ai.request(id);
    state.answer = r;
    state.vote = null;
    renderAnswer(r);
    openPane('answer');
    openSourcesWindow();
  } catch (e) {
    toast(e.message ?? 'Не удалось открыть ответ');
  }
}

function openPane(pane) {
  closeUserMenu(false);
  state.pane = pane;
  const answerPane = $('#pane-answer');
  const settingsPane = $('#pane-settings');
  const kbPane = $('#pane-kb');
  const expander = $('#expander');

  // Ответ, настройки и база знаний одновременно не отображаются 
  answerPane.hidden = pane !== 'answer';
  settingsPane.hidden = pane !== 'settings';
  kbPane.hidden = pane !== 'kb';
  expander.classList.toggle('is-open', pane !== 'none');
  $('#settings-btn').classList.toggle('is-active', pane === 'settings');

  if (pane === 'none') {
    resizeTo(COLLAPSED);
    return;
  }
  if (pane === 'settings') {
    renderCurrentSection();
    return;
  }
  if (pane === 'kb') {
    renderKbPane();
    resizeTo(Math.min(MAX_EXPANDED, 560));
    return;
  }
  // answer: измеряем содержимое.
  // ВАЖНО: .expander__body — сам scroll-контейнер (overflow:hidden auto),
  // поэтому expander.scrollHeight равен его clientHeight и окно НЕ росло.
  // Меряем scrollHeight ТЕЛА + высоту шапки области.
  requestAnimationFrame(() => {
    resizeTo(measureAnswerHeight());
  });
}

/**
 * Полная высота окна под ответ: бар (COLLAPSED) + шапка области + тело ответа
 * целиком (scrollHeight прокручиваемой области) + отступы/рамки. Ответ любой
 * длины помещается полностью; потолок — MAX_EXPANDED и рабочая область экрана
 * (клампует main process).
 */
function measureAnswerHeight() {
  const pane = $('#pane-answer');
  const head = pane.querySelector('.expander__head');
  const body = pane.querySelector('.expander__body');
  const headH = head ? head.offsetHeight : 40;
  const bodyH = body ? Math.max(body.scrollHeight, body.clientHeight) : 200;
  // 8 — margin-top экспандера, 2 — его рамки, 28 — паддинги тела (14×2)
  return Math.min(MAX_EXPANDED, Math.max(200, COLLAPSED + headH + bodyH + 38));
}

function renderCurrentSection() {
  renderSettings($('#pane-settings'), state.section);
}

/** База знаний внутри панели: обновления за день / история по дням. */
function renderKbPane() {
  const isUpd = state.kbTab !== 'history';
  $('#kb-tab-updates').classList.toggle('is-active', isUpd);
  $('#kb-tab-updates').setAttribute('aria-selected', String(isUpd));
  $('#kb-tab-history').classList.toggle('is-active', !isUpd);
  $('#kb-tab-history').setAttribute('aria-selected', String(!isUpd));
  const root = $('#kb-pane-root');
  clear(root);
  root.appendChild(isUpd
    ? buildUpdatesView(state.kbDay, { onDay: (day) => { state.kbDay = day; renderKbPane(); } })
    : buildHistoryView({ onOpenDay: (day) => { state.kbDay = day; state.kbTab = 'updates'; renderKbPane(); } }));
}

function clampTo(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

async function resizeTo(height) {
  const h = Math.round(clampTo(height, COLLAPSED, MAX_EXPANDED + COLLAPSED));
  state.viewHeight = h;
  await window.epicAI?.invoke('epic:panel:resize', h, { anchor: 'bottom' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Ответ AI  и feedback                                 */
/* ------------------------------------------------------------------ */

function renderAnswer(a) {
  $('#answer-mode').textContent = a.mode === 'laws' ? 'Законы' : 'Правила';
  $('#answer-meta').textContent = [
    a.kbVersion ? `база v${a.kbVersion}` : null,
    a.latencyMs ? `${(a.latencyMs / 1000).toFixed(1)} c` : null,
    a.provider && a.provider !== 'none' ? `${a.provider}/${a.model}` : null,
  ].filter(Boolean).join(' · ');

  const verdict = $('#answer-verdict');
  clear(verdict);
  verdict.append(
    el('span', { style: { color: verdictColor(a.verdict) } }, verdictLabel(a.verdict)),
    typeof a.confidence === 'number' && a.confidence > 0
      ? el('span', { class: 'subtle', style: { fontSize: '10px', fontWeight: '500', letterSpacing: '0' } }, `уверенность ${Math.round(a.confidence * 100)}%`)
      : null,
  );

  $('#answer-explanation').textContent = a.explanation || '—';

  const basisBlock = $('#answer-basis-block');
  if (a.basis) { basisBlock.hidden = false; $('#answer-basis').textContent = a.basis; }
  else basisBlock.hidden = true;

  renderSourceChips(a);
  renderFeedback(a);
}

function renderSourceChips(a) {
  const host = $('#answer-sources');
  clear(host);
  if (!a.sources?.length) {
    host.appendChild(el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'Источники не найдены'));
    return;
  }
  a.sources.forEach((s, i) => {
    host.appendChild(el('button', {
      class: 'src-chip', type: 'button', title: `${s.title}\n${s.heading ?? ''}\nРедакция: ${s.revisionLabel}`,
      onClick: () => openExternal(s.url),
    }, [
      el('b', {}, String(i + 1)),
      el('span', { class: 'ellipsis', style: { maxWidth: '210px' } }, s.heading ? `${s.title} · ${s.heading}` : s.title),
    ]));
  });
  host.appendChild(el('button', { class: 'src-chip', type: 'button', onClick: () => openSourcesWindow() }, 'Все источники ↗'));
}

function verdictLabel(v) {
  return { allowed: 'Разрешено', forbidden: 'Запрещено', depends: 'Зависит от обстоятельств', unknown: 'Нет данных' }[v] ?? 'Нет данных';
}
function verdictColor(v) {
  return { allowed: 'var(--accent)', forbidden: 'var(--danger)', depends: '#F1C40F', unknown: 'var(--text-muted)' }[v] ?? 'var(--text-muted)';
}

function renderError(message) {
  $('#answer-mode').textContent = state.mode === 'laws' ? 'Законы' : 'Правила';
  $('#answer-meta').textContent = '';
  clear($('#answer-verdict'));
  $('#answer-verdict').appendChild(el('span', { style: { color: 'var(--danger)' } }, 'Техническая ошибка'));
  $('#answer-explanation').textContent = message;
  $('#answer-basis-block').hidden = true;
  clear($('#answer-sources'));
  $('#answer-sources').appendChild(el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'Источники не найдены'));
  $('#feedback').style.display = 'none';
  $('#report-form').classList.remove('is-open');
  state.answer = null;
}

async function renderFeedback(a) {
  const wrap = $('#feedback');
  wrap.style.display = '';
  $('#feedback-hint').textContent = '';
  $('#vote-up').classList.remove('is-on');
  $('#vote-down').classList.remove('is-on');
  $('#vote-up').disabled = false;
  $('#vote-down').disabled = false;
  $('#report-form').classList.remove('is-open');
  $('#report-error').textContent = '';
  $('#report-comment').value = '';

  const allowed = (state.permissions ?? []).includes('ai.feedback');
  $('#vote-up').disabled = !allowed;
  $('#vote-down').disabled = !allowed;

  $('#vote-up').onclick = async () => {
    if (!a?.requestId) return;
    try {
      await Ai.like(a.requestId);
      $('#vote-up').classList.add('is-on');
      $('#vote-down').classList.remove('is-on');
      $('#report-form').classList.remove('is-open');
      $('#feedback-hint').textContent = 'Спасибо — оценка учтена в статистике качества';
      resize();
    } catch (e) { toast(e.message); }
  };

  $('#vote-down').onclick = async () => {
    if (!a?.requestId) return;
    $('#vote-down').classList.add('is-on');
    $('#vote-up').classList.remove('is-on');
    await openReportForm(a);
  };

  $('#report-cancel').onclick = () => { $('#report-form').classList.remove('is-open'); resize(); };
  $('#report-form').onsubmit = async (e) => {
    e.preventDefault();
    const category = $('#report-form').querySelector('input[name="report-category"]:checked')?.value;
    if (!category) { $('#report-error').textContent = 'Выберите причину — категория обязательна'; return; }
    const comment = $('#report-comment').value.trim() || null;
    const btn = $('#report-submit');
    btn.disabled = true; btn.textContent = 'Отправка…';
    try {
      const res = await Ai.report(a.requestId, category, comment);
      $('#report-form').classList.remove('is-open');
      $('#feedback-hint').textContent = `Отчёт #${res.reportId} создан — его проверит администратор`;
      toast('Отчёт об ошибке отправлен');
    } catch (err) {
      $('#report-error').textContent = err.message ?? 'Не удалось отправить отчёт';
    } finally {
      btn.disabled = false; btn.textContent = 'Отправить';
      resize();
    }
  };
  resize();
}

async function openReportForm(a) {
  if (!state.categories.length) {
    try { state.categories = (await Ai.feedbackCategories()).items ?? []; }
    catch { state.categories = [
      { id: 'misinterpreted', label: 'Неверно истолковано правило' },
      { id: 'wrong_article', label: 'Неправильная статья' },
      { id: 'outdated', label: 'Устаревшая информация' },
      { id: 'wrong_source', label: 'Неверный источник' },
      { id: 'technical', label: 'Техническая ошибка' },
      { id: 'other', label: 'Другое' },
    ]; }
  }
  const host = $('#report-categories');
  clear(host);
  state.categories.forEach((c, i) => {
    host.appendChild(el('label', { class: 'radio' }, [
      el('input', { type: 'radio', name: 'report-category', value: c.id,...(i === 0 ? {} : {}) }),
      el('span', { class: 'radio__mark' }),
      el('span', { class: 'radio__label' }, c.label),
    ]));
  });
  $('#report-error').textContent = '';
  $('#report-form').classList.add('is-open');
  resize();
}

/** Пересчитать высоту окна под текущую раскрытую область (ответ/форма отчёта). */
function resize() {
  requestAnimationFrame(() => {
    if (state.pane === 'answer') { void resizeTo(measureAnswerHeight()); return; }
    if (state.pane === 'settings' || state.pane === 'kb') return;   // фиксированная высота
    const expander = $('#expander');
    const h = Math.min(MAX_EXPANDED, Math.max(200, expander.scrollHeight + COLLAPSED + 18));
    void resizeTo(h);
  });
}

/* ------------------------------------------------------------------ */
/*  Окно источников — ОТДЕЛЬНЫЙ BrowserWindow справа        */
/* ------------------------------------------------------------------ */

function openSourcesWindow() {
  const a = state.answer;
  if (!a) return;
  const payload = {
    requestId: a.requestId,
    question: a.question,
    mode: a.mode,
    modeLabel: a.mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА',
    verdict: a.verdict,
    verdictLabel: verdictLabel(a.verdict),
    kbVersion: a.kbVersion,
    generatedAt: new Date().toISOString(),
    sources: a.sources ?? [],
    relatedDocuments: a.relatedDocuments ?? [],
    noData: Boolean(a.noData),
    feedbackAllowed: (state.permissions ?? []).includes('ai.feedback'),
  };
  window.epicAI?.invoke('epic:sources:open', payload).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Индикатор состояния базы                                     */
/* ------------------------------------------------------------------ */

async function refreshKbChip() {
  // Индикатор базы живёт в сайдбаре настроек (снизу) — обновляем, если он открыт
  const kb = $('#side-kb');
  const dot = $('#side-status-dot');
  if (!kb) return;
  try {
    const st = await Kb.status();
    kb.textContent = `база: ${st.documents.active} док. · ${st.stateLabel.toLowerCase()}`;
    if (dot) {
      dot.className = `dot${st.state === 'error' ? ' err' : ''}`;
      dot.style.background = st.stateColor;
      dot.style.boxShadow = `0 0 8px ${st.stateColor}`;
    }
  } catch (e) {
    kb.textContent = 'база недоступна';
    if (dot) dot.className = 'dot err';
  }
}

/* ------------------------------------------------------------------ */

let __booted = false;
function __start() {
  if (__booted) return;   // защита от повторного запуска (double DOMContentLoaded)
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
