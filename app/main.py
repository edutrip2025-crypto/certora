from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.db.init_db import init_db
from app.live_ws import register_live_websocket

settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
WEB_DIR = Path(__file__).resolve().parent / "web"
ASSETS_DIR = WEB_DIR / "assets"
MEDIA_DIR = Path(settings.resolved_media_dir)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

if settings.cors_origins_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

if settings.trusted_hosts_list:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts_list)

if settings.enable_gzip:
    app.add_middleware(GZipMiddleware, minimum_size=max(256, int(settings.gzip_minimum_size)))


@app.middleware("http")
async def apply_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    return response


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/manifest.json")
def manifest_json():
    return Response(status_code=204)


@app.get("/site.webmanifest")
def site_webmanifest():
    return Response(status_code=204)


@app.get("/apple-touch-icon.png")
def apple_touch_icon():
    return Response(status_code=204)


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
register_live_websocket(app)
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.get("/")
def frontend():
    return FileResponse(str(WEB_DIR / "index.html"))


@app.get("/stream-player")
def stream_player_frontend():
    return FileResponse(str(WEB_DIR / "stream_player.html"))
