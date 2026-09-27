# Развёртывание

## Локально через Docker

Нужны Docker Engine и Compose v2.

```bash
git clone git@github.com:PRYANIK26/moscow-transport-vsm.git
cd moscow-transport-vsm
docker compose up --build -d
```

Открыть http://127.0.0.1:5180. PostgreSQL и API не публикуют порты наружу. Компоненты: `db`, одноразовый `init`, `api`, `worker`, `web`. `init` применяет миграции и создаёт демоданные. Это демо-конфигурация с публичными тестовыми аккаунтами.

```bash
docker compose ps
docker compose logs --tail=100 api worker
docker compose down
```

`down` сохраняет данные. `down -v` удаляет БД — не используйте для обновления.

Для ключей Яндекса и VAPID создайте `.env` по `.env.example`. Для локального Docker оставьте `WEB_ORIGIN=http://127.0.0.1:5180` и `NODE_ENV=development`. Compose задаёт адрес БД внутри сети самостоятельно.

## Домен и HTTPS

Сайт можно поставить за существующим Caddy или nginx. Docker публикует web только на loopback: `127.0.0.1:5180`.

В `.env`:

```dotenv
WEB_ORIGIN=https://your-domain.example
NODE_ENV=production
POSTGRES_PASSWORD=replace-with-a-long-random-hex-value
LEADERBOARD_ALL_STUDENTS=true
```

`POSTGRES_PASSWORD` используется в URL подключения: выбирайте случайную строку из латинских букв и цифр без специальных символов. Менять пароль уже созданного тома нужно отдельно в PostgreSQL; одна правка `.env` существующий пароль не обновляет.

Caddyfile:

```caddy
your-domain.example {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5180
}
```

DNS должен указывать на сервер, порты 80/443 должны быть доступны. Внешний Caddy выдаёт сертификат. API в production устанавливает Secure cookie. `TRUST_PROXY_CIDRS` задаёт доверенную сеть reverse proxy, чтобы лимиты регистрации различали посетителей. В Compose по умолчанию доверена частная сеть Docker 172.16.0.0/12; API не публикуется наружу. Если Docker использует другую сеть, укажите её CIDR. Инициализация демоданных выполняется отдельно в режиме development даже при production API.

## Обновление и резервная копия

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U vsm vsm > backups/vsm.sql
git pull --ff-only
docker compose up --build -d
```

Для новой установки используйте пустой том. Не копируйте чужие аккаунты и попытки из работающей БД ради демо. Секреты, резервные копии и `.env` не добавляются в Git.

## Проверка после запуска

- `/api/health` возвращает успешный ответ.
- Регистрация, выход и повторный вход работают.
- В обучении видны сценарии; 3D открывает сцену и сохраняет таймер после перезагрузки.
- Автор может проверить и опубликовать сценарий.
- `/api/docs/` открывает Swagger, а `/api/docs/overview/index.html` — каталог 57 методов.
- Без ключей Яндекса интерфейс не обещает работающий SpeechKit.

## Проверенный стенд

27 сентября 2026 года приложение развёрнуто на Debian 13 через Docker Compose v2, за Caddy с HTTPS: https://fullstack-vsm.duckdns.org.

Проверены сборка контейнеров с нуля, миграции и демоданные, регистрация → выход → повторный вход, Secure cookie, полный 3D-сценарий из пяти действий, сохранение дедлайна после перезагрузки, запись по пробелу, реальные STT/TTS-запросы, поворот телефона и Swagger с 57 методами. Браузерных ошибок не было. Для записи использовался тестовый аудиофайл; физический микрофон этим не проверяется.
