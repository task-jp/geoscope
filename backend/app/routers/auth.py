"""Authentication endpoints: Google OAuth login."""

import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])

PROVIDERS = {
    "google": {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
    },
}

# OAuth state (CSRF protection) は uvicorn --workers 4 でプロセス間共有するため Valkey に保存。
_STATE_TTL_SECONDS = 600
_STATE_KEY_PREFIX = "oauth_state:"


async def _store_state(state: str) -> None:
    r = aioredis.from_url(settings.valkey_url)
    try:
        await r.set(f"{_STATE_KEY_PREFIX}{state}", "1", ex=_STATE_TTL_SECONDS)
    finally:
        await r.aclose()


async def _consume_state(state: str) -> bool:
    """state を 1回限り検証して削除。検証成功なら True."""
    r = aioredis.from_url(settings.valkey_url)
    try:
        deleted = await r.delete(f"{_STATE_KEY_PREFIX}{state}")
        return bool(deleted)
    finally:
        await r.aclose()


def _create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode({"sub": user_id, "exp": expire}, settings.secret_key, algorithm="HS256")


@router.get("/providers")
async def list_providers():
    """設定済みのOAuthプロバイダー一覧を返す"""
    available = []
    if settings.google_client_id:
        available.append({"id": "google", "name": "Google"})
    return available


@router.get("/{provider}/login")
async def oauth_login(provider: str):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    cfg = PROVIDERS[provider]
    redirect_uri = f"{settings.oauth_redirect_base}/api/auth/{provider}/callback"

    state = secrets.token_urlsafe(32)
    await _store_state(state)

    params = {
        "response_type": "code",
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri,
        "scope": cfg["scope"],
        "state": state,
    }
    auth_url = f"{cfg['auth_url']}?{urlencode(params)}"
    return RedirectResponse(url=auth_url)


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: str,
    state: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    # Verify state (Valkey に保存された state を consume; multi-worker safe)
    if state is None or not await _consume_state(state):
        raise HTTPException(status_code=400, detail="Invalid or expired state parameter")

    cfg = PROVIDERS[provider]
    redirect_uri = f"{settings.oauth_redirect_base}/api/auth/{provider}/callback"

    # Exchange code for access token
    token_data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
    }

    async with httpx.AsyncClient() as client:
        token_res = await client.post(cfg["token_url"], data=token_data)
        if token_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to exchange code for token")
        token_json = token_res.json()

    access_token = token_json.get("access_token")
    if not access_token:
        raise HTTPException(status_code=502, detail="No access_token in provider response")

    # Get Google user info
    async with httpx.AsyncClient() as client:
        info_res = await client.get(
            cfg["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if info_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to get Google user info")
        info = info_res.json()
    provider_sub = info["sub"]
    display_name = info.get("name")
    email = info.get("email")
    avatar_url = info.get("picture")

    # Upsert user
    result = await db.execute(
        select(User).where(User.provider == provider, User.provider_sub == provider_sub)
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            provider=provider,
            provider_sub=provider_sub,
            display_name=display_name,
            email=email,
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        # Update profile on each login
        user.display_name = display_name
        if email is not None:
            user.email = email
        user.avatar_url = avatar_url
        await db.commit()

    # Create JWT
    jwt_token = _create_token(str(user.id))

    # Redirect to frontend with token as query parameter
    return RedirectResponse(url=f"/?token={jwt_token}")


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "id": str(user.id),
        "display_name": user.display_name,
        "email": user.email,
        "avatar_url": user.avatar_url,
        "provider": user.provider,
        "api_key": user.api_key,
        "tos_accepted_at": user.tos_accepted_at.isoformat() if user.tos_accepted_at else None,
        "is_admin": user.is_admin,
        "created_at": user.created_at.isoformat(),
    }


@router.post("/api-key")
async def generate_api_key(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate or regenerate the user's worker API key."""
    user.api_key = secrets.token_hex(32)
    await db.commit()
    return {"api_key": user.api_key}


@router.post("/tos-accept")
async def accept_tos(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ユーザーが利用規約・プライバシーポリシーに同意した時刻を記録."""
    user.tos_accepted_at = datetime.now(timezone.utc)
    await db.commit()
    return {"tos_accepted_at": user.tos_accepted_at.isoformat()}


@router.delete("/me")
async def delete_me(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """アカウント削除 (GDPR的対応).

    自分のプロジェクト・アノテーション・ラベル・ジョブ・APIキー・ユーザー本体を
    cascade で削除。BYO の RunPod 側 (Pod, 料金) は別途各自で停止する必要あり。
    """
    await db.delete(user)
    await db.commit()
    return {"deleted": True}
