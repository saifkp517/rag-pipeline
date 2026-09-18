"""Postgres-backed registry of uploaded documents and the bots built on them.

Pinecone serverless can't delete by metadata filter, so the vector IDs
produced during ingestion are stored here and replayed back to Pinecone on
delete. Bot/document assignment is many-to-many so one upload can feed
several bots without being re-embedded per bot.
"""

import json
import os
import re
import uuid
from typing import Any

from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

load_dotenv()

_pool = ConnectionPool(
    os.environ["DATABASE_URL"],
    min_size=1,
    max_size=5,
    kwargs={"row_factory": dict_row},
    open=False,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id          UUID PRIMARY KEY,
    filename    TEXT        NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    node_count  INTEGER     NOT NULL DEFAULT 0,
    status      TEXT        NOT NULL DEFAULT 'processing'
);

CREATE TABLE IF NOT EXISTS document_chunks (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    vector_id   TEXT NOT NULL,
    PRIMARY KEY (document_id, vector_id)
);

CREATE TABLE IF NOT EXISTS bots (
    id            UUID PRIMARY KEY,
    slug          TEXT        NOT NULL UNIQUE,
    name          TEXT        NOT NULL,
    system_prompt TEXT        NOT NULL,
    guardrails    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_documents (
    bot_id      UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (bot_id, document_id)
);

-- A conversation. There is no explicit open/closed column: a session is
-- active while last_message_at is inside SESSION_WINDOW, and expiry is
-- evaluated when the next message arrives rather than by a background job.
CREATE TABLE IF NOT EXISTS chat_sessions (
    id              UUID PRIMARY KEY,
    bot_id          UUID        NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_bot_idx
    ON chat_sessions (bot_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         BIGSERIAL   PRIMARY KEY,
    session_id UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL,
    content    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
    ON chat_messages (session_id, id);
"""

# How long a conversation stays open after its most recent message. Held as
# a literal because it is interpolated into an interval, never user input.
SESSION_WINDOW = "24 hours"


def _active_clause(prefix: str = "") -> str:
    """SQL predicate for 'this conversation is still open'."""
    return f"{prefix}last_message_at > now() - interval '{SESSION_WINDOW}'"


def init_schema() -> None:
    _pool.open()
    with _pool.connection() as conn:
        conn.execute(SCHEMA)


# --- documents ---------------------------------------------------------


def create_document(filename: str) -> str:
    document_id = str(uuid.uuid4())
    with _pool.connection() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, status) VALUES (%s, %s, 'processing')",
            (document_id, filename),
        )
    return document_id


def mark_document_ready(document_id: str, vector_ids: list[str]) -> None:
    with _pool.connection() as conn, conn.transaction():
        if vector_ids:
            conn.cursor().executemany(
                "INSERT INTO document_chunks (document_id, vector_id) VALUES (%s, %s)"
                " ON CONFLICT DO NOTHING",
                [(document_id, vector_id) for vector_id in vector_ids],
            )
        conn.execute(
            "UPDATE documents SET status = 'ready', node_count = %s WHERE id = %s",
            (len(vector_ids), document_id),
        )


def mark_document_failed(document_id: str) -> None:
    with _pool.connection() as conn:
        conn.execute(
            "UPDATE documents SET status = 'failed' WHERE id = %s", (document_id,)
        )


def list_documents() -> list[dict[str, Any]]:
    with _pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, filename, uploaded_at, node_count, status"
            " FROM documents ORDER BY uploaded_at DESC"
        ).fetchall()
    return [_serialize_document(row) for row in rows]


def delete_document(document_id: str) -> list[str] | None:
    """Remove a document and return the vector IDs its chunks occupy.

    Returns None when no such document exists. Callers are expected to
    delete the returned IDs from Pinecone.
    """
    with _pool.connection() as conn, conn.transaction():
        exists = conn.execute(
            "SELECT 1 FROM documents WHERE id = %s", (document_id,)
        ).fetchone()
        if exists is None:
            return None

        rows = conn.execute(
            "SELECT vector_id FROM document_chunks WHERE document_id = %s",
            (document_id,),
        ).fetchall()
        # bot_documents and document_chunks both cascade from here.
        conn.execute("DELETE FROM documents WHERE id = %s", (document_id,))

    return [row["vector_id"] for row in rows]


# --- bots --------------------------------------------------------------


def create_bot(
    name: str, system_prompt: str, guardrails: dict[str, Any], document_ids: list[str]
) -> dict[str, Any]:
    bot_id = str(uuid.uuid4())
    with _pool.connection() as conn, conn.transaction():
        slug = _unique_slug(conn, name)
        conn.execute(
            "INSERT INTO bots (id, slug, name, system_prompt, guardrails)"
            " VALUES (%s, %s, %s, %s, %s)",
            (bot_id, slug, name, system_prompt, json.dumps(guardrails)),
        )
        _replace_bot_documents(conn, bot_id, document_ids)
    return get_bot(bot_id)


def update_bot(
    bot_id: str,
    name: str | None,
    system_prompt: str | None,
    guardrails: dict[str, Any] | None,
    document_ids: list[str] | None,
) -> dict[str, Any] | None:
    with _pool.connection() as conn, conn.transaction():
        exists = conn.execute("SELECT 1 FROM bots WHERE id = %s", (bot_id,)).fetchone()
        if exists is None:
            return None

        if name is not None:
            conn.execute("UPDATE bots SET name = %s WHERE id = %s", (name, bot_id))
        if system_prompt is not None:
            conn.execute(
                "UPDATE bots SET system_prompt = %s WHERE id = %s",
                (system_prompt, bot_id),
            )
        if guardrails is not None:
            conn.execute(
                "UPDATE bots SET guardrails = %s WHERE id = %s",
                (json.dumps(guardrails), bot_id),
            )
        if document_ids is not None:
            _replace_bot_documents(conn, bot_id, document_ids)

    return get_bot(bot_id)


def get_bot(bot_id_or_slug: str) -> dict[str, Any] | None:
    with _pool.connection() as conn:
        row = conn.execute(
            "SELECT id, slug, name, system_prompt, guardrails, created_at"
            " FROM bots WHERE slug = %s OR id::text = %s",
            (bot_id_or_slug, bot_id_or_slug),
        ).fetchone()
        if row is None:
            return None
        return _serialize_bot(row, _document_rows(conn, row["id"]))


def list_bots() -> list[dict[str, Any]]:
    with _pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, slug, name, system_prompt, guardrails, created_at"
            " FROM bots ORDER BY created_at DESC"
        ).fetchall()
        return [_serialize_bot(row, _document_rows(conn, row["id"])) for row in rows]


def delete_bot(bot_id: str) -> bool:
    with _pool.connection() as conn:
        # Assignments cascade; the documents themselves are shared and stay.
        result = conn.execute("DELETE FROM bots WHERE id = %s", (bot_id,))
    return result.rowcount > 0


def bot_document_ids(bot_id: str) -> list[str]:
    with _pool.connection() as conn:
        rows = conn.execute(
            "SELECT document_id FROM bot_documents WHERE bot_id = %s", (bot_id,)
        ).fetchall()
    return [str(row["document_id"]) for row in rows]


# --- chat sessions -----------------------------------------------------


def resolve_session(bot_id: str, session_id: str | None) -> str:
    """Return the session a new message belongs to, creating one if needed.

    The caller's session is reused only while it is still inside the active
    window; once it has expired the old conversation is left untouched for
    history and a fresh one is started. This is the only place the 24-hour
    rule is enforced, so no sweeper job is needed.
    """
    with _pool.connection() as conn, conn.transaction():
        if session_id:
            # id::text avoids a cast error when a client sends a stale or
            # malformed id rather than a UUID.
            row = conn.execute(
                "SELECT id FROM chat_sessions"
                f" WHERE id::text = %s AND bot_id = %s AND {_active_clause()}",
                (session_id, bot_id),
            ).fetchone()
            if row is not None:
                return str(row["id"])

        new_session_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO chat_sessions (id, bot_id) VALUES (%s, %s)",
            (new_session_id, bot_id),
        )
        return new_session_id


def append_message(session_id: str, role: str, content: str) -> None:
    """Store one message and extend the session's active window."""
    with _pool.connection() as conn, conn.transaction():
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, content)"
            " VALUES (%s, %s, %s)",
            (session_id, role, content),
        )
        conn.execute(
            "UPDATE chat_sessions SET last_message_at = now() WHERE id = %s",
            (session_id,),
        )


def session_history(session_id: str, limit: int = 50) -> list[dict[str, str]]:
    """Return the most recent messages of a session, oldest first.

    Bounded so a long conversation doesn't grow the per-turn query without
    limit; the chat memory trims to its token budget on top of this.
    """
    with _pool.connection() as conn:
        rows = conn.execute(
            "SELECT role, content FROM ("
            "  SELECT id, role, content FROM chat_messages"
            "  WHERE session_id = %s ORDER BY id DESC LIMIT %s"
            ") recent ORDER BY id",
            (session_id, limit),
        ).fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in rows]


def list_sessions(bot_id: str) -> list[dict[str, Any]]:
    with _pool.connection() as conn:
        rows = conn.execute(
            "SELECT s.id, s.created_at, s.last_message_at,"
            f"       ({_active_clause('s.')}) AS active,"
            "       (SELECT count(*) FROM chat_messages m"
            "         WHERE m.session_id = s.id) AS message_count,"
            "       (SELECT m.content FROM chat_messages m"
            "         WHERE m.session_id = s.id AND m.role = 'user'"
            "         ORDER BY m.id LIMIT 1) AS preview"
            " FROM chat_sessions s WHERE s.bot_id = %s"
            " ORDER BY s.last_message_at DESC",
            (bot_id,),
        ).fetchall()
    return [_serialize_session(row) for row in rows]


def list_messages(session_id: str) -> list[dict[str, Any]] | None:
    """Full transcript of one session, or None when it doesn't exist."""
    with _pool.connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM chat_sessions WHERE id::text = %s", (session_id,)
        ).fetchone()
        if exists is None:
            return None

        rows = conn.execute(
            "SELECT id, role, content, created_at FROM chat_messages"
            " WHERE session_id = %s ORDER BY id",
            (session_id,),
        ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "role": row["role"],
            "content": row["content"],
            "created_at": row["created_at"].isoformat(),
        }
        for row in rows
    ]


def delete_session(session_id: str) -> bool:
    with _pool.connection() as conn:
        # Messages cascade from the session row.
        result = conn.execute(
            "DELETE FROM chat_sessions WHERE id::text = %s", (session_id,)
        )
    return result.rowcount > 0


# --- helpers -----------------------------------------------------------


def _replace_bot_documents(conn, bot_id: str, document_ids: list[str]) -> None:
    conn.execute("DELETE FROM bot_documents WHERE bot_id = %s", (bot_id,))
    if document_ids:
        conn.cursor().executemany(
            "INSERT INTO bot_documents (bot_id, document_id) VALUES (%s, %s)",
            [(bot_id, document_id) for document_id in document_ids],
        )


def _document_rows(conn, bot_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT d.id, d.filename, d.uploaded_at, d.node_count, d.status"
        " FROM documents d"
        " JOIN bot_documents bd ON bd.document_id = d.id"
        " WHERE bd.bot_id = %s"
        " ORDER BY d.uploaded_at DESC",
        (bot_id,),
    ).fetchall()
    return [_serialize_document(row) for row in rows]


def _unique_slug(conn, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "bot"
    slug = base
    suffix = 2
    while conn.execute("SELECT 1 FROM bots WHERE slug = %s", (slug,)).fetchone():
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def _serialize_document(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "filename": row["filename"],
        "uploaded_at": row["uploaded_at"].isoformat(),
        "node_count": row["node_count"],
        "status": row["status"],
    }


def _serialize_session(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "created_at": row["created_at"].isoformat(),
        "last_message_at": row["last_message_at"].isoformat(),
        "active": row["active"],
        "message_count": row["message_count"],
        "preview": row["preview"],
    }


def _serialize_bot(row: dict[str, Any], documents: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "slug": row["slug"],
        "name": row["name"],
        "system_prompt": row["system_prompt"],
        "guardrails": row["guardrails"],
        "created_at": row["created_at"].isoformat(),
        "documents": documents,
    }
