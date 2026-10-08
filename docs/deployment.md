# Развёртывание

## Docker Compose

`compose.demo.yml` содержит только Next.js, NestJS и Caddy; учебные данные непостоянные. `compose.yml` — реальный режим с PostgreSQL, Redis, S3, Weaviate и двумя Python-сервисами. Внешним остаётся только порт Caddy на localhost:8080. Для удалённого доступа используйте TLS reverse proxy и соответствующий `APP_ORIGIN`: getUserMedia требует защищённого контекста, кроме localhost.

Образы web/API многостадийные и работают от непривилегированного пользователя. Python entrypoint создаёт каталоги моделей с владельцем worker и запускает uvicorn через gosu. Веса сохраняются в отдельных volumes. MinIO предназначен для локального стенда; в размещённом пилоте можно использовать любой совместимый закрытый S3.

Миграции: `docker compose --env-file .env.production.local run --rm migrate`.

Проверка: `docker compose --env-file .env.production.local exec api node dist/cli.js check`.

Логи: `docker compose --env-file .env.production.local logs --tail=100 api speech knowledge`.

Порты PostgreSQL, Redis, S3 и Weaviate не опубликованы на хост. Не включайте `DEMO_MODE=true` для реальных данных. Production-сервер дополнительно блокирует деморежим без явного `ALLOW_PUBLIC_DEMO=true`.

## Coolify: первый пилот на один разговор

### Сервер

Первый запуск: один активный разговор на обычном CPU-сервере Linux x86-64 (Ubuntu 22.04/24.04), без GPU. Отправная конфигурация полного стека: 8 выделенных vCPU, 32 ГБ RAM, SSD NVMe 150–200 ГБ. Это оценка для первого теста, а не измеренная гарантия задержки. Используйте `compose.coolify.yml`; `SPEECH_MAX_SESSIONS=1` ограничивает speech одной сессией.

Qwen/Kimi и KEV вызываются через OpenRouter, Voxtral — через Mistral API. Локально на CPU работают диаризация Diart/pyannote/WeSpeaker, BGE-M3/reranker, Docling и базы. Веса LLM и Voxtral на сервер не загружаются. У Diart есть [опубликованные CPU-измерения](https://github.com/juanmc2005/diart/blob/main/README.md); они подтверждают возможность CPU-обработки, но не заменяют измерения нашего полного приложения на выбранном VPS.

Для первого запуска дождитесь индексации источников до начала разговора. Измерьте задержку и отставание аудио на своём микрофоне. Цель p95 ≤ 6 секунд ещё не измерена. Расширение до десяти разговоров остаётся следующим этапом: потребуется отдельный нагрузочный тест и настройка CPU-обработки/маршрутизации сессий.

Записи сохраняются как mono PCM WAV 16 кГц / 16 бит: примерно 115 МБ на час одного микрофона. 1 × 8 часов × 30 дней ≈ 28 ГБ аудио, плюс модели, документы, образы и базы. Подстройте диск под реальное время работы. Сделайте резервное копирование PostgreSQL и Garage на другой сервер/хранилище: одноузловой Garage не имеет репликации.

### 1. Ключи внешних сервисов

1. **OpenRouter**: войдите в [Settings → API keys](https://openrouter.ai/settings/keys), создайте обычный API-ключ `sufler`, задайте лимит расходов и пополните баланс. Сохраните как `OPENROUTER_API_KEY`. Один ключ используется для KEV, Qwen и Kimi. [Документация](https://openrouter.ai/docs/quickstart).
2. **Mistral Studio**: откройте [консоль](https://console.mistral.ai), `API Keys → Create new key`, задайте имя и срок, скопируйте ключ сразу. Это `MISTRAL_API_KEY`. Проверьте доступ аккаунта к Voxtral Realtime и лимиты; наличие бесплатного ключа не гарантирует доступную квоту realtime. [Инструкция](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key).
3. **Hugging Face**: войдите и примите условия доступа на странице [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0). Затем [Settings → Access Tokens](https://huggingface.co/settings/tokens) → новый токен с правами Read; для fine-grained разрешите чтение gated-моделей, к которым аккаунт получил доступ. Сохраните как `HF_TOKEN`. Это доступ к скачиванию весов диаризации, а не платный API распознавания. [Права токенов](https://huggingface.co/docs/hub/security-tokens).

### 2. Локальные секреты и env

Из корня проекта:

```sh
node scripts/init-coolify-env.mjs
```

Создаётся `.env.coolify.local` с правами 0600; повторный запуск не перезаписывает файл. Если файл уже создан, откройте его. Генератор создаёт независимые секреты PostgreSQL, Better Auth, внутренних сервисов, Weaviate, Garage и S3. Покупать или регистрировать эти ключи нигде не нужно. `WEAVIATE_API_KEY` защищает свой локальный Weaviate. S3 находится в Garage внутри той же Compose-конфигурации; bucket `sufler` и доступ создаются при первом запуске.

Заполните только `APP_ORIGIN=https://ваш-домен` (без завершающего `/`) и три внешних ключа выше. Все остальные значения оставьте. `.env.coolify.local` игнорируется Git; не публикуйте его. Секреты задаются только серверным контейнерам. После создания bucket не меняйте S3-ключи через env как способ ротации — существующие ключи Garage требуют отдельного управления.

### 3. Репозиторий

Если репозитория ещё нет, из `/Users/shamil/Desktop/sufler`:

```sh
git init -b main
git add .
git status --short
```

Убедитесь, что `.env`, `.env.coolify.local`, `.env.production.local` отсутствуют в staged-файлах. Затем:

```sh
git commit -m "Initial Sufler pilot"
gh auth login
gh repo create sufler --private --source=. --remote=origin --push
```

Команды выполняете вы под своим GitHub-аккаунтом; проект пока не опубликован. Если репозиторий уже существует, используйте его origin и обычный commit/push вместо повторной инициализации.

### 4. Проект в Coolify

1. В Coolify подключите обычный CPU-сервер в **Servers** и проверьте доступ по SSH/работоспособность Docker. Можно использовать текущий сервер Coolify, если у него достаточно свободных CPU, RAM и диска.
2. В **Sources** подключите GitHub App и разрешите доступ к приватному репозиторию `sufler`.
3. **Projects → Add project → Sufler**, выберите environment, например `production`, затем **Add resource → Application** из GitHub. Выберите репозиторий, ветку `main` и сервер.
4. Выберите build strategy **Docker Compose** (в некоторых версиях — Build Pack). Base Directory: `/`. Docker Compose Location: `/compose.coolify.yml`. Raw Compose deployment оставьте выключенным.
5. В **Environment Variables** импортируйте значения `.env.coolify.local` через редактор env, сохраните. Не добавляйте `DATABASE_URL`/`S3_ENDPOINT` с localhost: внутренние адреса уже заданы в Compose.
6. В DNS создайте A-запись домена на IP сервера. В доменах Compose назначьте HTTPS-домен **только сервису gateway**, внутренний порт **8080** (в поле Domains он может задаваться как `https://ваш-домен:8080`). Посетитель открывает обычный HTTPS-адрес без `:8080`; это внутренний порт proxy. Он должен совпадать с `APP_ORIGIN`. Откройте внешние 80/443; базы и worker-сервисы не публикуйте.
7. Нажмите **Deploy**. Сборка Python-образов и первая загрузка моделей диаризации и поиска могут занимать значительное время. Проверьте логи `migrate`, `garage`, `speech`, `knowledge`, `api`. `migrate` должен завершиться с кодом 0; остальные сервисы остаются работать. Проверьте persistent volumes для баз, Garage и моделей. Не удаляйте их при redeploy.

[Compose в Coolify](https://coolify.io/docs/applications/builds/docker-compose). Garage настроен по [официальному quickstart](https://garagehq.deuxfleurs.fr/documentation/quick-start/).

### 5. Первый владелец и проверка

В ресурсе Coolify откройте **Terminal**, выберите контейнер **api**, подключитесь к `/bin/bash`. Выполните блок; пароль будет введён скрыто и не попадёт в текст команды:

```bash
read -r -p 'Email: ' BOOTSTRAP_EMAIL
read -r -p 'Имя: ' BOOTSTRAP_NAME
read -r -p 'Организация: ' BOOTSTRAP_ORG
read -r -s -p 'Пароль (от 12 символов): ' BOOTSTRAP_PASSWORD
printf '\n'
export BOOTSTRAP_EMAIL BOOTSTRAP_NAME BOOTSTRAP_ORG BOOTSTRAP_PASSWORD
node dist/cli.js bootstrap
unset BOOTSTRAP_EMAIL BOOTSTRAP_NAME BOOTSTRAP_ORG BOOTSTRAP_PASSWORD
```

Затем:

```sh
node dist/cli.js check
```

Команда делает небольшие платные тестовые запросы к трём LLM и проверяет health Python-сервисов. Она не заменяет проверку KEV на русском и реального аудио в Voxtral. Для проверки выбранного устройства в том же API-terminal:

```sh
node -e 'fetch(process.env.SPEECH_URL+"/health",{headers:{"X-Internal-Token":process.env.INTERNAL_SERVICE_TOKEN}}).then(async r=>{if(!r.ok)throw Error("speech HTTP "+r.status);console.log(await r.json())}).catch(()=>{console.error("speech unavailable");process.exitCode=1})'
```

Ожидается `device: 'cpu'`. GPU и NVIDIA Toolkit для этого запуска не нужны. Откройте `/admin/login` и войдите созданным владельцем. `/admin/models`: проверьте Qwen3.5-9B, оставьте его по умолчанию; другие модели включайте после проверки подключения. В `/admin/users` создайте личные учётные записи консультантов.

### 6. Источники и процессы

1. `/admin/knowledge`: загрузите PDF/DOCX/Markdown/TXT или CSV-каталог, либо нажмите **Добавить материал** для ручного текста.
2. Дождитесь окончания обработки. Загрузка сама по себе не публикует знания.
3. **Открыть**: проверьте исходное содержание и подготовленные блоки; задайте название, тип, направление, регион и даты действия. **Intent · ключ сценария** задайте явно, например `sim_replacement` / `tariff_selection`; импортированный `unknown` не подходит как рабочий справочник намерений.
4. Для процесса проверьте шаги, условия, документы и исключения по регламенту своей организации. Обязательное действие подтверждает сотрудник; обсуждение не равно выполнению. В CSV проверьте цены и дату каталога; доступность остаётся требующей уточнения.
5. **Сохранить черновик → Публикация**. При публикации фрагменты индексируются через BGE-M3 в Weaviate и становятся доступны RAG. Для первого запуска используйте 3–5 небольших проверенных материалов, а не всю базу сразу. Первичная индексация и запросы моделей знаний используют CPU; закончите загрузку до нагрузочного теста.
6. В `/app` проверьте текстовое обращение: подсказка должна ссылаться на опубликованный источник. Затем проверьте неизвестный вопрос: без подходящего источника фактического ответа быть не должно.

### 7. Голос и нагрузка

Откройте `/app` в Chrome по HTTPS, разрешите микрофон, выберите устройство в настройках и нажмите **Записать мой голос · 25 с**. Записывайте чистую речь консультанта; затем запустите консультацию. Проверьте назначение клиентского голоса, постороннюю речь, перекрытие, новый клиент и смену модели. После рестарта speech голосовой профиль потребуется записать заново.

Для текущего пилота проверьте один микрофон/аккаунт: задержку после окончания речи и после подтверждения реплики, отставание обработки, расход RAM/CPU, посторонних говорящих и ошибки API. Для будущего расширения вручную измените `SPEECH_MAX_SESSIONS`, затем проверяйте 2 → 5 → 10 потоков. Не увеличивайте число replicas без маршрутизации сессий — профили пока хранятся в RAM.

Типовые ошибки: HF 401/403 — условия модели не приняты тем же аккаунтом или нет прав токена; Mistral/OpenRouter 429 — квоты или баланс; пустой RAG — нет опубликованных действующих материалов с подходящим intent/регионом; ошибка публикации — knowledge ещё загружает модели либо недоступен Weaviate; микрофон недоступен — HTTPS или разрешения Chrome; auth redirect/CORS — домен отличается от `APP_ORIGIN`.

### Проверки этой поставки

CPU-конфигурация Coolify проходит `docker compose config --quiet`. Garage проверен настоящим AWS SDK: upload/get/delete, отказ неверному ключу и сохранность после пересоздания контейнера. В CPU-образе проверены импорт speech и выбор CPU. Реальное качество диаризации, внешние API и задержка первого разговора требуют измерений на CPU-сервере с ключами пользователя.

## Fly.io

В `deploy/fly` находятся шаблоны для `gateway`, `web`, `api`, `speech`, `knowledge`. Они не создают инфраструктуру автоматически и ещё не означают опубликованный сервис. Переименуйте `your-team` во всех app/env, выберите общий регион и создайте приложения в одной Fly organization.

Только gateway имеет публичный HTTP service. Он обслуживает HTTPS-адрес приложения и проксирует `/api/*`, включая WebSocket, в NestJS через private network; остальное — в Next.js. Web/API/speech/knowledge слушают IPv6 и доступны по `.internal`. Держите по одному экземпляру API и speech, без автозасыпания: голосовой образец и активная маршрутизация хранятся в памяти процесса.

Вручную подготовьте PostgreSQL, Redis, закрытый S3 и Weaviate, доступные приложению. Передайте secrets через `fly secrets set`/защищённый env import, а не в TOML:

| Приложение | Секреты |
| --- | --- |
| api | DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, INTERNAL_SERVICE_TOKEN, OPENROUTER_API_KEY, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY |
| speech | INTERNAL_SERVICE_TOKEN, MISTRAL_API_KEY, HF_TOKEN |
| knowledge | INTERNAL_SERVICE_TOKEN, WEAVIATE_URL, WEAVIATE_API_KEY |

Для S3 проверьте `S3_FORCE_PATH_STYLE` у выбранного провайдера. Все Python-сервисы и NestJS должны использовать одинаковый `INTERNAL_SERVICE_TOKEN`.

Создайте volumes `speech_models` и `knowledge_models` в выбранном регионе. Развёртывайте из корня репозитория:

```sh
fly deploy --config deploy/fly/web.toml
fly deploy --config deploy/fly/knowledge.toml
fly deploy --config deploy/fly/speech.toml
fly deploy --config deploy/fly/api.toml
fly deploy --config deploy/fly/gateway.toml
```

Release command API применит миграции. Начального владельца создайте через CLI в API-контейнере с временными переменными `BOOTSTRAP_*`; после bootstrap удалите пароль из secrets. RAM/CPU в TOML — отправная точка, не подтверждённая нагрузочная конфигурация. Нужны мониторинг памяти, времени ASR/классификации/RAG, длины очереди, отказов источников и retention jobs.

Инструкция опирается на [private networking Fly.io](https://fly.io/docs/networking/private-networking/) и [конфигурацию приложений](https://fly.io/docs/reference/configuration/).
