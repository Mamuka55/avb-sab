/**
 * EPIC AI — утилиты renderer'а.
 */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

/** Формат даты: 05.10.2026 20:14 */
export function fmtDateTime(value, withTime = true) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

export function fmtDate(value) { return fmtDateTime(value, false); }

export function relativeTime(value) {
  if (!value) return '—';
  const d = new Date(String(value)).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.round(h / 24);
  if (days < 8) return `${days} дн назад`;
  return fmtDate(value);
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Подсветка найденных терминов внутри текста (: Accent — «выделение
 * найденных элементов»). Работает по текстовому узлу, без innerHTML-инъекций.
 */
export function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const src = String(text ?? '');
  const words = [...new Set((terms ?? []).map((t) => String(t).trim()).filter((t) => t.length >= 2))]
   .sort((a, b) => b.length - a.length);
  if (!words.length) { frag.appendChild(document.createTextNode(src)); return frag; }

  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  let last = 0;
  for (const m of src.matchAll(pattern)) {
    const idx = m.index ?? 0;
    if (idx > last) frag.appendChild(document.createTextNode(src.slice(last, idx)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    mark.style.cssText = 'background:rgba(172,231,46,.20);color:#E2FF3F;border-radius:3px;padding:0 2px';
    frag.appendChild(mark);
    last = idx + m[0].length;
  }
  if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
  return frag;
}

export function toast(message, ms = 2600) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove('is-visible'), ms);
}

/** Открывает внешнюю ссылку в системном браузере. */
export async function openExternal(url) {
  if (!url) return false;
  try {
    if (window.epicAI?.invoke) return await window.epicAI.invoke('epic:external', url);
  } catch { /* ignore */ }
  window.open(url, '_blank');
  return true;
}

export function initials(name) {
  const parts = String(name ?? '?').trim().split(/[\s_.-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function avatarNode(url, name, cls = 'avatar') {
  if (url) {
    const img = el('img', { class: cls, src: url, alt: name ?? '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => {
      const ph = el('div', { class: `${cls} avatar--placeholder` }, initials(name));
      img.replaceWith(ph);
    });
    return img;
  }
  return el('div', { class: `${cls} avatar--placeholder` }, initials(name));
}

/**
 * Аватар-заглушка для режима стримера.
 *
 * Требование пользователя: аватар НЕ размывается (blur выглядел как грязное
 * пятно), а заменяется нейтральным силуэтом — ни фото, ни инициалы настоящего
 * ника в стрим не попадают.
 */
export function streamerAvatarNode(cls = 'avatar') {
  return el('div', {
    class: `${cls} avatar--placeholder avatar--streamer`,
    title: 'Аватар скрыт (режим стримера)',
    'aria-label': 'Аватар скрыт',
  }, [el('span', {
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.6" r="3.7"/><path d="M4.9 20.1c1.4-3.7 4.1-5.5 7.1-5.5s5.7 1.8 7.1 5.5"/></svg>',
    style: { display: 'inline-flex', width: '70%', height: '70%' },
  })]);
}

/**
 * Случайный ник для режима стримера: настоящий ник не светится в стриме.
 * Ник НЕ постоянный: main process перегенерирует его при каждом запуске
 * приложения, а renderer — при каждом включении режима (требование
 * пользователя: «ник каждый раз новый»).
 */
export function streamerName() {
  const a = ['Neo', 'Fox', 'Echo', 'Nova', 'Pixel', 'Ghost', 'Turbo', 'Vega', 'Luna', 'Raptor', 'Sigma', 'Zephyr'];
  const b = ['One', 'X', 'Prime', 'Core', 'Wave', 'Byte', 'Fox', 'Nord', 'Spark', 'Drift'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)}${pick(b)}_${100 + Math.floor(Math.random() * 900)}`;
}
