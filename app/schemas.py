from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field

from app.models.entities import (
    ApprovalStatus,
    DocumentType,
    LessonType,
    ModerationStatus,
    ProviderType,
    QuestionType,
    UserRole,
)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: UserRole


class SignupRequest(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=200)
    password: str = Field(min_length=8, max_length=128)
    role: UserRole


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    email: EmailStr
    full_name: str
    role: UserRole

    model_config = {"from_attributes": True}


class RegisterRoleRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=200)
    role: UserRole


class AdminRecoveryRequest(BaseModel):
    recovery_key: str = Field(min_length=8, max_length=256)


class AdminSetUserPasswordRequest(BaseModel):
    email: EmailStr
    new_password: str = Field(min_length=8, max_length=128)
    recovery_key: str = Field(min_length=8, max_length=256)


class ProviderProfileCreate(BaseModel):
    provider_type: ProviderType
    display_name: str
    description: str = ""


class ProviderProfileOut(BaseModel):
    id: int
    user_id: int
    provider_type: ProviderType
    display_name: str
    description: str
    approval_status: ApprovalStatus
    rejection_reason: str | None

    model_config = {"from_attributes": True}


class ProviderDocumentCreate(BaseModel):
    document_type: DocumentType
    file_url: str


class ProviderDocumentOut(BaseModel):
    id: int
    provider_id: int
    document_type: DocumentType
    file_url: str
    status: ApprovalStatus
    review_note: str | None

    model_config = {"from_attributes": True}


class CourseCreate(BaseModel):
    title: str
    description: str
    category: str
    thumbnail_url: str | None = None
    includes_certification_exam: bool = False


class CourseUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None
    thumbnail_url: str | None = None
    includes_certification_exam: bool | None = None


class CourseOut(BaseModel):
    id: int
    provider_id: int
    title: str
    description: str
    category: str
    thumbnail_url: str | None
    includes_certification_exam: bool
    is_published: bool

    model_config = {"from_attributes": True}


class ModuleCreate(BaseModel):
    title: str
    syllabus_text: str = ""
    position: int = 1


class LessonCreate(BaseModel):
    title: str
    lesson_type: LessonType
    recorded_video_url: str | None = None
    live_class_url: str | None = None
    position: int = 1


class ResourceCreate(BaseModel):
    title: str
    url: str
    resource_type: str = "attachment"


class ExamCreate(BaseModel):
    course_id: int
    title: str
    duration_minutes: int = 60
    timing_mode: str = "assessment"
    time_per_question_seconds: int | None = None
    questions_per_attempt: int = 0
    pass_score: float = 60
    negative_marking: bool = False
    shuffle_questions: bool = False
    shuffle_options: bool = False
    exam_window_start: datetime | None = None
    exam_window_end: datetime | None = None
    max_attempts: int = 1
    certificate_enabled: bool = True


class ExamUpdate(BaseModel):
    title: str | None = None
    duration_minutes: int | None = None
    timing_mode: str | None = None
    time_per_question_seconds: int | None = None
    questions_per_attempt: int | None = None
    pass_score: float | None = None
    negative_marking: bool | None = None
    shuffle_questions: bool | None = None
    shuffle_options: bool | None = None
    exam_window_start: datetime | None = None
    exam_window_end: datetime | None = None
    max_attempts: int | None = None
    certificate_enabled: bool | None = None


class ExamRuleUpdate(BaseModel):
    min_questions: int = 25
    min_pass_score: float = 60
    max_easy_ratio: float = 0.70
    min_syllabus_areas: int = 3
    max_duplicate_ratio: float = 0.10
    max_ambiguous_ratio: float = 0.10


class OptionCreate(BaseModel):
    option_text: str
    is_correct: bool
    position: int = 1


class QuestionCreate(BaseModel):
    question_text: str
    question_type: QuestionType
    marks: float = 1
    negative_marks: float = 0
    options: list[OptionCreate] = []


class ExamOut(BaseModel):
    id: int
    course_id: int
    title: str
    duration_minutes: int
    timing_mode: str
    time_per_question_seconds: int | None = None
    questions_per_attempt: int
    total_marks: float
    pass_score: float
    max_attempts: int
    certificate_enabled: bool
    status: str
    admin_certification_approved: bool

    model_config = {"from_attributes": True}


class EnrollmentCreate(BaseModel):
    course_id: int


class EnrollmentOut(BaseModel):
    id: int
    student_id: int
    course_id: int
    status: str
    progress_pct: float
    exam_eligible: bool

    model_config = {"from_attributes": True}


class AttemptStartResponse(BaseModel):
    attempt_id: int
    exam_id: int
    student_id: int
    started_at: datetime


class AnswerSaveRequest(BaseModel):
    question_id: int
    selected_option_ids: list[int] | None = None
    text_answer: str | None = None


class ResultOut(BaseModel):
    id: int
    attempt_id: int
    student_id: int
    exam_id: int
    score: float
    percentage: float
    passed: bool
    correct_count: int | None = None
    wrong_count: int | None = None
    total_questions: int | None = None
    proctor_decision: str | None = None
    proctor_probability: float | None = None
    proctor_deduction_pct: float | None = None
    proctor_deduction_mode: str | None = None
    proctor_review_required: bool | None = None
    proctor_hard_fail: bool | None = None
    proctor_hard_fail_reason: str | None = None
    training_feedback_status: str | None = None
    training_feedback_comment: str | None = None
    training_feedback_count: int = 0
    certificate: dict[str, Any] | None = None

    model_config = {"from_attributes": True}


class CertificateOut(BaseModel):
    certificate_id: str
    result_id: int
    student_id: int
    course_id: int
    provider_id: int
    status: str
    issued_at: datetime
    pdf_url: str | None = None
    download_url: str | None = None
    verification_link: str


class AdminApprovalRequest(BaseModel):
    approve: bool
    rejection_reason: str | None = None


class DocumentReviewRequest(BaseModel):
    status: ApprovalStatus
    review_note: str | None = None


class EventRequest(BaseModel):
    event_type: str
    payload: dict[str, Any] = {}


class UserApprovalOut(BaseModel):
    id: int
    user_id: int
    status: ApprovalStatus
    rejection_reason: str | None

    model_config = {"from_attributes": True}


class ReportCreate(BaseModel):
    report_type: str
    details: str
    target_type: str | None = None
    target_id: int | None = None


class ComplaintCreate(BaseModel):
    complaint_type: str
    details: str


class ModerationUpdateRequest(BaseModel):
    status: ModerationStatus


class AnalyticsOut(BaseModel):
    onboarded_providers: int
    approved_students: int
    enrolled_courses: int
    issued_certificates: int
    pass_percentage: float


class ProviderHomeOut(BaseModel):
    total_courses: int
    published_courses: int
    total_enrollments: int
    exams_created: int
    certificates_issued: int
    pass_percentage: float
    unread_notifications: int


class LessonTopicCreate(BaseModel):
    title: str
    time_seconds: int = Field(ge=0)
    thumbnail_data_url: str | None = None


class LessonTopicOut(BaseModel):
    id: int
    lesson_id: int
    title: str
    time_seconds: int
    thumbnail_data_url: str | None = None

    model_config = {"from_attributes": True}


class ProctorSessionStartRequest(BaseModel):
    mode: str = "attempt"  # attempt | preview
    exam_id: int | None = None
    attempt_id: int | None = None


class ProctorEventCreate(BaseModel):
    event_type: str
    severity: str = "info"  # info | warning | critical
    confidence: float | None = None
    details: dict = {}


class ProctorFinalizeRequest(BaseModel):
    ended_reason: str | None = None


class ProctorReviewRequest(BaseModel):
    review_status: str = "reviewed"  # reviewed | actioned
    notes: str | None = None


class ProctorTrainingFeedbackCreate(BaseModel):
    training_result: str = "correct"  # correct | incorrect
    comment: str | None = None


class CourseCommentCreate(BaseModel):
    message: str


class CourseCommentReply(BaseModel):
    reply: str


class CourseFeedbackCreate(BaseModel):
    valuable_time_rating: int = Field(ge=1, le=5)
    content_quality_rating: int = Field(ge=1, le=5)
    instructor_clarity_rating: int = Field(ge=1, le=5)
    practical_usefulness_rating: int = Field(ge=1, le=5)
    comment: str | None = None
