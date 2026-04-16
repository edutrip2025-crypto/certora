from datetime import datetime, timezone
from pathlib import Path
import re
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import get_db
from app.models.entities import (
    ApprovalStatus,
    Certificate,
    Course,
    CourseComment,
    CourseFeedback,
    Enrollment,
    Exam,
    Lesson,
    LessonTopic,
    LiveClassMessage,
    LiveClassParticipant,
    LiveClassPollVote,
    LiveClassSession,
    LiveClassCompletion,
    ProviderNotification,
    ProviderDocument,
    ProviderCourseDraft,
    ProviderProfile,
    ProviderType,
    Question,
    Resource,
    Result,
    User,
    UserRole,
    VideoUploadSession,
    VideoUploadStatus,
)
from app.schemas import (
    CourseCommentReply,
    LessonTopicCreate,
    LessonTopicOut,
    LiveClassBoardUpdate,
    LiveClassMessageCreate,
    LiveClassPollCreate,
    LiveClassScheduleCreate,
    LiveClassScheduleUpdate,
    ProviderDocumentCreate,
    ProviderDocumentOut,
    ProviderHomeOut,
    ProviderProfileCreate,
    ProviderProfileOut,
)
from app.services.certificates import ensure_certificate_pdf
from app.services.media_storage import resolve_media_url, upload_file_to_cloud_storage

router = APIRouter(prefix="/provider", tags=["provider"])


def _media_paths() -> tuple[Path, Path]:
    media_root = Path(get_settings().resolved_media_dir)
    videos_dir = media_root / "videos"
    uploads_dir = media_root / "uploads"
    videos_dir.mkdir(parents=True, exist_ok=True)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    return videos_dir, uploads_dir


def _safe_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", name.strip())
    return cleaned[:180] if cleaned else f"video_{uuid4().hex}.mp4"


@router.post("/profile", response_model=ProviderProfileOut, status_code=status.HTTP_201_CREATED)
def upsert_profile(
    payload: ProviderProfileCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, allow_unapproved=True)),
):
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == current_user.id))
    if not profile:
        profile = ProviderProfile(
            user_id=current_user.id,
            provider_type=payload.provider_type,
            display_name=payload.display_name,
            description=payload.description,
            approval_status=ApprovalStatus.PENDING,
        )
        db.add(profile)
    else:
        profile.provider_type = payload.provider_type
        profile.display_name = payload.display_name
        profile.description = payload.description
        profile.approval_status = ApprovalStatus.PENDING
        profile.rejection_reason = None
        profile.reviewed_at = None
        profile.reviewed_by_admin_id = None

    db.commit()
    db.refresh(profile)
    return profile


@router.post("/documents", response_model=ProviderDocumentOut, status_code=status.HTTP_201_CREATED)
def upload_document(
    payload: ProviderDocumentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, allow_unapproved=True)),
):
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == current_user.id))
    if not profile:
        raise HTTPException(status_code=404, detail="Provider profile not found")

    doc = ProviderDocument(
        provider_id=profile.id,
        document_type=payload.document_type,
        file_url=payload.file_url,
        status=ApprovalStatus.PENDING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/status", response_model=ProviderProfileOut)
def provider_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, allow_unapproved=True)),
):
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == current_user.id))
    if not profile:
        raise HTTPException(status_code=404, detail="Provider profile not found")
    return profile


@router.post("/status/{provider_id}/{decision}", response_model=ProviderProfileOut)
def review_provider_status(
    provider_id: int,
    decision: str,
    reason: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    profile = db.get(ProviderProfile, provider_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Provider not found")
    if decision not in ["approve", "reject"]:
        raise HTTPException(status_code=400, detail="Decision must be approve or reject")

    profile.approval_status = ApprovalStatus.APPROVED if decision == "approve" else ApprovalStatus.REJECTED
    profile.rejection_reason = None if decision == "approve" else reason
    profile.reviewed_by_admin_id = current_user.id
    profile.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(profile)
    return profile


def _provider_or_404(db: Session, user_id: int) -> ProviderProfile:
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == user_id))
    if not profile:
        user = db.get(User, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="Provider profile not found")
        profile = ProviderProfile(
            user_id=user_id,
            provider_type=ProviderType.INDIVIDUAL,
            display_name=user.full_name or user.email.split("@")[0],
            description="",
            approval_status=ApprovalStatus.PENDING,
        )
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


def _course_rating_summary(db: Session, course_ids: set[int]) -> dict[int, dict]:
    if not course_ids:
        return {}
    rows = db.execute(
        select(
            CourseFeedback.course_id,
            CourseFeedback.valuable_time_rating,
            CourseFeedback.content_quality_rating,
            CourseFeedback.instructor_clarity_rating,
            CourseFeedback.practical_usefulness_rating,
        ).where(CourseFeedback.course_id.in_(course_ids)),
    ).all()
    totals: dict[int, float] = {}
    counts: dict[int, int] = {}
    for course_id, v1, v2, v3, v4 in rows:
        cid = int(course_id)
        overall = (float(v1 or 0) + float(v2 or 0) + float(v3 or 0) + float(v4 or 0)) / 4.0
        totals[cid] = totals.get(cid, 0.0) + overall
        counts[cid] = counts.get(cid, 0) + 1
    return {
        cid: {
            "average_rating": round((totals[cid] / counts[cid]), 2) if counts[cid] else 0.0,
            "rating_count": int(counts[cid]),
        }
        for cid in counts
    }


def _provider_live_session_or_404(db: Session, provider_id: int, session_id: int) -> LiveClassSession:
    sess = db.get(LiveClassSession, session_id)
    if not sess or sess.provider_id != provider_id:
        raise HTTPException(status_code=404, detail="Live class session not found")
    return sess


def _live_poll_tally(db: Session, sess: LiveClassSession) -> dict:
    if not sess.active_poll_key:
        return {"total_votes": 0, "votes": []}
    rows = db.execute(
        select(LiveClassPollVote.option_index, func.count(LiveClassPollVote.id))
        .where(and_(LiveClassPollVote.session_id == sess.id, LiveClassPollVote.poll_key == sess.active_poll_key))
        .group_by(LiveClassPollVote.option_index),
    ).all()
    counts = {int(i): int(c) for i, c in rows}
    options = list(sess.active_poll_options_json or [])
    votes = [int(counts.get(i, 0)) for i in range(len(options))]
    return {"total_votes": sum(votes), "votes": votes}


def _provider_live_room_state(db: Session, sess: LiveClassSession) -> dict:
    course = db.get(Course, sess.course_id)
    participant_rows = db.scalars(
        select(LiveClassParticipant)
        .where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.is_present.is_(True)))
        .order_by(LiveClassParticipant.joined_at.asc()),
    ).all()
    poll_tally = _live_poll_tally(db, sess)
    return {
        "session": {
            "id": sess.id,
            "room_code": sess.room_code,
            "course_id": sess.course_id,
            "course_title": course.title if course else None,
            "title": sess.title,
            "description": sess.description,
            "timezone": sess.timezone,
            "status": sess.status,
            "scheduled_start_at": sess.scheduled_start_at,
            "scheduled_end_at": sess.scheduled_end_at,
            "started_at": sess.started_at,
            "ended_at": sess.ended_at,
            "meeting_mode": sess.meeting_mode,
            "external_meeting_url": sess.external_meeting_url,
            "allow_chat": bool(sess.allow_chat),
            "allow_raise_hand": bool(sess.allow_raise_hand),
            "allow_reactions": bool(sess.allow_reactions),
            "board_text": sess.board_text or "",
            "active_poll": {
                "key": sess.active_poll_key,
                "question": sess.active_poll_question,
                "options": list(sess.active_poll_options_json or []),
                "is_open": bool(sess.active_poll_open),
                "total_votes": poll_tally["total_votes"],
                "votes": poll_tally["votes"],
            },
        },
        "participants": [
            {
                "user_id": p.user_id,
                "display_name": p.display_name,
                "actor_role": p.actor_role,
                "raised_hand": bool(p.raised_hand),
                "joined_at": p.joined_at,
            }
            for p in participant_rows
        ],
        "participant_count": len(participant_rows),
    }


@router.get("/workspace/home", response_model=ProviderHomeOut)
def provider_home(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    total_courses = db.scalar(select(func.count(Course.id)).where(Course.provider_id == provider.id)) or 0
    published_courses = (
        db.scalar(select(func.count(Course.id)).where(and_(Course.provider_id == provider.id, Course.is_published.is_(True))))
        or 0
    )
    total_enrollments = (
        db.scalar(select(func.count(Enrollment.id)).join(Course, Course.id == Enrollment.course_id).where(Course.provider_id == provider.id))
        or 0
    )
    exams_created = db.scalar(select(func.count(Exam.id)).join(Course, Course.id == Exam.course_id).where(Course.provider_id == provider.id)) or 0
    certificates_issued = (
        db.scalar(select(func.count(Certificate.id)).where(Certificate.provider_id == provider.id)) or 0
    )
    result_rows = db.execute(
        select(Result.passed).join(Exam, Exam.id == Result.exam_id).join(Course, Course.id == Exam.course_id).where(Course.provider_id == provider.id),
    ).all()
    total_results = len(result_rows)
    passed_results = sum(1 for row in result_rows if row[0])
    pass_percentage = round((passed_results / total_results) * 100, 2) if total_results > 0 else 0
    unread_notifications = (
        db.scalar(
            select(func.count(ProviderNotification.id)).where(
                and_(ProviderNotification.provider_id == provider.id, ProviderNotification.is_read.is_(False)),
            ),
        )
        or 0
    )
    return ProviderHomeOut(
        total_courses=total_courses,
        published_courses=published_courses,
        total_enrollments=total_enrollments,
        exams_created=exams_created,
        certificates_issued=certificates_issued,
        pass_percentage=pass_percentage,
        unread_notifications=unread_notifications,
    )


@router.post("/workspace/content/lessons/{lesson_id}/topics", response_model=LessonTopicOut, status_code=status.HTTP_201_CREATED)
def add_lesson_topic(
    lesson_id: int,
    payload: LessonTopicCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lesson not found")
    # Validate lesson ownership through course module relation.
    from app.models.entities import CourseModule  # local import to avoid circular edits

    module = db.get(CourseModule, lesson.module_id)
    parent_course = db.get(Course, module.course_id) if module else None
    if not parent_course or parent_course.provider_id != provider.id:
        raise HTTPException(status_code=403, detail="Access denied")

    topic = LessonTopic(
        lesson_id=lesson.id,
        title=payload.title,
        time_seconds=payload.time_seconds,
        thumbnail_data_url=payload.thumbnail_data_url,
    )
    db.add(topic)
    db.commit()
    db.refresh(topic)
    return topic


@router.get("/workspace/content/courses")
def provider_content_courses(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    courses = list(db.scalars(select(Course).where(Course.provider_id == provider.id)).all())
    rating_summary = _course_rating_summary(db, {int(c.id) for c in courses})
    from app.models.entities import CourseModule  # local import to avoid file-wide refactor

    response = []
    for course in courses:
        modules = list(db.scalars(select(CourseModule).where(CourseModule.course_id == course.id)).all())
        module_items = []
        for module in modules:
            lessons = list(db.scalars(select(Lesson).where(Lesson.module_id == module.id)).all())
            lesson_items = []
            for lesson in lessons:
                topics = list(
                    db.scalars(select(LessonTopic).where(LessonTopic.lesson_id == lesson.id).order_by(LessonTopic.time_seconds)).all(),
                )
                resources = list(
                    db.scalars(select(Resource).where(Resource.lesson_id == lesson.id)).all(),
                )
                lesson_items.append(
                    {
                        "id": lesson.id,
                        "title": lesson.title,
                        "lesson_type": lesson.lesson_type,
                        "recorded_video_url": resolve_media_url(lesson.recorded_video_url),
                        "live_class_url": lesson.live_class_url,
                        "topics": [{"id": t.id, "title": t.title, "time_seconds": t.time_seconds, "thumbnail_data_url": t.thumbnail_data_url} for t in topics],
                        "resources": [{"id": r.id, "title": r.title, "url": r.url, "resource_type": r.resource_type} for r in resources],
                    },
                )
            module_items.append({"id": module.id, "title": module.title, "lessons": lesson_items})
        response.append(
            {
                "id": course.id,
                "title": course.title,
                "thumbnail_url": course.thumbnail_url,
                "is_published": course.is_published,
                "average_rating": float((rating_summary.get(int(course.id)) or {}).get("average_rating", 0.0)),
                "rating_count": int((rating_summary.get(int(course.id)) or {}).get("rating_count", 0)),
                "modules": module_items,
            },
        )
    return response


@router.post("/workspace/uploads/init")
def init_video_upload(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    filename = str(payload.get("filename") or "").strip()
    total_chunks = int(payload.get("total_chunks") or 0)
    total_size = int(payload.get("total_size") or 0)
    mime_type = payload.get("mime_type")
    if not filename or total_chunks <= 0:
        raise HTTPException(status_code=400, detail="filename and total_chunks are required")

    _, uploads_dir = _media_paths()
    session_id = uuid4().hex
    stored_filename = f"{session_id}_{_safe_filename(filename)}"
    session_dir = uploads_dir / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    upload = VideoUploadSession(
        session_id=session_id,
        provider_id=provider.id,
        original_filename=filename,
        stored_filename=stored_filename,
        mime_type=mime_type,
        total_size=total_size,
        total_chunks=total_chunks,
        received_chunks=0,
        status=VideoUploadStatus.INITIATED,
    )
    db.add(upload)
    db.commit()
    return {"session_id": session_id, "total_chunks": total_chunks}


@router.put("/workspace/uploads/{session_id}/chunk")
async def upload_video_chunk(
    session_id: str,
    index: int,
    chunk: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    upload = db.scalar(select(VideoUploadSession).where(VideoUploadSession.session_id == session_id))
    if not upload or upload.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Upload session not found")
    if upload.status == VideoUploadStatus.COMPLETED:
        raise HTTPException(status_code=400, detail="Upload already completed")
    if index < 0 or index >= upload.total_chunks:
        raise HTTPException(status_code=400, detail="Invalid chunk index")

    _, uploads_dir = _media_paths()
    session_dir = uploads_dir / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = session_dir / f"{index}.part"
    if chunk_path.exists():
        return {"session_id": session_id, "index": index, "status": "already_received", "received_chunks": upload.received_chunks}

    data = await chunk.read()
    chunk_path.write_bytes(data)
    upload.received_chunks += 1
    upload.status = VideoUploadStatus.UPLOADING
    db.commit()
    return {"session_id": session_id, "index": index, "status": "received", "received_chunks": upload.received_chunks, "total_chunks": upload.total_chunks}


@router.get("/workspace/uploads/{session_id}")
def upload_video_status(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    upload = db.scalar(select(VideoUploadSession).where(VideoUploadSession.session_id == session_id))
    if not upload or upload.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Upload session not found")
    return {
        "session_id": upload.session_id,
        "status": upload.status,
        "received_chunks": upload.received_chunks,
        "total_chunks": upload.total_chunks,
        "file_url": resolve_media_url(upload.file_url),
        "storage_ref": upload.file_url,
    }


@router.post("/workspace/uploads/{session_id}/complete")
def complete_video_upload(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    upload = db.scalar(select(VideoUploadSession).where(VideoUploadSession.session_id == session_id))
    if not upload or upload.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Upload session not found")
    if upload.received_chunks < upload.total_chunks:
        raise HTTPException(status_code=400, detail="Upload is incomplete")

    videos_dir, uploads_dir = _media_paths()
    session_dir = uploads_dir / session_id
    final_path = videos_dir / upload.stored_filename

    try:
        with final_path.open("wb") as out:
            for idx in range(upload.total_chunks):
                part = session_dir / f"{idx}.part"
                if not part.exists():
                    raise HTTPException(status_code=400, detail=f"Missing chunk {idx}")
                out.write(part.read_bytes())
        for idx in range(upload.total_chunks):
            part = session_dir / f"{idx}.part"
            if part.exists():
                part.unlink()
        if session_dir.exists():
            session_dir.rmdir()
    except HTTPException:
        upload.status = VideoUploadStatus.FAILED
        db.commit()
        raise
    except Exception as exc:
        upload.status = VideoUploadStatus.FAILED
        upload.error_message = str(exc)
        db.commit()
        raise HTTPException(status_code=500, detail="Failed to merge uploaded chunks")

    try:
        upload.file_url = upload_file_to_cloud_storage(
            final_path,
            object_path=f"videos/{upload.stored_filename}",
            content_type=upload.mime_type or "video/mp4",
        )
    except Exception as exc:
        settings = get_settings()
        if settings.resolved_object_storage_backend == "local":
            upload.file_url = f"/media/videos/{upload.stored_filename}"
        else:
            upload.status = VideoUploadStatus.FAILED
            upload.error_message = f"Cloud upload failed: {exc}"
            db.commit()
            raise HTTPException(status_code=500, detail="Failed to upload video to cloud storage")
    upload.status = VideoUploadStatus.COMPLETED
    db.commit()
    return {
        "session_id": upload.session_id,
        "file_url": resolve_media_url(upload.file_url),
        "storage_ref": upload.file_url,
        "status": upload.status,
    }


@router.post("/workspace/courses/drafts")
def save_course_draft(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    draft_id = payload.get("draft_id")
    draft = db.get(ProviderCourseDraft, int(draft_id)) if draft_id else None
    if draft and draft.provider_id != provider.id:
        raise HTTPException(status_code=403, detail="Access denied")
    if not draft:
        draft = ProviderCourseDraft(provider_id=provider.id)
        db.add(draft)

    draft.title = str(payload.get("title") or "")
    draft.level = str(payload.get("level") or "Beginner")
    draft.category = str(payload.get("category") or "General")
    draft.description = str(payload.get("description") or "")
    draft.thumbnail_url = payload.get("thumbnail_url")
    draft.includes_exam = bool(payload.get("includes_exam", True))
    draft.video_url = payload.get("video_url")
    draft.topics_json = payload.get("topics") or []
    db.commit()
    db.refresh(draft)
    return {
        "draft_id": draft.id,
        "title": draft.title,
        "level": draft.level,
        "category": draft.category,
        "description": draft.description,
        "thumbnail_url": draft.thumbnail_url,
        "includes_exam": draft.includes_exam,
        "video_url": draft.video_url,
        "topics": draft.topics_json,
        "updated_at": draft.updated_at,
    }


@router.get("/workspace/courses/drafts")
def list_course_drafts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    drafts = list(
        db.scalars(select(ProviderCourseDraft).where(ProviderCourseDraft.provider_id == provider.id).order_by(ProviderCourseDraft.updated_at.desc())).all(),
    )
    return [
        {
            "draft_id": d.id,
            "title": d.title,
            "level": d.level,
            "category": d.category,
            "video_url": d.video_url,
            "topics_count": len(d.topics_json or []),
            "updated_at": d.updated_at,
        }
        for d in drafts
    ]


@router.get("/workspace/courses/drafts/{draft_id}")
def get_course_draft(
    draft_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    draft = db.get(ProviderCourseDraft, draft_id)
    if not draft or draft.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Draft not found")
    return {
        "draft_id": draft.id,
        "title": draft.title,
        "level": draft.level,
        "category": draft.category,
        "description": draft.description,
        "thumbnail_url": draft.thumbnail_url,
        "includes_exam": draft.includes_exam,
        "video_url": draft.video_url,
        "video_play_url": resolve_media_url(draft.video_url),
        "topics": draft.topics_json or [],
        "updated_at": draft.updated_at,
    }


@router.delete("/workspace/courses/drafts/{draft_id}")
def delete_course_draft(
    draft_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    draft = db.get(ProviderCourseDraft, draft_id)
    if not draft or draft.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Draft not found")
    db.delete(draft)
    db.commit()
    return {"deleted": True, "draft_id": draft_id}


@router.get("/workspace/assessments")
def provider_assessments(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    rows = db.execute(select(Exam, Course).join(Course, Course.id == Exam.course_id).where(Course.provider_id == provider.id)).all()
    question_counts = {
        exam_id: count
        for exam_id, count in db.execute(
            select(Question.exam_id, func.count(Question.id)).group_by(Question.exam_id),
        ).all()
    }
    return [
        {
            "exam_id": exam.id,
            "title": exam.title,
            "course_id": course.id,
            "course_title": course.title,
            "status": exam.status,
            "pass_score": exam.pass_score,
            "max_attempts": exam.max_attempts,
            "negative_marking": exam.negative_marking,
            "shuffle_questions": exam.shuffle_questions,
            "shuffle_options": exam.shuffle_options,
            "certificate_enabled": exam.certificate_enabled,
            "timing_mode": exam.timing_mode,
            "duration_minutes": exam.duration_minutes,
            "time_per_question_seconds": exam.time_per_question_seconds,
            "questions_per_attempt": exam.questions_per_attempt,
            "question_count": int(question_counts.get(exam.id, 0)),
        }
        for exam, course in rows
    ]


@router.get("/workspace/live-classes")
def provider_live_classes(
    course_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    q = select(LiveClassSession).where(LiveClassSession.provider_id == provider.id)
    if course_id:
        q = q.where(LiveClassSession.course_id == course_id)
    rows = db.scalars(q.order_by(LiveClassSession.scheduled_start_at.desc(), LiveClassSession.id.desc())).all()
    courses = {c.id: c for c in db.scalars(select(Course).where(Course.provider_id == provider.id)).all()}
    items = []
    for sess in rows:
        participant_count = int(
            db.scalar(
                select(func.count(LiveClassParticipant.id)).where(
                    and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.is_present.is_(True)),
                ),
            )
            or 0
        )
        items.append(
            {
                "session_id": sess.id,
                "course_id": sess.course_id,
                "course_title": (courses.get(sess.course_id).title if courses.get(sess.course_id) else None),
                "room_code": sess.room_code,
                "title": sess.title,
                "description": sess.description,
                "timezone": sess.timezone,
                "status": sess.status,
                "scheduled_start_at": sess.scheduled_start_at,
                "scheduled_end_at": sess.scheduled_end_at,
                "started_at": sess.started_at,
                "ended_at": sess.ended_at,
                "meeting_mode": sess.meeting_mode,
                "external_meeting_url": sess.external_meeting_url,
                "participant_count": participant_count,
                "allow_chat": bool(sess.allow_chat),
                "allow_raise_hand": bool(sess.allow_raise_hand),
                "allow_reactions": bool(sess.allow_reactions),
            },
        )
    return {"items": items}


@router.post("/workspace/live-classes", status_code=status.HTTP_201_CREATED)
def create_live_class_schedule(
    payload: LiveClassScheduleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    course = db.get(Course, payload.course_id)
    if not course:
        raise HTTPException(status_code=404, detail="Course not found. Select a valid course from your provider workspace.")
    if course.provider_id != provider.id:
        raise HTTPException(status_code=403, detail="You can only schedule classes for your own courses.")
    if payload.scheduled_end_at and payload.scheduled_end_at <= payload.scheduled_start_at:
        raise HTTPException(status_code=400, detail="scheduled_end_at must be after scheduled_start_at")
    meeting_mode = str(payload.meeting_mode or "in_app").strip().lower()
    if meeting_mode not in {"in_app", "external"}:
        raise HTTPException(status_code=400, detail="meeting_mode must be in_app or external")
    if meeting_mode == "external" and not str(payload.external_meeting_url or "").strip():
        raise HTTPException(status_code=400, detail="external_meeting_url is required for external mode")
    sess = LiveClassSession(
        course_id=course.id,
        provider_id=provider.id,
        room_code=uuid4().hex[:10].upper(),
        title=payload.title.strip(),
        description=(payload.description or "").strip() or None,
        timezone=(payload.timezone or "UTC").strip() or "UTC",
        meeting_mode=meeting_mode,
        external_meeting_url=(payload.external_meeting_url or "").strip() or None,
        status="scheduled",
        scheduled_start_at=payload.scheduled_start_at,
        scheduled_end_at=payload.scheduled_end_at,
        max_participants=int(payload.max_participants),
        allow_chat=bool(payload.allow_chat),
        allow_raise_hand=bool(payload.allow_raise_hand),
        allow_reactions=bool(payload.allow_reactions),
    )
    db.add(sess)
    db.flush()
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="system",
            content=f"Live class '{sess.title}' scheduled.",
            payload_json={},
        ),
    )
    db.commit()
    return {"created": True, "session_id": sess.id, "room_code": sess.room_code}


@router.patch("/workspace/live-classes/{session_id}")
def update_live_class_schedule(
    session_id: int,
    payload: LiveClassScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    data = payload.model_dump(exclude_unset=True)
    if "meeting_mode" in data and data["meeting_mode"] is not None:
        mode = str(data["meeting_mode"]).strip().lower()
        if mode not in {"in_app", "external"}:
            raise HTTPException(status_code=400, detail="meeting_mode must be in_app or external")
        data["meeting_mode"] = mode
    if data.get("meeting_mode") == "external" and not str(data.get("external_meeting_url") or sess.external_meeting_url or "").strip():
        raise HTTPException(status_code=400, detail="external_meeting_url is required for external mode")
    next_start = data.get("scheduled_start_at", sess.scheduled_start_at)
    next_end = data.get("scheduled_end_at", sess.scheduled_end_at)
    if next_end and next_end <= next_start:
        raise HTTPException(status_code=400, detail="scheduled_end_at must be after scheduled_start_at")
    for key, value in data.items():
        setattr(sess, key, value)
    db.commit()
    return {"updated": True, "session_id": sess.id}


@router.post("/workspace/live-classes/{session_id}/start")
def start_live_class(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    if sess.status == "cancelled":
        raise HTTPException(status_code=400, detail="Cancelled class cannot be started")
    now = datetime.now(timezone.utc)
    sess.status = "live"
    sess.started_at = now
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="system",
            content="Class is now live.",
            payload_json={},
        ),
    )
    db.commit()
    return {"started": True, "session_id": sess.id, "status": sess.status}


@router.post("/workspace/live-classes/{session_id}/end")
def end_live_class(
    session_id: int,
    unlock_assessment: bool = True,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    now = datetime.now(timezone.utc)
    sess.status = "ended"
    sess.ended_at = now
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="system",
            content="Class has ended.",
            payload_json={},
        ),
    )
    unlocked = 0
    if unlock_assessment:
        enrollments = list(db.scalars(select(Enrollment).where(Enrollment.course_id == sess.course_id)).all())
        for enr in enrollments:
            enr.exam_eligible = True
            enr.progress_pct = max(float(enr.progress_pct or 0), 100.0)
        unlocked = len(enrollments)
        db.add(LiveClassCompletion(course_id=sess.course_id, provider_id=provider.id, note=f"Session #{sess.id} ended"))
    db.commit()
    return {"ended": True, "session_id": sess.id, "status": sess.status, "students_unlocked": unlocked}


@router.post("/workspace/live-classes/{session_id}/join")
def provider_join_live_class(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == current_user.id)),
    )
    now = datetime.now(timezone.utc)
    if not participant:
        participant = LiveClassParticipant(
            session_id=sess.id,
            user_id=current_user.id,
            actor_role="provider",
            display_name=current_user.full_name or current_user.email,
            is_present=True,
            joined_at=now,
            last_seen_at=now,
            raised_hand=False,
        )
        db.add(participant)
    else:
        participant.is_present = True
        participant.left_at = None
        participant.last_seen_at = now
    db.commit()
    return {"joined": True}


@router.post("/workspace/live-classes/{session_id}/leave")
def provider_leave_live_class(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == current_user.id)),
    )
    if participant:
        participant.is_present = False
        participant.raised_hand = False
        participant.left_at = datetime.now(timezone.utc)
        participant.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return {"left": True}


@router.get("/workspace/live-classes/{session_id}/room-state")
def provider_live_room_state(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    return _provider_live_room_state(db, sess)


@router.get("/workspace/live-classes/{session_id}/messages")
def provider_live_messages(
    session_id: int,
    after_id: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    limit = max(1, min(limit, 200))
    rows = db.scalars(
        select(LiveClassMessage)
        .where(and_(LiveClassMessage.session_id == sess.id, LiveClassMessage.id > int(after_id)))
        .order_by(LiveClassMessage.id.asc())
        .limit(limit),
    ).all()
    return {
        "items": [
            {
                "id": row.id,
                "message_type": row.message_type,
                "content": row.content,
                "actor_name": row.actor_name,
                "actor_role": row.actor_role,
                "payload": row.payload_json or {},
                "created_at": row.created_at,
            }
            for row in rows
        ]
    }


@router.post("/workspace/live-classes/{session_id}/messages")
def provider_send_live_message(
    session_id: int,
    payload: LiveClassMessageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    mtype = str(payload.message_type or "chat").strip().lower()
    if mtype not in {"chat", "announcement", "reaction"}:
        raise HTTPException(status_code=400, detail="Invalid message type")
    if mtype == "chat" and not sess.allow_chat:
        raise HTTPException(status_code=400, detail="Chat is disabled")
    if mtype == "reaction" and not sess.allow_reactions:
        raise HTTPException(status_code=400, detail="Reactions are disabled")
    text = str(payload.content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message content is required")
    row = LiveClassMessage(
        session_id=sess.id,
        user_id=current_user.id,
        actor_name=current_user.full_name,
        actor_role="provider",
        message_type=mtype,
        content=text,
        payload_json=payload.payload or {},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"message_id": row.id}


@router.post("/workspace/live-classes/{session_id}/tools/board")
def provider_update_live_board(
    session_id: int,
    payload: LiveClassBoardUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    sess.board_text = payload.board_text
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="board_update",
            content="Whiteboard updated.",
            payload_json={},
        ),
    )
    db.commit()
    return {"saved": True}


@router.post("/workspace/live-classes/{session_id}/tools/poll")
def provider_start_live_poll(
    session_id: int,
    payload: LiveClassPollCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    options = [str(x).strip() for x in payload.options if str(x).strip()]
    if len(options) < 2:
        raise HTTPException(status_code=400, detail="Poll requires at least 2 options")
    sess.active_poll_key = uuid4().hex
    sess.active_poll_question = str(payload.question).strip()
    sess.active_poll_options_json = options
    sess.active_poll_open = True
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="poll",
            content=f"Poll started: {sess.active_poll_question}",
            payload_json={"options": options},
        ),
    )
    db.commit()
    return {"started": True, "poll_key": sess.active_poll_key}


@router.post("/workspace/live-classes/{session_id}/tools/poll/close")
def provider_close_live_poll(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    sess = _provider_live_session_or_404(db, provider.id, session_id)
    sess.active_poll_open = False
    tally = _live_poll_tally(db, sess)
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="provider",
            message_type="poll",
            content="Poll closed.",
            payload_json={"tally": tally},
        ),
    )
    db.commit()
    return {"closed": True, "tally": tally}


@router.post("/workspace/live-class/{course_id}/complete")
def complete_live_class(
    course_id: int,
    note: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(status_code=404, detail="Course not found. Select a valid course from your provider workspace.")
    if course.provider_id != provider.id:
        raise HTTPException(status_code=403, detail="You can only complete classes for your own courses.")
    db.add(LiveClassCompletion(course_id=course.id, provider_id=provider.id, note=note))
    enrollments = list(db.scalars(select(Enrollment).where(Enrollment.course_id == course.id)).all())
    for enr in enrollments:
        enr.exam_eligible = True
        enr.progress_pct = max(enr.progress_pct, 100)
    db.commit()
    return {"course_id": course.id, "students_unlocked": len(enrollments), "assessment_access": True}


@router.get("/workspace/feedback/comments")
def provider_comments(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    rows = db.execute(
        select(CourseComment, Course, User)
        .join(Course, Course.id == CourseComment.course_id)
        .join(User, User.id == CourseComment.student_id)
        .where(Course.provider_id == provider.id)
        .order_by(CourseComment.created_at.desc()),
    ).all()
    return [
        {
            "comment_id": comment.id,
            "course_id": course.id,
            "course_title": course.title,
            "student_name": student.full_name,
            "student_email": student.email,
            "message": comment.message,
            "provider_reply": comment.provider_reply,
            "created_at": comment.created_at,
            "replied_at": comment.replied_at,
        }
        for comment, course, student in rows
    ]


@router.post("/workspace/feedback/comments/{comment_id}/reply")
def provider_reply_comment(
    comment_id: int,
    payload: CourseCommentReply,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    comment = db.get(CourseComment, comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    course = db.get(Course, comment.course_id)
    if not course or course.provider_id != provider.id:
        raise HTTPException(status_code=403, detail="Access denied")
    comment.provider_reply = payload.reply
    comment.replied_at = datetime.now(timezone.utc)
    db.commit()
    return {"comment_id": comment.id, "replied": True}


@router.get("/workspace/feedback/ratings")
def provider_course_feedback(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    rows = db.execute(
        select(CourseFeedback, Course, User)
        .join(Course, Course.id == CourseFeedback.course_id)
        .join(User, User.id == CourseFeedback.student_id)
        .where(Course.provider_id == provider.id)
        .order_by(CourseFeedback.created_at.desc()),
    ).all()
    return [
        {
            "feedback_id": fb.id,
            "course_id": course.id,
            "course_title": course.title,
            "student_name": student.full_name,
            "valuable_time_rating": fb.valuable_time_rating,
            "content_quality_rating": fb.content_quality_rating,
            "instructor_clarity_rating": fb.instructor_clarity_rating,
            "practical_usefulness_rating": fb.practical_usefulness_rating,
            "comment": fb.comment,
            "created_at": fb.created_at,
        }
        for fb, course, student in rows
    ]


@router.get("/workspace/notifications")
def provider_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    items = list(
        db.scalars(
            select(ProviderNotification).where(ProviderNotification.provider_id == provider.id).order_by(ProviderNotification.created_at.desc()),
        ).all(),
    )
    return [
        {
            "id": n.id,
            "event_type": n.event_type,
            "message": n.message,
            "ref_type": n.ref_type,
            "ref_id": n.ref_id,
            "is_read": n.is_read,
            "created_at": n.created_at,
        }
        for n in items
    ]


@router.post("/workspace/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    note = db.get(ProviderNotification, notification_id)
    if not note or note.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    note.is_read = True
    db.commit()
    return {"notification_id": note.id, "is_read": True}


@router.get("/workspace/certifications")
def provider_certifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    settings = get_settings()
    rows = db.execute(
        select(Certificate, Course, User)
        .join(Course, Course.id == Certificate.course_id)
        .join(User, User.id == Certificate.student_id)
        .where(Certificate.provider_id == provider.id)
        .order_by(Certificate.issued_at.desc()),
    ).all()
    dirty = False
    for cert, _, _ in rows:
        try:
            ensure_certificate_pdf(db, cert)
            dirty = True
        except RuntimeError:
            # Keep provider certificate list available even if PDF generation/storage is temporarily unavailable.
            continue
    if dirty:
        db.commit()
    return [
        {
            "certificate_id": cert.certificate_id,
            "course_name": course.title,
            "student_name": student.full_name,
            "issued_at": cert.issued_at,
            "download_url": (
                resolve_media_url(cert.pdf_url)
                if resolve_media_url(cert.pdf_url)
                else f"{settings.app_base_url}/certificates/verify/{cert.certificate_id}"
            ),
            "verification_url": f"{settings.app_base_url}/certificates/verify/{cert.certificate_id}",
        }
        for cert, course, student in rows
    ]
