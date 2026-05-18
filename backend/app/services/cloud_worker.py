"""RunPod On-demand Pod 制御サービス (BYO 専用、option B 設計).

- ユーザーは自分の RunPod API key を持参 (BYO)。backend はジョブ作成時に
  受け取って Pod を起動し、ジョブ完了時に Pod を削除してキーを破棄する
- Pod は **永続 volume なし** (volumeInGb=0)、container ephemeral disk のみ
- DEM タイルは scan 中に Cloudflare R2 から都度 HTTP fetch (`SKIP_DEM_EXTRACT=true`、並列 256本)
- ジョブ終了で Pod を delete (`cleanup_user_pods_if_idle`)。ユーザーの idle 課金 $0
- 部分スキャンは必要分のみ転送で従来より高速、全国スキャンは推論時間に fetch を隠せて同等速度
- R2 → RunPod の egress は Cloudflare R2 仕様で無料

環境変数:
- RUNPOD_IMAGE_NAME         : Pod で起動する Docker イメージ
- RUNPOD_GPU_TYPE_IDS       : 起動可能な GPU IDs カンマ区切り
- RUNPOD_POD_NAME_PREFIX    : Pod 名プレフィクス (デフォルト: "geoscope-worker")
- RUNPOD_CONTAINER_DISK_GB  : container disk サイズ (デフォルト: 50)
- RUNPOD_DATA_CENTER_IDS    : 起動先 DC IDs カンマ区切り (空なら任意)
- WORKER_API_KEY            : デフォルトのワーカー認証キー (BYO Pod ではユーザーキーで上書き)
- GEOSCOPE_SERVER           : ワーカーがアクセスするバックエンド URL
- DEM_TILE_BASE_URL         : DEM タイル配信元 (Cloudflare R2 等)
- PREFETCH_PARALLEL         : DEM プリフェッチ並列度
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

RUNPOD_IMAGE_NAME = os.environ.get("RUNPOD_IMAGE_NAME", "")
RUNPOD_GPU_TYPE_IDS = [
    s.strip() for s in os.environ.get(
        "RUNPOD_GPU_TYPE_IDS",
        "NVIDIA GeForce RTX 4090",
    ).split(",") if s.strip()
]
RUNPOD_POD_NAME_PREFIX = os.environ.get("RUNPOD_POD_NAME_PREFIX", "geoscope-worker")
RUNPOD_CONTAINER_DISK_GB = int(os.environ.get("RUNPOD_CONTAINER_DISK_GB", "50"))
RUNPOD_DATA_CENTER_IDS = [
    s.strip() for s in os.environ.get("RUNPOD_DATA_CENTER_IDS", "").split(",") if s.strip()
]

WORKER_API_KEY = os.environ.get("WORKER_API_KEY", "")
GEOSCOPE_SERVER = os.environ.get("GEOSCOPE_SERVER", "")
DEM_TILE_BASE_URL = os.environ.get("DEM_TILE_BASE_URL", "")
PREFETCH_PARALLEL = os.environ.get("PREFETCH_PARALLEL", "256")

_API_BASE = "https://rest.runpod.io/v1"
_HTTP_TIMEOUT = 30.0


def _mask_key(key: str | None) -> str:
    if not key or len(key) < 8:
        return "***"
    return f"{key[:4]}***{key[-2:]}"


def _headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


async def _request(
    method: str,
    path: str,
    json_body: dict[str, Any] | None = None,
    api_key: str | None = None,
) -> Any:
    if not api_key:
        raise RuntimeError("No RunPod API key available")
    url = f"{_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        resp = await client.request(method, url, headers=_headers(api_key), json=json_body)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"RunPod {method} {path} returned {resp.status_code}: {resp.text[:400]}"
            )
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()


async def list_pods(api_key: str | None = None) -> list[dict[str, Any]]:
    """geoscope-worker Pod を返す (BYO key 必須)."""
    if not api_key:
        return []
    data = await _request("GET", "/pods", api_key=api_key)
    pods = data if isinstance(data, list) else []
    return [p for p in pods if (p.get("name") or "").startswith(RUNPOD_POD_NAME_PREFIX)]


def _pod_status(p: dict[str, Any]) -> str:
    """desiredStatus と runtime から実際の状態を推定. running/transitioning."""
    desired = (p.get("desiredStatus") or "").upper()
    if desired == "RUNNING":
        return "running"
    return desired.lower() or "unknown"


async def create_pod(
    name_suffix: str = "",
    api_key: str | None = None,
    image_name: str | None = None,
    worker_api_key: str | None = None,
    scan_mode: str | None = None,
) -> str:
    """新規 Pod を作成. 戻り値は pod_id.

    永続 volume を持たない (volumeInGb なし)。container ephemeral disk のみ。
    DEM タイルは scan 中に R2 から HTTP fetch (SKIP_DEM_EXTRACT=true)。
    """
    use_image = image_name or RUNPOD_IMAGE_NAME
    if not use_image:
        raise RuntimeError("RunPod image not configured (RUNPOD_IMAGE_NAME)")
    if not api_key:
        raise RuntimeError("No RunPod API key (BYO required)")

    name = f"{RUNPOD_POD_NAME_PREFIX}-{int(time.time())}"
    if name_suffix:
        name = f"{name}-{name_suffix}"

    env: dict[str, str] = {
        "WORKER_API_KEY": worker_api_key or WORKER_API_KEY,
        "GEOSCOPE_SERVER": GEOSCOPE_SERVER,
        "REMOTE_TILES": "true",
        "DISABLE_PID_LOCK": "true",
        "PREFETCH_PARALLEL": PREFETCH_PARALLEL,
        # tar 一括展開をスキップ。worker は fetch_tile() で都度 R2 取得する
        "SKIP_DEM_EXTRACT": "true",
        # container ephemeral disk 上の作業ディレクトリ (Pod 削除で消える)
        "TILES_DIR": "/tmp/tiles",
        "MODELS_DIR": "/tmp/models",
        "DATASETS_DIR": "/tmp/datasets",
    }
    if DEM_TILE_BASE_URL:
        env["DEM_TILE_BASE_URL"] = DEM_TILE_BASE_URL

    body: dict[str, Any] = {
        "name": name,
        "imageName": use_image,
        "gpuCount": 1,
        "containerDiskInGb": RUNPOD_CONTAINER_DISK_GB,
        # 永続 volume なし。idle 時の課金を $0 にするため
        "env": env,
    }
    if RUNPOD_GPU_TYPE_IDS:
        body["gpuTypeIds"] = RUNPOD_GPU_TYPE_IDS
    if RUNPOD_DATA_CENTER_IDS:
        body["dataCenterIds"] = RUNPOD_DATA_CENTER_IDS

    # scan_mode で cloudType を切替:
    # - "cheap"    : COMMUNITY (在庫切れは永久リトライ、安いが取れない可能性)
    # - "balanced" : SECURE (default、4090 を確実に確保、~$0.69/h)
    # - "fast"     : SECURE + 高性能 GPU (H100 等、別途 gpuTypeIds で指定)
    mode = (scan_mode or "balanced").lower()
    body["cloudType"] = "COMMUNITY" if mode == "cheap" else "SECURE"
    pod = await _request("POST", "/pods", body, api_key=api_key) or {}
    log.info(
        "RunPod pod created (no volume) cloudType=%s mode=%s: %s (%s) key=%s",
        body["cloudType"], mode, pod.get("id"), name,
        _mask_key(api_key),
    )
    pod_id = pod.get("id")
    if not pod_id:
        raise RuntimeError(f"RunPod pod creation returned no id: {pod}")
    return pod_id


async def delete_pod(pod_id: str, api_key: str | None = None) -> None:
    """Pod を完全削除. 既に消えていれば 404 を無視 (冪等)."""
    if not api_key:
        return
    try:
        await _request("DELETE", f"/pods/{pod_id}", api_key=api_key)
    except RuntimeError as e:
        # 既に削除済み or 別 worker が並行削除した場合の 404 は無視
        if "404" in str(e) or "not found" in str(e).lower():
            log.info("RunPod pod already gone (idempotent): %s", pod_id)
            return
        raise
    log.info("RunPod pod deleted: %s", pod_id)


async def ensure_pod_for_job(
    api_key: str,
    job_id: str,
    worker_api_key: str | None = None,
    scan_mode: str | None = None,
) -> str | None:
    """BYO ジョブ用に Pod を確保する.

    既に running な Pod があれば再利用 (戻り値 None)、なければ create_pod で
    新規作成 (~30秒) → pod_id を返す。
    """
    if not api_key:
        return None
    try:
        active = await list_pods(api_key=api_key)
        running = [p for p in active if _pod_status(p) == "running"]
        if running:
            log.info(
                "Reusing running BYO pod for job %s (key=%s, pod=%s)",
                job_id, _mask_key(api_key), running[0]["id"],
            )
            return None
        # 新規作成
        pod_id = await create_pod(
            name_suffix=f"u{_mask_key(api_key)[:4]}",
            api_key=api_key,
            worker_api_key=worker_api_key,
            scan_mode=scan_mode,
        )
        return pod_id
    except RuntimeError as e:
        # COMMUNITY 在庫切れは想定内 (30秒後に再試行)。Sentry に飛ばさず WARNING のみ
        msg = str(e).lower()
        if any(p in msg for p in (
            "no instances currently available",
            "does not have the resources",
            "could not find any pods",
            "no machine with the resources",
        )):
            log.warning("Pod creation deferred (inventory): %s", str(e)[:200])
            return None
        log.exception("ensure_pod_for_job failed for job %s", job_id)
        return None
    except Exception:
        log.exception("ensure_pod_for_job failed for job %s", job_id)
        return None


async def cleanup_user_pods_if_idle(
    user_id,
    api_key: str,
    db: AsyncSession,
) -> None:
    """ユーザーの BYO Pod を全削除する (他に動作中ジョブが無い場合のみ).

    ジョブ完了/失敗/キャンセル時に `_clear_runpod_key` の前に呼ぶ。
    config から BYO キーが消えると Pod 削除手段が失われるため、
    キー消去前に Pod を片付ける必要がある。
    """
    from app.models import Project as _Project, Job as _Job
    if not api_key:
        return
    # ユーザーに他の queued / running ジョブが残っているか確認
    stmt = (
        select(_Job)
        .join(_Project, _Job.project_id == _Project.id)
        .where(_Project.user_id == user_id)
        .where(_Job.status.in_(("queued", "running")))
    )
    result = await db.execute(stmt)
    other_active = list(result.scalars().all())
    if other_active:
        log.info(
            "User %s still has %d active job(s); keeping Pods", user_id, len(other_active),
        )
        return
    # 他にジョブ無し → user の Pod を全削除
    try:
        pods = await list_pods(api_key=api_key)
    except Exception:
        log.exception("cleanup_user_pods_if_idle: list_pods failed for user %s", user_id)
        return
    for p in pods:
        try:
            await delete_pod(p["id"], api_key=api_key)
            log.info("Cleaned up orphan Pod %s for user %s", p["id"], user_id)
        except Exception:
            log.exception("cleanup_user_pods_if_idle: delete failed for Pod %s", p["id"])


