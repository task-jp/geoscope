import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import (
    Boolean,
    CHAR,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("provider", "provider_sub", name="uq_users_provider_sub"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    provider_sub: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(255))
    avatar_url: Mapped[str | None] = mapped_column(Text)
    api_key: Mapped[str | None] = mapped_column(String(64))
    tos_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    tag: Mapped[str | None] = mapped_column(String(50))
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user = relationship("User", back_populates="projects")
    labels = relationship("Label", back_populates="project", cascade="all, delete-orphan")
    annotations = relationship("Annotation", back_populates="project", cascade="all, delete-orphan")
    models = relationship("Model", back_populates="project", cascade="all, delete-orphan")
    jobs = relationship("Job", back_populates="project", cascade="all, delete-orphan")
    detections = relationship("Detection", back_populates="project", cascade="all, delete-orphan")


class Label(Base):
    __tablename__ = "labels"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_labels_project_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    emoji: Mapped[str] = mapped_column(String(10), default="📍")
    color: Mapped[str | None] = mapped_column(String(7), default=None)  # hex e.g. #ff6b6b, NULL=auto
    system: Mapped[str | None] = mapped_column(String(20), default=None)  # NULL=user, 'scan'=探索
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    project = relationship("Project", back_populates="labels")
    annotation_labels = relationship("AnnotationLabel", back_populates="label", cascade="all, delete-orphan")


class AnnotationLabel(Base):
    __tablename__ = "annotation_labels"

    annotation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("annotations.id", ondelete="CASCADE"), primary_key=True)
    label_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True)

    annotation = relationship("Annotation", back_populates="annotation_labels")
    label = relationship("Label", back_populates="annotation_labels")


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    lat: Mapped[float] = mapped_column(Double, nullable=False)
    lon: Mapped[float] = mapped_column(Double, nullable=False)
    bbox_px_cx: Mapped[float] = mapped_column(Double, nullable=False)
    bbox_px_cy: Mapped[float] = mapped_column(Double, nullable=False)
    bbox_px_w: Mapped[float] = mapped_column(Double, nullable=False)
    bbox_px_h: Mapped[float] = mapped_column(Double, nullable=False)
    tile_x: Mapped[int] = mapped_column(Integer, nullable=False)
    tile_y: Mapped[int] = mapped_column(Integer, nullable=False)
    tile_z: Mapped[int] = mapped_column(Integer, default=16)
    title: Mapped[str | None] = mapped_column(String(200))
    comment: Mapped[str | None] = mapped_column(Text)
    score: Mapped[float] = mapped_column(Double, default=0, nullable=False, server_default="0")
    annotation_vote: Mapped[str | None] = mapped_column(String(10))  # yes/no/pass/null
    geom = mapped_column(Geometry("POINT", srid=4326))
    bbox_geom = mapped_column(Geometry("POLYGON", srid=4326), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    project = relationship("Project", back_populates="annotations")
    annotation_labels = relationship("AnnotationLabel", back_populates="annotation", cascade="all, delete-orphan")


class Prefecture(Base):
    __tablename__ = "prefectures"

    code: Mapped[str] = mapped_column(CHAR(2), primary_key=True)
    name: Mapped[str] = mapped_column(String(10), nullable=False)
    geom = mapped_column(Geometry("MULTIPOLYGON", srid=4326), nullable=False)


class Model(Base):
    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("project_id", "version"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    model_path: Mapped[str | None] = mapped_column(String(500))
    metrics = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    project = relationship("Project", back_populates="models")
    detections = relationship("Detection", back_populates="model")


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("job_type IN ('train', 'scan')", name="ck_jobs_type"),
        CheckConstraint("status IN ('queued','running','completed','failed')", name="ck_jobs_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    job_type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    progress: Mapped[float] = mapped_column(Double, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    config = mapped_column(JSONB)
    result = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    project = relationship("Project", back_populates="jobs")


class Detection(Base):
    __tablename__ = "detections"
    __table_args__ = (
        CheckConstraint("feedback IN ('yes', 'no')", name="ck_detections_feedback"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("models.id"))
    lat: Mapped[float] = mapped_column(Double, nullable=False)
    lon: Mapped[float] = mapped_column(Double, nullable=False)
    conf: Mapped[float] = mapped_column(Double, nullable=False)
    bbox_cx: Mapped[float | None] = mapped_column(Double)
    bbox_cy: Mapped[float | None] = mapped_column(Double)
    bbox_w: Mapped[float | None] = mapped_column(Double)
    bbox_h: Mapped[float | None] = mapped_column(Double)
    tile_x: Mapped[int] = mapped_column(Integer, nullable=False)
    tile_y: Mapped[int] = mapped_column(Integer, nullable=False)
    geom = mapped_column(Geometry("POINT", srid=4326))
    feedback: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    project = relationship("Project", back_populates="detections")
    model = relationship("Model", back_populates="detections")
