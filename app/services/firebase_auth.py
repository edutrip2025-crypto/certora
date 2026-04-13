import json
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials

from app.core.config import get_settings


def init_firebase() -> None:
    if firebase_admin._apps:
        return
    settings = get_settings()
    service_account_json = (settings.firebase_service_account_json or "").strip()
    service_account_path = (settings.firebase_service_account_path or "").strip()

    cred = None
    if service_account_json:
        try:
            cred = credentials.Certificate(json.loads(service_account_json))
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON") from exc
    elif service_account_path:
        path = Path(service_account_path)
        if not path.exists():
            raise RuntimeError(f"Firebase service account file not found: {path}")
        cred = credentials.Certificate(str(path))
    else:
        raise RuntimeError(
            "Firebase credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON on Vercel "
            "or FIREBASE_SERVICE_ACCOUNT_PATH for local/file-based environments.",
        )

    firebase_admin.initialize_app(cred, {"projectId": settings.firebase_project_id or None})


def verify_firebase_token(id_token: str) -> dict[str, Any]:
    init_firebase()
    return auth.verify_id_token(id_token)
