"""管理者専用エンドポイント。`require_admin` dep で is_admin=true ユーザーのみアクセス可."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models import Annotation, Detection, Job, Project, User

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

# RTX 4090 Community Pod 単価。jobs.completed_at - started_at から GPU 時間 → 推定コスト換算。
# 注意: Pod の DEM 初回展開や idle 待機は jobs 行に出ないため過小評価になる。
# 正確な数値はユーザー自身が RunPod ダッシュボード (/v1/billing/pods) で確認する。
RUNPOD_HOURLY_USD = 0.34


@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db)):
    """全体統計: 各テーブルの総件数 + 直近 7日 / 30日の新規件数."""
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    async def count(stmt):
        return (await db.execute(stmt)).scalar_one()

    total_users = await count(select(func.count()).select_from(User))
    new_users_7d = await count(select(func.count()).select_from(User).where(User.created_at >= week_ago))
    new_users_30d = await count(select(func.count()).select_from(User).where(User.created_at >= month_ago))

    total_projects = await count(select(func.count()).select_from(Project))
    total_annotations = await count(select(func.count()).select_from(Annotation))
    total_detections = await count(select(func.count()).select_from(Detection))

    total_jobs = await count(select(func.count()).select_from(Job))
    new_jobs_7d = await count(select(func.count()).select_from(Job).where(Job.created_at >= week_ago))

    job_rows = await db.execute(
        select(Job.status, func.count()).group_by(Job.status)
    )
    jobs_by_status = {row[0]: row[1] for row in job_rows.all()}

    type_rows = await db.execute(
        select(Job.job_type, func.count()).group_by(Job.job_type)
    )
    jobs_by_type = {row[0]: row[1] for row in type_rows.all()}

    return {
        "users": {"total": total_users, "new_7d": new_users_7d, "new_30d": new_users_30d},
        "projects": {"total": total_projects},
        "annotations": {"total": total_annotations},
        "detections": {"total": total_detections},
        "jobs": {"total": total_jobs, "new_7d": new_jobs_7d, "by_status": jobs_by_status, "by_type": jobs_by_type},
        "as_of": now.isoformat(),
    }


@router.get("/users")
async def list_users(db: AsyncSession = Depends(get_db)):
    """全ユーザー一覧 + 各ユーザーの project / annotation / job 件数."""
    project_count = (
        select(Project.user_id, func.count().label("c"))
        .group_by(Project.user_id)
        .subquery()
    )
    annotation_count = (
        select(Project.user_id, func.count(Annotation.id).label("c"))
        .join(Annotation, Annotation.project_id == Project.id)
        .group_by(Project.user_id)
        .subquery()
    )
    job_count = (
        select(Project.user_id, func.count(Job.id).label("c"))
        .join(Job, Job.project_id == Project.id)
        .group_by(Project.user_id)
        .subquery()
    )
    # GPU 時間推定: completed_at - started_at の合計を秒で集計 (started_at IS NULL の行は除外)
    gpu_seconds = (
        select(
            Project.user_id,
            func.coalesce(
                func.sum(
                    func.extract("epoch", Job.completed_at - Job.started_at)
                ),
                0,
            ).label("sec"),
        )
        .join(Job, Job.project_id == Project.id)
        .where(Job.started_at.is_not(None), Job.completed_at.is_not(None))
        .group_by(Project.user_id)
        .subquery()
    )

    stmt = (
        select(
            User.id,
            User.provider,
            User.display_name,
            User.email,
            User.avatar_url,
            User.is_admin,
            User.tos_accepted_at,
            User.created_at,
            func.coalesce(project_count.c.c, 0).label("projects"),
            func.coalesce(annotation_count.c.c, 0).label("annotations"),
            func.coalesce(job_count.c.c, 0).label("jobs"),
            func.coalesce(gpu_seconds.c.sec, 0).label("gpu_sec"),
        )
        .outerjoin(project_count, project_count.c.user_id == User.id)
        .outerjoin(annotation_count, annotation_count.c.user_id == User.id)
        .outerjoin(job_count, job_count.c.user_id == User.id)
        .outerjoin(gpu_seconds, gpu_seconds.c.user_id == User.id)
        .order_by(User.created_at.desc())
    )
    rows = (await db.execute(stmt)).all()

    return [
        {
            "id": str(r.id),
            "provider": r.provider,
            "display_name": r.display_name,
            "email": r.email,
            "avatar_url": r.avatar_url,
            "is_admin": r.is_admin,
            "tos_accepted_at": r.tos_accepted_at.isoformat() if r.tos_accepted_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "projects": r.projects,
            "annotations": r.annotations,
            "jobs": r.jobs,
            "gpu_hours_est": round(float(r.gpu_sec) / 3600.0, 2),
            "gpu_cost_usd_est": round(float(r.gpu_sec) / 3600.0 * RUNPOD_HOURLY_USD, 2),
        }
        for r in rows
    ]
