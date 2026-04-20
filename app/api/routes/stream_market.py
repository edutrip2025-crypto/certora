from __future__ import annotations

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.session import get_db
from app.models.entities import (
    AuditLog,
    Course,
    CourseLesson,
    CoursePurchase,
    Creator,
    LessonVideo,
    LiveStreamSession,
    ProviderProfile,
    User,
    UserRole,
    VideoWatchProgress,
    VideoWatchSession,
)
from app.schemas import (
    StreamCourseCreate,
    StreamFairUsageOverrideRequest,
    StreamLessonCreate,
    StreamLiveSessionCreate,
    StreamPlaybackTokenRequest,
    StreamPricingRecommendationRequest,
    StreamPurchaseRequest,
    StreamVideoUploadInitResponse,
    StreamVideoUploadInitRequest,
    StreamWatchHeartbeatRequest,
)
from app.services.cloudflare_stream import (
    CloudflareStreamError,
    build_playback_urls,
    create_direct_upload,
    generate_playback_token,
    get_video_details,
    is_configured,
)
from app.services.fair_usage import evaluate_fair_usage, log_fair_usage_transition
from app.services.pricing_recommendation import analytics_total_uploaded_minutes, pricing_recommendation_for_course

router = APIRouter(prefix="/stream", tags=["stream-market"])


def _provider_profile_or_403(db: Session, user_id: int) -> ProviderProfile:
    p = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == int(user_id)))
    if not p:
        raise HTTPException(status_code=403, detail="Provider profile required")
    return p


def _creator_for_user(db: Session, user: User) -> Creator:
    creator = db.scalar(select(Creator).where(Creator.user_id == int(user.id)))
    if creator:
        return creator
    creator = Creator(user_id=int(user.id), display_name=user.full_name)
    db.add(creator)
    db.flush()
    return creator


def _must_have_course_purchase(db: Session, *, user_id: int, course_id: int) -> CoursePurchase:
    purchase = db.scalar(
        select(CoursePurchase).where(
            and_(
                CoursePurchase.user_id == int(user_id),
                CoursePurchase.course_id == int(course_id),
                CoursePurchase.status == "paid",
            ),
        ),
    )
    if not purchase:
        raise HTTPException(status_code=403, detail="Course not purchased")
    return purchase


@router.post("/courses")
def create_stream_course(
    payload: StreamCourseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_403(db, current_user.id)
    _creator_for_user(db, current_user)
    course = Course(
        provider_id=profile.id,
        title=payload.title,
        description=payload.description,
        category=payload.category,
        includes_certification_exam=False,
        is_published=False,
        fair_usage_multiplier=float(payload.fair_usage_multiplier or 2.5),
    )
    db.add(course)
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="stream_course_created",
            target_type="course",
            target_id=None,
            details_json={"title": payload.title, "category": payload.category},
        ),
    )
    db.commit()
    db.refresh(course)
    return {
        "course_id": course.id,
        "title": course.title,
        "is_published": course.is_published,
        "fair_usage_multiplier": course.fair_usage_multiplier,
    }


@router.post("/courses/{course_id}/lessons")
def create_stream_lesson(
    course_id: int,
    payload: StreamLessonCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _provider_profile_or_403(db, current_user.id)
    course = db.get(Course, int(course_id))
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    lesson = CourseLesson(
        course_id=course.id,
        title=payload.title,
        position=int(payload.position),
        created_by_user_id=current_user.id,
    )
    db.add(lesson)
    db.commit()
    db.refresh(lesson)
    return {"lesson_id": lesson.id, "course_id": course.id, "title": lesson.title, "position": lesson.position}


@router.get("/courses/{course_id}/lessons")
def list_stream_lessons(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.PROVIDER, UserRole.ADMIN)),
):
    if current_user.role == UserRole.STUDENT:
        _must_have_course_purchase(db, user_id=current_user.id, course_id=int(course_id))
    lessons = db.scalars(select(CourseLesson).where(CourseLesson.course_id == int(course_id)).order_by(CourseLesson.position.asc())).all()
    lesson_ids = [int(x.id) for x in lessons]
    videos = db.scalars(
        select(LessonVideo).where(LessonVideo.lesson_id.in_(lesson_ids) if lesson_ids else False).order_by(LessonVideo.created_at.asc()),
    ).all()
    vids_by_lesson: dict[int, list[LessonVideo]] = {}
    for v in videos:
        vids_by_lesson.setdefault(int(v.lesson_id), []).append(v)
    return {
        "course_id": int(course_id),
        "lessons": [
            {
                "lesson_id": int(ls.id),
                "title": ls.title,
                "position": int(ls.position),
                "videos": [
                    {
                        "lesson_video_id": int(v.id),
                        "internal_id": v.internal_id,
                        "ready": bool(v.ready_status),
                        "duration_seconds": int(v.duration_seconds or 0),
                        "thumbnail_url": v.thumbnail_url,
                    }
                    for v in vids_by_lesson.get(int(ls.id), [])
                ],
            }
            for ls in lessons
        ],
    }


@router.post("/videos/upload-init", response_model=StreamVideoUploadInitResponse)
def init_stream_video_upload(
    payload: StreamVideoUploadInitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _provider_profile_or_403(db, current_user.id)
    creator = _creator_for_user(db, current_user)
    lesson = db.get(CourseLesson, int(payload.lesson_id))
    if not lesson:
        raise HTTPException(status_code=404, detail="Lesson not found")

    if not is_configured():
        raise HTTPException(status_code=503, detail="Cloudflare Stream is not configured")

    internal_id = uuid.uuid4().hex
    try:
        direct = create_direct_upload(
            max_duration_seconds=payload.max_duration_seconds,
            metadata={
                "lesson_id": str(lesson.id),
                "course_id": str(lesson.course_id),
                "creator_id": str(creator.id),
                "internal_id": internal_id,
            },
        )
    except CloudflareStreamError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    row = LessonVideo(
        course_id=int(lesson.course_id),
        lesson_id=int(lesson.id),
        creator_id=int(creator.id),
        internal_id=internal_id,
        cloudflare_video_uid=direct["uid"],
        upload_status="pending",
        ready_status=False,
        duration_seconds=0,
        direct_upload_url=direct["upload_url"],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return StreamVideoUploadInitResponse(
        lesson_video_id=row.id,
        internal_id=row.internal_id,
        cloudflare_video_uid=row.cloudflare_video_uid,
        upload_url=direct["upload_url"],
        expires_at=direct.get("expires_at"),
        status=row.upload_status,
    )


@router.get("/videos/{lesson_video_id}/status")
def stream_video_status(
    lesson_video_id: int,
    sync: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    row = db.get(LessonVideo, int(lesson_video_id))
    if not row:
        raise HTTPException(status_code=404, detail="Lesson video not found")

    if sync:
        try:
            details = get_video_details(row.cloudflare_video_uid)
            row.upload_status = details["upload_status"]
            row.ready_status = bool(details["ready"])
            row.duration_seconds = int(details["duration_seconds"])
            if details.get("thumbnail_url"):
                row.thumbnail_url = details["thumbnail_url"]
            db.commit()
            db.refresh(row)
        except CloudflareStreamError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "lesson_video_id": row.id,
        "internal_id": row.internal_id,
        "cloudflare_video_uid": row.cloudflare_video_uid,
        "upload_status": row.upload_status,
        "ready_status": row.ready_status,
        "duration_seconds": int(row.duration_seconds or 0),
        "thumbnail_url": row.thumbnail_url,
        "updated_at": row.updated_at,
    }


@router.post("/webhooks/cloudflare")
async def cloudflare_stream_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    payload = await request.json()
    event = str(payload.get("type") or payload.get("event") or "stream.unknown")
    data = payload.get("data") or payload.get("result") or payload
    uid = str(data.get("uid") or data.get("videoUID") or "").strip()
    if not uid:
        return {"ok": True, "ignored": True}

    row = db.scalar(select(LessonVideo).where(LessonVideo.cloudflare_video_uid == uid))
    if not row:
        return {"ok": True, "ignored": True}

    state = str((data.get("status") or {}).get("state") or data.get("status") or "").strip().lower()
    ready = bool(data.get("readyToStream") or (state == "ready") or ("ready" in event))
    duration = int(float(data.get("duration") or row.duration_seconds or 0))
    thumbnail = data.get("preview") or row.thumbnail_url

    row.upload_status = state or row.upload_status
    row.ready_status = ready or row.ready_status
    row.duration_seconds = duration
    if thumbnail:
        row.thumbnail_url = str(thumbnail)

    db.add(
        AuditLog(
            actor_user_id=None,
            action="cloudflare_stream_webhook",
            target_type="lesson_video",
            target_id=row.id,
            details_json={"event": event, "uid": uid, "state": row.upload_status, "ready": row.ready_status},
        ),
    )
    db.commit()
    return {"ok": True, "lesson_video_id": row.id, "ready": row.ready_status}


@router.post("/purchases")
def create_course_purchase(
    payload: StreamPurchaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.ADMIN)),
):
    course = db.get(Course, int(payload.course_id))
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    existing = db.scalar(
        select(CoursePurchase).where(
            and_(CoursePurchase.user_id == current_user.id, CoursePurchase.course_id == course.id),
        ),
    )
    if existing and existing.status == "paid":
        return {"purchase_id": existing.id, "status": existing.status, "course_id": course.id, "already_purchased": True}

    # Payment gateway verification hook (replace with real gateway verification in production)
    if float(payload.price_amount or 0) > 0 and not str(payload.payment_ref or "").strip():
        raise HTTPException(status_code=400, detail="payment_ref is required for paid purchase")

    if not existing:
        existing = CoursePurchase(
            user_id=current_user.id,
            course_id=course.id,
            price_amount=float(payload.price_amount),
            currency=str(payload.currency or "INR").upper(),
            payment_ref=(payload.payment_ref or None),
            status="paid",
        )
        db.add(existing)
    else:
        existing.price_amount = float(payload.price_amount)
        existing.currency = str(payload.currency or "INR").upper()
        existing.payment_ref = payload.payment_ref or existing.payment_ref
        existing.status = "paid"

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="course_purchase",
            target_type="course",
            target_id=course.id,
            details_json={"amount": float(payload.price_amount), "currency": str(payload.currency or "INR").upper()},
        ),
    )
    db.commit()
    db.refresh(existing)
    return {"purchase_id": existing.id, "status": existing.status, "course_id": course.id, "already_purchased": False}


@router.get("/courses/{course_id}/entitlement")
def course_entitlement(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.ADMIN, UserRole.PROVIDER)),
):
    entitled = False
    if current_user.role in {UserRole.ADMIN, UserRole.PROVIDER}:
        entitled = True
    else:
        purchase = db.scalar(
            select(CoursePurchase).where(
                and_(CoursePurchase.user_id == current_user.id, CoursePurchase.course_id == int(course_id), CoursePurchase.status == "paid"),
            ),
        )
        entitled = bool(purchase)
    usage = evaluate_fair_usage(db, user_id=current_user.id, course_id=int(course_id)) if entitled else None
    return {"course_id": int(course_id), "entitled": entitled, "fair_usage": usage}


@router.post("/playback/token")
def issue_stream_playback_token(
    payload: StreamPlaybackTokenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.ADMIN, UserRole.PROVIDER)),
):
    video = db.get(LessonVideo, int(payload.lesson_video_id))
    if not video:
        raise HTTPException(status_code=404, detail="Lesson video not found")
    if not video.ready_status:
        raise HTTPException(status_code=409, detail="Video is not ready yet")

    if current_user.role not in {UserRole.ADMIN, UserRole.PROVIDER}:
        _must_have_course_purchase(db, user_id=current_user.id, course_id=int(video.course_id))

    usage_before = evaluate_fair_usage(db, user_id=current_user.id, course_id=int(video.course_id))
    if current_user.role not in {UserRole.ADMIN, UserRole.PROVIDER} and (
        int(usage_before.get("allowance_seconds") or 0) > 0
        and int(usage_before.get("consumed_seconds") or 0) >= int(usage_before.get("allowance_seconds") or 0)
    ):
        raise HTTPException(
            status_code=402,
            detail={
                "message": "Maximum watch allowance reached for this course. Please buy credits to continue watching.",
                "credits_required": True,
                "fair_usage": usage_before,
            },
        )

    try:
        token = generate_playback_token(video_uid=video.cloudflare_video_uid, user_id=current_user.id, course_id=video.course_id)
        urls = build_playback_urls(video_uid=video.cloudflare_video_uid, token=token)
    except CloudflareStreamError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    progress = db.scalar(
        select(VideoWatchProgress).where(
            and_(VideoWatchProgress.user_id == current_user.id, VideoWatchProgress.lesson_video_id == video.id),
        ),
    )
    resume_position = int(progress.resume_position_seconds) if progress else 0

    session = VideoWatchSession(
        user_id=current_user.id,
        course_id=video.course_id,
        lesson_id=video.lesson_id,
        lesson_video_id=video.id,
        client_app=str(payload.client_app or "web"),
    )
    db.add(session)
    db.commit()
    db.refresh(session)

    return {
        "session_id": session.id,
        "lesson_video_id": video.id,
        "video_uid": video.cloudflare_video_uid,
        "playback": urls,
        "expires_in_seconds": 900,
        "resume_position_seconds": resume_position,
        "fair_usage": usage_before,
    }


@router.post("/watch/heartbeat")
def stream_watch_heartbeat(
    payload: StreamWatchHeartbeatRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.ADMIN, UserRole.PROVIDER)),
):
    sess = db.get(VideoWatchSession, int(payload.session_id))
    if not sess or int(sess.user_id) != int(current_user.id):
        raise HTTPException(status_code=404, detail="Watch session not found")

    before_usage = evaluate_fair_usage(db, user_id=current_user.id, course_id=sess.course_id)
    old_level = int(before_usage.get("warning_level") or 0)

    delta = int(payload.watched_seconds_delta or 0)
    sess.consumed_seconds = int(sess.consumed_seconds or 0) + max(0, delta)
    sess.last_position_seconds = max(int(sess.last_position_seconds or 0), int(payload.position_seconds or 0))
    sess.ip_address = request.client.host if request.client else sess.ip_address
    sess.user_agent = request.headers.get("user-agent") or sess.user_agent
    if payload.ended:
        sess.ended_at = datetime.now(timezone.utc)

    progress = db.scalar(
        select(VideoWatchProgress).where(
            and_(VideoWatchProgress.user_id == current_user.id, VideoWatchProgress.lesson_video_id == int(payload.lesson_video_id)),
        ),
    )
    if not progress:
        progress = VideoWatchProgress(
            user_id=current_user.id,
            course_id=sess.course_id,
            lesson_id=sess.lesson_id,
            lesson_video_id=sess.lesson_video_id,
            total_watched_seconds=max(0, delta),
            resume_position_seconds=max(0, int(payload.position_seconds or 0)),
            completion_ratio=0,
        )
        db.add(progress)
    else:
        progress.total_watched_seconds = int(progress.total_watched_seconds or 0) + max(0, delta)
        progress.resume_position_seconds = max(int(progress.resume_position_seconds or 0), int(payload.position_seconds or 0))

    video = db.get(LessonVideo, int(payload.lesson_video_id))
    duration = int(video.duration_seconds or 0) if video else 0
    if duration > 0:
        progress.completion_ratio = min(1.0, float(progress.resume_position_seconds) / float(duration))

    db.commit()

    after_usage = evaluate_fair_usage(db, user_id=current_user.id, course_id=sess.course_id)
    new_level = int(after_usage.get("warning_level") or 0)

    progress.usage_warning_level = new_level
    log_fair_usage_transition(
        db,
        actor_user_id=current_user.id,
        target_user_id=current_user.id,
        course_id=sess.course_id,
        old_level=old_level,
        new_level=new_level,
        usage_snapshot=after_usage,
    )
    db.commit()

    return {
        "ok": True,
        "session_id": sess.id,
        "consumed_seconds": int(sess.consumed_seconds or 0),
        "resume_position_seconds": int(progress.resume_position_seconds or 0),
        "playback_allowed": "credits_required" not in set(after_usage.get("status_flags") or []),
        "credits_required": "credits_required" in set(after_usage.get("status_flags") or []),
        "fair_usage": after_usage,
    }


@router.post("/courses/{course_id}/pricing-recommendation")
def stream_pricing_recommendation(
    course_id: int,
    payload: StreamPricingRecommendationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    course = db.get(Course, int(course_id))
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    return pricing_recommendation_for_course(
        db,
        course_id=course.id,
        entered_price=float(payload.entered_price),
        expected_views_per_month=int(payload.expected_views_per_month),
    )


@router.post("/live/sessions")
def create_live_session_stub(
    payload: StreamLiveSessionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    creator = _creator_for_user(db, current_user)
    row = LiveStreamSession(
        creator_id=creator.id,
        course_id=payload.course_id,
        title=payload.title,
        status="draft",
        scheduled_start_at=payload.scheduled_start_at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "live_session_id": row.id,
        "status": row.status,
        "title": row.title,
        "scheduled_start_at": row.scheduled_start_at,
    }


@router.get("/admin/analytics")
def stream_admin_analytics(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    uploaded_minutes = analytics_total_uploaded_minutes(db)
    watched_minutes = round(
        float(
            (db.scalar(select(func.coalesce(func.sum(VideoWatchProgress.total_watched_seconds), 0))) or 0) / 60.0,
        ),
        2,
    )

    most_watched_courses_rows = db.execute(
        select(VideoWatchProgress.course_id, func.coalesce(func.sum(VideoWatchProgress.total_watched_seconds), 0).label("watched"))
        .group_by(VideoWatchProgress.course_id)
        .order_by(func.coalesce(func.sum(VideoWatchProgress.total_watched_seconds), 0).desc())
        .limit(10),
    ).all()

    users_exceeding = []
    course_ids = [int(row[0]) for row in most_watched_courses_rows]
    if course_ids:
        progress_rows = db.execute(
            select(VideoWatchProgress.user_id, VideoWatchProgress.course_id, func.coalesce(func.sum(VideoWatchProgress.total_watched_seconds), 0))
            .where(VideoWatchProgress.course_id.in_(course_ids))
            .group_by(VideoWatchProgress.user_id, VideoWatchProgress.course_id),
        ).all()
        for uid, cid, _ in progress_rows:
            usage = evaluate_fair_usage(db, user_id=int(uid), course_id=int(cid))
            if int(usage.get("warning_level") or 0) >= 2:
                users_exceeding.append({"user_id": int(uid), "course_id": int(cid), "usage": usage})

    creators_rows = db.execute(
        select(LessonVideo.creator_id, func.coalesce(func.sum(LessonVideo.duration_seconds), 0).label("seconds"))
        .group_by(LessonVideo.creator_id)
        .order_by(func.coalesce(func.sum(LessonVideo.duration_seconds), 0).desc())
        .limit(10),
    ).all()

    completion_rows = db.execute(
        select(VideoWatchProgress.course_id, func.avg(VideoWatchProgress.completion_ratio))
        .group_by(VideoWatchProgress.course_id),
    ).all()

    return {
        "total_uploaded_minutes": uploaded_minutes,
        "total_watched_minutes": watched_minutes,
        "most_watched_courses": [
            {"course_id": int(cid), "watched_minutes": round(float(sec or 0) / 60.0, 2)}
            for cid, sec in most_watched_courses_rows
        ],
        "users_exceeding_fair_usage": users_exceeding,
        "creators_highest_streaming_consumption": [
            {"creator_id": int(cid), "uploaded_minutes": round(float(sec or 0) / 60.0, 2)}
            for cid, sec in creators_rows
        ],
        "course_completion_rate": [
            {"course_id": int(cid), "avg_completion_pct": round(float(avg or 0) * 100.0, 2)}
            for cid, avg in completion_rows
        ],
    }


@router.patch("/admin/courses/{course_id}/fair-usage")
def admin_update_fair_usage(
    course_id: int,
    payload: StreamFairUsageOverrideRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    course = db.get(Course, int(course_id))
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    if payload.fair_usage_multiplier is not None:
        course.fair_usage_multiplier = float(payload.fair_usage_multiplier)
    course.admin_fair_usage_override_enabled = bool(payload.override_enabled)
    course.fair_usage_override_seconds = int(payload.override_seconds) if payload.override_seconds else None
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="fair_usage_override_updated",
            target_type="course",
            target_id=course.id,
            details_json={
                "fair_usage_multiplier": course.fair_usage_multiplier,
                "override_enabled": course.admin_fair_usage_override_enabled,
                "override_seconds": course.fair_usage_override_seconds,
            },
        ),
    )
    db.commit()
    return {
        "course_id": course.id,
        "fair_usage_multiplier": course.fair_usage_multiplier,
        "override_enabled": course.admin_fair_usage_override_enabled,
        "override_seconds": course.fair_usage_override_seconds,
    }
