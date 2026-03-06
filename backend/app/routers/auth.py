from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.database import get_db
from app.models import User
from app.schemas import Token, UserCreate, UserResponse, VerifyEmailRequest, ResendCodeRequest
from app.auth import verify_password, get_password_hash, create_access_token, ACCESS_TOKEN_EXPIRE_MINUTES
from app.dependencies import get_current_active_user
from app.email_service import (
    generate_code,
    store_verification_code,
    get_verification_code,
    delete_verification_code,
    send_verification_email,
)

router = APIRouter()


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(user_data: UserCreate, db: AsyncSession = Depends(get_db)):
    # Check if user already exists
    result = await db.execute(
        select(User).filter(
            (User.username == user_data.username) | (User.email == user_data.email)
        )
    )
    db_user = result.scalars().first()
    if db_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username or email already registered"
        )
    
    # Create new user (not verified yet)
    hashed_password = get_password_hash(user_data.password)
    db_user = User(
        username=user_data.username,
        email=user_data.email,
        hashed_password=hashed_password,
        full_name=user_data.full_name,
        is_email_verified=False,
    )
    db.add(db_user)
    await db.commit()
    await db.refresh(db_user)

    # Generate and send verification code
    code = generate_code()
    await store_verification_code(user_data.email, code)
    await send_verification_email(user_data.email, code)

    return db_user


@router.post("/verify-email")
async def verify_email(data: VerifyEmailRequest, db: AsyncSession = Depends(get_db)):
    """Verify user's email with a code sent to them"""
    stored_code = await get_verification_code(data.email)
    if not stored_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Код истёк или не был отправлен. Запросите новый код."
        )
    
    if stored_code != data.code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Неверный код подтверждения"
        )
    
    # Mark user as verified
    result = await db.execute(select(User).filter(User.email == data.email))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    
    user.is_email_verified = True
    await db.commit()
    await delete_verification_code(data.email)

    return {"message": "Email успешно подтверждён"}


@router.post("/resend-code")
async def resend_verification_code(data: ResendCodeRequest, db: AsyncSession = Depends(get_db)):
    """Resend verification code to user's email"""
    result = await db.execute(select(User).filter(User.email == data.email))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    
    if user.is_email_verified:
        raise HTTPException(status_code=400, detail="Email уже подтверждён")

    code = generate_code()
    await store_verification_code(data.email, code)
    await send_verification_email(data.email, code)

    return {"message": "Код повторно отправлен"}


@router.post("/login", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(User).filter(User.username == form_data.username))
    user = result.scalars().first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    
    # Check email verification
    if not user.is_email_verified:
        # Send a new code automatically
        code = generate_code()
        await store_verification_code(user.email, code)
        await send_verification_email(user.email, code)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="email_not_verified",
            headers={"X-Verify-Email": user.email},
        )
    
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me", response_model=UserResponse)
async def read_users_me(current_user: User = Depends(get_current_active_user)):
    return current_user
