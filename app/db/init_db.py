from sqlalchemy import text

from app.db.session import SessionLocal, engine
from app.models.entities import Base
from app.services.account_rules import sync_existing_accounts


def _migrate_proctor_training_feedback_nullable_attempt_id(conn) -> None:
    """Allow NULL attempt_id for preview-session training labels (legacy SQLite was NOT NULL)."""
    rows = conn.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='proctor_training_feedback'")).fetchall()
    if not rows:
        return
    cols = conn.execute(text("PRAGMA table_info(proctor_training_feedback)")).fetchall()
    att = next((r for r in cols if r[1] == "attempt_id"), None)
    if not att or int(att[3] or 0) == 0:
        return
    conn.execute(text("PRAGMA foreign_keys=OFF"))
    conn.execute(text("DROP TABLE IF EXISTS proctor_training_feedback__mig"))
    conn.execute(
        text(
            """
            CREATE TABLE proctor_training_feedback__mig (
                id INTEGER NOT NULL PRIMARY KEY,
                attempt_id INTEGER REFERENCES exam_attempts(id),
                result_id INTEGER REFERENCES results(id),
                session_id INTEGER REFERENCES proctor_sessions(id),
                actor_user_id INTEGER NOT NULL REFERENCES users(id),
                feedback_label VARCHAR(20) NOT NULL,
                comment TEXT,
                model_decision VARCHAR(40),
                model_probability FLOAT,
                final_result_passed BOOLEAN,
                created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
            )
            """
        ),
    )
    conn.execute(text("INSERT INTO proctor_training_feedback__mig SELECT * FROM proctor_training_feedback"))
    conn.execute(text("DROP TABLE proctor_training_feedback"))
    conn.execute(text("ALTER TABLE proctor_training_feedback__mig RENAME TO proctor_training_feedback"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_proctor_training_feedback_attempt_id ON proctor_training_feedback (attempt_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_proctor_training_feedback_result_id ON proctor_training_feedback (result_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_proctor_training_feedback_session_id ON proctor_training_feedback (session_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_proctor_training_feedback_actor_user_id ON proctor_training_feedback (actor_user_id)"))
    conn.execute(text("PRAGMA foreign_keys=ON"))


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name == "sqlite":
        with engine.begin() as conn:
            cols = conn.execute(text("PRAGMA table_info(lesson_topics)")).fetchall()
            col_names = {row[1] for row in cols}
            if "thumbnail_data_url" not in col_names:
                conn.execute(text("ALTER TABLE lesson_topics ADD COLUMN thumbnail_data_url TEXT"))

            exam_cols = conn.execute(text("PRAGMA table_info(exams)")).fetchall()
            exam_col_names = {row[1] for row in exam_cols}
            if "timing_mode" not in exam_col_names:
                conn.execute(text("ALTER TABLE exams ADD COLUMN timing_mode TEXT DEFAULT 'assessment'"))
            if "time_per_question_seconds" not in exam_col_names:
                conn.execute(text("ALTER TABLE exams ADD COLUMN time_per_question_seconds INTEGER"))
            if "questions_per_attempt" not in exam_col_names:
                conn.execute(text("ALTER TABLE exams ADD COLUMN questions_per_attempt INTEGER DEFAULT 0"))

            attempt_cols = conn.execute(text("PRAGMA table_info(exam_attempts)")).fetchall()
            attempt_col_names = {row[1] for row in attempt_cols}
            if "assigned_question_ids" not in attempt_col_names:
                conn.execute(text("ALTER TABLE exam_attempts ADD COLUMN assigned_question_ids JSON"))

            _migrate_proctor_training_feedback_nullable_attempt_id(conn)
    elif engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            try:
                conn.execute(text("ALTER TABLE proctor_training_feedback ALTER COLUMN attempt_id DROP NOT NULL"))
            except Exception:
                pass

    # Backfill and normalize existing accounts to current role/approval rules, then sync Firebase claims.
    db = SessionLocal()
    try:
        sync_existing_accounts(
            db,
            apply_legacy_student_approval_rollback=False,
            sync_firebase_claims=True,
        )
    finally:
        db.close()
