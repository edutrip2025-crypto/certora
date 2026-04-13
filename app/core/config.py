import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Certora API"
    app_base_url: str = "http://localhost:8000"
    database_url: str = "sqlite:///./certora.db"
    jwt_secret_key: str = "change_me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 120
    auth_mode: str = "firebase"
    enable_ai_review: bool = False
    allow_dev_role_override: bool = True
    firebase_project_id: str = ""
    firebase_service_account_path: str = ""
    firebase_service_account_json: str = ""
    firebase_web_api_key: str = ""
    firebase_auth_domain: str = ""
    firebase_storage_bucket: str = ""
    firebase_messaging_sender_id: str = ""
    firebase_app_id: str = ""
    firebase_measurement_id: str = ""
    media_dir: str = "app/web/media"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_sender: str = "noreply@certora.in"
    admin_emails: str = "admin@certora.in,admin@certora.com"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False)

    @property
    def is_vercel(self) -> bool:
        return bool(os.getenv("VERCEL") or os.getenv("VERCEL_ENV"))

    @property
    def resolved_database_url(self) -> str:
        raw = (self.database_url or "").strip()
        if not self.is_vercel:
            return raw
        if raw.startswith("sqlite:///./") or raw == "sqlite:///./certora.db":
            return "sqlite:////tmp/certora.db"
        return raw

    @property
    def resolved_media_dir(self) -> str:
        raw = (self.media_dir or "").strip() or "app/web/media"
        if not self.is_vercel:
            return raw
        path = Path(raw)
        if path.is_absolute():
            return str(path)
        return "/tmp/certora-media"

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in (self.admin_emails or "").split(",") if e.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
