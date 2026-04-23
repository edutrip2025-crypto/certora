from __future__ import annotations

import base64
import binascii
import mimetypes
from pathlib import Path
import re
import time
from urllib.parse import quote, urlparse
from urllib import error, request
from uuid import uuid4

try:
    import boto3
except ImportError:  # pragma: no cover - runtime dependency safety
    boto3 = None
from firebase_admin import storage

from app.core.config import get_settings
from app.services.firebase_auth import init_firebase

_DATA_URL_RE = re.compile(r"^data:(?P<mime>[-\w.+/]+)?;base64,(?P<data>.+)$", re.IGNORECASE)


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


def _upload_file_to_bunny_storage(local_path: Path, *, object_path: str, content_type: str | None = None) -> str:
    if not local_path.exists():
        raise RuntimeError(f"Local file not found for upload: {local_path}")
    settings = get_settings()
    zone = str(settings.bunny_storage_zone or "").strip()
    access_key = str(settings.bunny_storage_access_key or "").strip()
    endpoint = str(settings.bunny_storage_endpoint or "storage.bunnycdn.com").strip()
    if not (zone and access_key and endpoint):
        raise RuntimeError("Bunny Storage settings are incomplete.")
    timeout = max(60, int(settings.bunny_storage_upload_timeout_seconds or 900))
    retries = max(1, int(settings.bunny_storage_upload_retries or 3))
    key = object_path.lstrip("/")
    url = f"https://{endpoint}/{zone}/{key}"
    body = local_path.read_bytes()
    ctype = content_type or mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"
    for attempt in range(1, retries + 1):
        req = request.Request(
            url,
            data=body,
            method="PUT",
            headers={
                "AccessKey": access_key,
                "Content-Type": ctype,
                "Accept": "application/json",
            },
        )
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                status = int(getattr(resp, "status", 0) or 0)
                if status in {200, 201}:
                    break
                raise RuntimeError(f"Bunny upload failed with HTTP {status}")
        except error.HTTPError as exc:
            body_text = ""
            try:
                body_text = (exc.read() or b"").decode("utf-8", errors="ignore")
            except Exception:
                body_text = ""
            # Don't retry auth failures; they are configuration problems.
            if exc.code in {401, 403}:
                raise RuntimeError(f"Bunny upload failed with HTTP {exc.code}: {body_text[:400]}") from exc
            if attempt >= retries:
                raise RuntimeError(f"Bunny upload failed with HTTP {exc.code}: {body_text[:400]}") from exc
            time.sleep(min(8, attempt * 2))
        except Exception as exc:
            if attempt >= retries:
                raise RuntimeError(f"Bunny upload failed: {exc}") from exc
            time.sleep(min(8, attempt * 2))
    return f"bunny://{zone}/{key}"


def upload_file_to_cloud_storage(
    local_path: Path,
    *,
    object_path: str,
    content_type: str | None = None,
) -> str:
    backend = get_settings().resolved_object_storage_backend
    if backend == "bunny":
        return _upload_file_to_bunny_storage(local_path, object_path=object_path, content_type=content_type)
    if backend == "s3":
        return _upload_file_to_s3(local_path, object_path=object_path, content_type=content_type)
    if backend == "firebase":
        return _upload_file_to_firebase_storage(local_path, object_path=object_path, content_type=content_type)
    raise RuntimeError("Cloud storage backend is not configured.")


def normalize_image_storage_reference(
    value: str | None,
    *,
    object_prefix: str = "images",
) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    match = _DATA_URL_RE.match(raw)
    if not match:
        return raw

    mime = (match.group("mime") or "application/octet-stream").strip().lower()
    b64_data = match.group("data") or ""
    try:
        image_bytes = base64.b64decode(b64_data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid base64 data URL.") from exc
    if not image_bytes:
        raise ValueError("Image data is empty.")

    ext = mimetypes.guess_extension(mime) or ".bin"
    if ext == ".jpe":
        ext = ".jpg"
    object_prefix_clean = object_prefix.strip("/").replace("\\", "/") or "images"
    filename = f"{uuid4().hex}{ext}"
    object_path = f"{object_prefix_clean}/{filename}"

    settings = get_settings()
    media_root = Path(settings.resolved_media_dir)
    local_target = media_root / object_path
    local_target.parent.mkdir(parents=True, exist_ok=True)
    local_target.write_bytes(image_bytes)

    backend = settings.resolved_object_storage_backend
    if backend == "local":
        rel = local_target.relative_to(media_root).as_posix()
        return f"/media/{rel}"
    try:
        return upload_file_to_cloud_storage(local_target, object_path=object_path, content_type=mime)
    finally:
        try:
            local_target.unlink(missing_ok=True)
        except Exception:
            pass


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
        # If local media file is missing (common after cloud deploy), suppress broken URL.
        settings = get_settings()
        media_root = Path(settings.resolved_media_dir)
        rel = value.removeprefix("/media/").lstrip("/")
        local_file = media_root / rel
        if not local_file.exists():
            return None
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
    if value.startswith("bunny://"):
        settings = get_settings()
        pull_zone = str(settings.bunny_storage_pull_zone or "").strip().strip("/")
        if not pull_zone:
            return None
        key = value[len("bunny://"):]
        parts = key.split("/", 1)
        if len(parts) != 2:
            return None
        object_key = parts[1].lstrip("/")
        if pull_zone.startswith("http://") or pull_zone.startswith("https://"):
            return f"{pull_zone.rstrip('/')}/{object_key}"
        return f"https://{pull_zone}/{object_key}"
    return value
