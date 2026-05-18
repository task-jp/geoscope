import asyncio
import logging
import os
import re

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select

from app.database import async_session
from app.limiter import limiter
from app.models import Job, Project, User
from app.routers import admin, annotations, auth, byo, detections, jobs, og, projects, tiles, worker_api
from app.services import cloud_worker

log = logging.getLogger(__name__)


# --- Sentry エラー監視 ---
_SECRET_HEADER_PATTERN = re.compile(r"api.?key|authorization|token|secret", re.IGNORECASE)


def _mask_value(v):
    if not isinstance(v, str) or len(v) < 8:
        return "***"
    return f"{v[:4]}***{v[-2:]}"


def _sentry_before_send(event, hint):
    """Sentry 送信前のフィルタ: RunPod API key 等の機密情報を伏字化."""
    # request headers
    req = event.get("request") or {}
    headers = req.get("headers") or {}
    if isinstance(headers, dict):
        for k in list(headers.keys()):
            if _SECRET_HEADER_PATTERN.search(k):
                headers[k] = _mask_value(headers[k])
    # extra / contexts に runpod_api_key が含まれる場合
    for section in ("extra", "contexts"):
        data = event.get(section) or {}
        if isinstance(data, dict):
            for k, v in list(data.items()):
                if isinstance(k, str) and ("api_key" in k.lower() or "secret" in k.lower()):
                    data[k] = _mask_value(v) if isinstance(v, str) else "***"
    return event


_SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if _SENTRY_DSN:
    sentry_sdk.init(
        dsn=_SENTRY_DSN,
        traces_sample_rate=0.1,  # 10% の request をパフォーマンス計測
        environment=os.environ.get("SENTRY_ENV", "production"),
        before_send=_sentry_before_send,
        send_default_pii=False,
    )
    log.info("Sentry initialized")


app = FastAPI(title="GeoScope")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(tiles.router)
app.include_router(projects.router)
app.include_router(annotations.router)
app.include_router(jobs.router)
app.include_router(detections.router)
app.include_router(og.router)
app.include_router(worker_api.router)
app.include_router(byo.router)
app.include_router(admin.router)

# WebSocket — /api prefix の外に登録（Nginxは /ws/ → backend:8000/ws/ にプロキシ）
app.websocket("/ws/jobs/{job_id}")(jobs.job_websocket)


_cloud_capacity_task: asyncio.Task | None = None


async def _cloud_capacity_monitor() -> None:
    """queued ジョブに対して Pod 起動を能動的に試行する.

    ユーザーのリトライ操作なしで backend が自動的にretryする (在庫切れ等で
    1度失敗しても、30秒後に backend が自分でPod起動を再試行)。
    既存 Pod があれば ensure_pod_for_job 内で no-op。
    """
    while True:
        try:
            async with async_session() as db:
                # queued な scan/rescore/train ジョブを取得 (古い順、最大10件まで)
                stmt = (
                    select(Job)
                    .where(
                        Job.status == "queued",
                        Job.job_type.in_(("scan", "rescore", "train")),
                    )
                    .order_by(Job.created_at.asc())
                    .limit(10)
                )
                result = await db.execute(stmt)
                jobs_to_process = list(result.scalars().all())

                # BYO key を持つジョブごとに Pod 起動試行
                # 同じユーザーが複数 queued ジョブを持つ場合、1度の ensure_pod_for_job
                # で動く running Pod があれば残りは自動でそれを使う
                tried_keys: set[str] = set()
                for job in jobs_to_process:
                    cfg = job.config or {}
                    byo_key = cfg.get("runpod_api_key")
                    if not byo_key or byo_key in tried_keys:
                        continue
                    tried_keys.add(byo_key)
                    # User.api_key を取得
                    project = (await db.execute(
                        select(Project).where(Project.id == job.project_id)
                    )).scalar_one_or_none()
                    if not project:
                        continue
                    user = (await db.execute(
                        select(User).where(User.id == project.user_id)
                    )).scalar_one_or_none()
                    if not user or not user.api_key:
                        continue
                    await cloud_worker.ensure_pod_for_job(
                        byo_key, str(job.id),
                        worker_api_key=user.api_key,
                        scan_mode=cfg.get("scan_mode"),
                    )
        except Exception:
            log.exception("cloud capacity monitor iteration failed")
        await asyncio.sleep(30)


@app.on_event("startup")
async def _startup_cloud_worker() -> None:
    global _cloud_capacity_task
    if cloud_worker.RUNPOD_IMAGE_NAME:
        _cloud_capacity_task = asyncio.create_task(_cloud_capacity_monitor())
        log.info("Cloud worker capacity monitor started")


@app.on_event("shutdown")
async def _shutdown_cloud_worker() -> None:
    if _cloud_capacity_task is not None:
        _cloud_capacity_task.cancel()
        try:
            await _cloud_capacity_task
        except (asyncio.CancelledError, Exception):
            pass
