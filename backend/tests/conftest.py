import os

os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("DATABASE_URL", "sqlite://")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import User
from app.auth import get_password_hash

engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    app.state.limiter.reset()
    yield


@pytest.fixture(autouse=True)
def _reset_totp_replay_cache():
    """Ключи «код уже использован» живут 90 с в общем Redis и переживают
    конец теста. Без очистки повторный прогон падает: тот же юзер с тем же
    секретом в том же временном окне получает свой код как использованный."""
    from app.cache import clear_pattern

    clear_pattern("2fa:used:*")
    yield
    clear_pattern("2fa:used:*")


@pytest.fixture(autouse=True)
def _reset_email_verification_tokens():
    """Токены и незавершённые регистрации живут 24 ч в общем Redis."""
    from app.cache import clear_pattern

    clear_pattern("email:verify:*")
    clear_pattern("email:registration:*")
    yield
    clear_pattern("email:verify:*")
    clear_pattern("email:registration:*")


@pytest.fixture(autouse=True)
def _reset_email_2fa_codes():
    """Коды входа, счётчики попыток и cooldown почтовой 2FA (TTL до 10 мин).
    Тот же повод, что у токенов подтверждения: sqlite выдаёт id с 1 каждому
    тесту, а cooldown от прошлого теста иначе запрещает выслать новый код."""
    from app.cache import clear_pattern

    clear_pattern("2fa:mail:*")
    yield
    clear_pattern("2fa:mail:*")


@pytest.fixture(autouse=True)
def _reset_password_tokens():
    """Ссылки восстановления одноразовые, но живут между тестами до часа."""
    from app.cache import clear_pattern

    clear_pattern("password:reset:*")
    yield
    clear_pattern("password:reset:*")


@pytest.fixture(autouse=True)
def _reset_ytdlp_bot_check_backoff():
    """Глобальный бэкофф bot-check'а YouTube живёт в памяти процесса 3 минуты
    и переживает конец теста. Без сброса тест, который его открыл, ломает все
    последующие: резолв уходит в ветку «только Invidious» и не зовёт yt-dlp,
    хотя тест ждёт именно его."""
    from app.routers import ytdlp

    ytdlp._bot_check_until = 0.0
    yield
    ytdlp._bot_check_until = 0.0


@pytest.fixture()
def db():
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def create_user(db, username="alice", password="password123", is_admin=False,
                email_verified=True):
    # email_verified=True по умолчанию: почти всем тестам нужен юзер, который
    # может войти, а без подтверждения /login отдаёт 403. Тесты самого
    # подтверждения передают False явно.
    user = User(
        username=username,
        email=f"{username}@example.com",
        hashed_password=get_password_hash(password),
        is_admin=is_admin,
        email_verified=email_verified,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def trust_device(db, user_id: int, label="Тестовое устройство") -> str:
    """Делает устройство доверенным и возвращает его токен для заголовка.

    Пройти реальный шаг подтверждения в тесте нельзя: код лежит в Redis
    bcrypt-хэшем и обратно не достаётся. Тестам, которым нужен именно
    одношаговый вход, проще записать доверие напрямую — сам механизм
    подтверждения покрыт в test_trusted_devices.py.
    """
    from app.models import user_trusted_devices
    from app.trusted_devices import generate_device_token, hash_device_token

    token = generate_device_token()
    db.execute(
        user_trusted_devices.insert().values(
            user_id=user_id,
            token_hash=hash_device_token(token),
            label=label,
        )
    )
    db.commit()
    return token


def auth_headers(client, username="alice", password="password123"):
    """Заголовок с полноценным access-токеном, в обход /login.

    Через /login больше нельзя: вход с незнакомого устройства требует второй
    фактор (см. trusted_devices), а в тесте его нечем закрыть — код к письму
    не достать. Тестам ниже нужен просто авторизованный запрос, поэтому токен
    выписываем напрямую; сам вход проверяется в test_two_factor.py,
    test_email_2fa.py и test_trusted_devices.py.
    """
    from app.auth import create_access_token

    return {"Authorization": f"Bearer {create_access_token({'sub': username})}"}
