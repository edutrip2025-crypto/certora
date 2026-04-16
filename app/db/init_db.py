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


def _sqlite_add_column_if_missing(conn, table: str, column: str, ddl_suffix: str) -> None:
    rows = conn.execute(text(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table}'")).fetchall()
    if not rows:
        return
    cols = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    names = {row[1] for row in cols}
    if column in names:
        return
    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_suffix}"))


def _migrate_live_class_schema_sqlite(conn) -> None:
    # live_class_sessions incremental columns
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "timezone", "TEXT DEFAULT 'UTC'")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "meeting_mode", "TEXT DEFAULT 'in_app'")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "external_meeting_url", "TEXT")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "status", "TEXT DEFAULT 'scheduled'")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "scheduled_start_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "scheduled_end_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "started_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "ended_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "max_participants", "INTEGER DEFAULT 200")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "allow_chat", "BOOLEAN DEFAULT 1")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "allow_raise_hand", "BOOLEAN DEFAULT 1")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "allow_reactions", "BOOLEAN DEFAULT 1")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "board_text", "TEXT")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "active_poll_key", "TEXT")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "active_poll_question", "TEXT")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "active_poll_options_json", "JSON DEFAULT '[]'")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "active_poll_open", "BOOLEAN DEFAULT 0")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP")
    _sqlite_add_column_if_missing(conn, "live_class_sessions", "updated_at", "DATETIME DEFAULT CURRENT_TIMESTAMP")

    # live_class_participants incremental columns
    _sqlite_add_column_if_missing(conn, "live_class_participants", "actor_role", "TEXT DEFAULT 'student'")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "display_name", "TEXT")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "is_present", "BOOLEAN DEFAULT 1")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "raised_hand", "BOOLEAN DEFAULT 0")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "joined_at", "DATETIME DEFAULT CURRENT_TIMESTAMP")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "left_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "live_class_participants", "last_seen_at", "DATETIME DEFAULT CURRENT_TIMESTAMP")

    # live_class_messages payload field
    _sqlite_add_column_if_missing(conn, "live_class_messages", "payload_json", "JSON DEFAULT '{}'")


def _migrate_live_class_schema_postgres(conn) -> None:
    # `IF NOT EXISTS` keeps this idempotent across deploys.
    statements = [
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS timezone VARCHAR(80) DEFAULT 'UTC'",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS meeting_mode VARCHAR(20) DEFAULT 'in_app'",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS external_meeting_url VARCHAR(1000)",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'scheduled'",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS max_participants INTEGER DEFAULT 200",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS allow_chat BOOLEAN DEFAULT TRUE",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS allow_raise_hand BOOLEAN DEFAULT TRUE",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS allow_reactions BOOLEAN DEFAULT TRUE",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS board_text TEXT",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS active_poll_key VARCHAR(64)",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS active_poll_question TEXT",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS active_poll_options_json JSON DEFAULT '[]'::json",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS active_poll_open BOOLEAN DEFAULT FALSE",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
        "ALTER TABLE live_class_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS actor_role VARCHAR(20) DEFAULT 'student'",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS display_name VARCHAR(200)",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS is_present BOOLEAN DEFAULT TRUE",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS raised_hand BOOLEAN DEFAULT FALSE",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT NOW()",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ",
        "ALTER TABLE live_class_participants ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()",
        "ALTER TABLE live_class_messages ADD COLUMN IF NOT EXISTS payload_json JSON DEFAULT '{}'::json",
    ]
    for stmt in statements:
        try:
            conn.execute(text(stmt))
        except Exception:
            # Keep startup resilient even on partially-migrated datasets.
            pass


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
            _migrate_live_class_schema_sqlite(conn)
    elif engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            try:
                conn.execute(text("ALTER TABLE proctor_training_feedback ALTER COLUMN attempt_id DROP NOT NULL"))
            except Exception:
                pass
            _migrate_live_class_schema_postgres(conn)

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
