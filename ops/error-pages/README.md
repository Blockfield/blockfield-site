# Общая 404 Blockfield

`blockfield.html` — самостоятельная страница без внешних запросов. Откройте её
в браузере для preview; проверки входят в `pnpm check`. Шрифты встроены из
закреплённых Inter/IBM Plex Mono пакетов, лицензии — `FONT-LICENSE.txt`.

## Dokploy

Compose `Blockfield404` (`nOggl301lUMg3PuAPz4rL`) берёт этот каталог из `main`.
Образ error-pages закреплён по digest; отдельная сборка не нужна.
Automatic Deploy выключен: каждый ручной Deploy требует согласия владельца.

После успешного Deploy и проверки SHA шаблона сохраните `traefik.yml` через
`settings.updateTraefikFile` в `/etc/dokploy/traefik/dynamic/blockfield-404.yml`.
Проверьте файл и активные routers после записи: ответ API не гарантирует успех.
Traefik перечитывает его без перезапуска. Wildcard TLS использует существующий
Cloudflare resolver; дождитесь сертификата `*.blockfield.pro`.

Fallback обслуживает неизвестные поддомены. Для существующих apex/www/bot/skins
404 заменяется только у GET/HEAD с `Accept: text/html`, вне `/api`.
JSON, POST, успешные ответы и другие статусы сохраняются; Cookie/Authorization
не передаются странице ошибок. Новому HTTP-приложению нужен такой же overlay
router с его provider-qualified service. Игровой TCP router не участвует.

Приёмка: реальные 404 на bot/skins/случайном поддомене, действительный wildcard TLS,
рабочие страницы/скачивание сайта, прежние JSON/API ответы и GET webhook → 405.
Откат — убрать только `blockfield-404.yml`; прежние managed routers сохраняются.
Общая страница `*.nether.pp.ua` этой конфигурацией не меняется.
