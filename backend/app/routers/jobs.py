"""Job management endpoints and WebSocket for progress streaming."""

import json
import secrets
from uuid import UUID

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.deps import get_current_user, get_runpod_api_key, get_scan_mode, get_worker_mode
from app.limiter import limiter
from app.models import Annotation, AnnotationLabel, Job, Label, Project, User
from app.services import cloud_worker

router = APIRouter(prefix="/api", tags=["jobs"])


class TrainRequest(BaseModel):
    train_label: str


class ScanRequest(BaseModel):
    region: dict | None = None
    prefecture: str | None = None
    conf_threshold: float = 0.3
    scan_label: str | None = None


def _job_dict(j: Job) -> dict:
    return {
        "id": str(j.id),
        "project_id": str(j.project_id),
        "job_type": j.job_type,
        "status": j.status,
        "progress": j.progress,
        "message": j.message,
        "config": j.config,
        "result": j.result,
        "created_at": j.created_at.isoformat(),
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "completed_at": j.completed_at.isoformat() if j.completed_at else None,
    }


async def _get_user_project(project_id: UUID, user: User, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


_SECRET_CONFIG_KEYS = ("runpod_api_key",)


def _strip_runpod_key(config: dict | None) -> dict | None:
    """フロントに返す前に Job.config から機密フィールドを取り除く."""
    if not config:
        return config
    if not any(k in config for k in _SECRET_CONFIG_KEYS):
        return config
    return {k: v for k, v in config.items() if k not in _SECRET_CONFIG_KEYS}


def _job_dict_safe(j: Job) -> dict:
    d = _job_dict(j)
    d["config"] = _strip_runpod_key(d.get("config"))
    return d


async def _ensure_user_api_key(user: User, db: AsyncSession) -> str:
    """User.api_key を返す. 未生成なら自動生成して保存する."""
    if not user.api_key:
        user.api_key = secrets.token_hex(32)
        await db.commit()
    return user.api_key


async def _enqueue_job(
    job: Job,
    db: AsyncSession,
    runpod_api_key: str | None = None,
    user: User | None = None,
    scan_mode: str | None = None,
    worker_mode: str | None = None,
):
    """Push job ID to Valkey queue and trigger cloud worker.

    - runpod_api_key: BYO クラウドモード時の RunPod キー。Job.config に一時保存
    - scan_mode: cheap/balanced/fast (cloud_worker の cloudType と GPU 種別を切替)
    - worker_mode: cloud (default) or local。local の場合 Pod 起動せず、
      ユーザーのローカル worker が polling で claim する
    """
    cfg = dict(job.config or {})
    if runpod_api_key:
        cfg["runpod_api_key"] = runpod_api_key
    if scan_mode:
        cfg["scan_mode"] = scan_mode
    if worker_mode:
        cfg["worker_mode"] = worker_mode
    if cfg:
        job.config = cfg
    db.add(job)
    await db.commit()
    await db.refresh(job)
    r = aioredis.from_url(settings.valkey_url)
    try:
        await r.lpush("job_queue", str(job.id))
    finally:
        await r.aclose()
    # local mode: Pod 起動しない (ユーザーのローカル worker が polling)
    if worker_mode == "local":
        return job
    if runpod_api_key:
        worker_api_key = await _ensure_user_api_key(user, db) if user else None
        await cloud_worker.ensure_pod_for_job(
            runpod_api_key,
            str(job.id),
            worker_api_key=worker_api_key,
            scan_mode=scan_mode,
        )
    return job


@router.post("/projects/{project_id}/train", status_code=201)
@limiter.limit("10/minute")
async def start_training(
    request: Request,
    project_id: UUID,
    body: TrainRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    runpod_api_key: str | None = Depends(get_runpod_api_key),
    scan_mode: str | None = Depends(get_scan_mode),
    worker_mode: str | None = Depends(get_worker_mode),
):
    await _get_user_project(project_id, user, db)
    job = Job(
        project_id=project_id,
        job_type="train",
        config={"train_label": body.train_label},
    )
    job = await _enqueue_job(job, db, runpod_api_key=runpod_api_key,
                             user=user, scan_mode=scan_mode, worker_mode=worker_mode)
    return _job_dict_safe(job)


class RescoreRequest(BaseModel):
    filter: dict = {}


@router.post("/projects/{project_id}/rescore", status_code=201)
@limiter.limit("5/minute")
async def start_rescore(
    request: Request,
    project_id: UUID,
    body: RescoreRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    runpod_api_key: str | None = Depends(get_runpod_api_key),
    scan_mode: str | None = Depends(get_scan_mode),
    worker_mode: str | None = Depends(get_worker_mode),
):
    """再学習 + フィルタ結果のタイルのみ再推論してスコア更新。"""
    await _get_user_project(project_id, user, db)

    # フィルタ結果のタイル座標を取得
    from app.routers.annotations import _resolve_filter_subquery, _apply_filter, FilterRequest
    from pydantic import TypeAdapter
    from sqlalchemy import func as sa_func

    stmt = select(
        Annotation.tile_x, Annotation.tile_y, Annotation.tile_z
    ).where(Annotation.project_id == project_id).distinct()
    if body.filter:
        filter_req = TypeAdapter(FilterRequest).validate_python(body.filter)
        id_subq, _, _ = _resolve_filter_subquery(project_id, filter_req)
        if id_subq is not None:
            stmt = stmt.where(Annotation.id.in_(select(id_subq.c[0])))

    tiles = [(r[0], r[1], r[2] or 16) for r in (await db.execute(stmt)).all()]

    job = Job(
        project_id=project_id,
        job_type="rescore",
        config={"tiles": [[z, x, y] for x, y, z in tiles], "filter": body.filter},
    )
    job = await _enqueue_job(job, db, runpod_api_key=runpod_api_key,
                             user=user, scan_mode=scan_mode, worker_mode=worker_mode)
    return _job_dict_safe(job)


@router.post("/projects/{project_id}/scan", status_code=201)
@limiter.limit("5/minute")
async def start_scan(
    request: Request,
    project_id: UUID,
    body: ScanRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    runpod_api_key: str | None = Depends(get_runpod_api_key),
    scan_mode: str | None = Depends(get_scan_mode),
    worker_mode: str | None = Depends(get_worker_mode),
):
    await _get_user_project(project_id, user, db)
    # scan_label を即座に Label テーブルに作成しておくことで、フロントが
    # 探索開始直後にフィルタ UI で新ラベルを選べる (worker 側は同名ラベル
    # 作成時に exists 判定で重複を回避)。
    if body.scan_label:
        existing = await db.execute(
            select(Label).where(Label.project_id == project_id, Label.name == body.scan_label)
        )
        if existing.scalar_one_or_none() is None:
            db.add(Label(project_id=project_id, name=body.scan_label, emoji="🔍", system="scan"))
            try:
                await db.commit()
            except Exception:
                await db.rollback()  # race condition で worker が先に作っていた場合
    job = Job(
        project_id=project_id,
        job_type="scan",
        config={"region": body.region, "prefecture": body.prefecture,
                "conf_threshold": body.conf_threshold, "scan_label": body.scan_label},
    )
    job = await _enqueue_job(job, db, runpod_api_key=runpod_api_key,
                             user=user, scan_mode=scan_mode, worker_mode=worker_mode)
    return _job_dict_safe(job)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    await _get_user_project(job.project_id, user, db)
    if job.status in ("queued", "running"):
        job.status = "failed"
        job.message = "Cancelled by user"
        byo_key = (job.config or {}).get("runpod_api_key")
        # status を flush してから Pod 片付け (他 active ジョブ判定が正確になる)
        await db.commit()
        if byo_key:
            project = (await db.execute(select(Project).where(Project.id == job.project_id))).scalar_one_or_none()
            if project:
                await cloud_worker.cleanup_user_pods_if_idle(project.user_id, byo_key, db)
            await db.refresh(job)
        # キャンセル時は機密情報を削除
        if job.config and any(k in (job.config or {}) for k in _SECRET_CONFIG_KEYS):
            cfg = dict(job.config)
            for k in _SECRET_CONFIG_KEYS:
                cfg.pop(k, None)
            job.config = cfg
            await db.commit()
    return _job_dict_safe(job)


@router.post("/jobs/{job_id}/retry")
@limiter.limit("5/minute")
async def retry_job(
    request: Request,
    job_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    runpod_api_key: str | None = Depends(get_runpod_api_key),
    scan_mode: str | None = Depends(get_scan_mode),
    worker_mode: str | None = Depends(get_worker_mode),
):
    """Re-queue a failed job with the same config. For scan jobs, clears previous results."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    await _get_user_project(job.project_id, user, db)
    if job.status != "failed":
        raise HTTPException(status_code=400, detail="Only failed jobs can be retried")

    # Scan retry: delete previous annotations with the same scan_label
    config = dict(job.config) if job.config else {}
    scan_label = config.get("scan_label")
    if job.job_type == "scan" and scan_label:
        label = (await db.execute(
            select(Label).where(Label.project_id == job.project_id, Label.name == scan_label)
        )).scalar_one_or_none()
        if label:
            ann_subq = select(AnnotationLabel.annotation_id).where(AnnotationLabel.label_id == label.id)
            # Remove label links
            await db.execute(sa_delete(AnnotationLabel).where(
                AnnotationLabel.label_id == label.id,
            ))
            # Delete only orphaned annotations (no remaining labels, no vote)
            from sqlalchemy import exists as sa_exists
            await db.execute(sa_delete(Annotation).where(
                Annotation.id.in_(ann_subq),
                Annotation.annotation_vote.is_(None),
                ~sa_exists(select(AnnotationLabel.annotation_id)
                           .where(AnnotationLabel.annotation_id == Annotation.id))
            ))
            await db.commit()

    # 過去 config から secret は除いてから新ジョブに引き継ぐ
    config.pop("runpod_api_key", None)
    new_job = Job(
        project_id=job.project_id,
        job_type=job.job_type,
        config=config,
    )
    new_job = await _enqueue_job(new_job, db, runpod_api_key=runpod_api_key, user=user,
                                  scan_mode=scan_mode, worker_mode=worker_mode)
    return _job_dict_safe(new_job)


@router.get("/jobs/active")
async def list_active_jobs(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all running/queued jobs across all user's projects."""
    result = await db.execute(
        select(Job, Project.name).join(Project, Job.project_id == Project.id)
        .where(Project.user_id == user.id, Job.status.in_(["running", "queued"]))
        .order_by(Job.created_at.desc())
    )
    return [
        {**_job_dict_safe(j), "project_name": pname}
        for j, pname in result
    ]


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    await _get_user_project(job.project_id, user, db)
    return _job_dict_safe(job)


@router.get("/projects/{project_id}/jobs")
async def list_jobs(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    result = await db.execute(
        select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
    )
    return [_job_dict_safe(j) for j in result.scalars()]


async def job_websocket(websocket: WebSocket, job_id: UUID):
    """Stream job progress via Valkey pub/sub."""
    await websocket.accept()
    r = aioredis.from_url(settings.valkey_url)
    pubsub = r.pubsub()
    channel = f"job:{job_id}"
    await pubsub.subscribe(channel)
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                data = json.loads(message["data"])
                await websocket.send_json(data)
                if data.get("status") in ("completed", "failed"):
                    break
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()
        await r.aclose()
