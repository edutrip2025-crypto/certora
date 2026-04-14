from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db
from app.models.entities import ApprovalStatus, User, UserApproval, UserRole
from app.schemas import LoginRequest, RegisterRoleRequest, SignupRequest, TokenResponse, UserOut
from app.services.firebase_auth import set_firebase_custom_claims, verify_firebase_token

router = APIRouter(prefix="/auth", tags=["auth"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/firebase/login", auto_error=False)


def _public_uid(user_id: int | None) -> str:
    if not user_id:
        return "CR-000000"
    return f"CR-{int(user_id):06d}"


def _safe_sync_claims(firebase_uid: str, user: User, approval_status: ApprovalStatus) -> None:
    try:
        set_firebase_custom_claims(
            firebase_uid,
            {
                "role": user.role.value,
                "approval_status": approval_status.value,
                "app_user_id": user.id,
                "is_active": bool(user.is_active),
            },
        )
    except Exception:
        # Keep auth flow resilient even when Firebase admin claim writes fail.
        pass


def _firebase_identity_or_401(token: str | None) -> tuple[str, str | None, str, dict]:
    if not token:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    try:
        payload = verify_firebase_token(token)
        firebase_uid = payload.get("uid")
        email = payload.get("email")
        name = payload.get("name") or (email.split("@")[0] if email else "Firebase User")
        if not firebase_uid:
            raise HTTPException(status_code=401, detail="Could not validate credentials")
        return str(firebase_uid), email, str(name), payload
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Could not validate credentials") from exc


@router.post("/signup", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing:
        raise HTTPException(status_code=400, detail="Email already in use")
    user = User(
        email=payload.email,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(str(user.id), user.role.value)
    return TokenResponse(access_token=token, role=user.role)


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/me/context")
def me_context(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    firebase_uid, email, fallback_name, token_payload = _firebase_identity_or_401(token)
    email_norm = str(email or "").strip().lower() or None
    current_user = db.scalar(select(User).where(func.lower(User.email) == email_norm)) if email_norm else None
    settings = get_settings()
    if not current_user:
        role_claim = str(token_payload.get("role") or "").strip().lower()
        approval_claim = str(token_payload.get("approval_status") or "").strip().lower()
        if email_norm and email_norm in settings.admin_email_set:
            current_user = User(
                email=email_norm,
                full_name=fallback_name,
                password_hash="firebase",
                role=UserRole.ADMIN,
                is_active=True,
            )
            db.add(current_user)
            db.flush()
            approval = db.scalar(select(UserApproval).where(UserApproval.user_id == current_user.id))
            if not approval:
                db.add(
                    UserApproval(
                        user_id=current_user.id,
                        status=ApprovalStatus.APPROVED,
                        rejection_reason=None,
                    ),
                )
            else:
                approval.status = ApprovalStatus.APPROVED
                approval.rejection_reason = None
            db.commit()
            db.refresh(current_user)
            _safe_sync_claims(firebase_uid, current_user, ApprovalStatus.APPROVED)
        elif role_claim in {r.value for r in UserRole}:
            role = UserRole(role_claim)
            if role == UserRole.ADMIN and (not email_norm or email_norm not in settings.admin_email_set):
                return {
                    "setup_required": True,
                    "firebase_uid": firebase_uid,
                    "email": email_norm,
                    "full_name": fallback_name,
                }
            current_user = User(
                email=email_norm or f"{firebase_uid}@firebase.local",
                full_name=fallback_name,
                password_hash="firebase",
                role=role,
                is_active=True,
            )
            db.add(current_user)
            db.flush()
            approval = db.scalar(select(UserApproval).where(UserApproval.user_id == current_user.id))
            if not approval:
                approval = UserApproval(user_id=current_user.id)
                db.add(approval)
            if role == UserRole.ADMIN:
                approval.status = ApprovalStatus.APPROVED
            elif role == UserRole.STUDENT:
                approval.status = ApprovalStatus.APPROVED
            elif approval_claim in {ApprovalStatus.APPROVED.value, ApprovalStatus.REJECTED.value, ApprovalStatus.PENDING.value}:
                approval.status = ApprovalStatus(approval_claim)
            else:
                approval.status = ApprovalStatus.PENDING
            approval.rejection_reason = None
            db.commit()
            db.refresh(current_user)
            _safe_sync_claims(firebase_uid, current_user, approval.status)
        else:
            return {
                "setup_required": True,
                "firebase_uid": firebase_uid,
                "email": email_norm,
                "full_name": fallback_name,
            }
    else:
        changed = False
        if email_norm and email_norm in settings.admin_email_set and current_user.role != UserRole.ADMIN:
            current_user.role = UserRole.ADMIN
            changed = True
        if current_user.full_name != fallback_name:
            current_user.full_name = fallback_name
            changed = True
        if changed:
            db.commit()
            db.refresh(current_user)

    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == current_user.id))
    if not approval:
        default_status = ApprovalStatus.APPROVED if current_user.role in {UserRole.ADMIN, UserRole.STUDENT} else ApprovalStatus.PENDING
        approval = UserApproval(
            user_id=current_user.id,
            status=default_status,
            rejection_reason=None,
        )
        db.add(approval)
        db.commit()
        db.refresh(current_user)
    elif current_user.role in {UserRole.ADMIN, UserRole.STUDENT} and approval.status != ApprovalStatus.APPROVED:
        approval.status = ApprovalStatus.APPROVED
        approval.rejection_reason = None
        db.commit()
    approval_status = approval.status
    rejection_reason = approval.rejection_reason
    _safe_sync_claims(firebase_uid, current_user, approval_status)
    return {
        "setup_required": False,
        "id": current_user.id,
        "public_uid": _public_uid(current_user.id),
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": current_user.role,
        "approval_status": approval_status,
        "rejection_reason": rejection_reason,
    }


@router.post("/register-role", response_model=UserOut)
def register_role(
    payload: RegisterRoleRequest,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    firebase_uid, email, fallback_name, _ = _firebase_identity_or_401(token)
    email_norm = str(email or "").strip().lower() or None
    settings = get_settings()
    if payload.role == UserRole.ADMIN and (not email_norm or email_norm not in settings.admin_email_set):
        raise HTTPException(status_code=403, detail="Admin role can only be assigned to configured admin accounts")
    current_user = db.scalar(select(User).where(func.lower(User.email) == email_norm)) if email_norm else None
    if not current_user:
        current_user = User(
            email=email_norm or f"{firebase_uid}@firebase.local",
            full_name=payload.full_name or fallback_name,
            password_hash="firebase",
            role=payload.role,
            is_active=True,
        )
        db.add(current_user)
        db.flush()
    else:
        current_user.full_name = payload.full_name or fallback_name
        current_user.role = payload.role

    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == current_user.id))
    if not approval:
        approval = UserApproval(user_id=current_user.id)
        db.add(approval)
    if payload.role == UserRole.ADMIN:
        approval.status = ApprovalStatus.APPROVED
        approval.rejection_reason = None
    elif payload.role == UserRole.STUDENT:
        approval.status = ApprovalStatus.APPROVED
        approval.rejection_reason = None
    else:
        approval.status = ApprovalStatus.PENDING
        approval.rejection_reason = None
    db.commit()
    db.refresh(current_user)
    _safe_sync_claims(firebase_uid, current_user, approval.status)
    return current_user
