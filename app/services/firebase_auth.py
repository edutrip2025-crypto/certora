from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials

from app.core.config import get_settings


def init_firebase() -> None:
    if firebase_admin._apps:
        return
    settings = get_settings()
    service_account_path = settings.firebase_service_account_path
    if not service_account_path:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_PATH is required when AUTH_MODE=firebase")
    path = Path(service_account_path)
    if not path.exists():
        raise RuntimeError(f"Firebase service account file not found: {path}")
    cred = credentials.Certificate(str(path))
    firebase_admin.initialize_app(cred, {"projectId": settings.firebase_project_id or None})


def verify_firebase_token(id_token: str) -> dict[str, Any]:
    init_firebase()
    return auth.verify_id_token(id_token)
