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
    ProctorTrainingFeedbackCreate,
    ResultOut,
)
from app.services.scoring import score_attempt
from app.services.proctoring_ai import evaluate_proctor_session
from app.services.certificates import certificate_payload, ensure_certificate_pdf, issue_certificate

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

    total_enrolled = len(enrolled_rows)
    completed_count = sum(1 for enr, _ in enrolled_rows if (enr.progress_pct or 0) >= 100)
    avg_progress = round(sum((enr.progress_pct or 0) for enr, _ in enrolled_rows) / total_enrolled, 2) if total_enrolled else 0
    eligible_count = sum(1 for enr, _ in enrolled_rows if enr.exam_eligible)
    certificates_issued = db.scalar(select(func.count(Certificate.id)).where(Certificate.student_id == current_user.id)) or 0

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
                    "recorded_video_url": lesson.recorded_video_url,
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
    return {
        "id": course.id,
        "title": course.title,
        "description": course.description,
        "category": course.category,
        "thumbnail_url": course.thumbnail_url,
        "progress_pct": enrollment.progress_pct,
        "exam_eligible": enrollment.exam_eligible,
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
    for cert in items:
        ensure_certificate_pdf(db, cert)
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
        cert = issue_certificate(db, result)
        db.commit()
        db.refresh(cert)
        certificate = certificate_payload(db, cert)
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
    if ready:
        exams = list(db.scalars(select(Exam).where(and_(Exam.course_id == course_id, Exam.status == ExamStatus.PUBLISHED))).all())
        return {
            "ready": True,
            "message": "Proceed to assessment.",
            "exams": [{"exam_id": e.id, "title": e.title, "duration_minutes": e.duration_minutes} for e in exams],
        }
    return {
        "ready": False,
        "message": "You can replay the course video or ask questions to the provider.",
        "actions": ["replay_video", "ask_provider_question"],
    }


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
