# Сайт Blockfield

Сайт [blockfield.pro](https://blockfield.pro): загрузка лаунчера, аккаунты, игровые комнаты и статистика. Astro в режиме SSR (`@astrojs/node`, standalone), образ `ghcr.io/blockfield/blockfield-site`.
Репозиторий `Blockfield/blockfield-site` (до 2026-09-27 — `netherg-io/blockfield-web`; старый адрес GitHub перенаправляет).

Карта репозиториев и контрактов: [ARCHITECTURE](https://github.com/Blockfield/blockfield-workspace/blob/main/docs/ARCHITECTURE.md).

Общие 404/500 и другие страницы ошибок — в [blockfield-errors](https://github.com/Blockfield/blockfield-errors).

```bash
pnpm install --frozen-lockfile
pnpm dev           # http://localhost:4321
pnpm build
pnpm start
```

На Linux агент запускает свой экземпляр через `agent-process` после проверки порта
и владельца существующего процесса. Для Astro 7 передайте `ASTRO_DEV_BACKGROUND=1`
в окружение команды: это отключает автоматическое отделение agent-сервера от
зарегистрированной группы процессов. Остановка — по ID в `agent-process`.

## Почему SSR

Версия лаунчера и прямые ссылки на инсталляторы раньше резолвились на сборке — страница показывала устаревшую версию до
следующего деплоя сайта. Теперь их отдаёт `src/lib/launcher.ts` на запрос.

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
и `Sec-CH-UA-Platform`. Для мобильных устройств и неизвестной ОС они ведут к вариантам
установки; отдельные ссылки Windows/Linux остаются доступны. HTML отдаётся с
`Cache-Control: private, no-store` и `Vary`, чтобы CDN не смешивал ссылки разных платформ.

## Раздача

Пак, архивы клиента и `build.json` живут в другом образе — `ghcr.io/blockfield/blockfield-distribution`
из репозитория `Blockfield/blockfield-client` (nginx; до 2.54.1 он назывался `blockfield-web`). Этот сервис отдаёт только `/` и свои ассеты, поэтому на
`blockfield.pro` они должны стоять за одним роутером: корень — сюда, файлы пака — в nginx.

## CI

Push в `main` (только release-merge `next` → `main`) деплоит прод: сначала на `ubuntu-24.04` должны пройти оба джоба `deploy.yml` — `check` (линт, типы, формат, весь `pnpm test`, включая тесты на PostgreSQL, и сборка) и `postgres` (`pnpm test:postgres` на сервисе `postgres:18`); затем собираются образ `ghcr.io/blockfield/blockfield-site:<sha>` и `:latest`,
затем вебхук Dokploy. Без обоих зелёных джобов деплой не стартует. Приложение Dokploy `blockfield-site` разворачивает `:latest`; откат без пересборки — ручной запуск
workflow `Roll back the site without rebuild` с `sha` предыдущего коммита: он переставляет тег `:latest` на уже собранный
образ этого коммита, дёргает вебхук Dokploy и ждёт `/api/version`. Запасной путь — указать тег `<sha>` в приложении
Dokploy вручную. Откат через обновление схемы статистики требует восстановления дампа: старый код новую схему не открывает.
Старые образы `ghcr.io/netherg-io/blockfield-site` сохранены для отката на переходный период.

- `DOKPLOY_SITE_WEBHOOK` — вебхук деплоя приложения сайта в Dokploy.

## Аккаунт

Страница `/account` — вход, регистрация, скин, плащ и пароль. Аккаунты живут только в Drasl
(`DRASL_URL`, по умолчанию `https://skins.blockfield.pro`); браузер ходит лишь в `/api/account/*`,
а API-токен Drasl хранится в httpOnly-cookie. Выход только удаляет cookie: токен у пользователя Drasl
один, и его сброс разлогинил бы лаунчер.

## Игровые комнаты

`GET /api/rooms` получает комнаты через Minecraft Server List Ping внутреннего игрового сервера
с полем `blockfield` в ответе. За Velocity задайте Astro `BLOCKFIELD_SERVER_HOST` и
`BLOCKFIELD_SERVER_PORT`: публичный прокси не передаёт этот снимок. Состояние публичного лобби
и число игроков опрашиваются отдельно через `BLOCKFIELD_LOBBY_HOST` и `BLOCKFIELD_LOBBY_PORT`.
Обе цели по умолчанию — `play.blockfield.pro:25565`; посетитель сайта не может их изменить.
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

## Статистика

История матчей, таблица лидеров и статистика аккаунта: [docs/statistics.md](docs/statistics.md).
Сайт хранит данные в PostgreSQL (`BLOCKFIELD_DATABASE_URL`), отдельно от игрового сервера. Перед сменой базы следуйте инструкции миграции.

## Проверки и развёртывание

Установите Node.js 22 и pnpm 11.18.0; затем `pnpm install --frozen-lockfile`. Команды `pnpm lint` и
`pnpm format:check` проверяют весь TypeScript/JavaScript/Astro и формат;
`pnpm format` применяет форматирование, `pnpm check` запускает оба
контроля. PR выполняют проверки без публикации образа и без
обращений к продовому webhook.

Прод развёртывается workflow `Build and deploy the
landing page` на каждый push в `main` (release-merge `next` → `main`).
Этот workflow повторяет проверки, запускает тесты, публикует образ и ожидает появления выбранного SHA
на сайте.

Условия использования: [LICENSE](LICENSE).
