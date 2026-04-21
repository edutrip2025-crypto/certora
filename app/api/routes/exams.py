from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import get_db
from app.models.entities import (
    Course,
    CourseModule,
    Exam,
    ExamRule,
    ExamStatus,
    Option,
    ProviderProfile,
    Question,
    QuestionType,
    User,
    UserRole,
)
from app.schemas import ExamCreate, ExamOut, ExamRuleUpdate, ExamUpdate, QuestionCreate
from app.services.ai_review import upsert_ai_review
from app.services.rule_engine import evaluate_exam_rules

router = APIRouter(prefix="/exams", tags=["exams"])


def _provider_profile_or_404(db: Session, user_id: int) -> ProviderProfile:
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == user_id))
    if not profile:
        raise HTTPException(status_code=404, detail="Provider profile not found")
    return profile


def _provider_exam_or_403(db: Session, exam_id: int, current_user: User) -> tuple[ProviderProfile, Exam, Course]:
    profile = _provider_profile_or_404(db, current_user.id)
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    course = db.get(Course, exam.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")
    return profile, exam, course


@router.post("", response_model=ExamOut, status_code=status.HTTP_201_CREATED)
def create_exam(
    payload: ExamCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    course = db.get(Course, payload.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=404, detail="Course not found")
    if payload.timing_mode not in {"assessment", "question"}:
        raise HTTPException(status_code=400, detail="timing_mode must be 'assessment' or 'question'")
    if payload.timing_mode == "question" and (payload.time_per_question_seconds is None or payload.time_per_question_seconds <= 0):
        raise HTTPException(status_code=400, detail="time_per_question_seconds is required for question timing mode")
    if payload.timing_mode == "assessment" and payload.duration_minutes <= 0:
        raise HTTPException(status_code=400, detail="duration_minutes must be greater than 0")
    if payload.questions_per_attempt < 0:
        raise HTTPException(status_code=400, detail="questions_per_attempt cannot be negative")
    try:
        exam = Exam(**payload.model_dump())
        db.add(exam)
        db.flush()
        db.add(ExamRule(exam_id=exam.id))
        db.commit()
        db.refresh(exam)
        return exam
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create exam: {exc.__class__.__name__}") from exc


@router.put("/{exam_id}", response_model=ExamOut)
def update_exam(
    exam_id: int,
    payload: ExamUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _, exam, _ = _provider_exam_or_403(db, exam_id, current_user)
    if exam.status == ExamStatus.PUBLISHED:
        raise HTTPException(status_code=400, detail="Published exam cannot be edited")

    data = payload.model_dump(exclude_unset=True)
    timing_mode = data.get("timing_mode", exam.timing_mode)
    duration_minutes = data.get("duration_minutes", exam.duration_minutes)
    time_per_question_seconds = data.get("time_per_question_seconds", exam.time_per_question_seconds)
    questions_per_attempt = data.get("questions_per_attempt", exam.questions_per_attempt)

    if timing_mode not in {"assessment", "question"}:
        raise HTTPException(status_code=400, detail="timing_mode must be 'assessment' or 'question'")
    if timing_mode == "assessment" and (duration_minutes is None or duration_minutes <= 0):
        raise HTTPException(status_code=400, detail="duration_minutes must be greater than 0")
    if timing_mode == "question" and (time_per_question_seconds is None or time_per_question_seconds <= 0):
        raise HTTPException(status_code=400, detail="time_per_question_seconds is required for question timing mode")
    if questions_per_attempt is not None and questions_per_attempt < 0:
        raise HTTPException(status_code=400, detail="questions_per_attempt cannot be negative")

    try:
        for key, value in data.items():
            setattr(exam, key, value)
        db.commit()
        db.refresh(exam)
        return exam
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update exam: {exc.__class__.__name__}") from exc


@router.delete("/{exam_id}")
def delete_exam(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _, exam, _ = _provider_exam_or_403(db, exam_id, current_user)
    if exam.status == ExamStatus.PUBLISHED:
        raise HTTPException(status_code=400, detail="Published exam cannot be deleted")
    question_ids = list(db.scalars(select(Question.id).where(Question.exam_id == exam.id)).all())
    if question_ids:
        db.execute(delete(Option).where(Option.question_id.in_(question_ids)))
        db.execute(delete(Question).where(Question.id.in_(question_ids)))
    db.execute(delete(ExamRule).where(ExamRule.exam_id == exam.id))
    db.delete(exam)
    db.commit()
    return {"deleted": True, "exam_id": exam_id}


@router.post("/{exam_id}/rule")
def update_exam_rule(
    exam_id: int,
    payload: ExamRuleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    course = db.get(Course, exam.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        rule = db.scalar(select(ExamRule).where(ExamRule.exam_id == exam.id))
        if not rule:
            rule = ExamRule(exam_id=exam.id)
            db.add(rule)
        for key, value in payload.model_dump().items():
            setattr(rule, key, value)
        db.commit()
        db.refresh(rule)
        return rule
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save exam rule: {exc.__class__.__name__}") from exc


@router.post("/{exam_id}/questions")
def add_question(
    exam_id: int,
    payload: QuestionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    course = db.get(Course, exam.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")

    if payload.question_type != QuestionType.SHORT_ANSWER and not payload.options:
        raise HTTPException(status_code=400, detail="MCQ question requires options")

    try:
        question = Question(
            exam_id=exam.id,
            question_text=payload.question_text,
            question_type=payload.question_type,
            marks=payload.marks,
            negative_marks=payload.negative_marks,
        )
        db.add(question)
        db.flush()
        created_options: list[dict] = []
        for opt in payload.options:
            option = Option(
                question_id=question.id,
                option_text=opt.option_text,
                is_correct=opt.is_correct,
                position=opt.position,
            )
            db.add(option)
            db.flush()
            created_options.append({"id": option.id, "is_correct": option.is_correct})
        db.commit()
        db.refresh(question)

        exam.total_marks = db.scalar(select(func.coalesce(func.sum(Question.marks), 0)).where(Question.exam_id == exam.id))
        db.commit()
        return {"question_id": question.id, "options": created_options}
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to add question: {exc.__class__.__name__}") from exc


@router.get("/{exam_id}/questions")
def list_questions(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _, exam, _ = _provider_exam_or_403(db, exam_id, current_user)
    questions = list(db.scalars(select(Question).where(Question.exam_id == exam.id)).all())
    out = []
    for q in questions:
        options = list(db.scalars(select(Option).where(Option.question_id == q.id).order_by(Option.position)).all())
        out.append(
            {
                "question_id": q.id,
                "question_text": q.question_text,
                "question_type": q.question_type,
                "marks": q.marks,
                "negative_marks": q.negative_marks,
                "options": [
                    {"option_id": o.id, "option_text": o.option_text, "is_correct": o.is_correct, "position": o.position}
                    for o in options
                ],
            },
        )
    return out


@router.delete("/{exam_id}/questions/{question_id}")
def delete_question(
    exam_id: int,
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _, exam, _ = _provider_exam_or_403(db, exam_id, current_user)
    if exam.status == ExamStatus.PUBLISHED:
        raise HTTPException(status_code=400, detail="Published exam cannot be edited")
    question = db.get(Question, question_id)
    if not question or question.exam_id != exam.id:
        raise HTTPException(status_code=404, detail="Question not found")
    db.delete(question)
    db.flush()
    exam.total_marks = db.scalar(select(func.coalesce(func.sum(Question.marks), 0)).where(Question.exam_id == exam.id))
    db.commit()
    return {"deleted": True, "question_id": question_id}


@router.post("/{exam_id}/ai-review/request")
def request_ai_review(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    settings = get_settings()
    if not settings.enable_ai_review:
        return {"enabled": False, "status": "skipped", "message": "AI review is disabled for this phase."}

    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")

    if current_user.role == UserRole.PROVIDER:
        profile = _provider_profile_or_404(db, current_user.id)
        course = db.get(Course, exam.course_id)
        if not course or course.provider_id != profile.id:
            raise HTTPException(status_code=403, detail="Access denied")

    exam.status = ExamStatus.IN_REVIEW
    review = upsert_ai_review(db, exam)
    db.commit()
    return {
        "status": review.status,
        "clarity_score": review.clarity_score,
        "certification_readiness_score": review.certification_readiness_score,
        "summary": review.summary,
        "flags": review.flags_json,
    }


@router.get("/{exam_id}/ai-review")
def get_ai_review(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    settings = get_settings()
    if not settings.enable_ai_review:
        return {"enabled": False, "status": "skipped", "message": "AI review is disabled for this phase."}

    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    review = upsert_ai_review(db, exam)
    db.commit()
    return review


@router.post("/{exam_id}/publish", response_model=ExamOut)
def publish_exam(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    settings = get_settings()
    profile = _provider_profile_or_404(db, current_user.id)
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    course = db.get(Course, exam.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")

    if settings.enable_ai_review:
        upsert_ai_review(db, exam)
    total_questions = db.scalar(select(func.count(Question.id)).where(Question.exam_id == exam.id)) or 0
    if total_questions <= 0:
        raise HTTPException(status_code=400, detail="At least one question is required")
    if exam.questions_per_attempt and exam.questions_per_attempt > total_questions:
        raise HTTPException(
            status_code=400,
            detail=f"questions_per_attempt ({exam.questions_per_attempt}) cannot exceed total questions ({total_questions})",
        )
    check = evaluate_exam_rules(db, exam)
    if not check.approved:
        exam.status = ExamStatus.REJECTED
        db.commit()
        raise HTTPException(status_code=400, detail={"message": "Rule check failed", "reasons": check.reasons})

    exam.status = ExamStatus.PUBLISHED
    db.commit()
    db.refresh(exam)
    return exam


@router.get("/{exam_id}/syllabus-map")
def syllabus_map(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    modules = list(db.scalars(select(CourseModule).where(CourseModule.course_id == exam.course_id)).all())
    questions = list(db.scalars(select(Question).where(Question.exam_id == exam.id)).all())
    result = []
    for module in modules:
        matches = [q.id for q in questions if module.title.lower() in q.question_text.lower()]
        result.append({"module_id": module.id, "module_title": module.title, "question_matches": matches})
    return result
