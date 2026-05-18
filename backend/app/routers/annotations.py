"""Annotation CRUD endpoints with normalized label join table."""

import math
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select, delete as sa_delete, and_, exists
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload, aliased

from app.database import get_db
from app.deps import get_current_user
from app.models import Annotation, AnnotationLabel, Job, Label, Prefecture, Project, User


def _compute_bbox_geom_expr(tile_x, tile_y, tile_z, cx, cy, w, h):
    """SQL expression to build bbox polygon from tile coordinates.
    cx/cy/w/h are normalized (0-1) fractions of the tile.
    bbox_pxはタイル内正規化値で、1.0を超えるとタイル境界を跨ぐ。"""
    import math
    # Python側で浮動小数点演算（SQLAlchemy式の精度問題を回避）
    n = 2 ** int(tile_z) if isinstance(tile_z, (int, float)) else 2 ** 16
    tx = float(tile_x)
    ty = float(tile_y)
    _cx, _cy, _w, _h = float(cx), float(cy), float(w), float(h)
    west = (tx + _cx - _w / 2) / n * 360 - 180
    east = (tx + _cx + _w / 2) / n * 360 - 180
    merc_s = (ty + _cy + _h / 2) / n
    merc_n = (ty + _cy - _h / 2) / n
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * merc_s))))
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * merc_n))))
    return func.ST_SetSRID(func.ST_MakeEnvelope(west, south, east, north), 4326)


def _bbox_geom_from_annotation(a):
    """Compute bbox_geom SQL expression from annotation columns."""
    return _compute_bbox_geom_expr(
        a.tile_x, a.tile_y, a.tile_z,
        a.bbox_px_cx, a.bbox_px_cy, a.bbox_px_w, a.bbox_px_h
    )

router = APIRouter(prefix="/api", tags=["annotations"])


class AnnotationCreate(BaseModel):
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


def _labels_from_annotation(a: Annotation) -> list[dict]:
    """Build labels list from annotation_labels relationship."""
    return [
        {"name": al.label.name, "emoji": al.label.emoji, "color": al.label.color, "system": al.label.system}
        for al in (a.annotation_labels or [])
    ]


def _annotation_dict(a: Annotation) -> dict:
    return {
        "id": str(a.id),
        "project_id": str(a.project_id),
        "lat": a.lat,
        "lon": a.lon,
        "bbox_px_cx": a.bbox_px_cx,
        "bbox_px_cy": a.bbox_px_cy,
        "bbox_px_w": a.bbox_px_w,
        "bbox_px_h": a.bbox_px_h,
        "tile_x": a.tile_x,
        "tile_y": a.tile_y,
        "tile_z": a.tile_z,
        "title": a.title,
        "labels": _labels_from_annotation(a),
        "comment": a.comment,
        "score": a.score,
        "annotation_vote": a.annotation_vote,
        "created_at": a.created_at.isoformat(),
    }


def _eager_annotation():
    """Return selectinload options for annotation with labels."""
    return selectinload(Annotation.annotation_labels).selectinload(AnnotationLabel.label)


async def _resolve_labels(db: AsyncSession, project_id: UUID, label_dicts: list[dict]) -> list[Label]:
    """Resolve label name dicts to Label ORM objects, creating if needed."""
    if not label_dicts:
        return []
    names = [l.get("name") for l in label_dicts if l.get("name")]
    if not names:
        return []
    result = await db.execute(
        select(Label).where(Label.project_id == project_id, Label.name.in_(names))
    )
    existing = {l.name: l for l in result.scalars()}
    new_labels = []
    for ld in label_dicts:
        name = ld.get("name")
        if not name or name in existing:
            continue
        lbl = Label(project_id=project_id, name=name, emoji=ld.get("emoji", "📍"),
                    system=ld.get("system") or None)
        new_labels.append(lbl)
        existing[name] = lbl
    if new_labels:
        db.add_all(new_labels)
        await db.flush()
    return [existing[ld["name"]] for ld in label_dicts if ld.get("name") and ld["name"] in existing]


async def _set_annotation_labels(db: AsyncSession, annotation: Annotation, project_id: UUID, label_dicts: list[dict]):
    """Replace all labels for an annotation."""
    # Delete existing
    await db.execute(
        sa_delete(AnnotationLabel).where(AnnotationLabel.annotation_id == annotation.id)
    )
    # Add new
    labels = await _resolve_labels(db, project_id, label_dicts)
    for lbl in labels:
        db.add(AnnotationLabel(annotation_id=annotation.id, label_id=lbl.id))


async def _get_user_project(project_id: UUID, user: User, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/projects/{project_id}/annotations")
async def list_annotations(
    project_id: UUID,
    label: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    stmt = select(Annotation).where(Annotation.project_id == project_id).options(_eager_annotation())
    if label:
        stmt = stmt.where(
            Annotation.annotation_labels.any(
                AnnotationLabel.label.has(Label.name == label)
            )
        )
    result = await db.execute(stmt.order_by(Annotation.score.desc(), Annotation.created_at.desc()))
    return [_annotation_dict(a) for a in result.scalars().unique()]


@router.get("/prefectures/{name}/bbox")
async def get_prefecture_bbox(
    name: str,
    db: AsyncSession = Depends(get_db),
):
    """Get bounding box of a prefecture (no auth required)."""
    result = await db.execute(
        select(
            func.ST_XMin(func.ST_Envelope(Prefecture.geom)),
            func.ST_YMin(func.ST_Envelope(Prefecture.geom)),
            func.ST_XMax(func.ST_Envelope(Prefecture.geom)),
            func.ST_YMax(func.ST_Envelope(Prefecture.geom)),
        ).where(Prefecture.name == name)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Prefecture not found")
    return {"west": row[0], "south": row[1], "east": row[2], "north": row[3]}


@router.get("/prefectures/{name}/tiles")
async def get_prefecture_tiles(
    name: str,
    z: int = 16,
    db: AsyncSession = Depends(get_db),
):
    """Return z/x/y tile coordinates that intersect the prefecture boundary."""
    from sqlalchemy import text
    n = 2 ** z
    result = await db.execute(text("""
        WITH params AS (
            SELECT geom,
                   ST_XMin(ST_Envelope(geom)) as west, ST_YMin(ST_Envelope(geom)) as south,
                   ST_XMax(ST_Envelope(geom)) as east, ST_YMax(ST_Envelope(geom)) as north
            FROM prefectures WHERE name = :pref_name
        ),
        tile_range AS (
            SELECT geom,
                   floor((west + 180.0) / 360.0 * :n)::int as tx_min,
                   floor((east + 180.0) / 360.0 * :n)::int as tx_max,
                   floor((1.0 - ln(tan(radians(north)) + 1.0/cos(radians(north))) / pi()) / 2.0 * :n)::int as ty_min,
                   floor((1.0 - ln(tan(radians(south)) + 1.0/cos(radians(south))) / pi()) / 2.0 * :n)::int as ty_max
            FROM params
        )
        SELECT tx, ty FROM tile_range,
               generate_series(tx_min, tx_max) AS tx,
               generate_series(ty_min, ty_max) AS ty
        WHERE ST_Intersects(
            ST_MakeEnvelope(
                tx::float / :n * 360.0 - 180.0,
                degrees(atan(sinh(pi() * (1.0 - 2.0 * (ty + 1)::float / :n)))),
                (tx + 1)::float / :n * 360.0 - 180.0,
                degrees(atan(sinh(pi() * (1.0 - 2.0 * ty::float / :n)))),
                4326
            ),
            geom
        )
    """), {"n": n, "pref_name": name})
    rows = result.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="Prefecture not found or no tiles")
    return [{"x": row[0], "y": row[1]} for row in rows]


class ExportBody(BaseModel):
    filter: dict = {}


async def _filtered_annotations(project_id, body, user, db):
    await _get_user_project(project_id, user, db)
    stmt = select(Annotation).where(Annotation.project_id == project_id)
    stmt = _apply_filter(stmt, project_id, body.filter)
    stmt = stmt.options(_eager_annotation()).order_by(Annotation.score.desc(), Annotation.created_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().unique())


@router.post("/projects/{project_id}/annotations/export.geojson")
async def export_geojson(
    project_id: UUID,
    body: ExportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response
    import json as _json

    annots = await _filtered_annotations(project_id, body, user, db)
    features = []
    for a in annots:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [a.lon, a.lat]},
            "properties": {
                "title": a.title,
                "labels": _labels_from_annotation(a),
                "comment": a.comment,
                "score": a.score,
                "bbox_px_cx": a.bbox_px_cx, "bbox_px_cy": a.bbox_px_cy,
                "bbox_px_w": a.bbox_px_w, "bbox_px_h": a.bbox_px_h,
                "tile_x": a.tile_x, "tile_y": a.tile_y, "tile_z": a.tile_z,
            },
        })
    geojson = _json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)
    return Response(content=geojson.encode("utf-8"), media_type="application/geo+json; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=annotations_{project_id}.geojson"})


@router.post("/projects/{project_id}/annotations/export-points.geojson")
async def export_points_geojson(
    project_id: UUID,
    body: ExportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """フィルタ適用 + 都道府県逆引き付き Point GeoJSON エクスポート。"""
    from fastapi.responses import Response
    from sqlalchemy import text
    import json as _json

    annots = await _filtered_annotations(project_id, body, user, db)

    # 都道府県逆引き（一括）
    pref_map = {}
    if annots:
        rows = await db.execute(text("""
            SELECT a.id, p.name
            FROM annotations a
            JOIN prefectures p ON ST_Intersects(a.geom, p.geom)
            WHERE a.id = ANY(:ids)
        """), {"ids": [a.id for a in annots]})
        for aid, pname in rows:
            pref_map[aid] = pname

    features = []
    for a in annots:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [a.lon, a.lat]},
            "properties": {
                "name": a.title or "",
                "score": a.score,
                "labels": _labels_from_annotation(a),
                "prefecture": pref_map.get(a.id, ""),
            },
        })
    geojson = _json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)
    return Response(content=geojson.encode("utf-8"), media_type="application/geo+json; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=points_{project_id}.geojson"})


@router.post("/projects/{project_id}/annotations/export.csv")
async def export_csv(
    project_id: UUID,
    body: ExportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response
    import csv as _csv, io as _io, json as _json

    annots = await _filtered_annotations(project_id, body, user, db)
    buf = _io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(["lat", "lon", "title", "labels", "comment", "score",
                     "bbox_px_cx", "bbox_px_cy", "bbox_px_w", "bbox_px_h",
                     "tile_x", "tile_y", "tile_z"])
    for a in annots:
        writer.writerow([
            a.lat, a.lon, a.title or "",
            _json.dumps(_labels_from_annotation(a), ensure_ascii=False),
            a.comment or "", a.score,
            a.bbox_px_cx, a.bbox_px_cy, a.bbox_px_w, a.bbox_px_h,
            a.tile_x, a.tile_y, a.tile_z,
        ])
    csv_bytes = "\ufeff" + buf.getvalue()  # BOM for Excel compatibility
    return Response(content=csv_bytes.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=annotations_{project_id}.csv"})


@router.post("/projects/{project_id}/annotations/import", status_code=201)
async def import_annotations(
    project_id: UUID,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    import csv as _csv, io as _io, json as _json
    from datetime import datetime, timezone, timedelta

    await _get_user_project(project_id, user, db)

    # インポートラベル自動付与（探索ラベルと同様の形式）
    now_jst = datetime.now(timezone(timedelta(hours=9)))
    import_label_name = now_jst.strftime("%Y/%m/%d %H:%M:%S") + " インポート"
    import_label = Label(project_id=project_id, name=import_label_name, emoji="📤", system="import")
    db.add(import_label)
    await db.flush()

    content = await file.read()
    text = content.decode("utf-8-sig")
    inserted = 0

    if file.filename and file.filename.endswith(".geojson"):
        data = _json.loads(text)
        for f in data.get("features", []):
            props = f.get("properties", {})
            geom = f.get("geometry", {})
            geom_type = geom.get("type", "")

            if geom_type == "Polygon":
                # bbox polygon → extract center and dimensions
                coords = geom.get("coordinates", [[]])[0]
                lons = [c[0] for c in coords]
                lats = [c[1] for c in coords]
                west, east = min(lons), max(lons)
                south, north = min(lats), max(lats)
                lon = (west + east) / 2
                lat = (south + north) / 2
            else:
                # Point
                c = geom.get("coordinates", [0, 0])
                lon, lat = c[0], c[1]

            # Compute tile coordinates and fractional position within tile from lat/lon
            import math as _math
            z = props.get("tile_z", 16)
            n = 2 ** z
            px_total = (lon + 180) / 360 * n
            py_total = (1 - _math.log(_math.tan(_math.radians(lat)) + 1 / _math.cos(_math.radians(lat))) / _math.pi) / 2 * n
            tile_x = props.get("tile_x", int(px_total))
            tile_y = props.get("tile_y", int(py_total))
            # bbox center: default to actual lat/lon position within tile (NOT tile center)
            bbox_px_cx = props.get("bbox_px_cx", px_total - tile_x)
            bbox_px_cy = props.get("bbox_px_cy", py_total - tile_y)
            bbox_px_w = props.get("bbox_px_w", 0.1)
            bbox_px_h = props.get("bbox_px_h", 0.1)
            if bbox_px_cx > 1: bbox_px_cx /= 512
            if bbox_px_cy > 1: bbox_px_cy /= 512
            if bbox_px_w > 1: bbox_px_w /= 512
            if bbox_px_h > 1: bbox_px_h /= 512

            # Labels: accept both string array and dict array
            raw_labels = props.get("labels", [])
            if raw_labels and isinstance(raw_labels[0], str):
                label_dicts = [{"name": n} for n in raw_labels]
            else:
                label_dicts = raw_labels

            annotation = Annotation(
                project_id=project_id, lat=lat, lon=lon,
                bbox_px_cx=bbox_px_cx, bbox_px_cy=bbox_px_cy,
                bbox_px_w=bbox_px_w, bbox_px_h=bbox_px_h,
                tile_x=tile_x, tile_y=tile_y, tile_z=z,
                title=props.get("name") or props.get("title"),
                comment=props.get("comment"),
                score=props.get("score", 0),
                geom=func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326),
                bbox_geom=_compute_bbox_geom_expr(tile_x, tile_y, z, bbox_px_cx, bbox_px_cy, bbox_px_w, bbox_px_h),
            )
            db.add(annotation)
            await db.flush()
            await _set_annotation_labels(db, annotation, project_id, label_dicts)
            db.add(AnnotationLabel(annotation_id=annotation.id, label_id=import_label.id))
            inserted += 1
    else:
        reader = _csv.DictReader(_io.StringIO(text))
        for row in reader:
            lat = float(row.get("lat", 0))
            lon = float(row.get("lon", 0))
            label_dicts = _json.loads(row.get("labels", "[]")) if row.get("labels") else []
            bbox_px_cx = float(row.get("bbox_px_cx", 0.5))
            bbox_px_cy = float(row.get("bbox_px_cy", 0.5))
            bbox_px_w = float(row.get("bbox_px_w", 0.1))
            bbox_px_h = float(row.get("bbox_px_h", 0.1))
            # ピクセル値(>1)なら正規化(0-1)に変換
            if bbox_px_cx > 1: bbox_px_cx /= 512
            if bbox_px_cy > 1: bbox_px_cy /= 512
            if bbox_px_w > 1: bbox_px_w /= 512
            if bbox_px_h > 1: bbox_px_h /= 512
            tile_x = int(row.get("tile_x", 0))
            tile_y = int(row.get("tile_y", 0))
            tile_z = int(row.get("tile_z", 16))
            annotation = Annotation(
                project_id=project_id, lat=lat, lon=lon,
                bbox_px_cx=bbox_px_cx, bbox_px_cy=bbox_px_cy,
                bbox_px_w=bbox_px_w, bbox_px_h=bbox_px_h,
                tile_x=tile_x, tile_y=tile_y, tile_z=tile_z,
                title=row.get("title") or None, comment=row.get("comment") or None,
                score=float(row.get("score", inserted)),
                geom=func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326),
                bbox_geom=_compute_bbox_geom_expr(tile_x, tile_y, tile_z, bbox_px_cx, bbox_px_cy, bbox_px_w, bbox_px_h),
            )
            db.add(annotation)
            await db.flush()
            await _set_annotation_labels(db, annotation, project_id, label_dicts)
            db.add(AnnotationLabel(annotation_id=annotation.id, label_id=import_label.id))
            inserted += 1

    await db.commit()
    return {"inserted": inserted}


@router.post("/projects/{project_id}/annotations", status_code=201)
async def create_annotation(
    project_id: UUID,
    body: AnnotationCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_user_project(project_id, user, db)
    annotation = Annotation(
        project_id=project_id,
        lat=body.lat, lon=body.lon,
        bbox_px_cx=body.bbox_px_cx, bbox_px_cy=body.bbox_px_cy,
        bbox_px_w=body.bbox_px_w, bbox_px_h=body.bbox_px_h,
        tile_x=body.tile_x, tile_y=body.tile_y, tile_z=body.tile_z,
        title=body.title, comment=body.comment, score=body.score,
        geom=func.ST_SetSRID(func.ST_MakePoint(body.lon, body.lat), 4326),
        bbox_geom=_compute_bbox_geom_expr(
            body.tile_x, body.tile_y, body.tile_z,
            body.bbox_px_cx, body.bbox_px_cy, body.bbox_px_w, body.bbox_px_h),
    )
    db.add(annotation)
    await db.flush()
    await _set_annotation_labels(db, annotation, project_id, body.labels)
    await db.commit()
    # Reload with labels
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation.id).options(_eager_annotation())
    )
    return _annotation_dict(result.scalar_one())


class AnnotationUpdate(BaseModel):
    title: str | None = None
    labels: list[dict] | None = None
    comment: str | None = None
    annotation_vote: str | None = None
    score: float | None = None
    lat: float | None = None
    lon: float | None = None
    bbox_px_cx: float | None = None
    bbox_px_cy: float | None = None
    bbox_px_w: float | None = None
    bbox_px_h: float | None = None
    tile_x: int | None = None
    tile_y: int | None = None
    tile_z: int | None = None


@router.put("/annotations/{annotation_id}")
async def update_annotation(
    annotation_id: UUID,
    body: AnnotationUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Annotation).where(Annotation.id == annotation_id))
    annotation = result.scalar_one_or_none()
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await _get_user_project(annotation.project_id, user, db)
    if body.title is not None:
        annotation.title = body.title.strip() or None
    if body.labels is not None:
        await _set_annotation_labels(db, annotation, annotation.project_id, body.labels)
    if body.comment is not None:
        annotation.comment = body.comment.strip() or None
    if body.annotation_vote is not None:
        annotation.annotation_vote = body.annotation_vote or None
    if body.score is not None:
        annotation.score = body.score
    if body.lat is not None:
        annotation.lat = body.lat
    if body.lon is not None:
        annotation.lon = body.lon
    if body.bbox_px_cx is not None:
        annotation.bbox_px_cx = body.bbox_px_cx
    if body.bbox_px_cy is not None:
        annotation.bbox_px_cy = body.bbox_px_cy
    if body.bbox_px_w is not None:
        annotation.bbox_px_w = body.bbox_px_w
    if body.bbox_px_h is not None:
        annotation.bbox_px_h = body.bbox_px_h
    if body.tile_x is not None:
        annotation.tile_x = body.tile_x
    if body.tile_y is not None:
        annotation.tile_y = body.tile_y
    if body.tile_z is not None:
        annotation.tile_z = body.tile_z
    if body.lat is not None and body.lon is not None:
        annotation.geom = func.ST_SetSRID(func.ST_MakePoint(body.lon, body.lat), 4326)
    # bbox_pxが変わったらbbox_geom再計算
    if any(getattr(body, f) is not None for f in ('bbox_px_cx', 'bbox_px_cy', 'bbox_px_w', 'bbox_px_h', 'tile_x', 'tile_y', 'tile_z')):
        annotation.bbox_geom = _compute_bbox_geom_expr(
            annotation.tile_x, annotation.tile_y, annotation.tile_z,
            annotation.bbox_px_cx, annotation.bbox_px_cy,
            annotation.bbox_px_w, annotation.bbox_px_h)
    await db.commit()
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id).options(_eager_annotation())
    )
    return _annotation_dict(result.scalar_one())


@router.delete("/annotations/{annotation_id}", status_code=204)
async def delete_annotation(
    annotation_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Annotation).where(Annotation.id == annotation_id))
    annotation = result.scalar_one_or_none()
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await _get_user_project(annotation.project_id, user, db)
    await db.delete(annotation)
    await db.commit()


class BulkDeleteBody(BaseModel):
    ids: list[UUID]


@router.post("/annotations/bulk-delete", status_code=200)
async def bulk_delete_annotations(
    body: BulkDeleteBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.ids:
        return {"deleted": 0}
    user_project_ids = (await db.execute(
        select(Project.id).where(Project.user_id == user.id)
    )).scalars().all()
    result = await db.execute(
        sa_delete(Annotation).where(
            Annotation.id.in_(body.ids),
            Annotation.project_id.in_(user_project_ids),
        )
    )
    await db.commit()
    return {"deleted": result.rowcount}


class BulkVoteBody(BaseModel):
    ids: list[UUID]
    vote: str | None = None  # 'yes', 'no', 'pass', or null to clear


@router.post("/annotations/bulk-vote", status_code=200)
async def bulk_vote(
    body: BulkVoteBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.ids:
        return {"updated": 0}
    user_project_ids = (await db.execute(
        select(Project.id).where(Project.user_id == user.id)
    )).scalars().all()
    vote_val = body.vote if body.vote in ('yes', 'no', 'pass') else None
    from sqlalchemy import update as sa_update
    result = await db.execute(
        sa_update(Annotation).where(
            Annotation.id.in_(body.ids),
            Annotation.project_id.in_(user_project_ids),
        ).values(annotation_vote=vote_val)
    )
    await db.commit()
    return {"updated": result.rowcount}


class BulkVoteFilterBody(BaseModel):
    vote: str | None = None
    filter: dict = {}  # FilterRequest形式


@router.post("/projects/{project_id}/annotations/bulk-vote-filter", status_code=200)
async def bulk_vote_by_filter(
    project_id: UUID,
    body: BulkVoteFilterBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Apply vote to all annotations matching filter criteria."""
    await _get_user_project(project_id, user, db)
    vote_val = body.vote if body.vote in ('yes', 'no', 'pass') else None
    from pydantic import TypeAdapter
    from sqlalchemy import update as sa_update
    filter_req = TypeAdapter(FilterRequest).validate_python(body.filter)
    id_subq, _, _ = _resolve_filter_subquery(project_id, filter_req)
    stmt = sa_update(Annotation).where(Annotation.project_id == project_id)
    if id_subq is not None:
        stmt = stmt.where(Annotation.id.in_(select(id_subq.c[0])))
    result = await db.execute(stmt.values(annotation_vote=vote_val))
    await db.commit()
    return {"updated": result.rowcount}


class BulkRemoveLabelBody(BaseModel):
    ids: list[UUID]
    label_name: str


@router.post("/annotations/bulk-remove-label", status_code=200)
async def bulk_remove_label(
    body: BulkRemoveLabelBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a label from annotations. Delete orphaned annotations (no remaining labels)."""
    if not body.ids or not body.label_name:
        return {"unlinked": 0, "deleted": 0}
    user_project_ids = (await db.execute(
        select(Project.id).where(Project.user_id == user.id)
    )).scalars().all()
    # Find label
    label = (await db.execute(
        select(Label).where(Label.name == body.label_name, Label.project_id.in_(user_project_ids))
    )).scalar_one_or_none()
    if label:
        # 探索中なら拒否
        running = (await db.execute(
            select(Job).where(Job.project_id == label.project_id, Job.status == "running", Job.job_type == "scan")
        )).scalars().all()
        for job in running:
            if (job.config or {}).get("scan_label") == body.label_name:
                raise HTTPException(409, detail="探索中のラベルは削除できません。削除したい場合は先に探索をキャンセルしてください")
    if not label:
        return {"unlinked": 0, "deleted": 0}
    # Remove label links
    await db.execute(
        sa_delete(AnnotationLabel).where(
            AnnotationLabel.label_id == label.id,
            AnnotationLabel.annotation_id.in_(body.ids),
        )
    )
    # Delete orphaned annotations (no remaining labels AND no vote)
    from sqlalchemy import exists as sa_exists
    orphans = (await db.execute(
        select(Annotation.id).where(
            Annotation.id.in_(body.ids),
            Annotation.project_id.in_(user_project_ids),
            Annotation.annotation_vote.is_(None),
            ~sa_exists(select(AnnotationLabel.annotation_id)
                       .where(AnnotationLabel.annotation_id == Annotation.id))
        )
    )).scalars().all()
    deleted = 0
    if orphans:
        result = await db.execute(sa_delete(Annotation).where(Annotation.id.in_(orphans)))
        deleted = result.rowcount
    await db.commit()
    return {"unlinked": len(body.ids), "deleted": deleted}


class BulkAddLabelBody(BaseModel):
    ids: list[UUID]
    label_name: str
    label_emoji: str = "📍"


@router.post("/annotations/bulk-add-label", status_code=200)
async def bulk_add_label(
    body: BulkAddLabelBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a label to multiple annotations at once (skip if already present)."""
    if not body.ids or not body.label_name:
        return {"updated": 0}
    user_project_ids = (await db.execute(
        select(Project.id).where(Project.user_id == user.id)
    )).scalars().all()
    # Get target annotations
    result = await db.execute(
        select(Annotation).where(
            Annotation.id.in_(body.ids),
            Annotation.project_id.in_(user_project_ids),
        )
    )
    targets = list(result.scalars())
    if not targets:
        return {"updated": 0}
    # Resolve label (create if not exists) using first annotation's project
    project_id = targets[0].project_id
    labels = await _resolve_labels(db, project_id, [{"name": body.label_name, "emoji": body.label_emoji}])
    if not labels:
        return {"updated": 0}
    label = labels[0]
    # Find which annotations already have this label
    existing = set((await db.execute(
        select(AnnotationLabel.annotation_id).where(
            AnnotationLabel.annotation_id.in_([a.id for a in targets]),
            AnnotationLabel.label_id == label.id,
        )
    )).scalars())
    new_links = [AnnotationLabel(annotation_id=a.id, label_id=label.id)
                  for a in targets if a.id not in existing]
    if new_links:
        db.add_all(new_links)
    await db.commit()
    return {"updated": len(new_links)}


# ── Filter API ──

class FilterRow(BaseModel):
    model_config = {"extra": "ignore"}
    label: str | None = None
    present: bool = True
    type: str | None = None
    value: str | None = None

class FilterSet(BaseModel):
    model_config = {"extra": "ignore"}
    rows: list[FilterRow] = []
    enabled: bool = True
    visible: bool = True
    limit: int | None = None
    logic: str = "and"  # "and" or "or"

class FilterRequest(BaseModel):
    model_config = {"extra": "ignore"}
    sets: list[FilterSet] = []
    spatials: list[str] = []


def _row_condition(row: FilterRow, project_id: UUID):
    """Build a single filter condition from a FilterRow."""
    if row.type == 'title':
        if row.value:
            return Annotation.title.ilike(f"%{row.value}%")
        else:
            return (Annotation.title.is_(None)) | (Annotation.title == '')
    elif row.type == 'prefecture' and row.value:
        pref_geom = select(Prefecture.geom).where(Prefecture.name == row.value).scalar_subquery()
        return func.ST_Intersects(Annotation.bbox_geom, pref_geom)
    elif row.type == 'annotation':
        if row.value == 'none':
            return Annotation.annotation_vote.is_(None)
        elif row.value == 'any':
            return Annotation.annotation_vote.isnot(None)
        elif row.value in ('yes', 'no', 'pass'):
            return Annotation.annotation_vote == row.value
    elif row.type == 'overlap':
        return None  # handled in _build_set_query
    elif row.label:
        label_exists = select(AnnotationLabel.annotation_id).join(
            Label, AnnotationLabel.label_id == Label.id
        ).where(
            AnnotationLabel.annotation_id == Annotation.id,
            Label.name == row.label,
            Label.project_id == project_id,
        ).correlate(Annotation).exists()
        if row.present:
            return label_exists
        else:
            return ~label_exists
    return None


def _build_set_query(project_id: UUID, rows: list[FilterRow], logic: str = "and"):
    """Build a query for annotations matching conditions in a set (AND or OR)."""
    from sqlalchemy import and_, or_
    from sqlalchemy.orm import aliased
    has_overlap = any(r.type == 'overlap' for r in rows)
    other_rows = [r for r in rows if r.type != 'overlap']

    stmt = select(Annotation.id, Annotation.bbox_geom).where(Annotation.project_id == project_id)
    conditions = []
    for row in other_rows:
        cond = _row_condition(row, project_id)
        if cond is not None:
            conditions.append(cond)
    if not conditions and not has_overlap:
        return None
    if conditions:
        if logic == "or":
            stmt = stmt.where(or_(*conditions))
        else:
            stmt = stmt.where(and_(*conditions))

    if has_overlap:
        # 同セットの他条件にマッチするアノテーション内で重複チェック
        id_subq = select(Annotation.id).where(Annotation.project_id == project_id)
        if conditions:
            id_subq = id_subq.where(and_(*conditions) if logic != "or" else or_(*conditions))
        id_subq = id_subq.subquery()
        A2 = aliased(Annotation)
        overlap_exists = select(A2.id).where(
            A2.id != Annotation.id,
            A2.id.in_(select(id_subq.c.id)),
            func.ST_Intersects(Annotation.bbox_geom, A2.bbox_geom),
        ).correlate(Annotation).exists()
        stmt = stmt.where(overlap_exists)

    return stmt


def _apply_filter(stmt, project_id: UUID, filter_data: dict | None):
    """Apply filter to a SQLAlchemy statement. Adds WHERE clause if filter is set."""
    if not filter_data:
        return stmt
    from pydantic import TypeAdapter
    filter_req = TypeAdapter(FilterRequest).validate_python(filter_data)
    id_subq, _, _ = _resolve_filter_subquery(project_id, filter_req)
    if id_subq is not None:
        stmt = stmt.where(Annotation.id.in_(select(id_subq.c[0])))
    return stmt


def _resolve_filter_subquery(project_id: UUID, filter_req: FilterRequest):
    """Resolve filter to a SQLAlchemy subquery of annotation IDs.
    Returns (id_subquery_or_None, active_sets, active_spatials).
    None means 'all annotations in project' (no filter)."""
    active_sets = []
    active_spatials = []
    for i, s in enumerate(filter_req.sets):
        if not s.enabled:
            continue
        if active_sets:
            sp_idx = i - 1
            active_spatials.append(filter_req.spatials[sp_idx] if sp_idx < len(filter_req.spatials) else 'intersects')
        active_sets.append(s)

    if not active_sets or not active_sets[0].rows:
        return None, active_sets, active_spatials

    if len(active_sets) == 1:
        q = _build_set_query(project_id, active_sets[0].rows, active_sets[0].logic)
        if q is None:
            return None, active_sets, active_spatials
        id_q = q.with_only_columns(q.selected_columns[0])
        set_limit = active_sets[0].limit
        if set_limit and set_limit > 0:
            id_q = id_q.order_by(Annotation.created_at.desc(), Annotation.score.desc()).limit(set_limit)
        return id_q.subquery(), active_sets, active_spatials

    # 複数セット: サブクエリ + 空間比較
    from sqlalchemy import literal_column, union_all, union
    from sqlalchemy.orm import aliased

    set_id_subqs = []
    for s in active_sets:
        q = _build_set_query(project_id, s.rows, s.logic)
        if q is None:
            q = select(Annotation.id).where(Annotation.project_id == project_id)
        else:
            q = q.with_only_columns(q.selected_columns[0])
        if s.limit and s.limit > 0:
            q = q.order_by(Annotation.created_at.desc(), Annotation.score.desc()).limit(s.limit)
        set_id_subqs.append(q.subquery())

    parts = []
    for i in range(len(active_sets) - 1):
        sq_a, sq_b = set_id_subqs[i], set_id_subqs[i + 1]
        spatial = active_spatials[i] if i < len(active_spatials) else 'intersects'
        a_ann = aliased(Annotation, name=f"a_{i}")
        b_ann = aliased(Annotation, name=f"b_{i}")

        def _spatial_exists(outer, inner, sq_inner, negate=False):
            subq = select(literal_column("1")).where(
                inner.id.in_(select(sq_inner.c[0])),
                inner.bbox_geom.isnot(None),
                func.ST_Intersects(outer.bbox_geom, inner.bbox_geom),
            ).correlate(outer).exists()
            return ~subq if negate else subq

        if spatial == 'union':
            # 単純和集合: 空間フィルタなし
            if active_sets[i].visible:
                parts.append(select(a_ann.id).where(a_ann.id.in_(select(sq_a.c[0]))))
            if active_sets[i + 1].visible:
                parts.append(select(b_ann.id).where(b_ann.id.in_(select(sq_b.c[0]))))
        else:
            negate = spatial == 'disjoint'
            if active_sets[i].visible:
                parts.append(select(a_ann.id).where(
                    a_ann.id.in_(select(sq_a.c[0])),
                    a_ann.bbox_geom.isnot(None),
                    _spatial_exists(a_ann, b_ann, sq_b, negate),
                ))
            if active_sets[i + 1].visible:
                parts.append(select(b_ann.id).where(
                    b_ann.id.in_(select(sq_b.c[0])),
                    b_ann.bbox_geom.isnot(None),
                    _spatial_exists(b_ann, a_ann, sq_a, negate),
                ))

    if not parts:
        return select(Annotation.id).where(Annotation.id == None).subquery(), active_sets, active_spatials  # empty

    # union時は重複除去、それ以外はunion_all（intersects/disjointは構造上重複しない）
    has_union = any(s == 'union' for s in active_spatials)
    combined = (union if has_union else union_all)(*parts) if len(parts) > 1 else parts[0]
    return combined.subquery(), active_sets, active_spatials


@router.post("/projects/{project_id}/annotations/filter")
async def filter_annotations(
    project_id: UUID,
    body: FilterRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Filter annotations using set conditions and spatial comparisons. Returns filtered annotation list."""
    await _get_user_project(project_id, user, db)

    print(f"FILTER DEBUG: project={project_id}, sets={len(body.sets)}, "
          f"rows={[len(s.rows) for s in body.sets]}, "
          f"enabled={[s.enabled for s in body.sets]}, "
          f"logic={[s.logic for s in body.sets]}, "
          f"row_details={[[{'type':r.type,'value':r.value,'label':r.label,'present':r.present} for r in s.rows] for s in body.sets]}", flush=True)

    MAX_ITEMS = 10000
    id_subq, active_sets, _ = _resolve_filter_subquery(project_id, body)

    base = select(Annotation).where(Annotation.project_id == project_id)
    if id_subq is not None:
        base = base.where(Annotation.id.in_(select(id_subq.c[0])))

    total = (await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar()

    if total == 0:
        return {"total": 0, "items": []}

    set_limit = active_sets[0].limit if active_sets and active_sets[0].limit and active_sets[0].limit > 0 else None
    lim = min(set_limit, MAX_ITEMS) if set_limit else MAX_ITEMS

    result = await db.execute(
        base.options(_eager_annotation())
        .order_by(Annotation.score.desc(), Annotation.created_at.desc())
        .limit(lim)
    )
    annots = list(result.scalars().unique())

    # 都道府県逆引き（一括）
    pref_map = {}
    if annots:
        from sqlalchemy import text
        pref_rows = await db.execute(text("""
            SELECT a.id, p.name
            FROM annotations a
            JOIN prefectures p ON ST_Intersects(a.geom, p.geom)
            WHERE a.id = ANY(:ids)
        """), {"ids": [a.id for a in annots]})
        for aid, pname in pref_rows:
            pref_map[aid] = pname

    items = []
    for a in annots:
        d = _annotation_dict(a)
        d["prefecture"] = pref_map.get(a.id, "")
        items.append(d)
    return {"total": total, "items": items}


@router.get("/tags/{tag}/annotations")
async def community_annotations(
    tag: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Annotation)
        .join(Project, Annotation.project_id == Project.id)
        .where(Project.tag == tag, Project.is_public.is_(True))
        .options(_eager_annotation())
        .order_by(Annotation.created_at.desc())
    )
    return [_annotation_dict(a) for a in result.scalars().unique()]


# ── Label CRUD ──

@router.get("/projects/{project_id}/labels")
async def list_labels(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Label).where(Label.project_id == project_id).order_by(Label.name)
    )
    return [{"id": str(l.id), "name": l.name, "emoji": l.emoji, "color": l.color, "system": l.system} for l in result.scalars()]


class LabelCreateBody(BaseModel):
    name: str
    emoji: str = "📍"


@router.post("/projects/{project_id}/labels", status_code=201)
async def create_label(
    project_id: UUID,
    body: LabelCreateBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    label = Label(project_id=project_id, name=body.name, emoji=body.emoji)
    db.add(label)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(400, "ラベルが既に存在します")
    await db.refresh(label)
    return {"id": str(label.id), "name": label.name, "emoji": label.emoji}


class LabelPatchBody(BaseModel):
    name: str | None = None
    emoji: str | None = None
    color: str | None = None


@router.patch("/labels/{label_id}")
async def patch_label(
    label_id: UUID,
    body: LabelPatchBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ラベルの名前・絵文字を変更。正規化済みなのでlabelsテーブルだけ更新すればOK。"""
    label = await db.get(Label, label_id)
    if not label:
        raise HTTPException(404)
    if body.name is not None:
        label.name = body.name
    if body.emoji is not None:
        label.emoji = body.emoji
    if body.color is not None:
        label.color = body.color if body.color else None
    await db.commit()
    return {"id": str(label.id), "name": label.name, "emoji": label.emoji, "color": label.color}


class LabelDuplicateBody(BaseModel):
    new_name: str


@router.post("/labels/{label_id}/duplicate", status_code=201)
async def duplicate_label(
    label_id: UUID,
    body: LabelDuplicateBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ラベルを複製（お気に入りごと）"""
    label = await db.get(Label, label_id)
    if not label:
        raise HTTPException(404)
    new_label = Label(project_id=label.project_id, name=body.new_name, emoji=label.emoji)
    db.add(new_label)
    try:
        await db.flush()
    except Exception:
        await db.rollback()
        raise HTTPException(400, "同名のラベルが既に存在します")
    # そのラベルに紐づくアノテーションを複製
    result = await db.execute(
        select(Annotation)
        .join(AnnotationLabel, Annotation.id == AnnotationLabel.annotation_id)
        .where(AnnotationLabel.label_id == label.id)
    )
    copied = 0
    for a in result.scalars():
        new_a = Annotation(
            project_id=a.project_id,
            lat=a.lat, lon=a.lon,
            bbox_px_cx=a.bbox_px_cx, bbox_px_cy=a.bbox_px_cy,
            bbox_px_w=a.bbox_px_w, bbox_px_h=a.bbox_px_h,
            tile_x=a.tile_x, tile_y=a.tile_y, tile_z=a.tile_z,
            title=a.title, comment=a.comment,
            score=a.score, annotation_vote=a.annotation_vote,
            geom=func.ST_SetSRID(func.ST_MakePoint(a.lon, a.lat), 4326),
        )
        db.add(new_a)
        await db.flush()
        db.add(AnnotationLabel(annotation_id=new_a.id, label_id=new_label.id))
        copied += 1
    await db.commit()
    return {"id": str(new_label.id), "name": new_label.name, "annotations_copied": copied}


@router.delete("/labels/{label_id}", status_code=200)
async def delete_label(
    label_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ラベルを削除。そのラベルのみのお気に入りは削除、他ラベルもあればラベル紐付けだけ除去。"""
    label = await db.get(Label, label_id)
    if not label:
        raise HTTPException(404)
    # 探索中（running scanジョブのscan_label）なら削除禁止
    running = (await db.execute(
        select(Job).where(
            Job.project_id == label.project_id,
            Job.status == "running",
            Job.job_type == "scan",
        )
    )).scalars().all()
    for job in running:
        if (job.config or {}).get("scan_label") == label.name:
            raise HTTPException(409, detail="探索中のラベルは削除できません。削除したい場合は先に探索をキャンセルしてください")
    # 孤立アノテーション（このラベルのみ＋投票なし）を一括削除
    from sqlalchemy import text
    orphan_result = await db.execute(text("""
        DELETE FROM annotations WHERE id IN (
            SELECT a.id FROM annotations a
            JOIN annotation_labels al ON al.annotation_id = a.id
            WHERE al.label_id = :lid
              AND a.annotation_vote IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM annotation_labels al2
                  WHERE al2.annotation_id = a.id AND al2.label_id != :lid
              )
        )
    """), {"lid": str(label_id)})
    deleted_count = orphan_result.rowcount

    # 残りの紐付けを一括削除
    link_result = await db.execute(
        sa_delete(AnnotationLabel).where(AnnotationLabel.label_id == label.id)
    )
    updated_count = link_result.rowcount

    await db.delete(label)
    await db.commit()
    return {"deleted": True, "annotations_deleted": deleted_count, "annotations_updated": updated_count}


@router.post("/projects/{project_id}/annotations/delete-no-dem")
async def delete_annotations_no_dem(
    project_id: UUID,
    body: dict = {},
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """フィルタに一致するアノテーションのうちDEMタイルがないものを削除。"""
    await _get_user_project(project_id, user, db)
    from pathlib import Path
    from app.config import settings
    import asyncio

    # 対象アノテーションのtile座標を取得
    stmt = select(Annotation.id, Annotation.tile_x, Annotation.tile_y).where(
        Annotation.project_id == project_id
    )
    stmt = _apply_filter(stmt, project_id, body.get("filter"))
    rows = (await db.execute(stmt)).all()

    # DEMファイル存在チェック（IOなのでexecutorで）
    loop = asyncio.get_event_loop()
    tiles_dir = settings.tiles_dir
    def _check():
        no_dem_ids = []
        checked = {}
        for aid, tx, ty in rows:
            key = (tx, ty)
            if key not in checked:
                checked[key] = Path(tiles_dir) / "16" / str(tx) / f"{ty}.webp"
            if not checked[key].exists():
                no_dem_ids.append(aid)
        return no_dem_ids
    no_dem_ids = await loop.run_in_executor(None, _check)

    if not no_dem_ids:
        return {"deleted": 0, "checked": len(rows)}

    # 削除
    await db.execute(sa_delete(AnnotationLabel).where(AnnotationLabel.annotation_id.in_(no_dem_ids)))
    result = await db.execute(sa_delete(Annotation).where(Annotation.id.in_(no_dem_ids)))
    await db.commit()
    return {"deleted": result.rowcount, "checked": len(rows)}


class DedupBody(BaseModel):
    filter: dict = {}


@router.post("/projects/{project_id}/annotations/dedup")
async def dedup_annotations(
    project_id: UUID,
    body: DedupBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """重なるbboxのうちスコアが低い方を削除（NMS）。"""
    from sqlalchemy import text
    await _get_user_project(project_id, user, db)

    # フィルタ → サブクエリ
    id_subq, _, _ = _resolve_filter_subquery(project_id,
        __import__("pydantic").TypeAdapter(FilterRequest).validate_python(body.filter)) if body.filter else (None, [], [])

    a_ann = aliased(Annotation, name="a_dedup")
    b_ann = aliased(Annotation, name="b_dedup")

    # 投票済みアノテーションは常に優先（スコア無関係）、IoU>0.3で重複判定
    iou = func.ST_Area(func.ST_Intersection(a_ann.bbox_geom, b_ann.bbox_geom)) / (
        func.ST_Area(a_ann.bbox_geom) + func.ST_Area(b_ann.bbox_geom)
        - func.ST_Area(func.ST_Intersection(a_ann.bbox_geom, b_ann.bbox_geom))
    )
    exists_better = select(func.count()).where(
        b_ann.project_id == project_id,
        b_ann.id != a_ann.id,
        b_ann.bbox_geom.isnot(None),
        func.ST_Intersects(a_ann.bbox_geom, b_ann.bbox_geom),
        iou > 0.3,
        b_ann.annotation_vote.isnot(None)
        | (b_ann.score > a_ann.score)
        | ((b_ann.score == a_ann.score) & (b_ann.id > a_ann.id)),
        *([b_ann.id.in_(select(id_subq.c[0]))] if id_subq is not None else []),
    ).correlate(a_ann).scalar_subquery() > 0

    victims = select(a_ann.id).where(
        a_ann.project_id == project_id,
        a_ann.bbox_geom.isnot(None),
        a_ann.annotation_vote.is_(None),
        exists_better,
        *([a_ann.id.in_(select(id_subq.c[0]))] if id_subq is not None else []),
    )

    # COUNT first
    checked_q = select(func.count()).select_from(Annotation).where(Annotation.project_id == project_id)
    if id_subq is not None:
        checked_q = checked_q.where(Annotation.id.in_(select(id_subq.c[0])))
    checked = (await db.execute(checked_q)).scalar()

    result = await db.execute(sa_delete(Annotation).where(Annotation.id.in_(victims)))
    await db.commit()
    return {"deleted": result.rowcount, "checked": checked}


class EnrichGoogleBody(BaseModel):
    filter: dict = {}
    google_api_key: str
    max_distance_m: float = 100
    limit: int = 100
    keyword: str = ""


@router.post("/projects/{project_id}/annotations/enrich-google")
async def enrich_from_google(
    project_id: UUID,
    body: EnrichGoogleBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Google Places APIで未命名アノテーションの最寄りPOI名を付与。"""
    import httpx
    await _get_user_project(project_id, user, db)

    # タイトル未設定のアノテーション取得
    limit = min(body.limit, 1000)  # 最大1000件
    stmt = select(Annotation).where(
        Annotation.project_id == project_id,
        (Annotation.title.is_(None)) | (Annotation.title == ''),
    )
    stmt = _apply_filter(stmt, project_id, body.filter if hasattr(body, 'filter') else {})
    stmt = stmt.order_by(Annotation.score.desc(), Annotation.created_at.desc())
    stmt = stmt.limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return {"matched": 0, "total": 0}

    # 並列リクエストで高速化（10並列）
    import asyncio as _aio
    sem = _aio.Semaphore(10)
    matched = 0
    SKIP_TYPES = {"administrative_area_level_1", "administrative_area_level_2",
                  "administrative_area_level_3", "administrative_area_level_4",
                  "locality", "sublocality", "political", "country",
                  "route", "street_address", "postal_code"}

    async def _enrich_one(client, a):
        nonlocal matched
        async with sem:
            try:
                params = {
                    "location": f"{a.lat},{a.lon}",
                    "radius": int(body.max_distance_m),
                    "key": body.google_api_key,
                    "language": "ja",
                }
                if body.keyword:
                    params["keyword"] = body.keyword
                resp = await client.get(
                    "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                    params=params,
                )
                if resp.status_code != 200:
                    return
                data = resp.json()
                # 距離順でソートして最寄りを採用
                candidates = []
                for place in data.get("results", []):
                    place_types = set(place.get("types", []))
                    if place_types & SKIP_TYPES:
                        continue
                    name = place.get("name", "")
                    if not name:
                        continue
                    loc = place.get("geometry", {}).get("location", {})
                    plat, plon = loc.get("lat", 0), loc.get("lng", 0)
                    dist = (plat - a.lat) ** 2 + (plon - a.lon) ** 2
                    candidates.append((dist, name))
                if candidates:
                    candidates.sort()
                    a.title = candidates[0][1]
                    matched += 1
            except Exception:
                pass

    async with httpx.AsyncClient(timeout=10) as client:
        await _aio.gather(*[_enrich_one(client, a) for a in rows])

    await db.commit()
    return {"matched": matched, "total": len(rows)}


