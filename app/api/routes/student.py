from datetime import datetime, timezone
import random

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.session import get_db
from app.models.entities import (
    AttemptEvent,
    AttemptStatus,
    Certificate,
    CourseComment,
    CourseCompletion,
    CourseFeedback,
    Course,
    Enrollment,
    EnrollmentStatus,
    Exam,
    ExamAttempt,
    ExamStatus,
    Question,
    Result,
    Lesson,
    LessonTopic,
    LiveClassMessage,
    LiveClassParticipant,
    LiveClassPollVote,
    LiveClassSession,
    Resource,
    CourseModule,
    Option,
    StudentAnswer,
    ProviderNotification,
    ProviderProfile,
    ProctorTrainingFeedback,
    ProctorSession,
    User,
    UserRole,
)
from app.schemas import (
    AnswerSaveRequest,
    CourseCommentCreate,
    CourseFeedbackCreate,
    EnrollmentCreate,
    EnrollmentOut,
    EventRequest,
    LiveClassMessageCreate,
    LiveClassPollVoteCreate,
    ProctorTrainingFeedbackCreate,
    ResultOut,
)
from app.services.scoring import score_attempt
from app.services.proctoring_ai import evaluate_proctor_session
from app.services.certificates import certificate_payload, ensure_certificate_pdf, issue_certificate
from app.services.media_storage import resolve_media_url

router = APIRouter(prefix="/student", tags=["student"])


def _latest_training_feedback(db: Session, attempt_id: int) -> tuple[ProctorTrainingFeedback | None, int]:
    count = int(
        db.scalar(
            select(func.count(ProctorTrainingFeedback.id)).where(ProctorTrainingFeedback.attempt_id == attempt_id),
        )
        or 0,
    )
    latest = db.scalar(
        select(ProctorTrainingFeedback)
        .where(ProctorTrainingFeedback.attempt_id == attempt_id)
        .order_by(ProctorTrainingFeedback.created_at.desc(), ProctorTrainingFeedback.id.desc()),
    )
    return latest, count


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


def _student_feedback_map(db: Session, student_id: int, course_ids: set[int]) -> dict[int, dict]:
    if not course_ids:
        return {}
    rows = db.scalars(
        select(CourseFeedback).where(and_(CourseFeedback.student_id == student_id, CourseFeedback.course_id.in_(course_ids))),
    ).all()
    out: dict[int, dict] = {}
    for fb in rows:
        overall = (
            float(fb.valuable_time_rating or 0)
            + float(fb.content_quality_rating or 0)
            + float(fb.instructor_clarity_rating or 0)
            + float(fb.practical_usefulness_rating or 0)
        ) / 4.0
        out[int(fb.course_id)] = {
            "feedback_id": int(fb.id),
            "overall_rating": round(overall, 2),
            "valuable_time_rating": int(fb.valuable_time_rating),
            "content_quality_rating": int(fb.content_quality_rating),
            "instructor_clarity_rating": int(fb.instructor_clarity_rating),
            "practical_usefulness_rating": int(fb.practical_usefulness_rating),
            "comment": fb.comment,
            "created_at": fb.created_at,
        }
    return out


@router.get("/dashboard")
def dashboard(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrolled_rows = db.execute(
        select(Enrollment, Course)
        .join(Course, Course.id == Enrollment.course_id)
        .where(Enrollment.student_id == current_user.id)
        .order_by(Enrollment.enrolled_at.desc()),
    ).all()
    enrolled_course_ids = {course.id for _, course in enrolled_rows}
    published_courses = list(db.scalars(select(Course).where(Course.is_published.is_(True)).order_by(Course.id.desc())).all())
    available_courses = [c for c in published_courses if c.id not in enrolled_course_ids]
    dashboard_course_ids = {int(c.id) for c in published_courses}
    rating_summary = _course_rating_summary(db, dashboard_course_ids)
    my_feedback = _student_feedback_map(db, current_user.id, dashboard_course_ids)

    total_enrolled = len(enrolled_rows)
    completed_count = sum(1 for enr, _ in enrolled_rows if (enr.progress_pct or 0) >= 100)
    avg_progress = round(sum((enr.progress_pct or 0) for enr, _ in enrolled_rows) / total_enrolled, 2) if total_enrolled else 0
    eligible_count = sum(1 for enr, _ in enrolled_rows if enr.exam_eligible)
    certificates_issued = db.scalar(select(func.count(Certificate.id)).where(Certificate.student_id == current_user.id)) or 0

    published_exam_counts = {
        int(course_id): int(count)
        for course_id, count in db.execute(
            select(Exam.course_id, func.count(Exam.id))
            .where(Exam.status == ExamStatus.PUBLISHED)
            .group_by(Exam.course_id),
        ).all()
    }

    return {
        "stats": {
            "total_enrolled": total_enrolled,
            "completed_courses": completed_count,
            "avg_progress": avg_progress,
            "exam_eligible_courses": eligible_count,
            "certificates_issued": certificates_issued,
        },
        "enrolled": [
            {
                "course_id": course.id,
                "title": course.title,
                "category": course.category,
                "thumbnail_url": course.thumbnail_url,
                "progress_pct": enr.progress_pct,
                "exam_eligible": enr.exam_eligible,
                "published_assessments": int(published_exam_counts.get(int(course.id), 0)),
                "assessment_available": bool(enr.exam_eligible and int(published_exam_counts.get(int(course.id), 0)) > 0),
                "average_rating": float((rating_summary.get(int(course.id)) or {}).get("average_rating", 0.0)),
                "rating_count": int((rating_summary.get(int(course.id)) or {}).get("rating_count", 0)),
                "my_rating": float((my_feedback.get(int(course.id)) or {}).get("overall_rating", 0.0)),
                "status": enr.status,
                "enrolled_at": enr.enrolled_at,
            }
            for enr, course in enrolled_rows
        ],
        "available": [
            {
                "course_id": c.id,
                "title": c.title,
                "category": c.category,
                "thumbnail_url": c.thumbnail_url,
                "average_rating": float((rating_summary.get(int(c.id)) or {}).get("average_rating", 0.0)),
                "rating_count": int((rating_summary.get(int(c.id)) or {}).get("rating_count", 0)),
            }
            for c in available_courses
        ],
    }


@router.get("/courses/{course_id}/detail")
def course_detail(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrollment = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == course_id, Enrollment.student_id == current_user.id)),
    )
    if not enrollment:
        raise HTTPException(status_code=403, detail="Student not enrolled")
    course = db.get(Course, course_id)
    if not course or not course.is_published:
        raise HTTPException(status_code=404, detail="Course not found")

    modules = list(db.scalars(select(CourseModule).where(CourseModule.course_id == course.id)).all())
    module_items = []
    for module in modules:
        lessons = list(db.scalars(select(Lesson).where(Lesson.module_id == module.id)).all())
        lesson_items = []
        for lesson in lessons:
            topics = list(
                db.scalars(select(LessonTopic).where(LessonTopic.lesson_id == lesson.id).order_by(LessonTopic.time_seconds)).all(),
            )
            resources = list(db.scalars(select(Resource).where(Resource.lesson_id == lesson.id)).all())
            lesson_items.append(
                {
                    "id": lesson.id,
                    "title": lesson.title,
                    "lesson_type": lesson.lesson_type,
                    "recorded_video_url": resolve_media_url(lesson.recorded_video_url),
                    "live_class_url": lesson.live_class_url,
                    "topics": [
                        {
                            "id": t.id,
                            "title": t.title,
                            "time_seconds": t.time_seconds,
                            "thumbnail_data_url": t.thumbnail_data_url,
                        }
                        for t in topics
                    ],
                    "resources": [{"id": r.id, "title": r.title, "url": r.url, "resource_type": r.resource_type} for r in resources],
                },
            )
        module_items.append({"id": module.id, "title": module.title, "lessons": lesson_items})
    published_exam_count = int(
        db.scalar(
            select(func.count(Exam.id)).where(and_(Exam.course_id == course.id, Exam.status == ExamStatus.PUBLISHED)),
        )
        or 0
    )
    rating_summary = _course_rating_summary(db, {int(course.id)}).get(int(course.id), {"average_rating": 0.0, "rating_count": 0})
    my_feedback = _student_feedback_map(db, current_user.id, {int(course.id)}).get(int(course.id))
    return {
        "id": course.id,
        "title": course.title,
        "description": course.description,
        "category": course.category,
        "thumbnail_url": course.thumbnail_url,
        "progress_pct": enrollment.progress_pct,
        "exam_eligible": enrollment.exam_eligible,
        "published_assessments": published_exam_count,
        "assessment_available": bool(enrollment.exam_eligible and published_exam_count > 0),
        "average_rating": float(rating_summary.get("average_rating", 0.0)),
        "rating_count": int(rating_summary.get("rating_count", 0)),
        "my_feedback": my_feedback,
        "modules": module_items,
    }


@router.post("/lessons/{lesson_id}/join-live")
def join_live_lesson(
    lesson_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    lesson = db.get(Lesson, lesson_id)
    if not lesson or not lesson.live_class_url:
        raise HTTPException(status_code=404, detail="Live class not found")
    module = db.get(CourseModule, lesson.module_id)
    course = db.get(Course, module.course_id) if module else None
    if not course or not course.is_published:
        raise HTTPException(status_code=404, detail="Course not found")
    enrollment = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == course.id, Enrollment.student_id == current_user.id)),
    )
    if not enrollment:
        raise HTTPException(status_code=403, detail="Student not enrolled")
    return {
        "course_id": course.id,
        "lesson_id": lesson.id,
        "lesson_title": lesson.title,
        "live_class_url": lesson.live_class_url,
    }


@router.get("/certificates")
def student_certificates(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    items = list(
        db.scalars(
            select(Certificate)
            .where(Certificate.student_id == current_user.id)
            .order_by(Certificate.issued_at.desc(), Certificate.id.desc()),
        ).all(),
    )
    dirty = False
    for cert in items:
        try:
            ensure_certificate_pdf(db, cert)
            dirty = True
        except RuntimeError:
            # Return certificate rows even when PDF generation is temporarily unavailable.
            continue
    if dirty:
        db.commit()
    return [certificate_payload(db, cert) for cert in items]


@router.post("/enroll", response_model=EnrollmentOut)
def enroll(
    payload: EnrollmentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    course = db.get(Course, payload.course_id)
    if not course or not course.is_published:
        raise HTTPException(status_code=404, detail="Course not available")
    existing = db.scalar(
        select(Enrollment).where(and_(Enrollment.student_id == current_user.id, Enrollment.course_id == course.id)),
    )
    if existing:
        return existing
    enrollment = Enrollment(
        student_id=current_user.id,
        course_id=course.id,
        status=EnrollmentStatus.ACTIVE,
        progress_pct=0,
        exam_eligible=False,
    )
    db.add(enrollment)
    db.commit()
    db.refresh(enrollment)
    return enrollment


@router.post("/exams/{exam_id}/attempts/start", status_code=status.HTTP_201_CREATED)
def start_attempt(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    exam = db.get(Exam, exam_id)
    if not exam or exam.status != ExamStatus.PUBLISHED:
        raise HTTPException(status_code=404, detail="Exam not available")

    enrollment = db.scalar(
        select(Enrollment).where(
            and_(Enrollment.course_id == exam.course_id, Enrollment.student_id == current_user.id),
        ),
    )
    if not enrollment:
        raise HTTPException(status_code=403, detail="Student not enrolled")
    if not enrollment.exam_eligible:
        raise HTTPException(status_code=403, detail="Not exam eligible")

    existing_in_progress = db.scalar(
        select(ExamAttempt)
        .where(and_(ExamAttempt.student_id == current_user.id, ExamAttempt.status == AttemptStatus.IN_PROGRESS))
        .order_by(ExamAttempt.started_at.desc(), ExamAttempt.id.desc()),
    )
    if existing_in_progress:
        if existing_in_progress.exam_id == exam.id:
            assigned_ids = existing_in_progress.assigned_question_ids or []
            return {
                "attempt_id": existing_in_progress.id,
                "exam_id": existing_in_progress.exam_id,
                "student_id": current_user.id,
                "started_at": existing_in_progress.started_at,
                "attempt_number": existing_in_progress.attempt_number,
                "assigned_question_ids": assigned_ids,
                "total_questions": len(assigned_ids),
            }
        raise HTTPException(
            status_code=409,
            detail="Another test is already active for this user. Finish or submit that test before starting a new one.",
        )

    attempts_done = db.scalar(
        select(func.count(ExamAttempt.id)).where(
            and_(ExamAttempt.exam_id == exam.id, ExamAttempt.student_id == current_user.id),
        ),
    )
    if attempts_done >= exam.max_attempts:
        raise HTTPException(status_code=400, detail="Max attempts reached")

    question_ids = list(db.scalars(select(Question.id).where(Question.exam_id == exam.id)).all())
    if not question_ids:
        raise HTTPException(status_code=400, detail="Exam has no questions")
    if exam.questions_per_attempt and exam.questions_per_attempt > 0:
        take = min(exam.questions_per_attempt, len(question_ids))
        assigned_ids = random.sample(question_ids, take)
    else:
        assigned_ids = question_ids

    attempt = ExamAttempt(
        exam_id=exam.id,
        student_id=current_user.id,
        attempt_number=attempts_done + 1,
        assigned_question_ids=assigned_ids,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return {
        "attempt_id": attempt.id,
        "exam_id": exam.id,
        "student_id": current_user.id,
        "started_at": attempt.started_at,
        "attempt_number": attempt.attempt_number,
        "assigned_question_ids": assigned_ids,
        "total_questions": len(assigned_ids),
    }


@router.get("/attempts/{attempt_id}/paper")
def attempt_paper(
    attempt_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.student_id != current_user.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    exam = db.get(Exam, attempt.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    question_ids = attempt.assigned_question_ids or []
    if not question_ids:
        question_ids = list(db.scalars(select(Question.id).where(Question.exam_id == exam.id)).all())
    qmap = {
        q.id: q
        for q in db.scalars(select(Question).where(Question.id.in_(question_ids))).all()
    }
    items = []
    for qid in question_ids:
        q = qmap.get(qid)
        if not q:
            continue
        options = list(db.scalars(select(Option).where(Option.question_id == q.id).order_by(Option.position)).all())
        items.append(
            {
                "question_id": q.id,
                "question_text": q.question_text,
                "question_type": q.question_type,
                "marks": q.marks,
                "negative_marks": q.negative_marks,
                "options": [{"option_id": o.id, "option_text": o.option_text, "position": o.position} for o in options],
            },
        )
    return {
        "attempt_id": attempt.id,
        "exam_id": exam.id,
        "title": exam.title,
        "timing_mode": exam.timing_mode,
        "duration_minutes": exam.duration_minutes,
        "time_per_question_seconds": exam.time_per_question_seconds,
        "pass_score": exam.pass_score,
        "negative_marking": exam.negative_marking,
        "questions": items,
    }


@router.post("/attempts/{attempt_id}/answers")
def save_answer(
    attempt_id: int,
    payload: AnswerSaveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.student_id != current_user.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail="Attempt already submitted")

    question = db.get(Question, payload.question_id)
    if not question or question.exam_id != attempt.exam_id:
        raise HTTPException(status_code=404, detail="Question not found")
    if attempt.assigned_question_ids and payload.question_id not in attempt.assigned_question_ids:
        raise HTTPException(status_code=403, detail="Question not assigned for this attempt")

    existing = db.scalar(
        select(StudentAnswer).where(
            and_(StudentAnswer.attempt_id == attempt_id, StudentAnswer.question_id == payload.question_id),
        ),
    )
    if existing:
        existing.selected_option_ids = payload.selected_option_ids
        existing.text_answer = payload.text_answer
    else:
        db.add(
            StudentAnswer(
                attempt_id=attempt_id,
                question_id=payload.question_id,
                selected_option_ids=payload.selected_option_ids,
                text_answer=payload.text_answer,
            ),
        )
    db.commit()
    return {"saved": True}


@router.post("/attempts/{attempt_id}/events")
def log_attempt_event(
    attempt_id: int,
    payload: EventRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.student_id != current_user.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    event = AttemptEvent(attempt_id=attempt_id, event_type=payload.event_type, payload_json=payload.payload)
    db.add(event)
    db.commit()
    return {"logged": True, "ip": request.client.host if request.client else None}


@router.post("/attempts/{attempt_id}/submit", response_model=ResultOut)
def submit_attempt(
    attempt_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.student_id != current_user.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail="Attempt already submitted")

    exam = db.get(Exam, attempt.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")

    score, percentage, correct_count, wrong_count, total_questions = score_attempt(
        db,
        attempt.id,
        attempt.exam_id,
        exam.negative_marking,
        assigned_question_ids=attempt.assigned_question_ids,
    )
    proctor_session = db.scalar(
        select(ProctorSession)
        .where(ProctorSession.attempt_id == attempt.id)
        .order_by(ProctorSession.started_at.desc()),
    )
    proctor_eval = evaluate_proctor_session(db, proctor_session) if proctor_session else None
    latest_feedback, feedback_count = _latest_training_feedback(db, attempt.id)
    deduction_pct = float((proctor_eval or {}).get("deduction_pct", 0.0))
    final_percentage = max(0.0, float(percentage) - deduction_pct)
    hard_fail = bool((proctor_eval or {}).get("hard_fail", False))
    hard_fail_reason = (proctor_eval or {}).get("hard_fail_reason")
    if hard_fail:
        final_percentage = 0.0
    passed = (final_percentage >= exam.pass_score) and not hard_fail

    attempt.status = AttemptStatus.SUBMITTED
    attempt.submitted_at = datetime.now(timezone.utc)
    attempt.score = score
    attempt.percentage = final_percentage
    attempt.passed = passed

    result = Result(
        attempt_id=attempt.id,
        student_id=current_user.id,
        exam_id=exam.id,
        score=score,
        percentage=final_percentage,
        passed=passed,
    )
    db.add(result)
    db.commit()
    db.refresh(result)
    certificate = None
    if passed and exam.certificate_enabled:
        try:
            cert = issue_certificate(db, result)
            db.commit()
            db.refresh(cert)
            certificate = certificate_payload(db, cert)
        except Exception:
            # Keep result submission successful even if certificate generation/storage is unavailable.
            db.rollback()
    return {
        "id": result.id,
        "attempt_id": result.attempt_id,
        "student_id": result.student_id,
        "exam_id": result.exam_id,
        "score": result.score,
        "percentage": result.percentage,
        "passed": result.passed,
        "correct_count": correct_count,
        "wrong_count": wrong_count,
        "total_questions": total_questions,
        "proctor_decision": (proctor_eval or {}).get("decision"),
        "proctor_probability": (proctor_eval or {}).get("final_probability"),
        "proctor_deduction_pct": deduction_pct,
        "proctor_deduction_mode": (proctor_eval or {}).get("deduction_mode"),
        "proctor_review_required": bool((proctor_eval or {}).get("review_required", False)),
        "proctor_hard_fail": hard_fail,
        "proctor_hard_fail_reason": hard_fail_reason,
        "training_feedback_status": latest_feedback.feedback_label if latest_feedback else None,
        "training_feedback_comment": latest_feedback.comment if latest_feedback else None,
        "training_feedback_count": feedback_count,
        "certificate": certificate,
    }


@router.get("/attempts/{attempt_id}/result", response_model=ResultOut)
def get_result(
    attempt_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    result = db.scalar(
        select(Result).join(ExamAttempt, ExamAttempt.id == Result.attempt_id).where(
            and_(Result.attempt_id == attempt_id, ExamAttempt.student_id == current_user.id),
        ),
    )
    if not result:
        raise HTTPException(status_code=404, detail="Result not found")
    attempt = db.get(ExamAttempt, result.attempt_id)
    proctor_session = db.scalar(
        select(ProctorSession)
        .where(ProctorSession.attempt_id == result.attempt_id)
        .order_by(ProctorSession.started_at.desc()),
    )
    proctor_eval = evaluate_proctor_session(db, proctor_session) if proctor_session else None
    latest_feedback, feedback_count = _latest_training_feedback(db, result.attempt_id)
    cert = db.scalar(select(Certificate).where(Certificate.result_id == result.id))
    if cert:
        ensure_certificate_pdf(db, cert)
        db.commit()
    return {
        "id": result.id,
        "attempt_id": result.attempt_id,
        "student_id": result.student_id,
        "exam_id": result.exam_id,
        "score": result.score,
        "percentage": result.percentage,
        "passed": result.passed,
        "correct_count": None,
        "wrong_count": None,
        "total_questions": len((attempt.assigned_question_ids or [])) if attempt else None,
        "proctor_decision": (proctor_eval or {}).get("decision"),
        "proctor_probability": (proctor_eval or {}).get("final_probability"),
        "proctor_deduction_pct": float((proctor_eval or {}).get("deduction_pct", 0.0)),
        "proctor_deduction_mode": (proctor_eval or {}).get("deduction_mode"),
        "proctor_review_required": bool((proctor_eval or {}).get("review_required", False)),
        "proctor_hard_fail": bool((proctor_eval or {}).get("hard_fail", False)),
        "proctor_hard_fail_reason": (proctor_eval or {}).get("hard_fail_reason"),
        "training_feedback_status": latest_feedback.feedback_label if latest_feedback else None,
        "training_feedback_comment": latest_feedback.comment if latest_feedback else None,
        "training_feedback_count": feedback_count,
        "certificate": certificate_payload(db, cert) if cert else None,
    }


@router.post("/attempts/{attempt_id}/proctor-training-feedback")
def save_proctor_training_feedback(
    attempt_id: int,
    payload: ProctorTrainingFeedbackCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.student_id != current_user.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    result = db.scalar(select(Result).where(Result.attempt_id == attempt_id))
    if not result:
        raise HTTPException(status_code=400, detail="Result not available yet")

    feedback_label = str(payload.training_result or "correct").strip().lower()
    if feedback_label not in {"correct", "incorrect"}:
        raise HTTPException(status_code=400, detail="training_result must be correct or incorrect")

    proctor_session = db.scalar(
        select(ProctorSession)
        .where(ProctorSession.attempt_id == attempt_id)
        .order_by(ProctorSession.started_at.desc()),
    )
    proctor_eval = evaluate_proctor_session(db, proctor_session) if proctor_session else None
    item = ProctorTrainingFeedback(
        attempt_id=attempt_id,
        result_id=result.id,
        session_id=proctor_session.id if proctor_session else None,
        actor_user_id=current_user.id,
        feedback_label=feedback_label,
        comment=(payload.comment or "").strip() or None,
        model_decision=(proctor_eval or {}).get("decision"),
        model_probability=(proctor_eval or {}).get("final_probability"),
        final_result_passed=bool(result.passed),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    _, feedback_count = _latest_training_feedback(db, attempt_id)
    return {
        "id": item.id,
        "attempt_id": item.attempt_id,
        "result_id": item.result_id,
        "session_id": item.session_id,
        "training_feedback_status": item.feedback_label,
        "training_feedback_comment": item.comment,
        "training_feedback_count": feedback_count,
        "created_at": item.created_at,
    }


@router.post("/courses/{course_id}/complete")
def complete_course(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrollment = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == course_id, Enrollment.student_id == current_user.id)),
    )
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    enrollment.progress_pct = 100
    enrollment.exam_eligible = True
    existing = db.scalar(
        select(CourseCompletion).where(and_(CourseCompletion.course_id == course_id, CourseCompletion.student_id == current_user.id)),
    )
    if not existing:
        db.add(CourseCompletion(course_id=course_id, student_id=current_user.id))
    db.commit()
    return {
        "course_id": course_id,
        "completed": True,
        "assessment_prompt": "Have you completed and are you ready for the assessment?",
        "options": ["ready_for_assessment", "replay_video", "ask_provider_question"],
    }


@router.post("/courses/{course_id}/assessment-intent")
def assessment_intent(
    course_id: int,
    ready: bool,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrollment = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == course_id, Enrollment.student_id == current_user.id)),
    )
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    exams_published = list(
        db.scalars(select(Exam).where(and_(Exam.course_id == course_id, Exam.status == ExamStatus.PUBLISHED))).all(),
    )
    total_assessments = int(
        db.scalar(select(func.count(Exam.id)).where(Exam.course_id == course_id))
        or 0,
    )

    if ready:
        if not enrollment.exam_eligible:
            return {
                "ready": False,
                "assessment_status": "locked",
                "message": "Complete the course video first to unlock assessment.",
                "exams": [],
                "total_assessments": total_assessments,
                "published_assessments": len(exams_published),
            }
        if not exams_published:
            return {
                "ready": False,
                "assessment_status": "unavailable",
                "message": "No published assessment found for this course yet. Ask provider to publish the assessment.",
                "exams": [],
                "total_assessments": total_assessments,
                "published_assessments": 0,
            }
        return {
            "ready": True,
            "assessment_status": "available",
            "message": "Proceed to assessment.",
            "exams": [{"exam_id": e.id, "title": e.title, "duration_minutes": e.duration_minutes} for e in exams_published],
            "total_assessments": total_assessments,
            "published_assessments": len(exams_published),
        }
    return {
        "ready": False,
        "assessment_status": "deferred",
        "message": "You can replay the course video or ask questions to the provider.",
        "actions": ["replay_video", "ask_provider_question"],
        "exams": [],
        "total_assessments": total_assessments,
        "published_assessments": len(exams_published),
    }


def _student_live_session_or_403(db: Session, session_id: int, student_id: int) -> tuple[LiveClassSession, Enrollment]:
    sess = db.get(LiveClassSession, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Live class session not found")
    enr = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == sess.course_id, Enrollment.student_id == student_id)),
    )
    if not enr:
        raise HTTPException(status_code=403, detail="Student is not enrolled for this course")
    return sess, enr


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


def _student_live_room_state(db: Session, sess: LiveClassSession, student_id: int) -> dict:
    course = db.get(Course, sess.course_id)
    provider = db.get(ProviderProfile, sess.provider_id)
    my_participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == student_id)),
    )
    participant_rows = db.scalars(
        select(LiveClassParticipant)
        .where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.is_present.is_(True)))
        .order_by(LiveClassParticipant.joined_at.asc()),
    ).all()
    poll_tally = _live_poll_tally(db, sess)
    my_vote = None
    if sess.active_poll_key:
        vote = db.scalar(
            select(LiveClassPollVote).where(
                and_(
                    LiveClassPollVote.session_id == sess.id,
                    LiveClassPollVote.poll_key == sess.active_poll_key,
                    LiveClassPollVote.user_id == student_id,
                ),
            ),
        )
        my_vote = int(vote.option_index) if vote else None
    return {
        "session": {
            "id": sess.id,
            "room_code": sess.room_code,
            "course_id": sess.course_id,
            "course_title": course.title if course else None,
            "provider_name": provider.display_name if provider else None,
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
                "my_vote": my_vote,
            },
        },
        "me": {
            "present": bool(my_participant.is_present) if my_participant else False,
            "raised_hand": bool(my_participant.raised_hand) if my_participant else False,
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


@router.get("/live-classes")
def student_live_classes(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrolled_course_ids = list(
        db.scalars(select(Enrollment.course_id).where(Enrollment.student_id == current_user.id)).all(),
    )
    if not enrolled_course_ids:
        return {"items": []}
    courses = {c.id: c for c in db.scalars(select(Course).where(Course.id.in_(enrolled_course_ids))).all()}
    rows = db.scalars(
        select(LiveClassSession)
        .where(LiveClassSession.course_id.in_(enrolled_course_ids))
        .order_by(LiveClassSession.scheduled_start_at.desc(), LiveClassSession.id.desc()),
    ).all()
    my_participation = {
        int(p.session_id): p
        for p in db.scalars(
            select(LiveClassParticipant).where(
                and_(
                    LiveClassParticipant.user_id == current_user.id,
                    LiveClassParticipant.session_id.in_([int(s.id) for s in rows]) if rows else False,
                ),
            ),
        ).all()
    }
    items = []
    for sess in rows:
        course = courses.get(sess.course_id)
        participant_count = int(
            db.scalar(
                select(func.count(LiveClassParticipant.id)).where(
                    and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.is_present.is_(True)),
                ),
            )
            or 0
        )
        mine = my_participation.get(int(sess.id))
        items.append(
            {
                "session_id": sess.id,
                "course_id": sess.course_id,
                "course_title": course.title if course else None,
                "title": sess.title,
                "description": sess.description,
                "status": sess.status,
                "scheduled_start_at": sess.scheduled_start_at,
                "scheduled_end_at": sess.scheduled_end_at,
                "meeting_mode": sess.meeting_mode,
                "external_meeting_url": sess.external_meeting_url,
                "participant_count": participant_count,
                "joined": bool(mine and mine.is_present),
            },
        )
    return {"items": items}


@router.post("/live-classes/{session_id}/join")
def join_live_class_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    if sess.status in {"ended", "cancelled"}:
        raise HTTPException(status_code=400, detail="This live class is no longer active")
    participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == current_user.id)),
    )
    now = datetime.now(timezone.utc)
    if not participant:
        participant = LiveClassParticipant(
            session_id=sess.id,
            user_id=current_user.id,
            actor_role="student",
            display_name=current_user.full_name or current_user.email,
            is_present=True,
            raised_hand=False,
            joined_at=now,
            last_seen_at=now,
            left_at=None,
        )
        db.add(participant)
    else:
        participant.is_present = True
        participant.left_at = None
        participant.last_seen_at = now
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="student",
            message_type="system",
            content=f"{current_user.full_name} joined the class.",
            payload_json={},
        ),
    )
    db.commit()
    return {"joined": True, "room_state": _student_live_room_state(db, sess, current_user.id)}


@router.post("/live-classes/{session_id}/leave")
def leave_live_class_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == current_user.id)),
    )
    if participant:
        participant.is_present = False
        participant.raised_hand = False
        participant.left_at = datetime.now(timezone.utc)
        participant.last_seen_at = datetime.now(timezone.utc)
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="student",
            message_type="system",
            content=f"{current_user.full_name} left the class.",
            payload_json={},
        ),
    )
    db.commit()
    return {"left": True}


@router.get("/live-classes/{session_id}/room-state")
def student_live_room_state(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    return _student_live_room_state(db, sess, current_user.id)


@router.get("/live-classes/{session_id}/messages")
def student_live_messages(
    session_id: int,
    after_id: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
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


@router.post("/live-classes/{session_id}/messages")
def student_send_live_message(
    session_id: int,
    payload: LiveClassMessageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    if sess.status in {"ended", "cancelled"}:
        raise HTTPException(status_code=400, detail="This live class has already ended")
    mtype = str(payload.message_type or "chat").strip().lower()
    if mtype not in {"chat", "reaction"}:
        raise HTTPException(status_code=400, detail="Invalid message type")
    if mtype == "chat" and not sess.allow_chat:
        raise HTTPException(status_code=400, detail="Chat is disabled for this class")
    if mtype == "reaction" and not sess.allow_reactions:
        raise HTTPException(status_code=400, detail="Reactions are disabled for this class")
    text = str(payload.content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message content is required")
    row = LiveClassMessage(
        session_id=sess.id,
        user_id=current_user.id,
        actor_name=current_user.full_name,
        actor_role="student",
        message_type=mtype,
        content=text,
        payload_json=payload.payload or {},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"message_id": row.id}


@router.post("/live-classes/{session_id}/raise-hand")
def student_raise_hand(
    session_id: int,
    raised: bool | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    if not sess.allow_raise_hand:
        raise HTTPException(status_code=400, detail="Raise hand is disabled for this class")
    participant = db.scalar(
        select(LiveClassParticipant).where(and_(LiveClassParticipant.session_id == sess.id, LiveClassParticipant.user_id == current_user.id)),
    )
    now = datetime.now(timezone.utc)
    if not participant:
        participant = LiveClassParticipant(
            session_id=sess.id,
            user_id=current_user.id,
            actor_role="student",
            display_name=current_user.full_name or current_user.email,
            is_present=True,
            joined_at=now,
            last_seen_at=now,
        )
        db.add(participant)
    participant.raised_hand = (not bool(participant.raised_hand)) if raised is None else bool(raised)
    participant.last_seen_at = now
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="student",
            message_type="system",
            content=f"{current_user.full_name} {'raised' if participant.raised_hand else 'lowered'} hand.",
            payload_json={"raised_hand": bool(participant.raised_hand)},
        ),
    )
    db.commit()
    return {"raised_hand": bool(participant.raised_hand)}


@router.post("/live-classes/{session_id}/poll-vote")
def student_poll_vote(
    session_id: int,
    payload: LiveClassPollVoteCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    sess, _ = _student_live_session_or_403(db, session_id, current_user.id)
    if not sess.active_poll_open or not sess.active_poll_key:
        raise HTTPException(status_code=400, detail="No active poll")
    options = list(sess.active_poll_options_json or [])
    if payload.option_index < 0 or payload.option_index >= len(options):
        raise HTTPException(status_code=400, detail="Invalid poll option")
    vote = db.scalar(
        select(LiveClassPollVote).where(
            and_(
                LiveClassPollVote.session_id == sess.id,
                LiveClassPollVote.poll_key == sess.active_poll_key,
                LiveClassPollVote.user_id == current_user.id,
            ),
        ),
    )
    if not vote:
        vote = LiveClassPollVote(
            session_id=sess.id,
            poll_key=sess.active_poll_key,
            user_id=current_user.id,
            option_index=payload.option_index,
        )
        db.add(vote)
    else:
        vote.option_index = payload.option_index
    db.add(
        LiveClassMessage(
            session_id=sess.id,
            user_id=current_user.id,
            actor_name=current_user.full_name,
            actor_role="student",
            message_type="poll_vote",
            content=f"{current_user.full_name} voted.",
            payload_json={"option_index": int(payload.option_index)},
        ),
    )
    db.commit()
    tally = _live_poll_tally(db, sess)
    return {"saved": True, "tally": tally}


@router.post("/courses/{course_id}/comments")
def add_course_comment(
    course_id: int,
    payload: CourseCommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    enrollment = db.scalar(
        select(Enrollment).where(and_(Enrollment.course_id == course_id, Enrollment.student_id == current_user.id)),
    )
    if not enrollment:
        raise HTTPException(status_code=403, detail="Student not enrolled")
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    comment = CourseComment(course_id=course_id, student_id=current_user.id, message=payload.message)
    db.add(comment)
    db.flush()
    provider = db.get(ProviderProfile, course.provider_id)
    if provider:
        db.add(
            ProviderNotification(
                provider_id=provider.id,
                event_type="student_comment",
                message=f"New comment on course '{course.title}'",
                ref_type="course_comment",
                ref_id=comment.id,
                is_read=False,
            ),
        )
    db.commit()
    db.refresh(comment)
    return comment


@router.post("/courses/{course_id}/feedback")
def add_course_feedback(
    course_id: int,
    payload: CourseFeedbackCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT)),
):
    completion = db.scalar(
        select(CourseCompletion).where(and_(CourseCompletion.course_id == course_id, CourseCompletion.student_id == current_user.id)),
    )
    if not completion:
        raise HTTPException(status_code=400, detail="Course must be completed before feedback")
    existing = db.scalar(
        select(CourseFeedback).where(and_(CourseFeedback.course_id == course_id, CourseFeedback.student_id == current_user.id)),
    )
    if existing:
        existing.valuable_time_rating = payload.valuable_time_rating
        existing.content_quality_rating = payload.content_quality_rating
        existing.instructor_clarity_rating = payload.instructor_clarity_rating
        existing.practical_usefulness_rating = payload.practical_usefulness_rating
        existing.comment = payload.comment
        feedback = existing
    else:
        feedback = CourseFeedback(course_id=course_id, student_id=current_user.id, **payload.model_dump())
        db.add(feedback)
    db.commit()
    db.refresh(feedback)
    return feedback
