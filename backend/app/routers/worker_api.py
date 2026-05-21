"""Worker API endpoints — authenticated by WORKER_API_KEY.

The GPU worker (running on a local machine, not in Docker) polls these
endpoints to fetch jobs, report progress, and upload detection results.
"""

import asyncio
import json
import math
import re
from datetime import datetime, timezone
from uuid import UUID

import redis.asyncio as aioredis
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from geoalchemy2 import Geography
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.services import cloud_worker
from app.models import Annotation, AnnotationLabel, Detection, Job, Label, Project, User

router = APIRouter(prefix="/api/worker", tags=["worker"])
security = HTTPBearer()


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

class WorkerAuth:
    """Result of worker authentication. user_id is set for per-user keys, None for global key."""
    def __init__(self, user_id: UUID | None = None):
        self.user_id = user_id
    @property
    def is_global(self) -> bool:
        return self.user_id is None


async def verify_worker_key(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> WorkerAuth:
    """Validate Bearer token: global WORKER_API_KEY or per-user api_key."""
    key = credentials.credentials
    # Global admin key
    if settings.worker_api_key and key == settings.worker_api_key:
        return WorkerAuth()
    # Per-user key
    result = await db.execute(select(User).where(User.api_key == key))
    user = result.scalar_one_or_none()
    if user:
        return WorkerAuth(user_id=user.id)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid worker API key",
    )


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

_SECRET_KEYS = ("runpod_api_key",)


def _strip_secrets(config: dict | None) -> dict | None:
    """ワーカー / フロントには runpod_api_key 等の機密情報は渡さない."""
    if not config:
        return config
    if not any(k in config for k in _SECRET_KEYS):
        return config
    return {k: v for k, v in config.items() if k not in _SECRET_KEYS}


def _clear_runpod_key(job: Job) -> None:
    """Job.config から runpod_api_key を完全に取り除く. 完了/失敗/キャンセル時に呼ぶ."""
    if not job.config or not any(k in (job.config or {}) for k in _SECRET_KEYS):
        return
    job.config = {k: v for k, v in dict(job.config).items() if k not in _SECRET_KEYS}


def _job_dict(j: Job) -> dict:
    return {
        "id": str(j.id),
        "project_id": str(j.project_id),
        "job_type": j.job_type,
        "status": j.status,
        "progress": j.progress,
        "message": j.message,
        "config": _strip_secrets(j.config),
        "result": j.result,
        "created_at": j.created_at.isoformat(),
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "completed_at": j.completed_at.isoformat() if j.completed_at else None,
    }


async def _publish(channel: str, payload: dict):
    """Publish a JSON message to Valkey pub/sub."""
    r = aioredis.from_url(settings.valkey_url)
    try:
        await r.publish(channel, json.dumps(payload))
    finally:
        await r.aclose()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

STALE_JOB_MINUTES = 30


@router.get("/jobs/pending")
async def get_pending_job(
    peek: bool = False,
    join_only: bool = False,
    auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Atomically claim the oldest queued job (queued→running), or return empty dict.
    join_only=true: parallel参加可能なrunningジョブのみ返す（queuedをclaimしない）。
    User API keys only see their own projects' jobs.
    Also auto-fails running jobs with no heartbeat for STALE_JOB_MINUTES."""
    from app.models import Project
    # Auto-fail stale running jobs (no progress update in N minutes)
    cutoff = datetime.now(timezone.utc) - __import__("datetime").timedelta(minutes=STALE_JOB_MINUTES)
    stale = await db.execute(
        select(Job).where(
            Job.status == "running",
            ((Job.updated_at.isnot(None)) & (Job.updated_at < cutoff))
            | ((Job.updated_at.is_(None)) & (Job.started_at.isnot(None)) & (Job.started_at < cutoff))
        )
    )
    publish_tasks = []
    stale_jobs_with_keys: list[tuple[Job, str]] = []
    for job in stale.scalars():
        job.status = "failed"
        job.completed_at = datetime.now(timezone.utc)
        job.message = f"Auto-failed: no heartbeat for {STALE_JOB_MINUTES}+ minutes"
        byo_key = (job.config or {}).get("runpod_api_key")
        if byo_key:
            stale_jobs_with_keys.append((job, byo_key))
        publish_tasks.append(_publish(f"job:{job.id}", {
            "job_id": str(job.id), "status": "failed",
            "progress": job.progress, "message": job.message,
        }))
    # status を可視化してから Pod クリーンアップ
    await db.commit()
    for job, byo_key in stale_jobs_with_keys:
        proj = (await db.execute(select(Project).where(Project.id == job.project_id))).scalar_one_or_none()
        if proj:
            await cloud_worker.cleanup_user_pods_if_idle(proj.user_id, byo_key, db)
        await db.refresh(job)
        _clear_runpod_key(job)
    if publish_tasks:
        await asyncio.gather(*publish_tasks)
    await db.commit()

    if peek:
        # peek=true: queuedスキャンジョブの存在確認のみ（claimしない）
        queued = (await db.execute(
            select(Job).where(Job.status == "queued", Job.job_type == "scan")
            .order_by(Job.created_at.asc()).limit(1)
        )).scalar_one_or_none()
        return _job_dict(queued) if queued else {}

    # User API key: scope to their projects
    if not auth.is_global:
        user_projects = select(Project.id).where(Project.user_id == auth.user_id)

    # join_only: parallel参加可能なrunningジョブのみ（queuedをclaimしない）
    if not join_only:
        stmt = select(Job).where(Job.status == "queued")
        if not auth.is_global:
            stmt = stmt.where(Job.project_id.in_(user_projects))
        stmt = stmt.order_by(Job.created_at.asc()).limit(1).with_for_update(skip_locked=True)

        result = await db.execute(stmt)
        job = result.scalar_one_or_none()
        if job:
            job.status = "running"
            job.started_at = datetime.now(timezone.utc)
            job.updated_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(job)
            return _job_dict(job)

    # No queued jobs (or join_only) — check for joinable parallel scan jobs
    from sqlalchemy import text
    join_stmt = select(Job).where(
        Job.status == "running",
        Job.job_type == "scan",
        text("config->>'parallel' = 'true'"),
        text("config->>'model_uploaded' = 'true'"),
        text("(config->>'tile_cursor')::int < (config->>'total_tiles')::int"),
    )
    if not auth.is_global:
        join_stmt = join_stmt.where(Job.project_id.in_(user_projects))
    join_stmt = join_stmt.order_by(Job.created_at.asc()).limit(1)
    result = await db.execute(join_stmt)
    job = result.scalar_one_or_none()
    if job:
        return _job_dict(job)
    return {}


@router.post("/jobs/claim-all")
async def claim_all_queued(
    auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Atomically claim ALL queued jobs (queued→running). For batch processing."""
    from app.models import Project
    stmt = select(Job).where(Job.status == "queued").with_for_update(skip_locked=True)
    if not auth.is_global:
        user_projects = select(Project.id).where(Project.user_id == auth.user_id)
        stmt = stmt.where(Job.project_id.in_(user_projects))
    stmt = stmt.order_by(Job.created_at.asc())
    result = await db.execute(stmt)
    jobs = list(result.scalars())
    now = datetime.now(timezone.utc)
    for job in jobs:
        job.status = "running"
        job.started_at = now
        job.updated_at = now
    await db.commit()
    return [_job_dict(j) for j in jobs]


class StartJobBody(BaseModel):
    config_update: dict | None = None


@router.put("/jobs/{job_id}/start")
async def start_job(
    job_id: UUID,
    body: StartJobBody | None = None,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Mark a job as running. Optionally update config."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.status = "running"
    job.started_at = datetime.now(timezone.utc)
    if body and body.config_update:
        cfg = dict(job.config or {})
        cfg.update(body.config_update)
        job.config = cfg
    await db.commit()
    await db.refresh(job)
    await _publish(f"job:{job_id}", {
        "job_id": str(job_id), "status": "running", "progress": 0, "message": "Started",
    })
    return _job_dict(job)


class ProgressBody(BaseModel):
    progress: float = 0
    message: str = ""


@router.put("/jobs/{job_id}/progress")
async def update_progress(
    job_id: UUID,
    body: ProgressBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Update progress and publish to Valkey for WebSocket forwarding."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # キャンセル判定: statusがrunning以外なら停止を通知
    if job.status != "running":
        if job.status == "completed":
            # パラレルスキャン: 他ワーカーが先に完了した場合はcancelledではなくdoneを返す
            return {"ok": True, "cancelled": False, "done": True}
        reason = "auto-failed" if job.message and "Auto-failed" in job.message else "cancelled"
        return {"ok": True, "cancelled": True, "reason": reason}
    job.progress = body.progress
    job.message = body.message
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await _publish(f"job:{job_id}", {
        "job_id": str(job_id),
        "status": "running",
        "progress": body.progress,
        "message": body.message,
    })
    return {"ok": True, "cancelled": False}


class CompleteBody(BaseModel):
    result: dict = {}
    model_path: str | None = None


@router.put("/jobs/{job_id}/complete")
async def complete_job(
    job_id: UUID,
    body: CompleteBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Mark a job as completed."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in ("failed", "completed"):
        return _job_dict(job)  # キャンセル/auto-fail/既完了のジョブは上書きしない
    job.status = "completed"
    job.progress = 100
    job.completed_at = datetime.now(timezone.utc)
    job.result = body.result
    # Pod 削除はキー消去前に。他に active ジョブが無ければ user の Pod を片付ける
    byo_key = (job.config or {}).get("runpod_api_key")
    if byo_key:
        proj = (await db.execute(select(Project).where(Project.id == job.project_id))).scalar_one_or_none()
        if proj:
            await db.commit()  # まず status=completed を可視化 (他 active 判定が正確になる)
            await cloud_worker.cleanup_user_pods_if_idle(proj.user_id, byo_key, db)
            await db.refresh(job)
    _clear_runpod_key(job)
    await db.commit()
    await db.refresh(job)
    await _publish(f"job:{job_id}", {
        "job_id": str(job_id),
        "status": "completed",
        "progress": 100,
        "message": "Completed",
        "result": body.result,
    })
    return _job_dict(job)


@router.put("/jobs/{job_id}/requeue")
async def requeue_job(
    job_id: UUID,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Return a running job back to queued status."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.status = "queued"
    job.started_at = None
    job.updated_at = None
    await db.commit()
    return {"status": "queued"}


class FailBody(BaseModel):
    error: str


@router.put("/jobs/{job_id}/fail")
async def fail_job(
    job_id: UUID,
    body: FailBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Mark a job as failed."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "completed":
        return _job_dict(job)  # 完了済みジョブをfailedに上書きしない
    job.status = "failed"
    job.completed_at = datetime.now(timezone.utc)
    job.message = body.error
    byo_key = (job.config or {}).get("runpod_api_key")
    if byo_key:
        proj = (await db.execute(select(Project).where(Project.id == job.project_id))).scalar_one_or_none()
        if proj:
            await db.commit()
            await cloud_worker.cleanup_user_pods_if_idle(proj.user_id, byo_key, db)
            await db.refresh(job)
    _clear_runpod_key(job)
    await db.commit()
    await db.refresh(job)
    await _publish(f"job:{job_id}", {
        "job_id": str(job_id),
        "status": "failed",
        "progress": job.progress,
        "message": body.error,
    })
    return _job_dict(job)


class ClaimTilesBody(BaseModel):
    count: int = 5000


@router.post("/jobs/{job_id}/claim-tiles")
async def claim_tiles(
    job_id: UUID,
    body: ClaimTilesBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Atomically claim a chunk of tiles for parallel scanning.
    Returns {"start": old_cursor, "count": actual, "total": total_tiles}."""
    result = await db.execute(
        select(Job).where(Job.id == job_id).with_for_update()
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "running":
        return {"start": 0, "count": 0, "total": 0}

    cfg = dict(job.config or {})
    total = cfg.get("total_tiles", 0)
    old_cursor = cfg.get("tile_cursor", 0)
    actual = min(body.count, max(0, total - old_cursor))
    cfg["tile_cursor"] = old_cursor + actual
    job.config = cfg
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"start": old_cursor, "count": actual, "total": total}


class DetectionItem(BaseModel):
    lat: float
    lon: float
    conf: float
    bbox_cx: float
    bbox_cy: float
    bbox_w: float
    bbox_h: float
    tile_x: int
    tile_y: int


class BulkDetectionsBody(BaseModel):
    project_id: UUID
    model_id: UUID | None = None
    detections: list[DetectionItem]


@router.post("/detections/bulk", status_code=201)
async def bulk_insert_detections(
    body: BulkDetectionsBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Bulk-insert detection results with auto-generated PostGIS geometry."""
    inserted = 0
    # Process in chunks to avoid huge single inserts
    CHUNK = 1000
    for i in range(0, len(body.detections), CHUNK):
        chunk = body.detections[i : i + CHUNK]
        for det in chunk:
            detection = Detection(
                project_id=body.project_id,
                model_id=body.model_id,
                lat=det.lat,
                lon=det.lon,
                conf=det.conf,
                bbox_cx=det.bbox_cx,
                bbox_cy=det.bbox_cy,
                bbox_w=det.bbox_w,
                bbox_h=det.bbox_h,
                tile_x=det.tile_x,
                tile_y=det.tile_y,
                geom=func.ST_SetSRID(func.ST_MakePoint(det.lon, det.lat), 4326),
            )
            db.add(detection)
        await db.flush()
        inserted += len(chunk)
    await db.commit()
    return {"inserted": inserted}


class AnnotationItem(BaseModel):
    lat: float
    lon: float
    bbox_px_cx: float
    bbox_px_cy: float
    bbox_px_w: float
    bbox_px_h: float
    tile_x: int
    tile_y: int
    tile_z: int = 16
    title: str | None = None
    labels: list[dict] = []
    comment: str | None = None
    score: float = 0
    bbox_west: float | None = None
    bbox_south: float | None = None
    bbox_east: float | None = None
    bbox_north: float | None = None


class BulkAnnotationsBody(BaseModel):
    project_id: UUID
    annotations: list[AnnotationItem]
    prefecture: str | None = None
    scan_label: str | None = None


@router.post("/annotations/bulk", status_code=201)
async def bulk_insert_annotations(
    body: BulkAnnotationsBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Bulk-insert annotations with PostGIS geometry."""
    inserted = 0
    CHUNK = 500

    # ラベルを一括解決（1クエリ）
    all_label_names = set()
    for a in body.annotations:
        for ld in (a.labels or []):
            if ld.get("name"):
                all_label_names.add(ld["name"])
    label_cache: dict[str, Label] = {}
    if all_label_names:
        existing = (await db.execute(
            select(Label).where(Label.project_id == body.project_id, Label.name.in_(all_label_names))
        )).scalars().all()
        label_cache = {l.name: l for l in existing}
        new_labels = []
        # 新規ラベル作成（emoji/systemは最初に見つかったものを使用）
        label_meta: dict[str, dict] = {}
        for a in body.annotations:
            for ld in (a.labels or []):
                lname = ld.get("name")
                if lname and lname not in label_cache and lname not in label_meta:
                    label_meta[lname] = {"emoji": ld.get("emoji", "📍"), "system": ld.get("system") or None}
        for name, meta in label_meta.items():
            lbl = Label(project_id=body.project_id, name=name, emoji=meta["emoji"], system=meta["system"])
            new_labels.append(lbl)
            label_cache[name] = lbl
        if new_labels:
            db.add_all(new_labels)
            await db.flush()

    for i in range(0, len(body.annotations), CHUNK):
        chunk = body.annotations[i : i + CHUNK]
        new_annotations = []
        for a in chunk:
            annotation = Annotation(
                project_id=body.project_id,
                lat=a.lat, lon=a.lon,
                bbox_px_cx=a.bbox_px_cx, bbox_px_cy=a.bbox_px_cy,
                bbox_px_w=a.bbox_px_w, bbox_px_h=a.bbox_px_h,
                tile_x=a.tile_x, tile_y=a.tile_y, tile_z=a.tile_z,
                title=a.title, comment=a.comment, score=a.score,
                geom=func.ST_SetSRID(func.ST_MakePoint(a.lon, a.lat), 4326),
                bbox_geom=func.ST_SetSRID(func.ST_MakeEnvelope(
                    a.bbox_west if a.bbox_west is not None else (a.tile_x + a.bbox_px_cx - a.bbox_px_w/2) / pow(2, a.tile_z) * 360 - 180,
                    a.bbox_south if a.bbox_south is not None else math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (a.tile_y + a.bbox_px_cy + a.bbox_px_h/2) / pow(2, a.tile_z))))),
                    a.bbox_east if a.bbox_east is not None else (a.tile_x + a.bbox_px_cx + a.bbox_px_w/2) / pow(2, a.tile_z) * 360 - 180,
                    a.bbox_north if a.bbox_north is not None else math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (a.tile_y + a.bbox_px_cy - a.bbox_px_h/2) / pow(2, a.tile_z))))),
                ), 4326),
            )
            annotation._pending_labels = a.labels or []
            new_annotations.append(annotation)
        db.add_all(new_annotations)
        await db.flush()
        # ラベル紐付け（キャッシュ済みlabelを使用）
        link_rows = []
        for annotation in new_annotations:
            for ld in annotation._pending_labels:
                lname = ld.get("name")
                if lname and lname in label_cache:
                    link_rows.append(AnnotationLabel(annotation_id=annotation.id, label_id=label_cache[lname].id))
            del annotation._pending_labels
        if link_rows:
            db.add_all(link_rows)
            await db.flush()
        inserted += len(new_annotations)

    # Filter out detections outside prefecture boundary (ST_Intersects on bbox_geom)
    filtered = 0
    if body.prefecture and inserted > 0:
        from sqlalchemy import text
        result = await db.execute(text("""
            DELETE FROM annotations a
            WHERE a.project_id = :pid
              AND a.id IN (
                  SELECT al.annotation_id FROM annotation_labels al
                  JOIN labels l ON al.label_id = l.id
                  WHERE l.project_id = :pid AND l.system IS NOT NULL
              )
              AND a.bbox_geom IS NOT NULL
              AND NOT ST_Intersects(
                  a.bbox_geom,
                  (SELECT geom FROM prefectures WHERE name = :pref)
              )
              AND a.created_at > NOW() - INTERVAL '1 minute'
        """), {"pid": str(body.project_id), "pref": body.prefecture})
        filtered = result.rowcount

    # インライン dedup: 同じscan_label内でIoU>0.3の重複除去（並列ワーカー対応）
    deduped = 0
    if inserted > 0 and body.scan_label:
        from sqlalchemy import text
        result = await db.execute(text("""
            DELETE FROM annotations a
            WHERE a.project_id = :pid
              AND a.annotation_vote IS NULL
              AND a.bbox_geom IS NOT NULL
              AND a.created_at > NOW() - INTERVAL '1 minute'
              AND EXISTS (
                  SELECT 1 FROM annotations b
                  JOIN annotation_labels bal ON bal.annotation_id = b.id
                  JOIN labels bl ON bal.label_id = bl.id
                    AND bl.project_id = :pid AND bl.name = :scan_label
                  WHERE b.project_id = :pid
                    AND b.id != a.id
                    AND b.bbox_geom IS NOT NULL
                    AND ST_Intersects(a.bbox_geom, b.bbox_geom)
                    AND ST_Area(ST_Intersection(a.bbox_geom, b.bbox_geom))
                        / (ST_Area(a.bbox_geom) + ST_Area(b.bbox_geom)
                           - ST_Area(ST_Intersection(a.bbox_geom, b.bbox_geom))) > :iou_thresh
                    AND (b.annotation_vote IS NOT NULL
                         OR b.score > a.score
                         OR (b.score = a.score AND b.id > a.id))
              )
        """), {"pid": str(body.project_id), "scan_label": body.scan_label, "iou_thresh": 0.3})
        deduped = result.rowcount

    await db.commit()
    return {"inserted": inserted, "skipped": 0, "filtered": filtered, "deduped": deduped}


# ---------------------------------------------------------------------------
# Annotations (for worker to fetch training data)
# ---------------------------------------------------------------------------

def _annotation_dict(a: Annotation) -> dict:
    from sqlalchemy.orm import selectinload
    labels = [
        {"name": al.label.name, "emoji": al.label.emoji, "system": al.label.system}
        for al in (a.annotation_labels or [])
    ]
    return {
        "id": str(a.id),
        "project_id": str(a.project_id),
        "lat": a.lat, "lon": a.lon,
        "bbox_px_cx": a.bbox_px_cx, "bbox_px_cy": a.bbox_px_cy,
        "bbox_px_w": a.bbox_px_w, "bbox_px_h": a.bbox_px_h,
        "tile_x": a.tile_x, "tile_y": a.tile_y, "tile_z": a.tile_z,
        "title": a.title,
        "labels": labels,
        "comment": a.comment,
        "annotation_vote": a.annotation_vote,
        "created_at": a.created_at.isoformat(),
    }


@router.get("/projects/{project_id}/annotations")
async def get_project_annotations(
    project_id: UUID,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Fetch voted annotations for a project (worker auth). Only yes/no for training."""
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(Annotation)
        .where(Annotation.project_id == project_id, Annotation.annotation_vote.in_(["yes", "no"]))
        .options(
            selectinload(Annotation.annotation_labels).selectinload(AnnotationLabel.label)
        )
        .order_by(Annotation.created_at.desc())
    )
    return [_annotation_dict(a) for a in result.scalars().unique()]


class DeleteByLabelBody(BaseModel):
    label_name: str


@router.post("/projects/{project_id}/annotations/delete-by-label")
async def delete_annotations_by_label(
    project_id: UUID,
    body: DeleteByLabelBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Delete all annotations with a specific label (for scan retry cleanup)."""
    # Find label
    label = (await db.execute(
        select(Label).where(Label.project_id == project_id, Label.name == body.label_name)
    )).scalar_one_or_none()
    if not label:
        return {"deleted": 0}
    # Subquery for annotation IDs with this label
    ann_subq = select(AnnotationLabel.annotation_id).where(AnnotationLabel.label_id == label.id)
    # Remove label links
    await db.execute(sa_delete(AnnotationLabel).where(AnnotationLabel.label_id == label.id))
    # Delete annotations that have NO remaining labels AND no vote
    from sqlalchemy import exists as sa_exists
    result = await db.execute(sa_delete(Annotation).where(
        Annotation.id.in_(ann_subq),
        Annotation.annotation_vote.is_(None),
        ~sa_exists(
            select(AnnotationLabel.annotation_id)
            .where(AnnotationLabel.annotation_id == Annotation.id)
        )
    ))
    deleted = result.rowcount
    await db.commit()
    return {"deleted": deleted}


class WorkerLabelBody(BaseModel):
    name: str
    emoji: str = "🔍"


@router.post("/worker/projects/{project_id}/labels", status_code=201)
async def create_system_label(
    project_id: UUID,
    body: WorkerLabelBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """ワーカー用: systemラベルを作成"""
    label = Label(project_id=project_id, name=body.name, emoji=body.emoji, system="scan")
    db.add(label)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        return {"exists": True}
    return {"id": str(label.id), "name": label.name}


# ---------------------------------------------------------------------------
# Model file upload / download
# ---------------------------------------------------------------------------

@router.post("/models/{project_id}/upload")
async def upload_model(
    project_id: UUID,
    file: UploadFile,
    _auth: WorkerAuth = Depends(verify_worker_key),
):
    """Upload a trained model file (.pt) to server storage."""
    model_dir = Path(settings.models_dir) / str(project_id)
    model_dir.mkdir(parents=True, exist_ok=True)
    dest = model_dir / "best.pt"
    content = await file.read()
    dest.write_bytes(content)
    return {"path": str(dest), "size": len(content)}


@router.get("/models/{project_id}/download")
async def download_model(
    project_id: UUID,
    _auth: WorkerAuth = Depends(verify_worker_key),
):
    """Download a trained model file (.pt) from server storage."""
    model_path = Path(settings.models_dir) / str(project_id) / "best.pt"
    if not model_path.exists():
        raise HTTPException(status_code=404, detail="Model not found")
    return FileResponse(str(model_path), filename="best.pt")


# ---------------------------------------------------------------------------
# Multi-class model cache (keyed by combined_hash)
# ---------------------------------------------------------------------------

_MULTI_HASH_RE = re.compile(r"^[0-9a-f]{8,64}$")


def _multi_model_dir(combined_hash: str) -> Path:
    """Validate combined_hash (hex only, prevent path traversal) and return storage dir."""
    if not _MULTI_HASH_RE.match(combined_hash):
        raise HTTPException(status_code=400, detail="Invalid combined_hash")
    return Path(settings.models_dir) / "multi" / combined_hash


@router.post("/models/multi/{combined_hash}/upload")
async def upload_multi_model(
    combined_hash: str,
    file: UploadFile,
    meta: str | None = Form(None),
    _auth: WorkerAuth = Depends(verify_worker_key),
):
    """Upload a multi-class trained model + optional meta.json keyed by combined_hash."""
    model_dir = _multi_model_dir(combined_hash)
    model_dir.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    (model_dir / "best.pt").write_bytes(content)
    if meta is not None:
        try:
            json.loads(meta)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="meta must be valid JSON")
        (model_dir / "meta.json").write_text(meta)
    return {"hash": combined_hash, "size": len(content)}


@router.get("/models/multi/{combined_hash}/download")
async def download_multi_model(
    combined_hash: str,
    _auth: WorkerAuth = Depends(verify_worker_key),
):
    """Download a multi-class model file (.pt) by combined_hash."""
    model_path = _multi_model_dir(combined_hash) / "best.pt"
    if not model_path.exists():
        raise HTTPException(status_code=404, detail="Multi model not found")
    return FileResponse(str(model_path), filename="best.pt")


@router.get("/models/multi/{combined_hash}/meta")
async def get_multi_model_meta(
    combined_hash: str,
    _auth: WorkerAuth = Depends(verify_worker_key),
):
    """Return the meta.json for a multi-class model (class_map, project_hashes)."""
    meta_path = _multi_model_dir(combined_hash) / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Multi meta not found")
    return FileResponse(str(meta_path), media_type="application/json")


class DedupBody(BaseModel):
    scan_label: str | None = None


@router.post("/projects/{project_id}/annotations/dedup")
async def worker_dedup_annotations(
    project_id: UUID,
    body: DedupBody | None = None,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """今回のスキャン結果内でのみ重複除去（NMS）。scan_label指定時はそのラベルのアノテーションのみ対象。"""
    from sqlalchemy.orm import aliased

    scan_label = body.scan_label if body else None

    a = aliased(Annotation, name="a_dedup")
    b = aliased(Annotation, name="b_dedup")

    # scan_label内のアノテーションIDを限定するサブクエリ
    if scan_label:
        label_ids = select(AnnotationLabel.annotation_id).join(
            Label, AnnotationLabel.label_id == Label.id
        ).where(Label.project_id == project_id, Label.name == scan_label)
    else:
        label_ids = None

    # bとの比較: IoU>0.3 かつ (投票済み or スコアが高い or 同スコアならID大きい方を残す)
    iou = func.ST_Area(func.ST_Intersection(a.bbox_geom, b.bbox_geom)) / (
        func.ST_Area(a.bbox_geom) + func.ST_Area(b.bbox_geom)
        - func.ST_Area(func.ST_Intersection(a.bbox_geom, b.bbox_geom))
    )
    # 比較対象もscan_label内に限定（他のラベルのアノテーションを消さない）
    better_conditions = [
        b.project_id == project_id,
        b.id != a.id,
        b.bbox_geom.isnot(None),
        func.ST_Intersects(a.bbox_geom, b.bbox_geom),
        iou > 0.3,
        b.annotation_vote.isnot(None)
        | (b.score > a.score)
        | ((b.score == a.score) & (b.id > a.id)),
    ]
    if label_ids is not None:
        better_conditions.append(b.id.in_(label_ids))

    exists_better = select(func.count()).where(
        *better_conditions
    ).correlate(a).scalar_subquery() > 0

    conditions = [
        a.project_id == project_id,
        a.bbox_geom.isnot(None),
        a.annotation_vote.is_(None),
        exists_better,
    ]
    if label_ids is not None:
        conditions.append(a.id.in_(label_ids))

    victims = select(a.id).where(*conditions)

    result = await db.execute(sa_delete(Annotation).where(Annotation.id.in_(victims)))
    await db.commit()
    return {"deleted": result.rowcount}


@router.post("/projects/{project_id}/annotations/by-filter")
async def get_annotations_by_filter(
    project_id: UUID,
    body: dict,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Fetch all annotations matching a filter (for rescore). No limit."""
    from app.routers.annotations import FilterRequest, _resolve_filter_subquery, _annotation_dict, _eager_annotation
    from pydantic import TypeAdapter

    filter_req = TypeAdapter(FilterRequest).validate_python(body.get("filter", {}))
    id_subq, _, _ = _resolve_filter_subquery(project_id, filter_req)

    base = select(Annotation).where(Annotation.project_id == project_id)
    if id_subq is not None:
        base = base.where(Annotation.id.in_(select(id_subq.c[0])))

    result = await db.execute(
        base.options(_eager_annotation())
        .order_by(Annotation.created_at.desc())
    )
    return [_annotation_dict(a) for a in result.scalars().unique()]


class ScoreUpdateItem(BaseModel):
    annotation_id: UUID
    score: float


class BulkScoreBody(BaseModel):
    updates: list[ScoreUpdateItem]


@router.put("/annotations/bulk-score")
async def bulk_update_scores(
    body: BulkScoreBody,
    _auth: WorkerAuth = Depends(verify_worker_key),
    db: AsyncSession = Depends(get_db),
):
    """Bulk-update annotation scores (for rescore jobs)."""
    CHUNK = 500
    updated = 0
    for i in range(0, len(body.updates), CHUNK):
        chunk = body.updates[i : i + CHUNK]
        ids = [u.annotation_id for u in chunk]
        score_map = {u.annotation_id: u.score for u in chunk}
        result = await db.execute(
            select(Annotation).where(Annotation.id.in_(ids))
        )
        for a in result.scalars():
            if a.id in score_map:
                a.score = score_map[a.id]
                updated += 1
        await db.commit()
    return {"updated": updated}



