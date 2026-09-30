# blockfield-site

Лендинг Blockfield. Astro в режиме SSR (`@astrojs/node`, standalone), образ `ghcr.io/blockfield/blockfield-site`.
Репозиторий `Blockfield/blockfield-site` (до 2026-09-27 — `netherg-io/blockfield-web`; старый адрес GitHub перенаправляет).

```bash
just setup
just dev           # http://localhost:4321
just build
just start
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

Пак, архивы клиента и `build.json` живут в другом образе — `ghcr.io/blockfield/blockfield-distribution`
из репозитория `Blockfield/blockfield-client` (nginx; до 2.54.1 он назывался `blockfield-web`). Этот сервис отдаёт только `/` и свои ассеты, поэтому на
`blockfield.pro` они должны стоять за одним роутером: корень — сюда, файлы пака — в nginx.

## CI

Ручной Deploy после подтверждения владельца: тесты (в том числе на PostgreSQL) на Blacksmith, образ `ghcr.io/blockfield/blockfield-site:<sha>` и `:latest`,
затем вебхук Dokploy. Приложение Dokploy `blockfield-site` разворачивает `:latest`; откат — указать в нём тег `<sha>`
предыдущего коммита. Старые образы `ghcr.io/netherg-io/blockfield-site` сохранены для отката на переходный период.

- `DOKPLOY_SITE_WEBHOOK` — вебхук деплоя приложения сайта в Dokploy.

## Аккаунт

Страница `/account` — вход, регистрация, скин, плащ и пароль. Аккаунты живут только в Drasl
(`DRASL_URL`, по умолчанию `https://skins.blockfield.pro`); браузер ходит лишь в `/api/account/*`,
а API-токен Drasl хранится в httpOnly-cookie. Выход только удаляет cookie: токен у пользователя Drasl
один, и его сброс разлогинил бы лаунчер.

## Игровые комнаты

`GET /api/rooms` получает комнаты через Minecraft Server List Ping. Нужен серверный мод
с полем `blockfield` в ответе. По умолчанию используется `play.blockfield.pro:25565`;
для другого окружения задайте серверу Astro `BLOCKFIELD_SERVER_HOST` и `BLOCKFIELD_SERVER_PORT`.
Порт задаётся только через окружение, посетитель сайта не может изменить цель запроса.
Снимки старше 30 секунд отклоняются; запрос ограничен 4 секундами и 1 МиБ ответа.
При сбое старые кнопки входа убираются, повторная проверка выполняется автоматически.

Переключатель GAME/WORKSHOP хоста пишет `public.json` (`{"mode": "game"|"draining"|"workshop"|"maintenance", "message", "since"}`);
путь к нему задаётся в `BLOCKFIELD_GATE_FILE`. Монтируйте в контейнер каталог целиком только для чтения
(например `/srv/minecraft/workshop/public:/gate:ro`), а не сам файл: атомарная замена файла не видна через bind-mount файла.
Если переменная не задана, сайт работает как раньше. Любой режим, кроме `game`, а также отсутствующий, битый или неизвестный
файл показывают сообщение о техработах без комнат и кнопок входа, игровой сервер не опрашивается.

Ссылки `blockfield://join/<UUID>` и `blockfield://join/lobby` обрабатывает фирменный лаунчер. Требуется новая сборка
лаунчера и обоих модов. URL `/?room=<UUID>#rooms` используется для приглашений Discord;
закрытое приглашение показывает пояснение и остальные доступные комнаты.

## Statistics

Persistent gameplay history, leaderboard and account statistics: see `docs/statistics.md`. The site uses PostgreSQL (`BLOCKFIELD_DATABASE_URL`) or a persistent SQLite volume (`BLOCKFIELD_STATS_DB`) and remains independent of the Minecraft backend. Both backends preserve statistics, seasonal ratings and admin roles; see the migration instructions before switching.

## Проверки и развёртывание

Установите Python 3.12+, Node.js 22 и Just 1.57.0; затем `just setup`. Команды `just lint` и
`just format-check` проверяют весь TypeScript/JavaScript/Astro и формат;
`just format` применяет форматирование, `just check` запускает оба
контроля. Коммиты main и PR выполняют проверки без публикации образа и без
обращений к продовому webhook.

Прод развёртывается только ручным запуском workflow `Build and deploy the
landing page` после явного подтверждения владельца. Этот workflow повторяет
проверки, запускает тесты, публикует образ и ожидает появления выбранного SHA
на сайте. Push в main сам по себе прод не обновляет.
