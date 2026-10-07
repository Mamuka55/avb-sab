# EPIC AI

Компактный desktop-overlay интеллектуальный помощник для игрового проекта **EpicRP / Epic GTA**.
Отвечает на вопросы игроков **строго по официальной базе** форума `forum.epic-gta.com`:
правила проекта, правила сервера и законодательная база.

> **Главный принцип (ТЗ §68).** Epic AI — не универсальный ChatGPT, а официальный помощник EpicRP.
> Цепочка доверия: официальный форум → версия документа → поиск → AI → ответ → конкретные источники.
> Если подтвердить ответ официальным источником нельзя, система прямо сообщает об отсутствии подтверждения.

Реализовано по Техническому заданию v1.0. Соответствие пунктов ТЗ реализации — в [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

---

## ⚠️ Прочитайте перед включением crawler'а

`robots.txt` форума `forum.epic-gta.com` **запрещает доступ AI-краулерам**
(GPTBot, ClaudeBot, PerplexityBot, CCBot и т. д. — `Disallow: /`).
Поэтому crawler **по умолчанию выключен** (`CRAWLER_ENABLED=false`) и не обходит это ограничение.

Порядок действий, правовые варианты и альтернативы (официальный XenForo REST API, ручной импорт) —
в **[`docs/LEGAL.md`](docs/LEGAL.md)**. Это нужно решить до наполнения базы реальными документами.

---

## Быстрый старт

> **Пошаговая инструкция для Windows — в [`QUICKSTART.md`](QUICKSTART.md).**
> Там же: настройка Discord OAuth, локальный вход без OAuth, наполнение базы,
> разбор типовых ошибок и короткая шпаргалка команд.

Требуется **Node.js 20.11+**. Всё остальное ставится из npm.

```bash
# 1. Backend
cd backend
npm install                 # на Windows/macOS сразу поставит better-sqlite3 (prebuilt)
cp .env.example .env        # в Windows: copy .env.example .env
# затем заполните .env (см. ниже)

# 2. База данных: миграции + роли/permissions
npm run db:migrate
npm run db:seed

# 3. Первый Developer (ТЗ §45) — создаётся только через защищённый bootstrap
npm run bootstrap:developer -- --local developer
#    …или через реальный identity:
# npm run bootstrap:developer -- --discord 482913745629184011 --name "ВашНик"

# 4. Запуск backend
npm run dev                 # http://127.0.0.1:8787

# 5. Electron-клиент (в отдельном терминале)
cd ../electron
npm install
npm run dev
```

Или одной командой из корня репозитория (поднимет backend, дождётся health и запустит Electron):

```bash
node scripts/dev.mjs
```

### Минимальный `.env` для локальной разработки

```ini
HOST=127.0.0.1
PORT=8787
DB_DRIVER=sqlite
SESSION_SECRET=<сгенерируйте: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

# AI: бесплатный API Groq (https://console.groq.com) — OpenAI-совместимый
AI_PROVIDER=groq
AI_API_KEY=gsk_...
AI_MODEL=llama-3.3-70b-versatile

# Авторизация (можно включить позже)
DISCORD_ENABLED=false
TELEGRAM_ENABLED=false

# Crawler — включайте только после согласования с администрацией форума
CRAWLER_ENABLED=false
```

Без `AI_PROVIDER`/`AI_API_KEY` работает `AI_PROVIDER=mock`: поиск и источники настоящие,
а формулировку ответа генерирует заглушка — удобно для разработки интерфейса.

---

## Что можно посмотреть прямо сейчас (без Electron и без forum.epic-gta.com)

Соберите интерактивные демо-страницы — это **тот же код renderer'а**, что в приложении,
но со встроенным mock-backend'ом:

```bash
node scripts/build-demo.mjs
# откройте renderer/demo/index.html в браузере
```

| Страница | Что показывает |
|---|---|
| `demo/main.html` | Основная панель, режимы ПРАВИЛА/ЗАКОНЫ, запрос → ответ → 👍/👎 → форма ошибки, настройки внутри панели, раздел «Правила», «Обновления за сегодня» с красно-зелёным diff; рядом рисуются отдельные «окна» подтверждения, источников, истории и профиля |
| `demo/sources.html` | Отдельное окно найденных источников |
| `demo/confirm.html` | Отдельное окно подтверждения «Спросить ИИ?» с остатком дневного лимита (Enter — спросить, Esc — отмена) |
| `demo/profile.html` | Отдельное окно профиля: аватар, роль, «@ник · вход через Telegram», «Ответы ИИ сегодня» с остатком лимита и прогресс-баром, «Выйти из аккаунта» |
| `demo/admin.html` | Административная панель: Обзор, Пользователи, Роли, Permissions, Блокировки, Ошибки AI, Knowledge Base, Audit Log, System. В правом верхнем углу — переключатель роли, чтобы увидеть, как видимость разделов зависит от permissions |
| `demo/splash.html` | Splash screen 360×220 и его 9 этапов |

Демо-документы **вымышленные и учебные** — это не официальные правила EpicRP.

---

## Тесты

```bash
node scripts/test-all.mjs
```

Прогоняет несколько независимых наборов (оба — без Electron и без обращения к форуму):

1. **Backend: 71 проверка.** Чистая БД → миграции → сиды → bootstrap → запуск сервера →
   сквозной smoke-тест API: авторизация, RBAC и иерархия ролей, индивидуальные разрешения и запреты,
   блокировка с инвалидацией сессий, RAG-поиск и разделение баз RULE/LAW, честный отказ при отсутствии данных,
   👍/👎, AI Reports и их обработка, версии документов, word-level diff, Audit Log (включая запрет на изменение),
   настройки, видимость разделов админки, CSRF-защита.
2. **UI: 84 проверки.** Renderer исполняется в jsdom: сценарий «запрос → ответ → источники → дизлайк → отчёт»,
   поведение панели без запроса (ТЗ §9), настройки внутри панели (ТЗ §19), раздел «Правила» (ТЗ §21),
   экран обновлений с diff (ТЗ §23–§25), splash (ТЗ §32) и все разделы админки (ТЗ §47).
3. **Electron: 36 проверок.** Модуль `electron` подменяется заглушкой и проверяется
   `main/config.js`: валидность `client-config.default.json`, автосоздание конфига,
   подстановка команды запуска backend для dev и production, приоритет пользовательского
   конфига (сценарий VPS), устойчивость к битому JSON, значения настроек по умолчанию
   (F10, 900×56, always-on-top, прозрачность 0.82) и синтаксис всех main-модулей.

Отдельно:

```bash
node scripts/run-smoke.mjs        # только backend
node scripts/test-demo-dom.mjs    # только UI (нужен jsdom)
cd backend && npm run typecheck   # только типы
```

---

## Структура проекта

```
epic-ai/
├── electron/          Desktop-клиент (main + preload), без UI-фреймворка
│   ├── main/          main.js, windows.js, tray.js, hotkey.js, ipc.js, backend.js, config.js
│   └── preload/       contextBridge — единственный мост renderer ↔ main
├── renderer/          HTML/CSS/JS интерфейса (vanilla ESM)
│   ├── main.html      компактная горизонтальная панель + ответ + настройки
│   ├── sources.html   отдельное окно источников (справа от панели)
│   ├── history.html   отдельное окно истории ответов (слева от панели)
│   ├── confirm.html   отдельное окно подтверждения «Спросить ИИ?»
│   ├── profile.html   отдельное окно профиля и аккаунта
│   ├── admin.html     административная панель
│   ├── splash.html    splash screen
│   ├── blocked.html   окно блокировки аккаунта
│   ├── styles/        tokens.css (цвета ТЗ §4), base.css, main.css, sources.css, profile.css, kb.css, admin.css, splash.css
│   ├── scripts/       api.js, util.js, main.js, settings.js, sources.js, history.js, confirm.js, profile.js, kbview.js, admin.js, admin-views.js, splash.js
│   └── demo/          собранные демо-страницы (генерируется)
├── backend/           Fastify + TypeScript
│   └── src/
│       ├── auth/      Discord OAuth2, Telegram Login Widget, сессии, страница входа
│       ├── users/     единый аккаунт, identity, профиль, блокировки
│       ├── roles/     роли и иерархия (ТЗ §39, §46)
│       ├── permissions/ каталог и вычисление эффективных прав (ТЗ §42–§44)
│       ├── ai/        providers (groq/openai_compatible/ollama/mock), RAG-конвейер, промпты ТЗ §12–§14
│       ├── knowledge/ версионирование, diff, chunks, BM25-поиск, синхронизация
│       ├── crawler/   XenForo-парсер, robots.txt, вежливый HTTP-клиент с кэшем
│       ├── reports/   feedback и AI Reports (ТЗ §15–§18)
│       ├── audit/     append-only Audit Log (ТЗ §50)
│       └── db/        единый слой доступа: SQLite (better-sqlite3 / sql.js) и PostgreSQL
├── database/
│   ├── migrations/    001_init, 002_search_index, 003_document_changes
│   └── seeds/         8 ролей, 25 permissions, матрица роль→permissions
├── shared/tokens.js   единый источник цветов, ролей, статусов, категорий
├── scripts/           dev, build-demo, test-all, run-smoke, test-demo-dom, fixtures
└── docs/              ARCHITECTURE, DATABASE, API, LEGAL, DEVELOPMENT, COMPLIANCE
```

---

## Стек и почему он такой

| Слой | Решение | Обоснование |
|---|---|---|
| Desktop | Electron 33 + vanilla HTML/CSS/JS | Прямо по ТЗ §2: без тяжёлого UI-фреймворка на первом этапе |
| Backend | Node.js 20 + TypeScript + Fastify | Один язык на клиент и сервер; типизация критична для RBAC и версионирования |
| БД | SQLite локально → PostgreSQL на VPS | ТЗ §63/§64. Один и тот же код на обоих драйверах: перенос = смена `DB_DRIVER` |
| Поиск | Собственный BM25 + русский стеммер | Работает идентично на SQLite и PostgreSQL, понимает «зелёных»→«зеленых», жёстко разделяет RULE/LAW |
| AI | Groq (бесплатный API) через провайдер-абстракцию | Требование «бесплатный API». Смена провайдера — одна строка в `.env` |

Подробности — в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Перенос на VPS (ТЗ §64)

Клиент **не переписывается**: он знает только адрес backend.

1. На VPS: `DB_DRIVER=postgres`, заполнить `DB_*`, `PUBLIC_URL=https://api.…`.
2. `npm run build && npm start` за reverse proxy (nginx/Caddy) с TLS.
3. В клиенте `%APPDATA%/Epic AI/config.json` → `"backendUrl": "https://api.…", "embeddedBackend": false`.

---

## Документация

- [`QUICKSTART.md`](QUICKSTART.md) — **как запустить backend и приложение** (Windows, по шагам)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — архитектура, слои, поток данных, решения и их обоснование
- [`docs/DATABASE.md`](docs/DATABASE.md) — схема БД: 16 таблиц, связи, назначение каждой
- [`docs/API.md`](docs/API.md) — все HTTP-эндпоинты с правами доступа
- [`docs/LEGAL.md`](docs/LEGAL.md) — **robots.txt, правовые риски и легальные альтернативы crawler'у**
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — как разрабатывать, отлаживать, собирать
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — соответствие каждому пункту ТЗ v1.0 и критериям готовности §73
