from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.entities import Course, CourseModule, Lesson, ProviderProfile, Resource, User, UserRole
from app.schemas import CourseCreate, CourseOut, CourseUpdate, LessonCreate, ModuleCreate, ResourceCreate

router = APIRouter(prefix="/courses", tags=["courses"])


def _provider_profile_or_404(db: Session, user_id: int) -> ProviderProfile:
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == user_id))
    if not profile:
        raise HTTPException(status_code=404, detail="Provider profile not found")
    return profile


def _can_delete_course(db: Session, course: Course, current_user: User) -> bool:
    if current_user.role == UserRole.ADMIN and str(current_user.email or "").strip().lower() == "admin@certora.in":
        return True
    if current_user.role != UserRole.PROVIDER:
        return False
    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == current_user.id))
    return bool(profile and course.provider_id == profile.id)


@router.post("", response_model=CourseOut, status_code=status.HTTP_201_CREATED)
def create_course(
    payload: CourseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    course = Course(
        provider_id=profile.id,
        title=payload.title,
        description=payload.description,
        category=payload.category,
        thumbnail_url=payload.thumbnail_url,
        includes_certification_exam=payload.includes_certification_exam,
    )
    db.add(course)
    db.commit()
    db.refresh(course)
    return course


@router.put("/{course_id}", response_model=CourseOut)
def update_course(
    course_id: int,
    payload: CourseUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    course = db.get(Course, course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=404, detail="Course not found")

    for key, value in payload.model_dump(exclude_none=True).items():
        setattr(course, key, value)
    db.commit()
    db.refresh(course)
    return course


@router.get("", response_model=list[CourseOut])
def list_courses(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.role == UserRole.PROVIDER:
        profile = _provider_profile_or_404(db, user.id)
        courses = db.scalars(select(Course).where(Course.provider_id == profile.id)).all()
        return list(courses)
    courses = db.scalars(select(Course).where(Course.is_published.is_(True))).all()
    return list(courses)


@router.get("/public", response_model=list[CourseOut])
def public_courses(db: Session = Depends(get_db)):
    courses = db.scalars(select(Course).where(Course.is_published.is_(True))).all()
    return list(courses)


@router.post("/{course_id}/modules")
def add_module(
    course_id: int,
    payload: ModuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    course = db.get(Course, course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=404, detail="Course not found")
    module = CourseModule(course_id=course.id, **payload.model_dump())
    db.add(module)
    db.commit()
    db.refresh(module)
    return module


@router.post("/modules/{module_id}/lessons")
def add_lesson(
    module_id: int,
    payload: LessonCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    module = db.get(CourseModule, module_id)
    if not module:
        raise HTTPException(status_code=404, detail="Module not found")
    course = db.get(Course, module.course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")
    lesson = Lesson(module_id=module.id, **payload.model_dump())
    db.add(lesson)
    db.commit()
    db.refresh(lesson)
    return lesson


@router.post("/lessons/{lesson_id}/resources")
def add_resource_to_lesson(
    lesson_id: int,
    payload: ResourceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lesson not found")
    module = db.get(CourseModule, lesson.module_id)
    course = db.get(Course, module.course_id) if module else None
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=403, detail="Access denied")
    resource = Resource(lesson_id=lesson.id, **payload.model_dump())
    db.add(resource)
    db.commit()
    db.refresh(resource)
    return resource


@router.post("/{course_id}/publish", response_model=CourseOut)
def publish_course(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER)),
):
    profile = _provider_profile_or_404(db, current_user.id)
    course = db.get(Course, course_id)
    if not course or course.provider_id != profile.id:
        raise HTTPException(status_code=404, detail="Course not found")
    course.is_published = True
    db.commit()
    db.refresh(course)
    return course


@router.delete("/{course_id}")
def delete_course(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.PROVIDER, UserRole.ADMIN)),
):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    if not _can_delete_course(db, course, current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    from app.models.entities import (
        AiReviewJob,
        AttemptEvent,
        Certificate,
        CourseComment,
        CourseCompletion,
        CourseFeedback,
        Enrollment,
        Exam,
        ExamAttempt,
        ExamRule,
        LessonTopic,
        LiveClassCompletion,
        Option,
        ProctorEvent,
        ProctorEvidence,
        ProctorSession,
        ProctorTrainingFeedback,
        Question,
        Result,
        StudentAnswer,
        VerificationRecord,
    )

    module_ids = list(db.scalars(select(CourseModule.id).where(CourseModule.course_id == course.id)).all())
    lesson_ids = list(db.scalars(select(Lesson.id).where(Lesson.module_id.in_(module_ids))).all()) if module_ids else []
    exam_ids = list(db.scalars(select(Exam.id).where(Exam.course_id == course.id)).all())
    question_ids = list(db.scalars(select(Question.id).where(Question.exam_id.in_(exam_ids))).all()) if exam_ids else []
    attempt_ids = list(db.scalars(select(ExamAttempt.id).where(ExamAttempt.exam_id.in_(exam_ids))).all()) if exam_ids else []
    result_ids = list(db.scalars(select(Result.id).where(Result.exam_id.in_(exam_ids))).all()) if exam_ids else []
    session_ids = list(
        db.scalars(
            select(ProctorSession.id).where(
                (ProctorSession.exam_id.in_(exam_ids)) if exam_ids else False,
            ),
        ).all(),
    ) if exam_ids else []
    certificate_ids = list(db.scalars(select(Certificate.id).where(Certificate.course_id == course.id)).all())

    if certificate_ids:
        db.execute(delete(VerificationRecord).where(VerificationRecord.certificate_id.in_(certificate_ids)))
    if result_ids:
        db.execute(delete(ProctorTrainingFeedback).where(ProctorTrainingFeedback.result_id.in_(result_ids)))
    if attempt_ids:
        db.execute(delete(ProctorTrainingFeedback).where(ProctorTrainingFeedback.attempt_id.in_(attempt_ids)))
        db.execute(delete(AttemptEvent).where(AttemptEvent.attempt_id.in_(attempt_ids)))
        db.execute(delete(StudentAnswer).where(StudentAnswer.attempt_id.in_(attempt_ids)))
    if session_ids:
        db.execute(delete(ProctorTrainingFeedback).where(ProctorTrainingFeedback.session_id.in_(session_ids)))
        db.execute(delete(ProctorEvidence).where(ProctorEvidence.session_id.in_(session_ids)))
        db.execute(delete(ProctorEvent).where(ProctorEvent.session_id.in_(session_ids)))
        db.execute(delete(ProctorSession).where(ProctorSession.id.in_(session_ids)))
    if certificate_ids:
        db.execute(delete(Certificate).where(Certificate.id.in_(certificate_ids)))
    if result_ids:
        db.execute(delete(Result).where(Result.id.in_(result_ids)))
    if attempt_ids:
        db.execute(delete(ExamAttempt).where(ExamAttempt.id.in_(attempt_ids)))
    if exam_ids:
        db.execute(delete(ExamRule).where(ExamRule.exam_id.in_(exam_ids)))
        db.execute(delete(AiReviewJob).where(AiReviewJob.exam_id.in_(exam_ids)))
    if question_ids:
        db.execute(delete(Option).where(Option.question_id.in_(question_ids)))
        db.execute(delete(Question).where(Question.id.in_(question_ids)))
    if exam_ids:
        db.execute(delete(Exam).where(Exam.id.in_(exam_ids)))
    if lesson_ids:
        db.execute(delete(Resource).where(Resource.lesson_id.in_(lesson_ids)))
        db.execute(delete(LessonTopic).where(LessonTopic.lesson_id.in_(lesson_ids)))
        db.execute(delete(Lesson).where(Lesson.id.in_(lesson_ids)))
    if module_ids:
        db.execute(delete(CourseModule).where(CourseModule.id.in_(module_ids)))

    db.execute(delete(CourseComment).where(CourseComment.course_id == course.id))
    db.execute(delete(CourseFeedback).where(CourseFeedback.course_id == course.id))
    db.execute(delete(CourseCompletion).where(CourseCompletion.course_id == course.id))
    db.execute(delete(LiveClassCompletion).where(LiveClassCompletion.course_id == course.id))
    db.execute(delete(Enrollment).where(Enrollment.course_id == course.id))
    db.delete(course)
    db.commit()
    return {"deleted": True, "course_id": course_id}
