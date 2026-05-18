CREATE EXTENSION IF NOT EXISTS postgis;

-- users (OAuth)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(20) NOT NULL,
    provider_sub VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    email VARCHAR(255),
    avatar_url TEXT,
    api_key VARCHAR(64),
    tos_accepted_at TIMESTAMPTZ,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, provider_sub)
);

-- projects
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    tag VARCHAR(50),
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- annotations (矩形アノテーション)
CREATE TABLE annotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    bbox_px_cx DOUBLE PRECISION NOT NULL,
    bbox_px_cy DOUBLE PRECISION NOT NULL,
    bbox_px_w DOUBLE PRECISION NOT NULL,
    bbox_px_h DOUBLE PRECISION NOT NULL,
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    tile_z INTEGER DEFAULT 16,
    title VARCHAR(200),
    comment TEXT,
    score DOUBLE PRECISION NOT NULL DEFAULT 0,
    annotation_vote VARCHAR(10),
    geom GEOMETRY(Point, 4326),
    bbox_geom GEOMETRY(Polygon, 4326),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_annotations_geom ON annotations USING GIST(geom);
CREATE INDEX idx_annotations_bbox_geom ON annotations USING GIST(bbox_geom);
CREATE INDEX idx_annotations_project ON annotations(project_id);
-- annotation_labels (多対多の中間テーブル)
CREATE TABLE annotation_labels (
    annotation_id UUID REFERENCES annotations(id) ON DELETE CASCADE,
    label_id UUID REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (annotation_id, label_id)
);
CREATE INDEX idx_annotation_labels_label ON annotation_labels(label_id);

-- labels (プロジェクトごとのラベル定義)
CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    emoji VARCHAR(10) DEFAULT '📍',
    system VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, name)
);

-- prefectures (都道府県境界)
CREATE TABLE prefectures (
    code CHAR(2) PRIMARY KEY,
    name VARCHAR(10) NOT NULL,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX idx_prefectures_geom ON prefectures USING GIST(geom);

-- models (学習済みモデル)
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    model_path VARCHAR(500),
    metrics JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, version)
);

-- jobs (学習/スキャンジョブ)
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    job_type VARCHAR(20) NOT NULL CHECK (job_type IN ('train', 'scan')),
    status VARCHAR(20) DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
    progress DOUBLE PRECISION DEFAULT 0,
    message TEXT,
    config JSONB,
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

-- detections (検出結果)
CREATE TABLE detections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    model_id UUID REFERENCES models(id),
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    conf DOUBLE PRECISION NOT NULL,
    bbox_cx DOUBLE PRECISION,
    bbox_cy DOUBLE PRECISION,
    bbox_w DOUBLE PRECISION,
    bbox_h DOUBLE PRECISION,
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    geom GEOMETRY(Point, 4326),
    feedback VARCHAR(10) CHECK (feedback IN ('yes', 'no')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_detections_geom ON detections USING GIST(geom);
CREATE INDEX idx_detections_project ON detections(project_id);
CREATE INDEX idx_detections_conf ON detections(conf);
