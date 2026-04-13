from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db
from app.models.entities import ApprovalStatus, User, UserApproval, UserRole
from app.schemas import LoginRequest, RegisterRoleRequest, SignupRequest, TokenResponse, UserOut
from app.services.firebase_auth import set_firebase_custom_claims, verify_firebase_token

router = APIRouter(prefix="/auth", tags=["auth"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/firebase/login", auto_error=False)


def _firebase_identity_or_401(token: str | None) -> tuple[str, str | None, str]:
    if not token:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    try:
        payload = verify_firebase_token(token)
        firebase_uid = payload.get("uid")
        email = payload.get("email")
        name = payload.get("name") or (email.split("@")[0] if email else "Firebase User")
        if not firebase_uid:
            raise HTTPException(status_code=401, detail="Could not validate credentials")
        return str(firebase_uid), email, str(name)
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
def me_context(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == current_user.id))
    approval_status = approval.status if approval else ApprovalStatus.APPROVED
    rejection_reason = approval.rejection_reason if approval else None
    return {
        "id": current_user.id,
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
    firebase_uid, email, fallback_name = _firebase_identity_or_401(token)
    current_user = db.scalar(select(User).where(User.email == email)) if email else None
    if not current_user:
        current_user = User(
            email=email or f"{firebase_uid}@firebase.local",
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
    else:
        approval.status = ApprovalStatus.PENDING
        approval.rejection_reason = None
    set_firebase_custom_claims(firebase_uid, {"role": payload.role.value})
    db.commit()
    db.refresh(current_user)
    return current_user
