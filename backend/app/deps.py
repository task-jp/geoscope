from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    token = credentials.credentials
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """管理者ユーザーのみ通すdep。`User.is_admin` で判定."""
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


def get_runpod_api_key(request: Request) -> str | None:
    """BYO クラウドGPU: HTTPヘッダ X-RunPod-Api-Key からユーザーの RunPod APIキーを取り出す.

    クライアント (ブラウザ localStorage) が探索リクエスト時に付与する。
    未付与時は None を返し、呼び出し側が「管理者キーへのフォールバック」「BYO 必須エラー」を判断する。
    """
    key = request.headers.get("X-RunPod-Api-Key")
    if key:
        key = key.strip()
    return key or None


# 旧 X-RunPod-Network-Volume-Id ヘッダは廃止 (Pod の volumeInGb に永続化する設計に変更)


def get_scan_mode(request: Request) -> str | None:
    """探索モード (cheap/balanced/fast) を HTTP ヘッダ X-Scan-Mode から取得."""
    v = request.headers.get("X-Scan-Mode")
    if v:
        v = v.strip().lower()
        if v in ("cheap", "balanced", "fast"):
            return v
    return None


def get_worker_mode(request: Request) -> str | None:
    """ワーカー実行先 (cloud or local) を HTTP ヘッダ X-Worker-Mode から取得.

    local の場合、backend は RunPod Pod を起動せず、ユーザーのローカル worker が
    polling で claim する。未指定 = cloud。
    """
    v = request.headers.get("X-Worker-Mode")
    if v:
        v = v.strip().lower()
        if v in ("cloud", "local"):
            return v
    return None
