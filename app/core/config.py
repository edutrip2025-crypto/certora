from functools import lru_cache

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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
