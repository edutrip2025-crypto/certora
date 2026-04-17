import secrets
from datetime import datetime, timezone
from pathlib import Path

try:
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfgen import canvas
except ImportError:  # pragma: no cover - runtime dependency safety
    renderPDF = None
    QrCodeWidget = None
    Drawing = None
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


def certificate_verification_url(certificate: Certificate) -> str:
    base = get_settings().app_base_url.rstrip("/")
    lower = base.lower()
    if "localhost" in lower or "127.0.0.1" in lower:
        raise RuntimeError("Certificate verification base URL must be public, not localhost.")
    return f"{base}/certificates/verify/{certificate.certificate_id}?vt={certificate.verification_token}"


def safe_certificate_verification_url(certificate: Certificate) -> str | None:
    try:
        return certificate_verification_url(certificate)
    except Exception:
        return None


def _masked_name(value: str) -> str:
    text = (value or "").strip()
    if len(text) <= 6:
        return text
    return f"{text[:3]}...{text[-3:]}"


CERTIFICATE_TEMPLATE_VERSION = "v2"


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

    # Header branding (no top bar)
    logo_path = _certificate_logo_path()
    if logo_path.exists():
        logo_w = 210
        logo_h = 52
        logo_x = (page_width - logo_w) / 2
        logo_y = page_height - 112
        c.drawImage(
            str(logo_path),
            logo_x,
            logo_y,
            width=logo_w,
            height=logo_h,
            mask="auto",
            preserveAspectRatio=True,
            anchor="c",
        )

    # Main title
    c.setFillColor(colors.HexColor("#8a6a1f"))
    c.setFont("Times-Bold", 30)
    c.drawCentredString(page_width / 2, page_height - 166, "Certificate of Achievement")

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 13)
    c.drawCentredString(page_width / 2, page_height - 196, "This certifies that")

    c.setFillColor(colors.HexColor("#111827"))
    c.setFont("Times-Bold", 28)
    c.drawCentredString(page_width / 2, page_height - 238, _masked_name(student.full_name))

    c.setStrokeColor(colors.HexColor("#caa14d"))
    c.setLineWidth(1.2)
    c.line(page_width / 2 - 210, page_height - 250, page_width / 2 + 210, page_height - 250)

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 13)
    c.drawCentredString(page_width / 2, page_height - 280, "has successfully completed the course and passed the final assessment")

    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(page_width / 2, page_height - 322, course.title)

    c.setFillColor(colors.HexColor("#334155"))
    c.setFont("Helvetica", 12)
    c.drawCentredString(page_width / 2, page_height - 352, f"Issued by {provider.display_name} through Certora")

    # Pass/result block (aligned card)
    score_y = page_height - 430
    c.setFillColor(colors.HexColor("#f9f4e6"))
    c.roundRect(page_width / 2 - 164, score_y - 20, 328, 70, 12, fill=1, stroke=0)
    c.setStrokeColor(colors.HexColor("#d6b35d"))
    c.setLineWidth(1)
    c.roundRect(page_width / 2 - 164, score_y - 20, 328, 70, 12, fill=0, stroke=1)
    c.setFillColor(colors.HexColor("#9a6f19"))
    c.setFont("Helvetica-Bold", 13)
    c.drawCentredString(page_width / 2, score_y + 30, "PASS")
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 26)
    c.drawCentredString(page_width / 2, score_y + 5, f"{float(result.percentage or 0):.2f}%")

    # Footer metadata (trimmed; details move under QR)
    issued_on = certificate.issued_at.astimezone(timezone.utc).strftime("%d %b %Y")
    masked_name = _masked_name(student.full_name)

    # QR-only verification block
    verification_url = certificate_verification_url(certificate)
    qr_size = 72
    qr_x = page_width - 154
    qr_y = 112
    c.setFillColor(colors.HexColor("#1f2937"))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(qr_x - 28, qr_y + qr_size + 16, "For verification, scan QR")
    if QrCodeWidget and Drawing and renderPDF:
        qr_widget = QrCodeWidget(verification_url)
        bounds = qr_widget.getBounds()
        qr_w = bounds[2] - bounds[0]
        qr_h = bounds[3] - bounds[1]
        drawing = Drawing(qr_size, qr_size, transform=[qr_size / qr_w, 0, 0, qr_size / qr_h, 0, 0])
        drawing.add(qr_widget)
        renderPDF.draw(drawing, c, qr_x, qr_y)
    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    c.setLineWidth(1)
    c.rect(qr_x - 6, qr_y - 6, qr_size + 12, qr_size + 12, stroke=1, fill=0)
    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 8.7)
    c.drawString(qr_x - 28, qr_y - 18, certificate.certificate_id)
    c.drawString(qr_x - 28, qr_y - 31, issued_on)
    c.drawString(qr_x - 28, qr_y - 44, masked_name)
    c.drawString(qr_x - 28, qr_y - 57, (course.title or "")[:30])

    # Signature + digital seal
    sig_x1 = page_width / 2 - 182
    sig_x2 = page_width / 2 + 40
    sig_y = 104
    c.setStrokeColor(colors.HexColor("#94a3b8"))
    c.setLineWidth(1)
    c.line(sig_x1, sig_y, sig_x2, sig_y)
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Times-Italic", 24)
    c.drawString(sig_x1 + 8, sig_y + 6, "Certora")
    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica", 9)
    c.drawString(sig_x1, sig_y - 14, "Authorized Digital Signatory")

    # Unique digital seal using certificate-specific token fragments + layered geometry
    seal_x = page_width / 2 + 158
    seal_y = sig_y + 2
    token = (certificate.verification_token or "").upper()
    token_a = token[:6] if token else "SECURE"
    token_b = token[-6:] if token else "SEAL00"
    c.setStrokeColor(colors.HexColor("#7f1d1d"))
    c.setFillColor(colors.HexColor("#fff1f2"))
    c.setLineWidth(1.8)
    c.circle(seal_x, seal_y, 36, stroke=1, fill=1)
    c.setStrokeColor(colors.HexColor("#b91c1c"))
    c.setLineWidth(1.1)
    c.circle(seal_x, seal_y, 29, stroke=1, fill=0)
    c.circle(seal_x, seal_y, 22, stroke=1, fill=0)
    c.setFillColor(colors.HexColor("#b91c1c"))
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(seal_x, seal_y + 10, "CERTORA")
    c.drawCentredString(seal_x, seal_y + 1, token_a)
    c.drawCentredString(seal_x, seal_y - 8, token_b)
    c.setStrokeColor(colors.HexColor("#991b1b"))
    c.setLineWidth(0.9)
    c.line(seal_x - 14, seal_y, seal_x + 14, seal_y)
    c.line(seal_x, seal_y - 14, seal_x, seal_y + 14)
    c.line(seal_x - 10, seal_y - 10, seal_x + 10, seal_y + 10)
    c.line(seal_x - 10, seal_y + 10, seal_x + 10, seal_y - 10)

    c.showPage()
    c.save()
    settings = get_settings()
    if settings.resolved_object_storage_backend != "s3":
        raise RuntimeError("Certificate storage requires AWS S3 backend configuration.")
    return upload_file_to_cloud_storage(
        out_path,
        object_path=f"certificates/{CERTIFICATE_TEMPLATE_VERSION}/{certificate.certificate_id}.pdf",
        content_type="application/pdf",
    )


def ensure_certificate_pdf(db: Session, certificate: Certificate, *, force_regenerate: bool = False) -> Certificate:
    if certificate.pdf_url and not force_regenerate:
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
            return ensure_certificate_pdf(db, existing, force_regenerate=True)
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
    course = db.get(Course, certificate.course_id)
    provider = db.get(ProviderProfile, certificate.provider_id)
    student = db.get(User, certificate.student_id)
    result = db.get(Result, certificate.result_id)
    pdf_url = resolve_media_url(certificate.pdf_url) or _absolute_url(certificate.pdf_url)
    verification_link = safe_certificate_verification_url(certificate)
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
        "download_url": pdf_url,
        "verification_link": verification_link,
    }
