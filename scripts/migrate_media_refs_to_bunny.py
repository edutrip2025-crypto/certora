from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    import boto3
except ImportError:  # pragma: no cover
    boto3 = None
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.core.config import get_settings
from app.db.session import engine
from app.models.entities import Base, Certificate, Course, Lesson, ProctorEvidence, ProviderCourseDraft, ProviderDocument, VideoUploadSession
from app.services.media_storage import upload_file_to_cloud_storage

S3_RE = re.compile(r"^s3://(?P<bucket>[^/]+)/(?P<key>.+)$", re.IGNORECASE)


class MigrationSpec:
    def __init__(self, label: str, model, column: str, object_prefix: str):
        self.label = label
        self.model = model
        self.column = column
        self.object_prefix = object_prefix.strip("/")


SPECS = [
    MigrationSpec("courses.thumbnail_url", Course, "thumbnail_url", "course-thumbnails/migrated"),
    MigrationSpec("provider_course_drafts.thumbnail_url", ProviderCourseDraft, "thumbnail_url", "course-thumbnails/drafts-migrated"),
    MigrationSpec("lessons.recorded_video_url", Lesson, "recorded_video_url", "videos/migrated"),
    MigrationSpec("certificates.pdf_url", Certificate, "pdf_url", "certificates/migrated"),
    MigrationSpec("provider_documents.file_url", ProviderDocument, "file_url", "provider-documents/migrated"),
    MigrationSpec("video_upload_sessions.file_url", VideoUploadSession, "file_url", "videos/upload-sessions-migrated"),
    MigrationSpec("proctor_evidence.file_url", ProctorEvidence, "file_url", "proctor-evidence/migrated"),
]


def _sanitize_filename(name: str, *, fallback_ext: str = ".bin") -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", (name or "").strip())
    if not clean:
        clean = f"asset{fallback_ext}"
    if "." not in clean:
        clean = f"{clean}{fallback_ext}"
    return clean[:200]


def _should_migrate(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    low = raw.lower()
    if low.startswith("bunny://"):
        return False
    if low.startswith("data:"):
        return False
    if low.startswith("s3://"):
        return True
    if raw.startswith("/media/"):
        return True
    if low.startswith("http://") or low.startswith("https://"):
        p = urlparse(raw)
        host = (p.hostname or "").lower()
        return host in {"localhost", "127.0.0.1"} and p.path.startswith("/media/")
    if "://" not in raw:
        return True
    return False


def _s3_client():
    if boto3 is None:
        raise RuntimeError("boto3 is required to migrate s3:// references.")
    settings = get_settings()
    kwargs = {}
    if settings.aws_region:
        kwargs["region_name"] = settings.aws_region
    if settings.aws_access_key_id and settings.aws_secret_access_key:
        kwargs["aws_access_key_id"] = settings.aws_access_key_id
        kwargs["aws_secret_access_key"] = settings.aws_secret_access_key
    return boto3.client("s3", **kwargs)


def _read_source_bytes(value: str, *, media_root: Path, s3):
    raw = str(value or "").strip()
    if raw.startswith("/media/"):
        rel = raw.removeprefix("/media/").lstrip("/")
        path = media_root / rel
        if not path.exists():
            raise FileNotFoundError(f"Local file not found: {path}")
        return path.read_bytes(), path.name

    if raw.lower().startswith("http://") or raw.lower().startswith("https://"):
        p = urlparse(raw)
        host = (p.hostname or "").lower()
        if host in {"localhost", "127.0.0.1"} and p.path.startswith("/media/"):
            rel = p.path.removeprefix("/media/").lstrip("/")
            path = media_root / rel
            if not path.exists():
                raise FileNotFoundError(f"Local file not found: {path}")
            return path.read_bytes(), path.name
        raise ValueError(f"Unsupported URL source: {raw}")

    m = S3_RE.match(raw)
    if m:
        bucket = m.group("bucket")
        key = m.group("key")
        obj = s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        filename = Path(key).name or "asset.bin"
        return body, filename

    if "://" not in raw:
        rel_path = Path(raw.strip("/\\"))
        path = media_root / rel_path
        if not path.exists():
            raise FileNotFoundError(f"Relative local file not found: {path}")
        return path.read_bytes(), path.name

    raise ValueError(f"Unsupported source reference: {raw}")


def _upload_bytes_to_bunny(data: bytes, *, object_path: str) -> str:
    suffix = Path(object_path).suffix or ".bin"
    fd, temp_name = tempfile.mkstemp(prefix="bunny_migrate_", suffix=suffix)
    temp_path = Path(temp_name)
    try:
        with open(fd, "wb", closefd=True) as f:
            f.write(data)
        return upload_file_to_cloud_storage(temp_path, object_path=object_path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _build_object_path(spec: MigrationSpec, row_id: int, original_name: str) -> str:
    ext = Path(original_name).suffix or ".bin"
    safe_name = _sanitize_filename(original_name, fallback_ext=ext)
    return f"{spec.object_prefix}/{int(row_id)}/{safe_name}"


def run(*, apply: bool, table_filter: set[str] | None, limit: int | None) -> int:
    settings = get_settings()
    backend = settings.resolved_object_storage_backend
    if apply and backend != "bunny":
        raise RuntimeError(
            "OBJECT_STORAGE_BACKEND must resolve to 'bunny' before running this migration. "
            f"Current resolved backend: '{backend}'.",
        )

    media_root = Path(settings.resolved_media_dir)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    s3 = _s3_client() if apply else None

    scanned = 0
    candidates = 0
    migrated = 0
    failed = 0

    with SessionLocal() as db:
        Base.metadata.create_all(bind=engine)
        for spec in SPECS:
            if table_filter and spec.label not in table_filter:
                continue

            query = select(spec.model).order_by(spec.model.id.asc())
            rows = list(db.scalars(query).all())
            if limit is not None:
                rows = rows[: max(0, int(limit))]

            spec_scanned = 0
            spec_candidates = 0
            spec_migrated = 0
            spec_failed = 0

            for row in rows:
                spec_scanned += 1
                scanned += 1
                old_value = getattr(row, spec.column, None)
                if not _should_migrate(old_value):
                    continue

                spec_candidates += 1
                candidates += 1
                row_id = int(getattr(row, "id"))
                if not apply:
                    print(f"[DRY] {spec.label} id={row_id} value={old_value}")
                    continue

                try:
                    data, original_name = _read_source_bytes(str(old_value), media_root=media_root, s3=s3)
                    object_path = _build_object_path(spec, row_id, original_name)
                    new_ref = _upload_bytes_to_bunny(data, object_path=object_path)
                    setattr(row, spec.column, new_ref)
                    db.add(row)
                    spec_migrated += 1
                    migrated += 1
                    if migrated % 25 == 0:
                        db.commit()
                except Exception as exc:
                    spec_failed += 1
                    failed += 1
                    print(f"[FAIL] {spec.label} id={row_id} value={old_value} err={exc}")

            if apply:
                db.commit()
            print(
                f"[SUMMARY] {spec.label}: scanned={spec_scanned} candidates={spec_candidates} "
                f"migrated={spec_migrated} failed={spec_failed}",
            )

    print(
        f"[DONE] scanned={scanned} candidates={candidates} migrated={migrated} failed={failed} "
        f"mode={'apply' if apply else 'dry-run'}",
    )
    return 0 if failed == 0 else 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate local/s3 media references to Bunny storage.")
    parser.add_argument("--apply", action="store_true", help="Perform upload + DB updates. Default is dry-run.")
    parser.add_argument(
        "--only",
        action="append",
        help=(
            "Limit to specific label(s), e.g. "
            "'courses.thumbnail_url' or 'certificates.pdf_url'. Can be repeated."
        ),
    )
    parser.add_argument("--limit", type=int, default=None, help="Max rows per table (for testing).")
    args = parser.parse_args()

    table_filter = set(args.only or []) if args.only else None
    return run(apply=bool(args.apply), table_filter=table_filter, limit=args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
