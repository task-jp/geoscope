from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://geoscope:changeme@db:5432/geoscope"
    valkey_url: str = "redis://valkey:6379/0"
    secret_key: str = "dev-secret-key"
    tiles_dir: str = "/data/tiles"
    models_dir: str = "/data/models"
    datasets_dir: str = "/data/datasets"
    access_token_expire_minutes: int = 10080  # 1 week
    tile_cache_size: int = 2000

    # OAuth (Google のみ)
    google_client_id: str = ""
    google_client_secret: str = ""
    oauth_redirect_base: str = ""

    # Worker API
    worker_api_key: str = ""


settings = Settings()
