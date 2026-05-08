from datetime import datetime, timedelta, timezone

import random
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from jose import jwt
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import require_role
from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.db.session import get_db
from app.models.entities import (
    AssessmentIssue,
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
from app.services.notifications import send_email
from app.services.rule_engine import evaluate_exam_rules

router = APIRouter(prefix="/exams", tags=["exams"])
ALLOWED_QUESTIONS_PER_ATTEMPT = {25, 30, 35, 40}
ALLOWED_TIME_PER_QUESTION_SECONDS = {25, 30, 35, 40, 45}
STANDALONE_ASSESSMENT_CATEGORY = "__standalone_assessment__"
ISSUED_TOKEN_ROLE = "issued_candidate"


def _sync_pk_sequence_if_needed(db: Session, table_name: str, pk_col: str = "id") -> None:
    # PostgreSQL-safe sequence heal: set sequence to current MAX(id)
    # so next INSERT uses a free primary key.
    db.execute(
        text(
            f"""
            SELECT setval(
              pg_get_serial_sequence('{table_name}', '{pk_col}'),
              COALESCE((SELECT MAX({pk_col}) FROM {table_name}), 1),
              true
            )
            """,
        ),
    )


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


def _get_or_create_standalone_course(db: Session, profile: ProviderProfile) -> Course:
    existing = db.scalar(
        select(Course).where(
            Course.provider_id == profile.id,
            Course.category == STANDALONE_ASSESSMENT_CATEGORY,
        ),
    )
    if existing:
        return existing
    course = Course(
        provider_id=profile.id,
        title="Standalone Assessments",
        description="Hidden course container for standalone assessments.",
        category=STANDALONE_ASSESSMENT_CATEGORY,
        suitable_age_ranges=[],
        is_published=False,
    )
    db.add(course)
    db.flush()
    return course


class IssueAssessmentRequest(BaseModel):
    candidate_name: str = Field(min_length=2, max_length=200)
    candidate_email: EmailStr


class IssuedCandidateLoginRequest(BaseModel):
    email: EmailStr | None = None
    password: str = Field(min_length=6, max_length=120)


class IssuedCandidateSubmitRequest(BaseModel):
    answers: dict[str, list[int] | int | None]


def _create_issued_candidate_token(issue_id: int) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": f"assessment_issue:{issue_id}",
        "role": ISSUED_TOKEN_ROLE,
        "issue_id": issue_id,
        "exp": now.timestamp() + (60 * 60 * 8),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def _decode_issued_candidate_token(token: str) -> int:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid issued-candidate token") from exc
    if payload.get("role") != ISSUED_TOKEN_ROLE:
        raise HTTPException(status_code=403, detail="Invalid token role")
    issue_id = int(payload.get("issue_id") or 0)
    if issue_id <= 0:
        raise HTTPException(status_code=401, detail="Invalid issued-candidate token payload")
    return issue_id


def _internal_assessment_id(exam_id: int) -> str:
    return f"ASM-{int(exam_id):06d}"


def _is_expired(value: datetime | None) -> bool:
    if not value:
        return False
    expires_at = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return expires_at < datetime.now(timezone.utc)


def _questions_for_issued_attempt(db: Session, issue: AssessmentIssue, exam: Exam) -> list[Question]:
    questions = list(db.scalars(select(Question).where(Question.exam_id == exam.id).order_by(Question.id.asc())).all())
    limit = int(exam.questions_per_attempt or 0)
    if limit <= 0 or limit >= len(questions):
        return questions
    shuffled = list(questions)
    random.Random(int(issue.id)).shuffle(shuffled)
    selected_ids = {q.id for q in shuffled[:limit]}
    return [q for q in questions if q.id in selected_ids]


def _safe_send_assessment_issue_email(
    *,
    to_email: str,
    candidate_name: str,
    assessment_title: str,
    login_link: str,
    temporary_password: str,
    expires_at: datetime | None,
) -> dict:
    subject = f"Assessment issued: {assessment_title}"
    expiry_text = expires_at.isoformat() if expires_at else "7 days from issue"
    body = (
        f"Hello {candidate_name},\n\n"
        f"You have been issued the assessment: {assessment_title}.\n\n"
        f"Assessment link: {login_link}\n"
        f"One-time password: {temporary_password}\n"
        f"Credentials expire: {expiry_text}\n\n"
        "Open the link, enter the password, and complete the assessment in one sitting.\n"
    )
    try:
        return send_email(to_email, subject, body)
    except Exception as exc:
        return {"sent": False, "reason": str(exc)}


@router.post("", response_model=ExamOut, status_code=status.HTTP_201_CREATED)
def create_exam(
    payload: ExamCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    if int(payload.course_id or 0) <= 0:
        course = _get_or_create_standalone_course(db, profile)
        payload.course_id = int(course.id)
    else:
        course = db.get(Course, payload.course_id)
        if not course or course.provider_id != profile.id:
            raise HTTPException(status_code=404, detail="Course not found")
    if payload.timing_mode not in {"assessment", "question"}:
        raise HTTPException(status_code=400, detail="timing_mode must be 'assessment' or 'question'")
    if float(payload.pass_score) < 70:
        raise HTTPException(status_code=400, detail="pass_score must be at least 70")
    if int(payload.max_attempts) < 1 or int(payload.max_attempts) > 3:
        raise HTTPException(status_code=400, detail="max_attempts must be between 1 and 3")
    if payload.timing_mode == "question":
        if payload.time_per_question_seconds is None:
            raise HTTPException(status_code=400, detail="time_per_question_seconds is required for question timing mode")
        if payload.time_per_question_seconds not in ALLOWED_TIME_PER_QUESTION_SECONDS:
            raise HTTPException(status_code=400, detail="time_per_question_seconds must be one of: 25, 30, 35, 40, 45")
    if payload.timing_mode == "assessment" and payload.duration_minutes <= 0:
        raise HTTPException(status_code=400, detail="duration_minutes must be greater than 0")
    if payload.questions_per_attempt not in ALLOWED_QUESTIONS_PER_ATTEMPT:
        raise HTTPException(status_code=400, detail="questions_per_attempt must be one of: 25, 30, 35, 40")
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
    pass_score = data.get("pass_score", exam.pass_score)
    max_attempts = data.get("max_attempts", exam.max_attempts)
    if pass_score is not None and float(pass_score) < 70:
        raise HTTPException(status_code=400, detail="pass_score must be at least 70")
    if max_attempts is not None and (int(max_attempts) < 1 or int(max_attempts) > 3):
        raise HTTPException(status_code=400, detail="max_attempts must be between 1 and 3")
    if timing_mode == "assessment" and (duration_minutes is None or duration_minutes <= 0):
        raise HTTPException(status_code=400, detail="duration_minutes must be greater than 0")
    if timing_mode == "question":
        if time_per_question_seconds is None:
            raise HTTPException(status_code=400, detail="time_per_question_seconds is required for question timing mode")
        if int(time_per_question_seconds) not in ALLOWED_TIME_PER_QUESTION_SECONDS:
            raise HTTPException(status_code=400, detail="time_per_question_seconds must be one of: 25, 30, 35, 40, 45")
    if questions_per_attempt is not None and int(questions_per_attempt) not in ALLOWED_QUESTIONS_PER_ATTEMPT:
        raise HTTPException(status_code=400, detail="questions_per_attempt must be one of: 25, 30, 35, 40")

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
    cleaned_options = []
    for idx, opt in enumerate(payload.options or [], start=1):
        text_val = str(opt.option_text or "").strip()
        if not text_val:
            continue
        cleaned_options.append(
            {
                "option_text": text_val,
                "is_correct": bool(opt.is_correct),
                "position": int(opt.position or idx),
            },
        )
    if payload.question_type != QuestionType.SHORT_ANSWER and len(cleaned_options) < 2:
        raise HTTPException(status_code=400, detail="MCQ question requires at least 2 non-empty options")
    if payload.question_type == QuestionType.MCQ_SINGLE and sum(1 for o in cleaned_options if o["is_correct"]) != 1:
        raise HTTPException(status_code=400, detail="Single correct MCQ needs exactly 1 correct option")
    if payload.question_type == QuestionType.MCQ_MULTI and sum(1 for o in cleaned_options if o["is_correct"]) < 1:
        raise HTTPException(status_code=400, detail="Multiple correct MCQ needs at least 1 correct option")

    def _insert_question_and_options() -> dict:
        # Store enum member name in DB for compatibility with legacy enum column sizing/values.
        qtype_db_value = payload.question_type.name if hasattr(payload.question_type, "name") else str(payload.question_type)
        question = Question(
            exam_id=exam.id,
            question_text=payload.question_text,
            question_type=qtype_db_value,
            marks=payload.marks,
            negative_marks=payload.negative_marks,
        )
        db.add(question)
        db.flush()
        created_options: list[dict] = []
        for opt in cleaned_options:
            option = Option(
                question_id=question.id,
                option_text=opt["option_text"],
                is_correct=opt["is_correct"],
                position=opt["position"],
            )
            db.add(option)
            db.flush()
            created_options.append({"id": option.id, "is_correct": option.is_correct})
        db.commit()
        db.refresh(question)
        exam.total_marks = db.scalar(select(func.coalesce(func.sum(Question.marks), 0)).where(Question.exam_id == exam.id))
        db.commit()
        return {"question_id": question.id, "options": created_options}

    try:
        return _insert_question_and_options()
    except IntegrityError as exc:
        db.rollback()
        detail = str(getattr(exc, "orig", exc))
        # Auto-heal PK sequence drift and retry once.
        if "duplicate key value violates unique constraint" in detail and ("options_pkey" in detail or "questions_pkey" in detail):
            _sync_pk_sequence_if_needed(db, "options")
            _sync_pk_sequence_if_needed(db, "questions")
            try:
                return _insert_question_and_options()
            except IntegrityError as retry_exc:
                db.rollback()
                retry_detail = str(getattr(retry_exc, "orig", retry_exc))
                raise HTTPException(status_code=400, detail=f"Failed to add question after sequence sync: {retry_detail}") from retry_exc
        raise HTTPException(status_code=400, detail=f"Failed to add question: {detail}") from exc
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


@router.post("/{exam_id}/issue")
def issue_assessment_to_candidate(
    exam_id: int,
    payload: IssueAssessmentRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    _provider_profile_or_404(db, current_user.id)
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    if exam.status != ExamStatus.PUBLISHED:
        raise HTTPException(status_code=400, detail="Only published assessments can be issued")

    candidate_email = str(payload.candidate_email).strip().lower()
    candidate_name = str(payload.candidate_name).strip()
    temp_password = secrets.token_urlsafe(8)
    issue = AssessmentIssue(
        exam_id=exam.id,
        issuer_user_id=current_user.id,
        candidate_user_id=None,
        candidate_name=candidate_name,
        candidate_email=candidate_email,
        candidate_password_hash=hash_password(temp_password),
        access_key=secrets.token_urlsafe(24),
        access_expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        status="issued",
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)
    base_url = f"{request.url.scheme}://{request.headers.get('host')}"
    login_link = f"{base_url}/?issued_key={issue.access_key}"
    email_delivery = _safe_send_assessment_issue_email(
        to_email=candidate_email,
        candidate_name=candidate_name,
        assessment_title=exam.title,
        login_link=login_link,
        temporary_password=temp_password,
        expires_at=issue.access_expires_at,
    )
    return {
        "issued_id": issue.id,
        "exam_id": exam.id,
        "internal_id": _internal_assessment_id(exam.id),
        "candidate_email": candidate_email,
        "temporary_password": temp_password,
        "login_link": login_link,
        "credentials_valid_till": issue.access_expires_at,
        "email_delivery": email_delivery,
        "note": "Credentials were emailed when SMTP is configured. Keep the temporary password visible here as fallback.",
    }


@router.get("/issued/by-me")
def list_issued_assessments_for_provider(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    rows = db.scalars(
        select(AssessmentIssue)
        .where(AssessmentIssue.issuer_user_id == current_user.id)
        .order_by(AssessmentIssue.id.desc()),
    ).all()
    out = []
    for row in rows:
        exam = db.get(Exam, row.exam_id)
        out.append(
            {
                "issued_id": row.id,
                "exam_id": row.exam_id,
                "internal_id": _internal_assessment_id(row.exam_id),
                "assessment_title": exam.title if exam else f"Assessment #{row.exam_id}",
                "candidate_name": row.candidate_name,
                "candidate_email": row.candidate_email,
                "status": row.status,
                "score_pct": row.score_pct,
                "passed": row.passed,
                "issued_at": row.issued_at,
                "access_expires_at": row.access_expires_at,
                "completed_at": row.completed_at,
            },
        )
    return out


@router.get("/catalog/published")
def list_published_assessment_catalog(
    q: str = Query(default="", max_length=120),
    duration: str = Query(default="all", pattern="^(all|short|standard|long)$"),
    sort: str = Query(default="latest", pattern="^(latest|title_asc|duration_asc|pass_desc|popular)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    rows = list(db.scalars(
        select(Exam)
        .where(Exam.status == ExamStatus.PUBLISHED)
        .order_by(Exam.id.desc()),
    ).all())
    needle = str(q or "").strip().lower()
    if needle:
        rows = [
            exam for exam in rows
            if needle in (exam.title or "").lower()
            or needle in _internal_assessment_id(exam.id).lower()
        ]
    if duration == "short":
        rows = [exam for exam in rows if int(exam.duration_minutes or 0) <= 30]
    elif duration == "standard":
        rows = [exam for exam in rows if 30 < int(exam.duration_minutes or 0) <= 45]
    elif duration == "long":
        rows = [exam for exam in rows if int(exam.duration_minutes or 0) > 45]

    issued_counts = {
        int(row._mapping["exam_id"]): int(row._mapping["count"] or 0)
        for row in db.execute(
            select(AssessmentIssue.exam_id, func.count(AssessmentIssue.id).label("count"))
            .where(AssessmentIssue.issuer_user_id == current_user.id)
            .group_by(AssessmentIssue.exam_id),
        ).all()
    }
    taken_counts = {
        int(row._mapping["exam_id"]): int(row._mapping["count"] or 0)
        for row in db.execute(
            select(AssessmentIssue.exam_id, func.count(AssessmentIssue.id).label("count"))
            .where(
                AssessmentIssue.issuer_user_id == current_user.id,
                AssessmentIssue.status == "completed",
            )
            .group_by(AssessmentIssue.exam_id),
        ).all()
    }
    question_counts = {
        int(row._mapping["exam_id"]): int(row._mapping["count"] or 0)
        for row in db.execute(
            select(Question.exam_id, func.count(Question.id).label("count"))
            .group_by(Question.exam_id),
        ).all()
    }

    if sort == "title_asc":
        rows.sort(key=lambda exam: (exam.title or "").lower())
    elif sort == "duration_asc":
        rows.sort(key=lambda exam: int(exam.duration_minutes or 0))
    elif sort == "pass_desc":
        rows.sort(key=lambda exam: float(exam.pass_score or 70), reverse=True)
    elif sort == "popular":
        rows.sort(key=lambda exam: issued_counts.get(int(exam.id), 0), reverse=True)
    else:
        rows.sort(key=lambda exam: int(exam.id), reverse=True)

    out = []
    for exam in rows:
        question_count = question_counts.get(int(exam.id), 0)
        out.append(
            {
                "exam_id": exam.id,
                "internal_id": _internal_assessment_id(exam.id),
                "title": exam.title,
                "duration_minutes": exam.duration_minutes,
                "timing_mode": getattr(exam, "timing_mode", None),
                "time_per_question_seconds": getattr(exam, "time_per_question_seconds", None),
                "pass_score": exam.pass_score,
                "questions_per_attempt": exam.questions_per_attempt,
                "question_count": question_count,
                "issued_count": issued_counts.get(int(exam.id), 0),
                "taken_count": taken_counts.get(int(exam.id), 0),
            },
        )
    return out


@router.post("/issued/login")
def issued_candidate_login(payload: IssuedCandidateLoginRequest, db: Session = Depends(get_db)):
    if not payload.email:
        raise HTTPException(status_code=400, detail="Email is required")
    email = str(payload.email).strip().lower()
    issue = db.scalar(
        select(AssessmentIssue)
        .where(AssessmentIssue.candidate_email == email)
        .order_by(AssessmentIssue.id.desc()),
    )
    if not issue or not verify_password(payload.password, issue.candidate_password_hash):
        raise HTTPException(status_code=401, detail="Invalid issued assessment credentials")
    now = datetime.now(timezone.utc)
    if _is_expired(issue.access_expires_at):
        raise HTTPException(status_code=401, detail="Credentials expired. Ask issuer for re-issue.")
    if issue.credential_used_at:
        raise HTTPException(status_code=401, detail="Credentials already used. Ask issuer for re-issue.")
    issue.credential_used_at = now
    if issue.status == "issued":
        issue.status = "started"
        issue.started_at = now
    db.add(issue)
    db.commit()
    token = _create_issued_candidate_token(issue.id)
    return {"token": token}


@router.post("/issued/key/{access_key}/login")
def issued_candidate_login_by_key(access_key: str, payload: IssuedCandidateLoginRequest, db: Session = Depends(get_db)):
    issue = db.scalar(select(AssessmentIssue).where(AssessmentIssue.access_key == access_key))
    if not issue or not verify_password(payload.password, issue.candidate_password_hash):
        raise HTTPException(status_code=401, detail="Invalid issued assessment credentials")
    now = datetime.now(timezone.utc)
    if _is_expired(issue.access_expires_at):
        raise HTTPException(status_code=401, detail="Credentials expired. Ask issuer for re-issue.")
    if issue.credential_used_at:
        raise HTTPException(status_code=401, detail="Credentials already used. Ask issuer for re-issue.")
    issue.credential_used_at = now
    if issue.status == "issued":
        issue.status = "started"
        issue.started_at = now
    db.add(issue)
    db.commit()
    token = _create_issued_candidate_token(issue.id)
    return {"token": token}


@router.get("/issued/me")
def issued_candidate_get_assessment(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    issue_id = _decode_issued_candidate_token(token)
    issue = db.get(AssessmentIssue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issued assessment not found")
    exam = db.get(Exam, issue.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if issue.status == "completed":
        return {"status": "completed", "score_pct": issue.score_pct, "passed": issue.passed}
    questions = _questions_for_issued_attempt(db, issue, exam)
    payload_questions = []
    for q in questions:
        opts = list(db.scalars(select(Option).where(Option.question_id == q.id).order_by(Option.position.asc(), Option.id.asc())).all())
        payload_questions.append(
            {
                "question_id": q.id,
                "question_text": q.question_text,
                "question_type": q.question_type.value,
                "options": [{"id": o.id, "text": o.option_text} for o in opts],
            },
        )
    return {
        "status": issue.status,
        "issued_id": issue.id,
        "candidate_name": issue.candidate_name,
        "assessment_title": exam.title,
        "duration_minutes": exam.duration_minutes,
        "timing_mode": exam.timing_mode,
        "time_per_question_seconds": exam.time_per_question_seconds,
        "questions_per_attempt": exam.questions_per_attempt,
        "pass_score": exam.pass_score,
        "questions": payload_questions,
    }


@router.post("/issued/submit")
def issued_candidate_submit(
    payload: IssuedCandidateSubmitRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    issue_id = _decode_issued_candidate_token(token)
    issue = db.get(AssessmentIssue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issued assessment not found")
    if issue.status == "completed":
        raise HTTPException(status_code=409, detail="Assessment already submitted")
    exam = db.get(Exam, issue.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Assessment not found")

    questions = _questions_for_issued_attempt(db, issue, exam)
    if not questions:
        raise HTTPException(status_code=400, detail="Assessment has no questions")
    total_marks = 0.0
    awarded_marks = 0.0
    correct_count = 0
    for q in questions:
        total_marks += float(q.marks or 0)
        selected_raw = payload.answers.get(str(q.id))
        selected_ids: list[int] = []
        if isinstance(selected_raw, int):
            selected_ids = [selected_raw]
        elif isinstance(selected_raw, list):
            selected_ids = [int(x) for x in selected_raw if str(x).isdigit()]
        correct_ids = [int(x) for x in db.scalars(select(Option.id).where(Option.question_id == q.id, Option.is_correct.is_(True))).all()]
        is_correct = set(selected_ids) == set(correct_ids) and len(correct_ids) > 0
        if is_correct:
            awarded_marks += float(q.marks or 0)
            correct_count += 1
        elif bool(exam.negative_marking):
            awarded_marks -= float(q.negative_marks or 0)

    percentage = round((awarded_marks / total_marks) * 100.0, 2) if total_marks > 0 else 0.0
    passed = bool(percentage >= float(exam.pass_score or 70))
    issue.status = "completed"
    issue.score_pct = percentage
    issue.passed = passed
    issue.completed_at = datetime.now(timezone.utc)
    issue.result_json = {"correct_count": correct_count, "question_count": len(questions), "awarded_marks": awarded_marks, "total_marks": total_marks}
    db.add(issue)
    db.commit()

    return {
        "status": "completed",
        "score_pct": percentage,
        "passed": passed,
        "correct_count": correct_count,
        "question_count": len(questions),
    }
