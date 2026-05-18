"""BYO (Bring Your Own) クラウドGPU 初期化エンドポイント.

ユーザーが RunPod API key を入力したら呼ばれる。キーの疎通確認をする。
Network Volume は使わない設計 (cross-account共有不可・DC在庫タイトのため)。
DEM キャッシュは Pod の volumeInGb (Pod自身の persistent disk) に保存し、
Pod stop/start のサイクルで永続化する。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user, get_runpod_api_key
from app.models import User
from app.services import cloud_worker

router = APIRouter(prefix="/api/byo/runpod", tags=["byo"])


@router.post("/init")
async def init_runpod(
    _user: User = Depends(get_current_user),
    api_key: str | None = Depends(get_runpod_api_key),
):
    """指定された RunPod API key で疎通確認.

    レスポンス: {"verified": bool, "pod_count": int}
    """
    if not api_key:
        raise HTTPException(status_code=400, detail="X-RunPod-Api-Key header required")
    try:
        pods = await cloud_worker.list_pods(api_key=api_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid RunPod API key: {e}")
    return {
        "verified": True,
        "pod_count": len(pods),
    }
