"""Project CRUD endpoints."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models import Annotation, Detection, Model, Project, User

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    tag: str | None = None
    is_public: bool = False


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    tag: str | None = None
    is_public: bool | None = None


def _project_dict(p: Project, **counts) -> dict:
    return {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "tag": p.tag,
        "is_public": p.is_public,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
        **counts,
    }


@router.get("/")
async def list_projects(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    stmt = (
        select(
            Project,
            func.count(Annotation.id.distinct()).label("annotation_count"),
        )
        .outerjoin(Annotation, Annotation.project_id == Project.id)
        .where(Project.user_id == user.id)
        .group_by(Project.id)
        .order_by(Project.created_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    return [_project_dict(p, annotation_count=cnt) for p, cnt in rows]


@router.post("/", status_code=201)
async def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = Project(user_id=user.id, **body.model_dump())
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return _project_dict(project)


async def _get_project(project_id: UUID, user: User, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/{project_id}")
async def get_project(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(project_id, user, db)
    annotation_count = (
        await db.execute(
            select(func.count()).select_from(Annotation).where(Annotation.project_id == project.id)
        )
    ).scalar()
    model_count = (
        await db.execute(
            select(func.count()).select_from(Model).where(Model.project_id == project.id)
        )
    ).scalar()
    detection_count = (
        await db.execute(
            select(func.count()).select_from(Detection).where(Detection.project_id == project.id)
        )
    ).scalar()
    return _project_dict(
        project,
        annotation_count=annotation_count,
        model_count=model_count,
        detection_count=detection_count,
    )


@router.put("/{project_id}")
async def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(project_id, user, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    return _project_dict(project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(project_id, user, db)
    await db.delete(project)
    await db.commit()
