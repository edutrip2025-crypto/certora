from datetime import datetime, timezone
import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.session import get_db
from app.models.entities import (
    AuditLog,
    ApprovalStatus,
    Certificate,
    ComplaintItem,
    Enrollment,
    Exam,
    ExamStatus,
    ModerationStatus,
    ProviderDocument,
    ProviderProfile,
    ProviderType,
    ReportItem,
    Result,
    User,
    UserApproval,
    UserRole,
)
from app.schemas import (
    AdminApprovalRequest,
    AnalyticsOut,
    ComplaintCreate,
    DocumentReviewRequest,
    ModerationUpdateRequest,
    ReportCreate,
)
from app.services.notifications import send_email
from app.services.account_rules import sync_existing_accounts

router = APIRouter(prefix="/admin", tags=["admin"])


def _audit(db: Session, actor_user_id: int | None, action: str, target_type: str, target_id: int | None, details: dict):
    db.add(
        AuditLog(
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details_json=details,
        ),
    )


def _safe_send_email(to_email: str, subject: str, body: str) -> dict:
    try:
        return send_email(to_email, subject, body)
    except Exception as exc:
        return {"sent": False, "reason": str(exc)}


@router.post("/accounts/sync-rules")
def sync_account_rules(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    summary = sync_existing_accounts(
        db,
        apply_legacy_student_approval_rollback=True,
        sync_firebase_claims=True,
    )
    _audit(
        db,
        current_user.id,
        "sync_account_rules",
        "user",
        None,
        summary,
    )
    db.commit()
    return summary


@router.get("/providers/pending")
def pending_providers(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    providers = db.scalars(select(ProviderProfile).where(ProviderProfile.approval_status == ApprovalStatus.PENDING)).all()
    return list(providers)


@router.get("/analytics", response_model=AnalyticsOut)
def analytics(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    onboarded_providers = db.scalar(
        select(func.count(ProviderProfile.id)).where(ProviderProfile.approval_status == ApprovalStatus.APPROVED),
    ) or 0
    approved_students = db.scalar(
        select(func.count(User.id))
        .join(UserApproval, UserApproval.user_id == User.id, isouter=True)
        .where(User.role == UserRole.STUDENT)
        .where((UserApproval.status == ApprovalStatus.APPROVED) | (UserApproval.id.is_(None))),
    ) or 0
    enrolled_courses = db.scalar(select(func.count(Enrollment.id))) or 0
    issued_certificates = db.scalar(select(func.count(Certificate.id))) or 0
    total_results = db.scalar(select(func.count(Result.id))) or 0
    passed_results = db.scalar(select(func.count(Result.id)).where(Result.passed.is_(True))) or 0
    pass_percentage = round((passed_results / total_results) * 100, 2) if total_results > 0 else 0.0
    return AnalyticsOut(
        onboarded_providers=onboarded_providers,
        approved_students=approved_students,
        enrolled_courses=enrolled_courses,
        issued_certificates=issued_certificates,
        pass_percentage=pass_percentage,
    )


@router.post("/providers/{provider_id}/decision")
def provider_decision(
    provider_id: int,
    payload: AdminApprovalRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    provider = db.get(ProviderProfile, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider.approval_status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    provider.rejection_reason = None if payload.approve else payload.rejection_reason
    provider.reviewed_by_admin_id = current_user.id
    provider.reviewed_at = datetime.now(timezone.utc)
    user_approval = db.scalar(select(UserApproval).where(UserApproval.user_id == provider.user_id))
    if not user_approval:
        user_approval = UserApproval(user_id=provider.user_id)
        db.add(user_approval)
    user_approval.status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    user_approval.rejection_reason = None if payload.approve else payload.rejection_reason
    user_approval.reviewed_by_admin_id = current_user.id
    user_approval.reviewed_at = datetime.now(timezone.utc)
    _audit(
        db,
        current_user.id,
        "provider_decision_legacy",
        "provider",
        provider_id,
        {"approved": payload.approve, "reason": payload.rejection_reason},
    )
    db.commit()
    return {"provider_id": provider_id, "status": provider.approval_status}


@router.get("/documents/pending")
def pending_documents(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    docs = db.scalars(select(ProviderDocument).where(ProviderDocument.status == ApprovalStatus.PENDING)).all()
    return list(docs)


@router.post("/documents/{document_id}/review")
def review_document(
    document_id: int,
    payload: DocumentReviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    doc = db.get(ProviderDocument, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    doc.status = payload.status
    doc.review_note = payload.review_note
    db.commit()
    return {"document_id": doc.id, "status": doc.status}


@router.get("/approvals/summary")
def approvals_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    pending_students = db.scalar(
        select(func.count(UserApproval.id))
        .join(User, User.id == UserApproval.user_id)
        .where(and_(User.role == UserRole.STUDENT, UserApproval.status == ApprovalStatus.PENDING)),
    ) or 0
    pending_providers = db.scalar(
        select(func.count(UserApproval.id))
        .join(User, User.id == UserApproval.user_id)
        .where(and_(User.role == UserRole.PROVIDER, UserApproval.status == ApprovalStatus.PENDING)),
    ) or 0
    return {"pending_students": pending_students, "pending_providers": pending_providers}


@router.get("/workspace-badges")
def workspace_badges(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    pending_students = db.scalar(
        select(func.count(UserApproval.id))
        .join(User, User.id == UserApproval.user_id)
        .where(and_(User.role == UserRole.STUDENT, UserApproval.status == ApprovalStatus.PENDING)),
    ) or 0
    pending_providers = db.scalar(
        select(func.count(UserApproval.id))
        .join(User, User.id == UserApproval.user_id)
        .where(and_(User.role == UserRole.PROVIDER, UserApproval.status == ApprovalStatus.PENDING)),
    ) or 0
    open_reports = db.scalar(
        select(func.count(ReportItem.id)).where(ReportItem.status.in_([ModerationStatus.OPEN, ModerationStatus.IN_REVIEW])),
    ) or 0
    open_complaints = db.scalar(
        select(func.count(ComplaintItem.id)).where(ComplaintItem.status.in_([ModerationStatus.OPEN, ModerationStatus.IN_REVIEW])),
    ) or 0
    return {
        "pending_approvals": pending_students + pending_providers,
        "pending_students": pending_students,
        "pending_providers": pending_providers,
        "open_reports": open_reports,
        "open_complaints": open_complaints,
        "open_moderation": open_reports + open_complaints,
    }


@router.get("/approvals/students")
def pending_student_approvals(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    base_query = (
        select(User, UserApproval)
        .join(UserApproval, UserApproval.user_id == User.id)
        .where(and_(User.role == UserRole.STUDENT, UserApproval.status == ApprovalStatus.PENDING))
    )
    total = db.scalar(select(func.count()).select_from(base_query.subquery())) or 0
    rows = db.execute(base_query.offset((page - 1) * page_size).limit(page_size)).all()
    items = [
        {
            "user_id": user.id,
            "email": user.email,
            "full_name": user.full_name,
            "approval_status": approval.status,
            "created_at": approval.created_at,
        }
        for user, approval in rows
    ]
    return {"items": items, "page": page, "page_size": page_size, "total": total}


@router.get("/approvals/providers")
def pending_provider_approvals(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    base_query = (
        select(User, ProviderProfile, UserApproval)
        .join(ProviderProfile, ProviderProfile.user_id == User.id, isouter=True)
        .join(UserApproval, UserApproval.user_id == User.id)
        .where(and_(User.role == UserRole.PROVIDER, UserApproval.status == ApprovalStatus.PENDING))
    )
    total = db.scalar(select(func.count()).select_from(base_query.subquery())) or 0
    rows = db.execute(base_query.offset((page - 1) * page_size).limit(page_size)).all()
    data = []
    for user, profile, approval in rows:
        docs = list(db.scalars(select(ProviderDocument).where(ProviderDocument.provider_id == profile.id)).all()) if profile else []
        data.append(
            {
                "user_id": user.id,
                "provider_id": profile.id if profile else None,
                "email": user.email,
                "full_name": user.full_name,
                "provider_type": profile.provider_type if profile else "not_submitted",
                "display_name": profile.display_name if profile else user.full_name,
                "approval_status": approval.status,
                "profile_created": profile is not None,
                "documents": [
                    {
                        "id": d.id,
                        "document_type": d.document_type,
                        "file_url": d.file_url,
                        "status": d.status,
                    }
                    for d in docs
                ],
            },
        )
    return {"items": data, "page": page, "page_size": page_size, "total": total}


@router.post("/approvals/providers/users/{user_id}/decision")
def provider_user_approval_decision(
    user_id: int,
    payload: AdminApprovalRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    user = db.get(User, user_id)
    if not user or user.role != UserRole.PROVIDER:
        raise HTTPException(status_code=404, detail="Provider user not found")

    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == user_id))
    if not approval:
        approval = UserApproval(user_id=user_id)
        db.add(approval)
    approval.status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    approval.rejection_reason = None if payload.approve else payload.rejection_reason
    approval.reviewed_by_admin_id = current_user.id
    approval.reviewed_at = datetime.now(timezone.utc)

    profile = db.scalar(select(ProviderProfile).where(ProviderProfile.user_id == user_id))
    if not profile and payload.approve:
        profile = ProviderProfile(
            user_id=user_id,
            provider_type=ProviderType.INDIVIDUAL,
            display_name=user.full_name,
            description="",
            approval_status=ApprovalStatus.APPROVED,
            rejection_reason=None,
            reviewed_by_admin_id=current_user.id,
            reviewed_at=datetime.now(timezone.utc),
        )
        db.add(profile)
    elif profile:
        profile.approval_status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
        profile.rejection_reason = None if payload.approve else payload.rejection_reason
        profile.reviewed_by_admin_id = current_user.id
        profile.reviewed_at = datetime.now(timezone.utc)

    _audit(
        db,
        current_user.id,
        "provider_user_approval_decision",
        "user",
        user.id,
        {"approved": payload.approve, "reason": payload.rejection_reason},
    )
    email_result = _safe_send_email(
        user.email,
        "Certora Provider Approval Update",
        "Your provider profile was approved."
        if payload.approve
        else f"Your provider profile was rejected. Reason: {payload.rejection_reason or 'Not specified'}",
    )
    db.commit()
    return {"user_id": user.id, "status": approval.status, "profile_created": profile is not None, "email": email_result}


@router.post("/approvals/students/{user_id}/decision")
def student_approval_decision(
    user_id: int,
    payload: AdminApprovalRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    user = db.get(User, user_id)
    if not user or user.role != UserRole.STUDENT:
        raise HTTPException(status_code=404, detail="Student not found")
    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == user_id))
    if not approval:
        approval = UserApproval(user_id=user_id)
        db.add(approval)
    approval.status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    approval.rejection_reason = None if payload.approve else payload.rejection_reason
    approval.reviewed_by_admin_id = current_user.id
    approval.reviewed_at = datetime.now(timezone.utc)
    _audit(
        db,
        current_user.id,
        "student_approval_decision",
        "user",
        user.id,
        {"approved": payload.approve, "reason": payload.rejection_reason},
    )
    email_result = _safe_send_email(
        user.email,
        "Certora Profile Approval Update",
        "Your profile was approved." if payload.approve else f"Your profile was rejected. Reason: {payload.rejection_reason or 'Not specified'}",
    )
    db.commit()
    return {"user_id": user.id, "status": approval.status, "email": email_result}


@router.post("/approvals/providers/{provider_id}/decision")
def provider_approval_decision(
    provider_id: int,
    payload: AdminApprovalRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    provider = db.get(ProviderProfile, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider.approval_status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    provider.rejection_reason = None if payload.approve else payload.rejection_reason
    provider.reviewed_by_admin_id = current_user.id
    provider.reviewed_at = datetime.now(timezone.utc)
    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == provider.user_id))
    if not approval:
        approval = UserApproval(user_id=provider.user_id)
        db.add(approval)
    approval.status = ApprovalStatus.APPROVED if payload.approve else ApprovalStatus.REJECTED
    approval.rejection_reason = None if payload.approve else payload.rejection_reason
    approval.reviewed_by_admin_id = current_user.id
    approval.reviewed_at = datetime.now(timezone.utc)
    user = db.get(User, provider.user_id)
    _audit(
        db,
        current_user.id,
        "provider_approval_decision",
        "provider",
        provider.id,
        {"approved": payload.approve, "reason": payload.rejection_reason},
    )
    email_result = (
        _safe_send_email(
            user.email,
            "Certora Provider Approval Update",
            "Your provider profile was approved."
            if payload.approve
            else f"Your provider profile was rejected. Reason: {payload.rejection_reason or 'Not specified'}",
        )
        if user
        else {"sent": False, "reason": "User not found"}
    )
    db.commit()
    return {"provider_id": provider.id, "status": approval.status, "email": email_result}


@router.get("/exams/review")
def exams_for_review(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    exams = db.scalars(select(Exam).where(Exam.status.in_([ExamStatus.IN_REVIEW, ExamStatus.REJECTED]))).all()
    return list(exams)


@router.post("/exams/{exam_id}/certification-approval")
def approve_exam_for_certification(
    exam_id: int,
    payload: AdminApprovalRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    exam.admin_certification_approved = payload.approve
    exam.status = ExamStatus.PUBLISHED if payload.approve else ExamStatus.REJECTED
    db.commit()
    return {"exam_id": exam.id, "admin_certification_approved": exam.admin_certification_approved, "status": exam.status}


@router.post("/reports")
def submit_report(
    payload: ReportCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.PROVIDER, UserRole.ADMIN, allow_unapproved=True)),
):
    item = ReportItem(
        reporter_user_id=current_user.id,
        report_type=payload.report_type,
        details=payload.details,
        target_type=payload.target_type,
        target_id=payload.target_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.post("/complaints")
def submit_complaint(
    payload: ComplaintCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.STUDENT, UserRole.PROVIDER, UserRole.ADMIN, allow_unapproved=True)),
):
    item = ComplaintItem(
        complainant_user_id=current_user.id,
        complaint_type=payload.complaint_type,
        details=payload.details,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/reports")
def list_reports(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status: str | None = None,
    search: str | None = None,
):
    query = select(ReportItem, User).join(User, User.id == ReportItem.reporter_user_id, isouter=True)
    if status:
        query = query.where(ReportItem.status == status)
    if search:
        like = f"%{search}%"
        query = query.where((ReportItem.details.ilike(like)) | (User.full_name.ilike(like)) | (User.email.ilike(like)))

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(query.order_by(ReportItem.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    for it, reporter in rows:
        counts[it.report_type] = counts.get(it.report_type, 0) + 1
        key = it.status.value if hasattr(it.status, "value") else str(it.status)
        status_counts[key] = status_counts.get(key, 0) + 1
        items.append(
            {
                "id": it.id,
                "report_type": it.report_type,
                "details": it.details,
                "target_type": it.target_type,
                "target_id": it.target_id,
                "status": key,
                "created_at": it.created_at,
                "reporter_user_id": it.reporter_user_id,
                "reporter_name": reporter.full_name if reporter else None,
                "reporter_email": reporter.email if reporter else None,
            },
        )
    return {"count": len(items), "by_type": counts, "by_status": status_counts, "items": items, "page": page, "page_size": page_size, "total": total}


@router.get("/complaints")
def list_complaints(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status: str | None = None,
    search: str | None = None,
):
    query = select(ComplaintItem, User).join(User, User.id == ComplaintItem.complainant_user_id, isouter=True)
    if status:
        query = query.where(ComplaintItem.status == status)
    if search:
        like = f"%{search}%"
        query = query.where((ComplaintItem.details.ilike(like)) | (User.full_name.ilike(like)) | (User.email.ilike(like)))

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(query.order_by(ComplaintItem.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    for it, complainant in rows:
        counts[it.complaint_type] = counts.get(it.complaint_type, 0) + 1
        key = it.status.value if hasattr(it.status, "value") else str(it.status)
        status_counts[key] = status_counts.get(key, 0) + 1
        items.append(
            {
                "id": it.id,
                "complaint_type": it.complaint_type,
                "details": it.details,
                "status": key,
                "created_at": it.created_at,
                "complainant_user_id": it.complainant_user_id,
                "complainant_name": complainant.full_name if complainant else None,
                "complainant_email": complainant.email if complainant else None,
            },
        )
    return {"count": len(items), "by_type": counts, "by_status": status_counts, "items": items, "page": page, "page_size": page_size, "total": total}


@router.post("/reports/{report_id}/status")
def update_report_status(
    report_id: int,
    payload: ModerationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    report = db.get(ReportItem, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    previous = report.status
    report.status = payload.status
    _audit(
        db,
        current_user.id,
        "report_status_update",
        "report",
        report.id,
        {"previous": previous, "new": payload.status},
    )
    db.commit()
    return {"report_id": report.id, "status": report.status}


@router.post("/complaints/{complaint_id}/status")
def update_complaint_status(
    complaint_id: int,
    payload: ModerationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    complaint = db.get(ComplaintItem, complaint_id)
    if not complaint:
        raise HTTPException(status_code=404, detail="Complaint not found")
    previous = complaint.status
    complaint.status = payload.status
    _audit(
        db,
        current_user.id,
        "complaint_status_update",
        "complaint",
        complaint.id,
        {"previous": previous, "new": payload.status},
    )
    db.commit()
    return {"complaint_id": complaint.id, "status": complaint.status}


@router.get("/reports/export.csv")
def export_reports_csv(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    rows = db.execute(
        select(ReportItem, User).join(User, User.id == ReportItem.reporter_user_id, isouter=True).order_by(ReportItem.created_at.desc()),
    ).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "type", "status", "details", "reporter_name", "reporter_email", "created_at"])
    for report, user in rows:
        writer.writerow([report.id, report.report_type, report.status, report.details, user.full_name if user else "", user.email if user else "", report.created_at])
    return Response(content=output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=reports.csv"})


@router.get("/complaints/export.csv")
def export_complaints_csv(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    rows = db.execute(
        select(ComplaintItem, User).join(User, User.id == ComplaintItem.complainant_user_id, isouter=True).order_by(ComplaintItem.created_at.desc()),
    ).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "type", "status", "details", "complainant_name", "complainant_email", "created_at"])
    for complaint, user in rows:
        writer.writerow([complaint.id, complaint.complaint_type, complaint.status, complaint.details, user.full_name if user else "", user.email if user else "", complaint.created_at])
    return Response(content=output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=complaints.csv"})


@router.get("/approvals/export.csv")
def export_approvals_csv(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    rows = db.execute(
        select(User, UserApproval)
        .join(UserApproval, UserApproval.user_id == User.id)
        .where(UserApproval.status == ApprovalStatus.PENDING)
        .order_by(UserApproval.created_at.desc()),
    ).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["user_id", "full_name", "email", "role", "status", "created_at"])
    for user, approval in rows:
        writer.writerow([user.id, user.full_name, user.email, user.role, approval.status, approval.created_at])
    return Response(content=output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=pending_approvals.csv"})


@router.get("/billing-payments")
def billing_payments_overview(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    return {
        "status": "placeholder",
        "message": "Billing & payments module is reserved for next phase.",
    }


@router.get("/audit-logs")
def audit_logs(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    query = select(AuditLog).order_by(AuditLog.created_at.desc())
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = list(db.scalars(query.offset((page - 1) * page_size).limit(page_size)).all())
    return {"items": rows, "page": page, "page_size": page_size, "total": total}
