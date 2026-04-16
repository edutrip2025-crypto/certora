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


@router.post("/workspace/live-class/{course_id}/complete")
def complete_live_class(
    course_id: int,
    note: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    provider = _provider_or_404(db, current_user.id)
    course = db.get(Course, course_id)
    if not course or course.provider_id != provider.id:
        raise HTTPException(status_code=404, detail="Course not found")
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
