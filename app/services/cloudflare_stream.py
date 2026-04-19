from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from urllib import error, request

from jose import jwt

from app.core.config import get_settings


class CloudflareStreamError(RuntimeError):
    pass


def _api_base() -> str:
    s = get_settings()
    account = str(s.cloudflare_stream_account_id or "").strip()
    if not account:
        raise CloudflareStreamError("CLOUDFLARE_STREAM_ACCOUNT_ID is missing")
    return f"https://api.cloudflare.com/client/v4/accounts/{account}"


def _api_headers() -> dict[str, str]:
    s = get_settings()
    token = str(s.cloudflare_stream_api_token or "").strip()
    if not token:
        raise CloudflareStreamError("CLOUDFLARE_STREAM_API_TOKEN is missing")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def is_configured() -> bool:
    s = get_settings()
    return bool(s.cloudflare_stream_account_id and s.cloudflare_stream_api_token and s.cloudflare_stream_customer_code)


def _http_json(method: str, url: str, payload: dict | None = None) -> dict:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=data, headers=_api_headers(), method=method)
    try:
        with request.urlopen(req, timeout=30) as resp:
            raw = (resp.read() or b"{}").decode("utf-8", errors="ignore")
            out = json.loads(raw or "{}")
            if isinstance(out, dict):
                return out
            raise CloudflareStreamError("Unexpected Cloudflare response")
    except error.HTTPError as exc:
        body = ""
        try:
            body = (exc.read() or b"").decode("utf-8", errors="ignore")
        except Exception:
            body = ""
        raise CloudflareStreamError(f"Cloudflare HTTP {exc.code}: {body[:400]}") from exc
    except Exception as exc:
        raise CloudflareStreamError(f"Cloudflare request failed: {str(exc)}") from exc


def create_direct_upload(*, max_duration_seconds: int | None = None, metadata: dict | None = None) -> dict:
    s = get_settings()
    expiry = datetime.now(timezone.utc) + timedelta(seconds=max(300, int(s.stream_direct_upload_expiry_seconds or 3600)))
    payload: dict = {
        "expiry": expiry.isoformat().replace("+00:00", "Z"),
    }
    if max_duration_seconds:
        payload["maxDurationSeconds"] = int(max_duration_seconds)
    if metadata:
        payload["meta"] = metadata
    out = _http_json("POST", f"{_api_base()}/stream/direct_upload", payload)
    result = out.get("result") or {}
    if not result.get("uid") or not result.get("uploadURL"):
        raise CloudflareStreamError("Cloudflare direct upload response missing uid/uploadURL")
    return {
        "uid": str(result["uid"]),
        "upload_url": str(result["uploadURL"]),
        "expires_at": expiry,
    }


def get_video_details(video_uid: str) -> dict:
    uid = str(video_uid or "").strip()
    if not uid:
        raise CloudflareStreamError("video uid is required")
    out = _http_json("GET", f"{_api_base()}/stream/{uid}")
    result = out.get("result") or {}
    status = result.get("status") or {}
    ready = bool(status.get("state") == "ready")
    duration = int(float(result.get("duration") or 0))
    thumbnail = None
    preview = result.get("preview")
    if preview:
        thumbnail = str(preview)
    return {
        "uid": uid,
        "ready": ready,
        "upload_status": str(status.get("state") or "pending"),
        "duration_seconds": duration,
        "thumbnail_url": thumbnail,
    }


def generate_playback_token(*, video_uid: str, user_id: int, course_id: int, ttl_seconds: int | None = None) -> str:
    s = get_settings()
    key_id = str(s.cloudflare_stream_signing_key_id or "").strip()
    key_secret = str(s.cloudflare_stream_signing_key_secret or "").strip()
    if not key_id or not key_secret:
        raise CloudflareStreamError("Cloudflare playback signing key is not configured")
    now = datetime.now(timezone.utc)
    ttl = int(ttl_seconds or s.stream_playback_token_ttl_seconds or 900)
    payload = {
        "sub": str(video_uid),
        "kid": key_id,
        "exp": int((now + timedelta(seconds=max(60, ttl))).timestamp()),
        "nbf": int(now.timestamp()),
        "accessRules": [{"type": "any"}],
        "u": int(user_id),
        "c": int(course_id),
    }
    return jwt.encode(payload, key_secret, algorithm="HS256", headers={"kid": key_id})


def build_playback_urls(*, video_uid: str, token: str | None) -> dict:
    s = get_settings()
    customer_code = str(s.cloudflare_stream_customer_code or "").strip()
    if not customer_code:
        raise CloudflareStreamError("CLOUDFLARE_STREAM_CUSTOMER_CODE is missing")
    uid = str(video_uid)
    iframe_url = f"https://iframe.videodelivery.net/{uid}"
    hls_url = f"https://customer-{customer_code}.cloudflarestream.com/{uid}/manifest/video.m3u8"
    dash_url = f"https://customer-{customer_code}.cloudflarestream.com/{uid}/manifest/video.mpd"
    if token:
        iframe_url = f"{iframe_url}?token={token}"
        hls_url = f"{hls_url}?token={token}"
        dash_url = f"{dash_url}?token={token}"
    return {
        "iframe_url": iframe_url,
        "hls_url": hls_url,
        "dash_url": dash_url,
    }
