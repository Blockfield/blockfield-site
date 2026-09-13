# blockfield-web

Лендинг Blockfield. Astro в режиме SSR (`@astrojs/node`, standalone), образ `ghcr.io/netherg-io/blockfield-site`.

```bash
npm install
npm run dev        # http://localhost:4321
npm run build && npm start
```

## Почему SSR

Версия лаунчера и прямые ссылки на инсталляторы раньше резолвились на сборке — лендинг врал до
следующего деплоя пака. Теперь их отдаёт `src/lib/launcher.ts` на запрос.

Проверка идёт раз в минуту, но условным запросом (`If-None-Match`): ответ 304 не расходует лимит
GitHub, а релиз меняется редко — так что почти все проверки бесплатны, хотя аноним и ограничен
60 запросами в час на IP. Ответа ждёт только первый рендер после старта контейнера; дальше страница
отдаётся из кэша, а он обновляется фоном. Сбой (в том числе исчерпанный лимит) отодвигает следующую
попытку на 10 минут, и до тех пор показывается прошлый успешный ответ.

Имена ассетов релиза содержат версию, поэтому `releases/latest/download/<имя>` не работает —
ссылки приходится доставать из API.

## Палитра и типографика

Взяты у лаунчера (`Blockfield Launcher/src/styles/theme.css`), правятся только вместе с ним:
фон `#070604`/`#0B0906`, панели `#11100D`, линии `#2A2116`, акцент `#F5A524`, текст `#F3E7D0`,
второстепенный `#C7AE86`, приглушённый `#8E7A5E`, статус `#82D66B`. Шрифты — Inter и IBM Plex Mono,
как в лаунчере, но self-hosted через `@fontsource` вместо Google Fonts.

Фоновая сетка (`.voxel`) — 16px (тексель Minecraft) поверх 96px (шесть блоков), чистый CSS.
Раньше на её месте была текстурная PNG-плашка.

Иконки: бренды — Simple Icons (CC0), интерфейсные — Lucide (ISC), те же, что в лаунчере.
`src/lib/icons.ts` сгенерирован из пакетов, руками пути не править — перегенерировать целиком.

`public/logo.svg` — фирменный знак, снятый с `Blockfield Launcher/src/app/components/icons/LogoMark.tsx`
(он же `src-tauri/icons/icon.png`). Он же служит фавиконкой. Своих знаков не рисовать: меняется знак
в лаунчере — переснимается и этот.

## Выбор версии лаунчера

Главные кнопки выбирают Windows `.exe` или Linux `.AppImage` на сервере по `User-Agent`
и `Sec-CH-UA-Platform`. Для macOS, мобильных устройств и неизвестной ОС они ведут к вариантам
установки; отдельные ссылки Windows/Linux остаются доступны. HTML отдаётся с
`Cache-Control: private, no-store` и `Vary`, чтобы CDN не смешивал ссылки разных платформ.

## Раздача

Пак, архивы клиента и `build.json` живут в другом образе (`blockfield-web` из репозитория
`blockfield-modpack`, nginx). Этот сервис отдаёт только `/` и свои ассеты, поэтому на
`modpack.nether.pp.ua` они должны стоять за одним роутером: корень — сюда, файлы пака — в nginx.

## Секреты CI

- `DOKPLOY_SITE_WEBHOOK` — вебхук деплоя приложения лендинга в Dokploy.

## Аккаунт

Страница `/account` — вход, регистрация, скин, плащ и пароль. Аккаунты живут только в Drasl
(`DRASL_URL`, по умолчанию `https://skins.nether.pp.ua`); браузер ходит лишь в `/api/account/*`,
а API-токен Drasl хранится в httpOnly-cookie. Выход только удаляет cookie: токен у пользователя Drasl
один, и его сброс разлогинил бы лаунчер.

## Игровые комнаты

`GET /api/rooms` получает комнаты через Minecraft Server List Ping. Нужен серверный мод
с полем `blockfield` в ответе. По умолчанию используется `minecraft.play.nether.pp.ua:25565`;
для другого окружения задайте серверу Astro `BLOCKFIELD_SERVER_HOST` и `BLOCKFIELD_SERVER_PORT`.
Порт задаётся только через окружение, посетитель сайта не может изменить цель запроса.
Снимки старше 30 секунд отклоняются; запрос ограничен 4 секундами и 1 МиБ ответа.
При сбое старые кнопки входа убираются, повторная проверка выполняется автоматически.

Ссылки `blockfield://join/<UUID>` и `blockfield://join/lobby` обрабатывает фирменный лаунчер. Требуется новая сборка
лаунчера и обоих модов. URL `/?room=<UUID>#rooms` используется для приглашений Discord;
закрытое приглашение показывает пояснение и остальные доступные комнаты.

## Statistics

Persistent gameplay history, leaderboard and account statistics: see `docs/statistics.md`. The site uses its own SQLite volume and remains independent of the Minecraft backend. No MMR formula is enabled by this change.
