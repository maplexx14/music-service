from datetime import timedelta
from typing import List
import base64
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from app.rate_limit import limiter
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User
from app.schemas import (
    CaptchaConfig,
    EmailResendRequest,
    EmailTwoFactorEnableRequest,
    EmailTwoFactorSetupResponse,
    EmailVerifyRequest,
    EmailVerifyResponse,
    LoginResult,
    MfaEmailCodeRequest,
    MfaEmailCodeResponse,
    MfaLoginRequest,
    MessageResponse,
    PasswordResetConfirm,
    PasswordResetRequest,
    PendingRegistrationResponse,
    RevokeAllDevicesResponse,
    Token,
    TrustedDeviceResponse,
    TwoFactorDisableRequest,
    TwoFactorEnableRequest,
    TwoFactorEnableResponse,
    TwoFactorSetupResponse,
    TwoFactorStatus,
    UserCreate,
    UserResponse,
)
from app.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    MFA_TOKEN_EXPIRE_MINUTES,
    create_access_token,
    get_password_hash,
    verify_password,
)
from app.captcha import (
    TURNSTILE_SITE_KEY,
    CaptchaUnavailable,
    captcha_configured,
    verify_captcha,
)
from app.dependencies import get_current_active_user
from app.email_verification import (
    RegistrationAlreadyPending,
    RegistrationNotPending,
    VerificationUnavailable,
    consume_pending_token,
    consume_token,
    create_pending_registration,
    delete_pending_registration,
    get_pending_registration,
    issue_token,
    reissue_pending_token,
    restore_pending_token,
    send_verification_email,
)
from app.email_2fa import (
    EMAIL_CODE_RESEND_COOLDOWN_SEC,
    PURPOSE_ENABLE,
    PURPOSE_LOGIN,
    EmailCodeCooldown,
    EmailCodeUnavailable,
    clear_email_code,
    issue_email_code,
    mask_email,
    send_email_code,
    verify_email_code,
)
from app.password_reset import (
    PasswordResetUnavailable,
    consume_reset_token,
    issue_reset_token,
    send_password_reset_email,
)
from app.two_factor import (
    ReplayCacheUnavailable,
    build_totp_qr_png,
    build_totp_uri,
    check_recovery_code,
    consume_recovery_code,
    consume_totp_code,
    generate_recovery_codes,
    generate_totp_secret,
    hash_recovery_codes,
    verify_totp,
)
from app.trusted_devices import (
    DEVICE_TOKEN_HEADER,
    current_device_id,
    is_trusted_device,
    list_devices,
    remember_device,
    revoke_all_devices,
    revoke_device,
)

router = APIRouter()

logger = logging.getLogger("auth")

MFA_REQUIRED = "2FA code required"
INVALID_CODE = "Invalid 2FA code"
# Отдельная формулировка: «код правильный, но уже использован» — иначе юзер,
# честно вводящий свежий код после реплея, не понимает, почему отказ.
CODE_ALREADY_USED = "This code was already used, wait for a new one"
# Фронт различает этот отказ по коду 403 + этой строке, чтобы показать экран
# «проверьте почту» с кнопкой повторной отправки вместо ошибки логина.
EMAIL_NOT_VERIFIED = "Email not verified"
# Общая формулировка для почтового кода: не различаем «не тот код», «протух» и
# «попытки исчерпаны» — иначе подсказываем перебирающему, где он находится.
INVALID_EMAIL_CODE = "Invalid or expired code"
MAIL_2FA_UNAVAILABLE = "Email 2FA temporarily unavailable"
# Каптча: «токена нет» и «токен не принят» — разные ситуации для фронта.
# Первое чинится перерисовкой виджета, второе — новой попыткой юзера.
CAPTCHA_REQUIRED = "Captcha required"
CAPTCHA_INVALID = "Captcha verification failed"
CAPTCHA_UNAVAILABLE = "Captcha temporarily unavailable"


def _mfa_methods(user: User) -> list[str]:
    """Включённые факторы. Порядок задаёт и порядок проверки в /mfa/verify,
    и то, какой способ фронт предлагает первым: TOTP быстрее письма."""
    methods = []
    if user.totp_enabled:
        methods.append("totp")
    if user.email_2fa_enabled:
        methods.append("email")
    return methods


def _send_login_code(user: User) -> bool:
    """Выслать код входа. True — письмо ушло именно сейчас.

    Cooldown не ошибка: предыдущий код ещё жив, юзеру просто нечего слать.
    Недоступный Redis на шаге логина не роняем — фронт покажет кнопку
    «выслать код», и там ошибка будет видна явно.
    """
    try:
        code = issue_email_code(user.id, PURPOSE_LOGIN)
    except EmailCodeCooldown:
        return False
    except EmailCodeUnavailable:
        logger.warning("email 2FA code storage unavailable for user %s", user.id)
        return False
    sent = send_email_code(user.email, user.username, code, PURPOSE_LOGIN)
    if not sent:
        clear_email_code(user.id, PURPOSE_LOGIN)
    return sent


def _send_verification(user: User) -> None:
    """Выписать токен и отправить письмо. Ошибку Redis не поднимаем: аккаунт
    уже создан/запрос уже принят, а юзеру доступен повторный запрос письма."""
    try:
        token = issue_token(user.id)
    except VerificationUnavailable:
        logger.exception("could not issue verification token for user %s", user.id)
        return
    send_verification_email(user.email, user.username, token)


def _pending_response(username: str, email: str) -> PendingRegistrationResponse:
    return PendingRegistrationResponse(
        username=username,
        email=email,
        full_name=None,
        email_verified=False,
    )


def _issue_access_token(user: User, device_token: str | None = None) -> dict:
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    result = {"access_token": access_token, "token_type": "bearer"}
    if device_token:
        result["device_token"] = device_token
    return result


def _check_captcha(request: Request, token: str | None) -> None:
    """Пропускает дальше только пройденную каптчу.

    Каптча не настроена — шага нет (локальная разработка и тесты; на проде это
    открытая регистрация, см. app.captcha и предупреждение на старте).
    """
    if not captcha_configured():
        return
    if not token:
        raise HTTPException(status_code=400, detail=CAPTCHA_REQUIRED)
    try:
        passed = verify_captcha(
            token, request.client.host if request.client else None
        )
    except CaptchaUnavailable:
        # 503, а не «пропустить»: недоступная проверка не должна быть способом
        # её обойти. Юзеру предлагаем повторить попытку.
        logger.exception("captcha verification unavailable")
        raise HTTPException(status_code=503, detail=CAPTCHA_UNAVAILABLE)
    if not passed:
        raise HTTPException(status_code=400, detail=CAPTCHA_INVALID)


@router.get("/captcha-config", response_model=CaptchaConfig)
def get_captcha_config():
    """Ключ виджета для формы регистрации.

    Отдаём с бэка, а не вшиваем в бандл: ключ публичный, но так фронт и бэк не
    могут разъехаться — виджет появляется ровно тогда, когда на сервере есть
    секрет для проверки токена.
    """
    return CaptchaConfig(
        required=captcha_configured(),
        site_key=TURNSTILE_SITE_KEY or None,
    )


@router.post(
    "/register",
    response_model=PendingRegistrationResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("5/minute")
def register(request: Request, user_data: UserCreate, db: Session = Depends(get_db)):
    # Каптча — ПЕРВЫМ делом, до обращения к БД: иначе эндпоинт отвечает
    # «username занят» кому угодно без прохождения каптчи, то есть остаётся
    # оракулом существования аккаунтов.
    _check_captcha(request, user_data.captcha_token)

    # Check if user already exists
    db_user = db.query(User).filter(
        (User.username == user_data.username) | (User.email == user_data.email)
    ).first()
    if db_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username or email already registered"
        )

    # До подтверждения в SQL ничего не пишем: данные и резервирование
    # username/email живут в Redis ровно столько же, сколько ссылка.
    hashed_password = get_password_hash(user_data.password)
    try:
        pending, token = create_pending_registration(
            user_data.username, user_data.email, hashed_password
        )
    except RegistrationAlreadyPending:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username or email already registered",
        )
    except VerificationUnavailable:
        raise HTTPException(
            status_code=503, detail="Email verification temporarily unavailable"
        )

    send_verification_email(pending.email, pending.username, token)
    return _pending_response(pending.username, pending.email)


@router.post("/login", response_model=LoginResult)
@limiter.limit("10/minute")
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")

    # Почта не подтверждена — вход закрыт. Проверка идёт ПОСЛЕ пароля: иначе
    # эндпоинт отвечал бы по-разному на существующих и несуществующих юзеров,
    # то есть работал бы перебором имён.
    if not user.email_verified:
        raise HTTPException(status_code=403, detail=EMAIL_NOT_VERIFIED)

    # 2FA включена → пароль проверен, но вход не завершён: выдаём короткоживущий
    # mfa_token (в API он не работает — это не access_token), а фронт на его
    # основе вызывает /auth/mfa/verify. Иначе пришлось бы хранить сессию шага.
    methods = _mfa_methods(user)

    # Вход с НЕЗНАКОМОГО устройства требует второй фактор даже у тех, кто 2FA
    # не включал: одного украденного пароля должно быть недостаточно. Фолбэк —
    # код на почту (адрес подтверждён, проверено выше).
    device_token = request.headers.get(DEVICE_TOKEN_HEADER)
    trusted = is_trusted_device(db, user.id, device_token)
    new_device = not trusted
    if new_device:
        # Фактор мог быть не выбран юзером — тогда назначаем почтовый код,
        # иначе шаг подтверждения нечем закрыть.
        methods = _login_methods(user)

    if methods:
        mfa_token_expires = timedelta(minutes=MFA_TOKEN_EXPIRE_MINUTES)
        mfa_token = create_access_token(
            data={"sub": user.username, "mfa": True},
            expires_delta=mfa_token_expires,
        )
        # Письмо отправляем сразу, когда почта — единственный доступный способ
        # (включена только она либо это проверка нового устройства без своей
        # 2FA). Если есть TOTP, юзер обычно им и войдёт — письмо было бы
        # лишним, для него есть /auth/mfa/email/send по кнопке.
        email_code_sent = methods == ["email"] and _send_login_code(user)
        return {
            "mfa_token": mfa_token,
            "mfa_required": True,
            "mfa_methods": methods,
            "email_code_sent": email_code_sent,
            "new_device": new_device,
            "email_masked": mask_email(user.email) if "email" in methods else None,
        }

    return _issue_access_token(user)


@router.post("/forgot-password", response_model=MessageResponse)
@limiter.limit("5/minute")
def forgot_password(
    payload: PasswordResetRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Отправляет ссылку, не раскрывая, зарегистрирован ли адрес."""
    user = db.query(User).filter(func.lower(User.email) == payload.email.lower()).first()
    if user and user.is_active and user.email_verified:
        try:
            token = issue_reset_token(user.id)
        except PasswordResetUnavailable:
            raise HTTPException(status_code=503, detail="Password reset temporarily unavailable")
        send_password_reset_email(user.email, user.username, token)
    return MessageResponse(
        message="Если аккаунт с такой почтой существует, ссылка уже отправлена"
    )


@router.post("/reset-password", response_model=MessageResponse)
@limiter.limit("10/minute")
def reset_password(
    payload: PasswordResetConfirm,
    request: Request,
    db: Session = Depends(get_db),
):
    try:
        user_id = consume_reset_token(payload.token)
    except PasswordResetUnavailable:
        raise HTTPException(status_code=503, detail="Password reset temporarily unavailable")
    if user_id is None:
        raise HTTPException(status_code=400, detail="Invalid or expired password reset link")

    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.is_active:
        raise HTTPException(status_code=400, detail="Invalid or expired password reset link")
    user.hashed_password = get_password_hash(payload.new_password)
    revoke_all_devices(db, user.id)
    db.commit()
    return MessageResponse(message="Пароль изменён")


@router.post("/verify-email", response_model=EmailVerifyResponse)
@limiter.limit("10/minute")
def verify_email(
    payload: EmailVerifyRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Переход по ссылке из письма.

    Токен одноразовый: повторный переход по той же ссылке — 400, «ссылка
    неверна или протухла». Не уточняем, что именно, чтобы не подсказывать
    переборщику, существует ли аккаунт.
    """
    try:
        pending = consume_pending_token(payload.token)
    except VerificationUnavailable:
        raise HTTPException(
            status_code=503, detail="Email verification temporarily unavailable"
        )

    if pending is not None:
        existing = db.query(User).filter(
            (User.username == pending.username) | (User.email == pending.email)
        ).first()
        if existing:
            delete_pending_registration(pending)
            raise HTTPException(
                status_code=400, detail="Username or email already registered"
            )

        user = User(
            username=pending.username,
            email=pending.email,
            hashed_password=pending.hashed_password,
            email_verified=True,
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            delete_pending_registration(pending)
            raise HTTPException(
                status_code=400, detail="Username or email already registered"
            )
        except Exception:
            db.rollback()
            try:
                restore_pending_token(pending, payload.token)
            except VerificationUnavailable:
                logger.exception("could not restore registration token %s", pending.id)
            raise
        delete_pending_registration(pending)
        access = _issue_access_token(user)
        return EmailVerifyResponse(
            email_verified=True,
            access_token=access["access_token"],
            token_type=access["token_type"],
        )

    # Совместимость со ссылками, выписанными старой версией приложения.
    try:
        user_id = consume_token(payload.token)
    except VerificationUnavailable:
        raise HTTPException(
            status_code=503, detail="Email verification temporarily unavailable"
        )

    if user_id is None:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link")

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link")
    if not user.email_verified:
        user.email_verified = True
        db.commit()
    return EmailVerifyResponse(email_verified=True)


@router.post("/resend-verification", response_model=PendingRegistrationResponse)
@limiter.limit("5/minute")
def resend_verification(
    payload: EmailResendRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Повторная отправка письма с экрана «проверьте почту».

    Пароль обязателен (см. EmailResendRequest): иначе перебором username
    любой засыпал бы чужой ящик. issue_token гасит предыдущий токен, так что
    утёкшая первая ссылка не переживает повторную отправку.
    """
    user = db.query(User).filter(User.username == payload.username).first()
    if user:
        if not verify_password(payload.password, user.hashed_password):
            raise HTTPException(status_code=401, detail="Incorrect username or password")
        if user.email_verified:
            raise HTTPException(status_code=400, detail="Email already verified")
        if not user.is_active:
            raise HTTPException(status_code=400, detail="Inactive user")

        # Старые неподтверждённые аккаунты продолжают поддерживаться.
        _send_verification(user)
        return _pending_response(user.username, user.email)

    try:
        pending = get_pending_registration(payload.username)
    except VerificationUnavailable:
        raise HTTPException(
            status_code=503, detail="Email verification temporarily unavailable"
        )
    if not pending or not verify_password(payload.password, pending.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    try:
        token = reissue_pending_token(pending)
    except RegistrationNotPending:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    except VerificationUnavailable:
        raise HTTPException(
            status_code=503, detail="Email verification temporarily unavailable"
        )
    send_verification_email(pending.email, pending.username, token)
    return _pending_response(pending.username, pending.email)


def _resolve_mfa_user(mfa_token: str, db: Session) -> User:
    """Юзер из промежуточного токена шага 2FA.

    verify_mfa_token требует claim "mfa": настоящий access_token сюда не
    пролезет, а mfa_token не пролезет в обычные эндпоинты (см. verify_token).

    Включённые факторы НЕ проверяем: mfa_token выдаётся и на проверку нового
    устройства у юзера без своей 2FA. Сам токен подписан и живёт минуты —
    этого достаточно, чтобы считать шаг легитимным.
    """
    from app.auth import verify_mfa_token

    username = verify_mfa_token(mfa_token)
    if username is None:
        raise HTTPException(status_code=401, detail="Invalid mfa_token")
    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid mfa_token")
    return user


def _login_methods(user: User) -> list[str]:
    """Способы, которыми можно закрыть текущий шаг подтверждения.

    Совпадает с _mfa_methods, но для юзера без своей 2FA (проверка нового
    устройства) добавляет почтовый код — иначе шаг нечем пройти.
    """
    methods = _mfa_methods(user)
    return methods or ["email"]


@router.post("/mfa/email/send", response_model=MfaEmailCodeResponse)
@limiter.limit("5/minute")
def send_mfa_email_code(
    payload: MfaEmailCodeRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Выслать код на почту на втором шаге входа.

    Пароль не спрашиваем: mfa_token уже доказывает, что пароль верен. Защита
    от заваливания ящика — cooldown внутри issue_email_code плюс rate-limit.
    """
    user = _resolve_mfa_user(payload.mfa_token, db)
    # email_2fa_enabled не требуем: почтовый код — ещё и способ подтвердить
    # новое устройство юзеру, который свою 2FA не включал (см. _login_methods).
    if "email" not in _login_methods(user):
        raise HTTPException(status_code=400, detail="Email 2FA is not enabled")

    try:
        code = issue_email_code(user.id, PURPOSE_LOGIN)
    except EmailCodeCooldown as exc:
        # Не ошибка: предыдущий код ещё живой. Фронт покажет, сколько ждать.
        return MfaEmailCodeResponse(
            sent=False,
            email_masked=mask_email(user.email),
            cooldown_seconds=exc.seconds_left,
        )
    except EmailCodeUnavailable:
        raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)

    sent = send_email_code(user.email, user.username, code, PURPOSE_LOGIN)
    if not sent:
        # Код выписан, но доставить его нечем (SMTP не настроен или письмо не
        # ушло). Молчаливое sent=false фронт показал бы как «код уже отправлен»,
        # и юзер ждал бы письма, которого не будет, — на входе с нового
        # устройства это тупик. Говорим прямо.
        logger.error("could not deliver login code to user %s", user.id)
        clear_email_code(user.id, PURPOSE_LOGIN)
        raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)
    return MfaEmailCodeResponse(
        sent=sent,
        email_masked=mask_email(user.email),
        cooldown_seconds=EMAIL_CODE_RESEND_COOLDOWN_SEC,
    )


@router.post("/mfa/verify", response_model=Token)
@limiter.limit("10/minute")
def verify_mfa(
    payload: MfaLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Второй шаг входа: TOTP-код, код из письма или резервный код.

    Успех запоминает устройство и возвращает device_token: следующий вход с
    него пройдёт в один шаг (если юзер не включал свою 2FA).
    """
    user = _resolve_mfa_user(payload.mfa_token, db)

    code = (payload.code or "").strip()
    method = (payload.method or "").strip().lower() or None
    methods = _login_methods(user)

    def _success() -> dict:
        # Токен устройства выдаём ТОЛЬКО здесь — после реально пройденного
        # второго фактора. До этого устройство ничем не подтверждено. Уже
        # знакомому устройству возвращается его же токен (см. remember_device),
        # иначе вход юзера с TOTP каждый раз добавлял бы дубль в список.
        device_token = remember_device(
            db,
            user.id,
            request.headers.get("user-agent"),
            request.headers.get(DEVICE_TOKEN_HEADER),
        )
        return _issue_access_token(user, device_token)

    # Код из письма. Проверяем первым, когда фронт явно назвал способ; иначе
    # порядок не важен — форматы кодов не пересекаются настолько, чтобы
    # чужой код случайно подошёл.
    if "email" in methods and method in (None, "email"):
        try:
            if verify_email_code(user.id, code, PURPOSE_LOGIN):
                return _success()
        except EmailCodeUnavailable:
            raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)
        if method == "email":
            raise HTTPException(status_code=401, detail=INVALID_EMAIL_CODE)

    if user.totp_enabled and method in (None, "totp"):
        if verify_totp(user.totp_secret or "", code):
            # Код верный криптографически — теперь гасим его, чтобы тот же код
            # нельзя было предъявить ещё раз в пределах его 90-секундного окна.
            try:
                if not consume_totp_code(user.id, code):
                    raise HTTPException(status_code=401, detail=CODE_ALREADY_USED)
            except ReplayCacheUnavailable:
                # Без Redis гарантию одноразовости не дать. Пускать нельзя —
                # это ровно та дыра, которую закрывает кеш.
                raise HTTPException(status_code=503, detail="2FA temporarily unavailable")
            return _success()

    # Резервные коды работают при любом включённом факторе: это запасной вход,
    # когда недоступны ни телефон, ни почта.
    if check_recovery_code(user.totp_recovery_codes or [], code):
        # bcrypt не говорит, какой хэш совпал, — вычищаем отдельным проходом.
        user.totp_recovery_codes = consume_recovery_code(user.totp_recovery_codes or [], code)
        db.commit()
        return _success()

    raise HTTPException(status_code=401, detail=INVALID_CODE)


@router.get("/me", response_model=UserResponse)
async def read_users_me(current_user: User = Depends(get_current_active_user)):
    return current_user


@router.get("/2fa/status", response_model=TwoFactorStatus)
def get_two_factor_status(
    current_user: User = Depends(get_current_active_user),
):
    """Текущее состояние 2FA. Показываем незавершённый секрет (setup без
    enable): после перезагрузки страницы настроек QR должен быть доступен
    снова, а не протухать в никуда."""
    if not current_user.totp_enabled and current_user.totp_secret:
        return TwoFactorStatus(
            totp_enabled=False,
            totp_secret=current_user.totp_secret,
            otpauth_url=build_totp_uri(current_user.username, current_user.totp_secret),
            email_2fa_enabled=current_user.email_2fa_enabled,
            email_masked=mask_email(current_user.email),
        )
    return TwoFactorStatus(
        totp_enabled=current_user.totp_enabled,
        email_2fa_enabled=current_user.email_2fa_enabled,
        email_masked=mask_email(current_user.email),
    )


@router.post("/2fa/setup", response_model=TwoFactorSetupResponse)
def setup_two_factor(
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Новый TOTP-секрет + QR. Каждый вызов перегенерирует секрет и
    инвалидирует предыдущий незавершённый setup. Если 2FA уже включена — 409:
    секрет нельзя сменить, не выключив (иначе кража сессии = смена фактора).

    QR рисуем на бэке: у фронта нет QR-библиотеки в зависимостях, а тянуть её
    ради одного экрана дороже, чем отдать готовый PNG.
    """
    if current_user.totp_enabled:
        raise HTTPException(status_code=409, detail="2FA is already enabled")
    secret = generate_totp_secret()
    current_user.totp_secret = secret
    db.commit()
    uri = build_totp_uri(current_user.username, secret)
    png = base64.b64encode(build_totp_qr_png(uri)).decode("ascii")
    return TwoFactorSetupResponse(
        totp_secret=secret,
        otpauth_url=uri,
        qr_png=f"data:image/png;base64,{png}",
    )


@router.post("/2fa/enable", response_model=TwoFactorEnableResponse)
@limiter.limit("10/minute")
def enable_two_factor(
    payload: TwoFactorEnableRequest,
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Подтверждение включения: TOTP-код + пароль.

    Пароль — переподтверждение опасной операции (вход станет двухшаговым).
    Код доказывает, что секрет реально отсканирован в приложение, а не
    сгенерирован мимо. Возвращает одноразовые резервные коды."""
    if current_user.totp_enabled:
        raise HTTPException(status_code=409, detail="2FA is already enabled")
    if not current_user.totp_secret:
        raise HTTPException(status_code=400, detail="Run /2fa/setup first")
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect password")
    if not verify_totp(current_user.totp_secret, payload.code):
        raise HTTPException(status_code=400, detail=INVALID_CODE)
    # Гасим и здесь: иначе кодом, который юзер только что ввёл при включении,
    # можно тут же пройти mfa/verify. Redis недоступен — включение отклоняем,
    # включать 2FA без работающей защиты от повтора смысла нет.
    try:
        if not consume_totp_code(current_user.id, payload.code):
            raise HTTPException(status_code=400, detail=CODE_ALREADY_USED)
    except ReplayCacheUnavailable:
        raise HTTPException(status_code=503, detail="2FA temporarily unavailable")

    codes = generate_recovery_codes()
    current_user.totp_enabled = True
    current_user.totp_recovery_codes = hash_recovery_codes(codes)
    db.commit()
    return TwoFactorEnableResponse(recovery_codes=codes)


@router.post("/2fa/disable", response_model=TwoFactorStatus)
@limiter.limit("10/minute")
def disable_two_factor(
    payload: TwoFactorDisableRequest,
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect password")
    current_user.totp_enabled = False
    current_user.totp_secret = None
    current_user.totp_recovery_codes = []
    db.commit()
    return TwoFactorStatus(
        totp_enabled=False,
        email_2fa_enabled=current_user.email_2fa_enabled,
        email_masked=mask_email(current_user.email),
    )


@router.post("/2fa/email/setup", response_model=EmailTwoFactorSetupResponse)
@limiter.limit("5/minute")
def setup_email_two_factor(
    request: Request,
    current_user: User = Depends(get_current_active_user),
):
    """Шаг 1 включения почтовой 2FA: выслать код на адрес юзера.

    Требуем подтверждённую почту: включать фактор на адрес, которым юзер не
    владеет, — верный способ запереть себя снаружи.
    """
    if current_user.email_2fa_enabled:
        raise HTTPException(status_code=400, detail="Email 2FA is already enabled")
    if not current_user.email_verified:
        raise HTTPException(status_code=400, detail=EMAIL_NOT_VERIFIED)

    try:
        code = issue_email_code(current_user.id, PURPOSE_ENABLE)
    except EmailCodeCooldown as exc:
        return EmailTwoFactorSetupResponse(
            sent=False,
            email_masked=mask_email(current_user.email),
            cooldown_seconds=exc.seconds_left,
        )
    except EmailCodeUnavailable:
        raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)

    sent = send_email_code(current_user.email, current_user.username, code, PURPOSE_ENABLE)
    if not sent:
        # Как и на входе: «отправили» без письма — обещание, которое некому
        # выполнить. Фактор, код к которому не доставляется, включать нельзя.
        logger.error("could not deliver enable code to user %s", current_user.id)
        clear_email_code(current_user.id, PURPOSE_ENABLE)
        raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)
    return EmailTwoFactorSetupResponse(
        sent=sent,
        email_masked=mask_email(current_user.email),
        cooldown_seconds=EMAIL_CODE_RESEND_COOLDOWN_SEC,
    )


@router.post("/2fa/email/enable", response_model=TwoFactorStatus)
@limiter.limit("10/minute")
def enable_email_two_factor(
    payload: EmailTwoFactorEnableRequest,
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Шаг 2: код из письма + пароль. Пароль — как у TOTP: включение фактора
    меняет условия входа, одной живой сессии для этого мало."""
    if current_user.email_2fa_enabled:
        raise HTTPException(status_code=400, detail="Email 2FA is already enabled")
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect password")

    try:
        if not verify_email_code(current_user.id, (payload.code or "").strip(), PURPOSE_ENABLE):
            raise HTTPException(status_code=400, detail=INVALID_EMAIL_CODE)
    except EmailCodeUnavailable:
        raise HTTPException(status_code=503, detail=MAIL_2FA_UNAVAILABLE)

    current_user.email_2fa_enabled = True
    db.commit()
    return TwoFactorStatus(
        totp_enabled=current_user.totp_enabled,
        email_2fa_enabled=True,
        email_masked=mask_email(current_user.email),
    )


@router.post("/2fa/email/disable", response_model=TwoFactorStatus)
@limiter.limit("10/minute")
def disable_email_two_factor(
    payload: TwoFactorDisableRequest,
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect password")
    current_user.email_2fa_enabled = False
    db.commit()
    # Выданный код входа больше ни к чему — не оставляем его дожидаться TTL.
    clear_email_code(current_user.id, PURPOSE_LOGIN)
    return TwoFactorStatus(
        totp_enabled=current_user.totp_enabled,
        email_2fa_enabled=False,
        email_masked=mask_email(current_user.email),
    )


@router.get("/devices", response_model=List[TrustedDeviceResponse])
def get_trusted_devices(
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Устройства, которым доверяет аккаунт. Текущее помечено current=true —
    фронт не предлагает отозвать доверие «под собой»."""
    this_device = current_device_id(
        db, current_user.id, request.headers.get(DEVICE_TOKEN_HEADER)
    )
    return [
        TrustedDeviceResponse(**device, current=device["id"] == this_device)
        for device in list_devices(db, current_user.id)
    ]


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_trusted_device(
    device_id: int,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """Отзывает доверие устройству: следующий вход с него потребует код.

    404 и для чужого устройства тоже — не подтверждаем существование id,
    который юзеру не принадлежит.
    """
    if not revoke_device(db, current_user.id, device_id):
        raise HTTPException(status_code=404, detail="Device not found")


@router.post("/devices/revoke-all", response_model=RevokeAllDevicesResponse)
@limiter.limit("5/minute")
def revoke_other_devices(
    request: Request,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db),
):
    """«Забыть все устройства, кроме текущего».

    Текущее сохраняем: иначе кнопка выкидывала бы юзера из браузера, в котором
    он её нажал, и попытка вышибить чужой доступ превращалась бы в самоблок.
    """
    revoked = revoke_all_devices(
        db, current_user.id, keep_token=request.headers.get(DEVICE_TOKEN_HEADER)
    )
    return RevokeAllDevicesResponse(revoked=revoked)
