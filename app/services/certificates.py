import secrets
from datetime import datetime, timezone
from pathlib import Path

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfgen import canvas
except ImportError:  # pragma: no cover - runtime dependency safety
    colors = None
    A4 = None
    landscape = None
    canvas = None
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import Certificate, CertificateStatus, Course, Exam, ProviderProfile, Result, User
from app.services.media_storage import resolve_media_url, upload_file_to_cloud_storage


def _certificate_media_dir() -> Path:
    root = Path(get_settings().resolved_media_dir) / "certificates"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _certificate_logo_path() -> Path:
    return Path(__file__).resolve().parent.parent / "web" / "assets" / "certora_logo.png"


def _certificate_pdf_relpath(certificate_id: str) -> str:
    return f"/media/certificates/{certificate_id}.pdf"


def _ensure_pdf_engine() -> None:
    if not all((colors, A4, landscape, canvas)):
        raise RuntimeError("Certificate PDF engine unavailable. Install reportlab.")


def _absolute_url(path_or_url: str | None) -> str | None:
    if not path_or_url:
        return None
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        return path_or_url
    return f"{get_settings().app_base_url.rstrip('/')}{path_or_url}"


def _load_certificate_context(db: Session, certificate: Certificate) -> dict:
    course = db.get(Course, certificate.course_id)
    provider = db.get(ProviderProfile, certificate.provider_id)
    student = db.get(User, certificate.student_id)
    result = db.get(Result, certificate.result_id)
    if not course or not provider or not student or not result:
        raise ValueError("Certificate context is incomplete")
    return {
        "course": course,
        "provider": provider,
        "student": student,
        "result": result,
    }


def render_certificate_pdf(db: Session, certificate: Certificate) -> str:
    _ensure_pdf_engine()
    ctx = _load_certificate_context(db, certificate)
    course: Course = ctx["course"]
    provider: ProviderProfile = ctx["provider"]
    student: User = ctx["student"]
    result: Result = ctx["result"]

    out_path = _certificate_media_dir() / f"{certificate.certificate_id}.pdf"
    page_width, page_height = landscape(A4)
    c = canvas.Canvas(str(out_path), pagesize=(page_width, page_height))

    # Background
    c.setFillColor(colors.HexColor("#f7f2e7"))
    c.rect(0, 0, page_width, page_height, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#fffdf8"))
    c.roundRect(26, 26, page_width - 52, page_height - 52, 18, fill=1, stroke=0)

    # Dual border
    c.setStrokeColor(colors.HexColor("#b68a2e"))
    c.setLineWidth(3)
    c.roundRect(34, 34, page_width - 68, page_height - 68, 16, stroke=1, fill=0)
    c.setStrokeColor(colors.HexColor("#d6b35d"))
    c.setLineWidth(1)
    c.roundRect(48, 48, page_width - 96, page_height - 96, 14, stroke=1, fill=0)

    # Header band
    c.setFillColor(colors.HexColor("#0f172a"))
    c.roundRect(64, page_height - 110, page_width - 128, 54, 12, fill=1, stroke=0)
    logo_path = _certificate_logo_path()
    if logo_path.exists():
      c.drawImage(str(logo_path), 82, page_height - 100, width=108, height=32, mask="auto", preserveAspectRatio=True)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 22)
    c.drawRightString(page_width - 82, page_height - 78, "CERTORA CERTIFICATION")

    # Main title
    c.setFillColor(colors.HexColor("#8a6a1f"))
    c.setFont("Times-Bold", 30)
    c.drawCentredString(page_width / 2, page_height - 160, "Certificate of Achievement")

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 13)
    c.drawCentredString(page_width / 2, page_height - 192, "This certifies that")

    c.setFillColor(colors.HexColor("#111827"))
    c.setFont("Times-Bold", 28)
    c.drawCentredString(page_width / 2, page_height - 235, student.full_name)

    c.setStrokeColor(colors.HexColor("#caa14d"))
    c.setLineWidth(1.2)
    c.line(page_width / 2 - 210, page_height - 247, page_width / 2 + 210, page_height - 247)

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 13)
    c.drawCentredString(page_width / 2, page_height - 278, "has successfully completed the course and passed the final assessment")

    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(page_width / 2, page_height - 320, course.title)

    c.setFillColor(colors.HexColor("#334155"))
    c.setFont("Helvetica", 12)
    c.drawCentredString(
        page_width / 2,
        page_height - 350,
        f"Issued by {provider.display_name} through Certora",
    )

    # Center badge
    badge_x = page_width / 2 - 72
    badge_y = page_height - 455
    c.setFillColor(colors.HexColor("#f5e3a6"))
    c.circle(page_width / 2, badge_y + 38, 36, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#9a6f19"))
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(page_width / 2, badge_y + 34, "PASS")
    c.setFillColor(colors.HexColor("#111827"))
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(page_width / 2, badge_y + 16, f"{float(result.percentage or 0):.2f}%")

    # Footer metadata
    issued_on = certificate.issued_at.astimezone(timezone.utc).strftime("%d %b %Y")
    verification_url = f"{get_settings().app_base_url.rstrip('/')}/certificates/verify/{certificate.certificate_id}"
    left_x = 86
    right_x = page_width - 280
    footer_y = 118

    c.setFillColor(colors.HexColor("#1f2937"))
    c.setFont("Helvetica-Bold", 11)
    c.drawString(left_x, footer_y + 36, "Certificate ID")
    c.drawString(left_x, footer_y + 10, "Issued On")
    c.drawString(right_x, footer_y + 36, "Verification URL")
    c.drawString(right_x, footer_y + 10, "Status")

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 10)
    c.drawString(left_x + 98, footer_y + 36, certificate.certificate_id)
    c.drawString(left_x + 98, footer_y + 10, issued_on)
    c.drawString(right_x + 102, footer_y + 10, "ACTIVE")

    text = c.beginText()
    text.setTextOrigin(right_x + 102, footer_y + 42)
    text.setFont("Helvetica", 8.5)
    text.setFillColor(colors.HexColor("#475569"))
    verification_line = verification_url
    max_chars = 54
    for i in range(0, len(verification_line), max_chars):
        text.textLine(verification_line[i:i + max_chars])
    c.drawText(text)

    # Signature line
    c.setStrokeColor(colors.HexColor("#94a3b8"))
    c.setLineWidth(1)
    c.line(page_width / 2 - 150, 92, page_width / 2 + 150, 92)
    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 10)
    c.drawCentredString(page_width / 2, 76, "Authorized Digital Certificate • Certora")

    c.showPage()
    c.save()
    settings = get_settings()
    if settings.resolved_object_storage_backend != "local":
        return upload_file_to_cloud_storage(
            out_path,
            object_path=f"certificates/{certificate.certificate_id}.pdf",
            content_type="application/pdf",
        )
    return _certificate_pdf_relpath(certificate.certificate_id)


def ensure_certificate_pdf(db: Session, certificate: Certificate) -> Certificate:
    if certificate.pdf_url:
        if certificate.pdf_url.startswith("http://") or certificate.pdf_url.startswith("https://"):
            return certificate
        existing_path = Path(get_settings().resolved_media_dir) / certificate.pdf_url.replace("/media/", "", 1)
        if existing_path.exists():
            return certificate
    certificate.pdf_url = render_certificate_pdf(db, certificate)
    db.flush()
    return certificate


def issue_certificate(db: Session, result: Result) -> Certificate:
    existing = db.scalar(select(Certificate).where(Certificate.result_id == result.id))
    if existing:
        try:
            return ensure_certificate_pdf(db, existing)
        except RuntimeError:
            # Keep existing certificate row usable even if PDF engine/storage is temporarily unavailable.
            return existing

    exam = db.get(Exam, result.exam_id)
    if not exam:
        raise ValueError("Exam not found for certificate generation")
    if not exam.certificate_enabled:
        raise ValueError("Certificates are disabled for this assessment")
    course = db.get(Course, exam.course_id)
    if not course:
        raise ValueError("Related course not found for certificate generation")

    provider = db.get(ProviderProfile, course.provider_id)
    if not provider:
        raise ValueError("Provider not found for certificate generation")

    cert = Certificate(
        result_id=result.id,
        student_id=result.student_id,
        course_id=course.id,
        provider_id=provider.id,
        certificate_id=secrets.token_hex(8).upper(),
        verification_token=secrets.token_hex(16),
        pdf_url=None,
        status=CertificateStatus.ACTIVE,
        issued_at=datetime.now(timezone.utc),
    )
    db.add(cert)
    db.flush()
    try:
        return ensure_certificate_pdf(db, cert)
    except RuntimeError:
        # Preserve issued certificate row; PDF can be generated lazily later.
        return cert


def certificate_payload(db: Session, certificate: Certificate) -> dict:
    settings = get_settings()
    course = db.get(Course, certificate.course_id)
    provider = db.get(ProviderProfile, certificate.provider_id)
    student = db.get(User, certificate.student_id)
    result = db.get(Result, certificate.result_id)
    pdf_url = resolve_media_url(certificate.pdf_url) or _absolute_url(certificate.pdf_url)
    verification_link = f"{settings.app_base_url.rstrip('/')}/certificates/verify/{certificate.certificate_id}"
    return {
        "certificate_id": certificate.certificate_id,
        "result_id": certificate.result_id,
        "student_id": certificate.student_id,
        "student_name": student.full_name if student else None,
        "course_id": certificate.course_id,
        "course_name": course.title if course else None,
        "provider_id": certificate.provider_id,
        "provider_name": provider.display_name if provider else None,
        "score": result.score if result else None,
        "percentage": result.percentage if result else None,
        "status": certificate.status,
        "issued_at": certificate.issued_at,
        "pdf_url": pdf_url,
        "download_url": pdf_url or verification_link,
        "verification_link": verification_link,
    }
