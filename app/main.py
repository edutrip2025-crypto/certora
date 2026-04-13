from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.core.config import get_settings
from app.db.init_db import init_db
from app.services.firebase_auth import init_firebase

settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
WEB_DIR = Path(__file__).resolve().parent / "web"
ASSETS_DIR = WEB_DIR / "assets"
MEDIA_DIR = Path(settings.media_dir)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    if settings.auth_mode.lower() == "firebase":
        init_firebase()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/config/firebase")
def firebase_config():
    return {
        "auth_mode": settings.auth_mode,
        "apiKey": settings.firebase_web_api_key,
        "authDomain": settings.firebase_auth_domain,
        "projectId": settings.firebase_project_id,
        "storageBucket": settings.firebase_storage_bucket,
        "messagingSenderId": settings.firebase_messaging_sender_id,
        "appId": settings.firebase_app_id,
        "measurementId": settings.firebase_measurement_id,
        "allowDevRoleOverride": settings.allow_dev_role_override,
    }


app.include_router(api_router)
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.get("/")
def frontend():
    return FileResponse(str(WEB_DIR / "index.html"))
