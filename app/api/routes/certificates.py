from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.session import get_db
from app.models.entities import Certificate, CertificateStatus, Result, User, UserRole, VerificationRecord
from app.services.certificates import certificate_payload, ensure_certificate_pdf, issue_certificate

router = APIRouter(prefix="/certificates", tags=["certificates"])


def _public_request_base_url(request: Request) -> str:
    xf_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    xf_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    proto = xf_proto or request.url.scheme
    host = xf_host or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


@router.post("/generate/{result_id}")
def generate_certificate(
    result_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PROVIDER)),
):
    result = db.get(Result, result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Result not found")
    if not result.passed:
        raise HTTPException(status_code=400, detail="Result is not pass eligible")

    try:
        cert = issue_certificate(db, result, verification_base_url=_public_request_base_url(request))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.commit()
    db.refresh(cert)
    return certificate_payload(db, cert)


@router.get("/verify/{certificate_id}")
def verify_certificate(
    certificate_id: str,
    request: Request,
    vt: str | None = None,
    db: Session = Depends(get_db),
):
    cert = db.scalar(select(Certificate).where(Certificate.certificate_id == certificate_id))
    if not cert or cert.status != CertificateStatus.ACTIVE:
        raise HTTPException(status_code=404, detail="Certificate not found")
    if not vt or vt != cert.verification_token:
        raise HTTPException(status_code=404, detail="Certificate not found")
    try:
        ensure_certificate_pdf(
            db,
            cert,
            force_regenerate=True,
            verification_base_url=_public_request_base_url(request),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    db.add(
        VerificationRecord(
            certificate_id=cert.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        ),
    )
    db.commit()
    db.refresh(cert)
    return certificate_payload(db, cert, mask_identity=True)


@router.post("/{certificate_id}/revoke")
def revoke_certificate(
    certificate_id: str,
    reason: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    cert = db.scalar(select(Certificate).where(Certificate.certificate_id == certificate_id))
    if not cert:
        raise HTTPException(status_code=404, detail="Certificate not found")
    cert.status = CertificateStatus.REVOKED
    db.commit()
    return {"revoked": True, "certificate_id": certificate_id, "reason": reason}
