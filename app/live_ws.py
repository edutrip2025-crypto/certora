import asyncio
import json
import random
import time
from collections import defaultdict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.entities import Course, Enrollment, LiveClassSession, ProviderProfile, User, UserRole
from app.services.firebase_auth import verify_firebase_token


class LiveSignalManager:
    def __init__(self) -> None:
        self._rooms: dict[int, dict[int, set[WebSocket]]] = defaultdict(lambda: defaultdict(set))
        self._lock = asyncio.Lock()

    async def connect(self, session_id: int, user_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            self._rooms[session_id][user_id].add(websocket)

    async def disconnect(self, session_id: int, user_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(session_id)
            if not room:
                return
            sockets = room.get(user_id)
            if sockets and websocket in sockets:
                sockets.remove(websocket)
            if sockets is not None and not sockets:
                room.pop(user_id, None)
            if not room:
                self._rooms.pop(session_id, None)

    async def emit(
        self,
        session_id: int,
        payload: dict,
        *,
        to_user_id: int | None = None,
        exclude_user_id: int | None = None,
    ) -> None:
        async with self._lock:
            room = self._rooms.get(session_id, {})
            if to_user_id:
                targets = [(to_user_id, list(room.get(to_user_id, set())))]
            else:
                targets = [(uid, list(socks)) for uid, socks in room.items()]
        for uid, sockets in targets:
            if exclude_user_id and uid == exclude_user_id:
                continue
            for ws in sockets:
                try:
                    await ws.send_json(payload)
                except Exception:
                    await self.disconnect(session_id, uid, ws)


signal_manager = LiveSignalManager()


def _ws_close_payload(code: int, reason: str) -> tuple[int, str]:
    # Keep custom app codes in 4400+ space.
    return code, reason[:120]


def _resolve_user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    try:
        claims = verify_firebase_token(token)
    except Exception:
        return None
    email = str(claims.get("email") or "").strip().lower()
    if not email:
        return None
    return db.scalar(select(User).where(func.lower(func.trim(User.email)) == email))


def _provider_allowed(db: Session, user_id: int, session_id: int) -> bool:
    provider_id = db.scalar(select(ProviderProfile.id).where(ProviderProfile.user_id == user_id))
    if not provider_id:
        return False
    session = db.scalar(select(LiveClassSession).where(LiveClassSession.id == session_id))
    if not session:
        return False
    return int(session.provider_id or 0) == int(provider_id)


def _student_allowed(db: Session, user_id: int, session_id: int) -> bool:
    row = db.execute(
        select(LiveClassSession, Course, Enrollment)
        .join(Course, Course.id == LiveClassSession.course_id)
        .join(Enrollment, and_(Enrollment.course_id == Course.id, Enrollment.student_id == user_id))
        .where(LiveClassSession.id == session_id),
    ).first()
    return bool(row)


def _is_authorized_for_session(db: Session, user: User, session_id: int) -> bool:
    if user.role == UserRole.PROVIDER:
        return _provider_allowed(db, user.id, session_id)
    if user.role == UserRole.STUDENT:
        return _student_allowed(db, user.id, session_id)
    return False


def register_live_websocket(app: FastAPI) -> None:
    @app.websocket("/ws/live/{session_id}")
    async def live_signal_socket(websocket: WebSocket, session_id: int):
        token = websocket.query_params.get("token")
        db: Session = SessionLocal()
        user: User | None = None
        try:
            user = _resolve_user_from_token(db, token)
            if not user:
                await websocket.close(*_ws_close_payload(4401, "Unauthorized"))
                return
            if not _is_authorized_for_session(db, user, session_id):
                await websocket.close(*_ws_close_payload(4403, "Forbidden"))
                return
            await websocket.accept()
            await signal_manager.connect(session_id, user.id, websocket)
            await signal_manager.emit(
                session_id,
                {
                    "type": "presence",
                    "event": "joined",
                    "user_id": user.id,
                    "ts": int(time.time() * 1000),
                },
                exclude_user_id=user.id,
            )
            while True:
                packet_raw = await websocket.receive_text()
                try:
                    packet = json.loads(packet_raw or "{}")
                except Exception:
                    continue
                ptype = str(packet.get("type") or "").strip().lower()
                if ptype == "ping":
                    await websocket.send_json({"type": "pong", "ts": int(time.time() * 1000)})
                    continue
                if ptype != "signal":
                    continue
                kind = str(packet.get("kind") or "").strip().lower()
                if kind not in {"presence", "offer", "answer", "ice", "leave"}:
                    continue
                to_user_id_raw = packet.get("to_user_id")
                to_user_id = int(to_user_id_raw) if to_user_id_raw is not None else None
                payload = packet.get("payload") if isinstance(packet.get("payload"), dict) else {}
                out = {
                    "type": "signal",
                    "id": f"{session_id}-{user.id}-{int(time.time() * 1000)}-{random.randint(1000, 9999)}",
                    "kind": kind,
                    "from_user_id": user.id,
                    "to_user_id": to_user_id,
                    "payload": payload,
                    "ts": int(time.time() * 1000),
                }
                await signal_manager.emit(
                    session_id,
                    out,
                    to_user_id=to_user_id,
                    exclude_user_id=None if to_user_id else user.id,
                )
        except WebSocketDisconnect:
            pass
        finally:
            if user:
                await signal_manager.disconnect(session_id, user.id, websocket)
                await signal_manager.emit(
                    session_id,
                    {
                        "type": "presence",
                        "event": "left",
                        "user_id": user.id,
                        "ts": int(time.time() * 1000),
                    },
                    exclude_user_id=user.id,
                )
            db.close()
