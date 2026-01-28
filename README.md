# Music Streaming Application

Веб-приложение для прослушивания музыки, похожее на Spotify или Yandex Music.

## Технологии

- **Backend**: Python FastAPI
- **Frontend**: React (Vite)
- **База данных**: PostgreSQL
- **Кэш**: Redis
- **Контейнеризация**: Docker & Docker Compose

## Функциональность

- ✅ Регистрация и аутентификация пользователей
- ✅ Поиск треков, плейлистов и пользователей
- ✅ Создание и управление плейлистами
- ✅ Система рекомендаций на основе предпочтений пользователя
- ✅ Лайки треков
- ✅ Воспроизведение музыки
- ✅ Отслеживание популярности треков
- ✅ Загрузка собственных треков (MP3, WAV, FLAC, M4A, OGG, AAC)

## Структура проекта

```
bolt/
├── backend/          # FastAPI приложение
│   ├── app/
│   │   ├── routers/  # API endpoints
│   │   ├── models.py # Модели базы данных
│   │   ├── schemas.py # Pydantic схемы
│   │   └── main.py   # Точка входа
│   └── Dockerfile
├── frontend/         # React приложение
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── store/
│   │   └── services/
│   └── Dockerfile
└── docker-compose.yml
```

## Быстрый старт

### Требования

- Docker и Docker Compose
- Git

### Установка и запуск

1. Клонируйте репозиторий (или используйте текущую директорию):
```bash
cd bolt
```

2. Запустите все сервисы с помощью Docker Compose:
```bash
docker-compose up --build
```

Это запустит:
- PostgreSQL на порту 5432
- Redis на порту 6379
- Backend API на http://localhost:8000
- Frontend на http://localhost:3000

3. Откройте браузер и перейдите на http://localhost:3000

### Остановка

```bash
docker-compose down
```

Для полной очистки (включая данные):
```bash
docker-compose down -v
```

## API Endpoints

### Аутентификация
- `POST /api/auth/register` - Регистрация
- `POST /api/auth/login` - Вход
- `GET /api/auth/me` - Текущий пользователь

### Треки
- `GET /api/tracks` - Список треков
- `GET /api/tracks/{id}` - Детали трека
- `POST /api/tracks` - Создать трек (ручной ввод)
- `POST /api/tracks/upload` - Загрузить трек (файл + метаданные)
- `POST /api/tracks/{id}/like` - Лайкнуть трек
- `DELETE /api/tracks/{id}/like` - Убрать лайк
- `GET /api/tracks/me/liked` - Понравившиеся треки

### Плейлисты
- `GET /api/playlists` - Список плейлистов
- `GET /api/playlists/me` - Мои плейлисты
- `GET /api/playlists/{id}` - Детали плейлиста
- `POST /api/playlists` - Создать плейлист
- `PUT /api/playlists/{id}` - Обновить плейлист
- `DELETE /api/playlists/{id}` - Удалить плейлист
- `POST /api/playlists/{id}/tracks/{track_id}` - Добавить трек
- `DELETE /api/playlists/{id}/tracks/{track_id}` - Удалить трек

### Поиск
- `GET /api/search?q=query` - Поиск

### Рекомендации
- `GET /api/recommendations` - Персонализированные рекомендации

## Разработка

### Backend (без Docker)

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend (без Docker)

```bash
cd frontend
npm install
npm run dev
```

## Добавление музыки

### Через веб-интерфейс
1. Войдите в систему
2. Перейдите в раздел "Загрузить трек" в боковом меню
3. Выберите аудио файл (MP3, WAV, FLAC, M4A, OGG, AAC)
4. Заполните метаданные (название, исполнитель, альбом, жанр)
5. Нажмите "Загрузить трек"

### Через API
Для программного добавления треков используйте endpoint:
```bash
POST /api/tracks/upload
Content-Type: multipart/form-data

file: [аудио файл]
title: "Название трека"
artist: "Исполнитель"
album: "Альбом" (опционально)
genre: "Pop" (опционально)
duration: 180 (опционально, в секундах)
```

Или используйте ручной endpoint:
```bash
POST /api/tracks
{
  "title": "Название трека",
  "artist": "Исполнитель",
  "album": "Альбом",
  "duration": 180,
  "file_path": "/music_files/filename.mp3",
  "genre": "Pop"
}
```

## Примечания

- В production измените `SECRET_KEY` в `docker-compose.yml`
- Настройте CORS для вашего домена
- Добавьте обработку загрузки файлов для музыки
- Настройте статическую раздачу файлов для аудио

## Лицензия

MIT
