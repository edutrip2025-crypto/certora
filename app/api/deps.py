from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.entities import ApprovalStatus, User, UserApproval, UserRole
from app.services.firebase_auth import verify_firebase_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/firebase/login", auto_error=False)


def _dummy_user(
    db: Session,
    dummy_user_id: int | None,
    dummy_role: str | None,
    dummy_email: str | None,
    dummy_name: str | None,
) -> User:
    user_id = dummy_user_id or 1
    role_value = (dummy_role or UserRole.ADMIN.value).lower()
    email = dummy_email or f"dummy{user_id}@local.test"
    name = dummy_name or f"Dummy {role_value.title()}"
    try:
        role = UserRole(role_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid X-Dummy-Role header") from exc

    user = db.get(User, user_id)
    taken = db.scalar(select(User).where(User.email == email, User.id != user_id))
    if taken:
        local, _, domain = email.partition("@")
        domain_part = domain if domain else "local.test"
        email = f"{local}+u{user_id}@{domain_part}"
    if not user:
        user = User(
            id=user_id,
            email=email,
            full_name=name,
            password_hash="dummy",
            role=role,
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    user.role = role
    user.email = email
    user.full_name = name
    db.commit()
    db.refresh(user)
    return user


def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    x_dummy_user_id: int | None = Header(default=None),
    x_dummy_role: str | None = Header(default=None),
    x_dummy_email: str | None = Header(default=None),
    x_dummy_name: str | None = Header(default=None),
    x_dev_role: str | None = Header(default=None),
) -> User:
    settings = get_settings()
    if settings.auth_mode.lower() == "dummy":
        return _dummy_user(db, x_dummy_user_id, x_dummy_role, x_dummy_email, x_dummy_name)

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
    )
    if not token:
        raise credentials_exception
    try:
        payload = verify_firebase_token(token)
        firebase_uid = payload.get("uid")
        email = payload.get("email")
        name = payload.get("name") or (email.split("@")[0] if email else "Firebase User")
        if not firebase_uid:
            raise credentials_exception
    except Exception as exc:
        raise credentials_exception from exc

    user = db.scalar(select(User).where(User.email == email)) if email else None
    if not user:
        if email and email.lower() in settings.admin_email_set:
            user = User(
                email=email,
                full_name=name,
                password_hash="firebase",
                role=UserRole.ADMIN,
                is_active=True,
            )
            db.add(user)
            db.flush()
            approval = db.scalar(select(UserApproval).where(UserApproval.user_id == user.id))
            if not approval:
                db.add(
                    UserApproval(
                        user_id=user.id,
                        status=ApprovalStatus.APPROVED,
                        rejection_reason=None,
                    ),
                )
            else:
                approval.status = ApprovalStatus.APPROVED
                approval.rejection_reason = None
            db.commit()
            db.refresh(user)
            return user
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Account role not registered. Complete account setup first.",
        )

    effective_role = user.role
    if settings.allow_dev_role_override and x_dev_role and x_dev_role in {r.value for r in UserRole}:
        effective_role = UserRole(x_dev_role)
    if user.role != effective_role or user.full_name != name:
        user.role = effective_role
        user.full_name = name
        db.commit()
        db.refresh(user)
    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == user.id))
    if user.role != UserRole.ADMIN and not approval:
        db.add(
            UserApproval(
                user_id=user.id,
                status=ApprovalStatus.PENDING,
                rejection_reason=None,
            ),
        )
        db.commit()
    elif user.role == UserRole.ADMIN and approval and approval.status != ApprovalStatus.APPROVED:
        approval.status = ApprovalStatus.APPROVED
        approval.rejection_reason = None
        db.commit()
    return user


def is_user_approved(db: Session, user: User) -> tuple[bool, str | None]:
    if user.role == UserRole.ADMIN:
        return True, None
    approval = db.scalar(select(UserApproval).where(UserApproval.user_id == user.id))
    if not approval:
        return True, None
    if approval.status == ApprovalStatus.APPROVED:
        return True, None
    if approval.status == ApprovalStatus.REJECTED:
        return False, "Profile is invalid. Contact support."
    return False, "Profile is pending approval."


def require_role(*roles: UserRole, allow_unapproved: bool = False):
    def checker(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        if not allow_unapproved:
            approved, reason = is_user_approved(db, user)
            if not approved:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=reason)
        return user

    return checker
