from __future__ import annotations

from pathlib import Path
from urllib.parse import quote, urlparse
from uuid import uuid4

try:
    import boto3
except ImportError:  # pragma: no cover - runtime dependency safety
    boto3 = None
from firebase_admin import storage

from app.core.config import get_settings
from app.services.firebase_auth import init_firebase


def _bucket_name() -> str:
    settings = get_settings()
    if settings.firebase_storage_bucket:
        return settings.firebase_storage_bucket
    if settings.firebase_project_id:
        return f"{settings.firebase_project_id}.appspot.com"
    raise RuntimeError("Firebase Storage bucket is not configured.")


def _s3_client():
    if boto3 is None:
        raise RuntimeError("S3 client unavailable. Install boto3.")
    settings = get_settings()
    if not all((settings.aws_region, settings.aws_access_key_id, settings.aws_secret_access_key, settings.aws_s3_bucket_name)):
        raise RuntimeError("AWS S3 settings are incomplete.")
    return boto3.client(
        "s3",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
    )


def _upload_file_to_firebase_storage(
    local_path: Path,
    *,
    object_path: str,
    content_type: str | None = None,
) -> str:
    if not local_path.exists():
        raise RuntimeError(f"Local file not found for upload: {local_path}")
    init_firebase()
    bucket = storage.bucket(_bucket_name())
    blob = bucket.blob(object_path.lstrip("/"))
    token = uuid4().hex
    blob.metadata = {"firebaseStorageDownloadTokens": token}
    blob.upload_from_filename(str(local_path), content_type=content_type)
    blob.patch()
    encoded_path = quote(blob.name, safe="")
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket.name}/o/{encoded_path}?alt=media&token={token}"


def _upload_file_to_s3(local_path: Path, *, object_path: str, content_type: str | None = None) -> str:
    if not local_path.exists():
        raise RuntimeError(f"Local file not found for upload: {local_path}")
    settings = get_settings()
    key = object_path.lstrip("/")
    client = _s3_client()
    if content_type:
        client.upload_file(str(local_path), settings.aws_s3_bucket_name, key, ExtraArgs={"ContentType": content_type})
    else:
        client.upload_file(str(local_path), settings.aws_s3_bucket_name, key)
    return f"s3://{settings.aws_s3_bucket_name}/{key}"


def upload_file_to_cloud_storage(
    local_path: Path,
    *,
    object_path: str,
    content_type: str | None = None,
) -> str:
    backend = get_settings().resolved_object_storage_backend
    if backend == "s3":
        return _upload_file_to_s3(local_path, object_path=object_path, content_type=content_type)
    if backend == "firebase":
        return _upload_file_to_firebase_storage(local_path, object_path=object_path, content_type=content_type)
    raise RuntimeError("Cloud storage backend is not configured.")


def resolve_media_url(value: str | None, *, expires_in_seconds: int = 3600) -> str | None:
    if not value:
        return None
    # Normalize legacy localhost absolute URLs to same-origin media paths to avoid
    # mixed-content errors on HTTPS deployments.
    if value.startswith("http://") or value.startswith("https://"):
        try:
            parsed = urlparse(value)
            host = (parsed.hostname or "").lower()
            if host in {"localhost", "127.0.0.1"} and parsed.path.startswith("/media/"):
                return parsed.path
        except Exception:
            pass
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("/media/"):
        # Return relative path so browser always uses current origin/protocol.
        return value
    if value.startswith("s3://"):
        settings = get_settings()
        if not settings.aws_s3_bucket_name:
            return None
        key = value[len(f"s3://{settings.aws_s3_bucket_name}/"):] if value.startswith(f"s3://{settings.aws_s3_bucket_name}/") else value.split("/", 3)[-1]
        client = _s3_client()
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.aws_s3_bucket_name, "Key": key},
            ExpiresIn=max(60, min(expires_in_seconds, 7 * 24 * 3600)),
        )
    return value
