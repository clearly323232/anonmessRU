# Anonymous Messenger

Анонимный веб-мессенджер с комнатами, перепиской и WebRTC-звонками без регистрации.

## Что уже есть

- анонимный вход по псевдониму без аккаунта
- комнаты по ссылке
- realtime-чат через Socket.IO
- аудио/видео звонки через WebRTC
- адаптивный интерфейс для телефона и ПК
- отдельный signaling-сервер для внешнего деплоя

## Структура

- `src/` — фронтенд на React + Vite
- `backend/` — Node.js signaling/server слой
- `.github/workflows/deploy-pages.yml` — автодеплой фронтенда на GitHub Pages
- `backend/render.yaml` — конфиг деплоя backend на Render

## Локальный запуск

### 1. Фронтенд

```bash
npm install
npm run dev
```

### 2. Backend

```bash
cd backend
npm install
npm run dev
```

По умолчанию фронтенд ждёт backend на `http://localhost:3001`.

## Прод-деплой

### GitHub Pages

1. Создать GitHub-репозиторий.
2. Залить туда содержимое папки проекта.
3. Включить GitHub Pages для GitHub Actions.
4. Добавить секрет репозитория `VITE_SIGNALING_URL` со значением URL backend, например `https://your-signaling.onrender.com`.
5. Запушить в ветку `main`.

### Render

1. Создать новый Web Service из папки `backend/`.
2. Render может прочитать `backend/render.yaml` автоматически.
3. Задать `CLIENT_ORIGIN` как URL GitHub Pages фронтенда.
4. После публикации вставить URL backend в секрет `VITE_SIGNALING_URL` на GitHub.

## Ограничения текущей версии

- текущая реализация звонка ориентирована на 1 активного собеседника за раз внутри комнаты
- история сообщений не хранится после выхода из комнаты
- для production-качества стоит добавить TURN-сервер, rate limit и moderation controls
