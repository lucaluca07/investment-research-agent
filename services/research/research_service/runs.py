import json
from typing import Any
from uuid import uuid4

from .db import Database
from .models import ApprovalRequest, ChatMessage, ResearchRun, ResearchRunStep, StepStatus

RUNNING: StepStatus = "running"
WAITING_APPROVAL: StepStatus = "waiting_approval"
SUCCEEDED: StepStatus = "succeeded"
FAILED: StepStatus = "failed"
CANCELLED: StepStatus = "cancelled"


class IllegalTransition(RuntimeError):
    pass


class CitationOwnershipConflict(RuntimeError):
    pass


class RunStore:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create_run(self, chat_id: str, pi_session_id: str, model: str) -> ResearchRun:
        run_id = str(uuid4())
        with self.database.transaction() as connection:
            self._require_chat(connection, chat_id)
            created_at = connection.execute(
                "INSERT INTO research_runs (id, chat_id, pi_session_id, model) "
                "VALUES (?, ?, ?, ?) RETURNING created_at",
                [run_id, chat_id, pi_session_id, model],
            ).fetchone()[0]
        return ResearchRun(run_id, chat_id, pi_session_id, model, created_at)

    def create_chat(self, chat_id: str) -> None:
        with self.database.transaction() as connection:
            self.create_chat_in_transaction(connection, chat_id)

    @staticmethod
    def create_chat_in_transaction(connection: Any, chat_id: str) -> None:
        connection.execute("INSERT INTO chats (id) VALUES (?) ON CONFLICT DO NOTHING", [chat_id])

    def update_pi_session(self, chat_id: str, pi_session_id: str) -> None:
        with self.database.transaction() as connection:
            self._require_chat(connection, chat_id)
            connection.execute("UPDATE chats SET pi_session_id = ? WHERE id = ?", [pi_session_id, chat_id])

    def append_message(self, chat_id: str, role: str, content: str) -> ChatMessage:
        message_id = str(uuid4())
        with self.database.transaction() as connection:
            self._require_chat(connection, chat_id)
            created_at = connection.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content) VALUES (?, ?, ?, ?) "
                "RETURNING created_at",
                [message_id, chat_id, role, content],
            ).fetchone()[0]
        return ChatMessage(message_id, chat_id, role, content, created_at)

    def list_messages(self, chat_id: str) -> list[ChatMessage]:
        with self.database.transaction() as connection:
            self._require_chat(connection, chat_id)
            rows = connection.execute(
                "SELECT id, chat_id, role, content, created_at FROM chat_messages "
                "WHERE chat_id = ? ORDER BY created_at, id",
                [chat_id],
            ).fetchall()
        return [ChatMessage(*row) for row in rows]

    @staticmethod
    def _require_chat(connection: Any, chat_id: str) -> None:
        if connection.execute("SELECT 1 FROM chats WHERE id = ?", [chat_id]).fetchone() is None:
            raise KeyError(chat_id)

    def save_research_note(
        self,
        run_id: str,
        idempotency_key: str,
        input_hash: str,
        title: str,
        body: str,
        citation_ids: list[str],
        fault_after_note: bool = False,
    ) -> dict[str, Any]:
        with self.database.transaction() as connection:
            if connection.execute("SELECT 1 FROM research_runs WHERE id = ?", [run_id]).fetchone() is None:
                raise KeyError(run_id)
            existing = connection.execute(
                "SELECT id, status, input_hash, result_json FROM research_run_steps "
                "WHERE run_id = ? AND idempotency_key = ?",
                [run_id, idempotency_key],
            ).fetchone()
            if existing:
                if existing[2] != input_hash:
                    raise ValueError("input hash differs for idempotency key")
                if existing[1] != SUCCEEDED:
                    raise IllegalTransition(f"step is already {existing[1]}")
                return _json_object(existing[3]) or {}

            owned = connection.execute(
                "SELECT id FROM citations WHERE id IN (SELECT UNNEST(?)) AND note_id IS NOT NULL",
                [citation_ids],
            ).fetchone()
            if owned:
                raise CitationOwnershipConflict(f"citation already belongs to a note: {owned[0]}")

            step_id = str(uuid4())
            connection.execute(
                "INSERT INTO research_run_steps "
                "(id, run_id, step_name, status, idempotency_key, input_hash, started_at) "
                "VALUES (?, ?, 'save_note', 'running', ?, ?, CURRENT_TIMESTAMP)",
                [step_id, run_id, idempotency_key, input_hash],
            )
            note_id = str(uuid4())
            connection.execute(
                "INSERT INTO research_notes (id, run_id, title, body) VALUES (?, ?, ?, ?)",
                [note_id, run_id, title, body],
            )
            if fault_after_note:
                raise RuntimeError("test fault after note insertion")
            for citation_id in citation_ids:
                connection.execute(
                    "UPDATE citations SET note_id = ? WHERE id = ?", [note_id, citation_id]
                )
            result = {"note_id": note_id, "citation_ids": citation_ids}
            connection.execute(
                "UPDATE research_run_steps SET status = 'succeeded', result_json = ?, "
                "completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [json.dumps(result), step_id],
            )
            return result

    def start_step(
        self, run_id: str, step_name: str, idempotency_key: str, input_hash: str
    ) -> ResearchRunStep:
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT id, step_name, status, input_hash, result_json, error_json, retryable "
                "FROM research_run_steps WHERE run_id = ? AND idempotency_key = ?",
                [run_id, idempotency_key],
            ).fetchone()
            if existing:
                if existing[3] != input_hash:
                    raise ValueError("input hash differs for idempotency key")
                if existing[2] == SUCCEEDED:
                    return self._step_from_row(run_id, idempotency_key, existing)
                raise IllegalTransition(f"step is already {existing[2]}")

            step_id = str(uuid4())
            connection.execute(
                "INSERT INTO research_run_steps "
                "(id, run_id, step_name, status, idempotency_key, input_hash, started_at) "
                "VALUES (?, ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP)",
                [step_id, run_id, step_name, idempotency_key, input_hash],
            )
        return ResearchRunStep(step_id, run_id, step_name, "running", idempotency_key, input_hash)

    def get_step(self, step_id: str) -> ResearchRunStep:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT id, run_id, step_name, status, idempotency_key, input_hash, "
                "result_json, error_json, retryable FROM research_run_steps WHERE id = ?",
                [step_id],
            ).fetchone()
        if row is None:
            raise KeyError(step_id)
        return self._step_from_row_values(row)

    def request_approval(self, step_id: str, payload: dict[str, Any]) -> None:
        with self.database.transaction() as connection:
            self._require_status(connection, step_id, {RUNNING})
            connection.execute(
                "UPDATE research_run_steps SET status = 'waiting_approval' WHERE id = ?", [step_id]
            )
            connection.execute(
                "INSERT INTO approval_requests (id, step_id, payload_json, status) VALUES (?, ?, ?, 'pending')",
                [str(uuid4()), step_id, json.dumps(payload)],
            )

    def approve(self, step_id: str, actor: str) -> None:
        self._resolve_approval(step_id, "approved", actor, None, "running")

    def reject(self, step_id: str, actor: str, reason: str) -> None:
        self._resolve_approval(step_id, "rejected", actor, reason, "cancelled")

    def get_approval(self, step_id: str) -> ApprovalRequest:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT id, step_id, status, payload_json, actor, reason "
                "FROM approval_requests WHERE step_id = ? ORDER BY created_at DESC LIMIT 1",
                [step_id],
            ).fetchone()
        if row is None:
            raise KeyError(step_id)
        return ApprovalRequest(row[0], row[1], row[2], _json_object(row[3]) or {}, row[4], row[5])

    def succeed(self, step_id: str, result: dict[str, Any]) -> None:
        with self.database.transaction() as connection:
            self._require_status(connection, step_id, {RUNNING})
            connection.execute(
                "UPDATE research_run_steps SET status = 'succeeded', result_json = ?, "
                "completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [json.dumps(result), step_id],
            )

    def fail(self, step_id: str, error: dict[str, Any], retryable: bool) -> None:
        with self.database.transaction() as connection:
            self._require_status(connection, step_id, {RUNNING})
            connection.execute(
                "UPDATE research_run_steps SET status = 'failed', error_json = ?, retryable = ?, "
                "completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [json.dumps(error), retryable, step_id],
            )

    def retry(self, step_id: str) -> None:
        with self.database.transaction() as connection:
            row = self._require_status(connection, step_id, {FAILED})
            if not row[1]:
                raise IllegalTransition("failed step is not retryable")
            connection.execute(
                "UPDATE research_run_steps SET status = 'running', error_json = NULL, "
                "started_at = CURRENT_TIMESTAMP, completed_at = NULL WHERE id = ?",
                [step_id],
            )

    @staticmethod
    def _require_status(connection: Any, step_id: str, allowed: set[str]) -> tuple[Any, ...]:
        row = connection.execute(
            "SELECT status, retryable FROM research_run_steps WHERE id = ?", [step_id]
        ).fetchone()
        if row is None:
            raise KeyError(step_id)
        if row[0] not in allowed:
            raise IllegalTransition(f"cannot transition from {row[0]}")
        return row

    def _resolve_approval(
        self, step_id: str, approval_status: str, actor: str, reason: str | None, step_status: str
    ) -> None:
        with self.database.transaction() as connection:
            self._require_status(connection, step_id, {WAITING_APPROVAL})
            connection.execute(
                "UPDATE approval_requests SET status = ?, actor = ?, reason = ?, "
                "resolved_at = CURRENT_TIMESTAMP WHERE step_id = ? AND status = 'pending'",
                [approval_status, actor, reason, step_id],
            )
            connection.execute(
                "UPDATE research_run_steps SET status = ?, completed_at = "
                "CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?",
                [step_status, step_status, step_id],
            )

    @staticmethod
    def _step_from_row(run_id: str, idempotency_key: str, row: tuple[Any, ...]) -> ResearchRunStep:
        return ResearchRunStep(
            row[0], run_id, row[1], row[2], idempotency_key, row[3],
            _json_object(row[4]), _json_object(row[5]), row[6],
        )

    @staticmethod
    def _step_from_row_values(row: tuple[Any, ...]) -> ResearchRunStep:
        return ResearchRunStep(
            row[0], row[1], row[2], row[3], row[4], row[5],
            _json_object(row[6]), _json_object(row[7]), row[8],
        )


def _json_object(value: str | dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None or isinstance(value, dict):
        return value
    return json.loads(value)
