"""Detection query endpoints with bbox filtering and GeoJSON export."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models import Detection, Project, User

router = APIRouter(prefix="/api", tags=["detections"])


class DetectionFeedback(BaseModel):
    feedback: Literal["yes", "no"]


def _detection_dict(d: Detection) -> dict:
    return {
        "id": str(d.id),
        "project_id": str(d.project_id),
        "model_id": str(d.model_id) if d.model_id else None,
        "lat": d.lat,
        "lon": d.lon,
        "conf": d.conf,
        "bbox_cx": d.bbox_cx,
        "bbox_cy": d.bbox_cy,
        "bbox_w": d.bbox_w,
        "bbox_h": d.bbox_h,
        "tile_x": d.tile_x,
        "tile_y": d.tile_y,
        "feedback": d.feedback,
        "created_at": d.created_at.isoformat(),
    }


async def _get_user_project(project_id: UUID, user: User, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _bbox_filter(stmt, west: float | None, south: float | None, east: float | None, north: float | None):
    if all(v is not None for v in (west, south, east, north)):
        stmt = stmt.where(
            func.ST_Intersects(
                Detection.geom,
                func.ST_MakeEnvelope(west, south, east, north, 4326),
            )
        )
    return stmt


@router.get("/projects/{project_id}/detections")
async def list_detections(
    project_id: UUID,
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=1000),
    min_conf: float = Query(0.0, ge=0, le=1),
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    stmt = (
        select(Detection)
        .where(Detection.project_id == project_id, Detection.conf >= min_conf)
        .order_by(Detection.conf.desc())
    )
    stmt = _bbox_filter(stmt, west, south, east, north)
    stmt = stmt.offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(stmt)
    return [_detection_dict(d) for d in result.scalars()]


@router.get("/projects/{project_id}/detections/geojson")
async def detections_geojson(
    project_id: UUID,
    min_conf: float = Query(0.0, ge=0, le=1),
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    stmt = (
        select(Detection)
        .where(Detection.project_id == project_id, Detection.conf >= min_conf)
        .order_by(Detection.conf.desc())
    )
    stmt = _bbox_filter(stmt, west, south, east, north)
    result = await db.execute(stmt)
    features = []
    for d in result.scalars():
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [d.lon, d.lat]},
            "properties": {
                "id": str(d.id),
                "conf": d.conf,
                "feedback": d.feedback,
                "tile_x": d.tile_x,
                "tile_y": d.tile_y,
            },
        })
    return {"type": "FeatureCollection", "features": features}


@router.post("/detections/{detection_id}/feedback")
async def set_feedback(
    detection_id: UUID,
    body: DetectionFeedback,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Detection).where(Detection.id == detection_id))
    detection = result.scalar_one_or_none()
    if not detection:
        raise HTTPException(status_code=404, detail="Detection not found")
    await _get_user_project(detection.project_id, user, db)
    detection.feedback = body.feedback
    await db.commit()
    await db.refresh(detection)
    return _detection_dict(detection)


@router.get("/projects/{project_id}/detections/stats")
async def detection_stats(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    base = select(func.count()).select_from(Detection).where(Detection.project_id == project_id)
    total = (await db.execute(base)).scalar()
    yes_count = (
        await db.execute(base.where(Detection.feedback == "yes"))
    ).scalar()
    no_count = (
        await db.execute(base.where(Detection.feedback == "no"))
    ).scalar()
    avg_conf = (
        await db.execute(
            select(func.avg(Detection.conf)).where(Detection.project_id == project_id)
        )
    ).scalar()
    return {
        "total": total,
        "feedback_yes": yes_count,
        "feedback_no": no_count,
        "feedback_pending": total - (yes_count or 0) - (no_count or 0),
        "avg_confidence": round(avg_conf, 4) if avg_conf else None,
    }
