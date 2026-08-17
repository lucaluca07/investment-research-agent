"""Durable interrupt approval state machine for AG-UI runs."""
import json
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from .agui_store import canonical_json, payload_hash
from .db import Database


class InterruptError(ValueError):
    status_code = 422


class InterruptNotFound(InterruptError):
    status_code = 404


class InterruptConflict(InterruptError):
    status_code = 409


class InterruptStore:
    def __init__(self, database: Database):
        self.database = database

    def request_interrupt(self, thread_id: str, interrupt_id: str, *, run_id: str,
                          nonce: str, tool_name: str = "", input_value: Any = None,
                          tool_operation_id: str | None = None,
                          last_event_seq: int | None = None, tool_call_id: str | None = None,
                          pi_session_id: str | None = None, pi_session_revision: int | None = None,
                          pi_session_storage_ref: str | None = None) -> dict[str, Any]:
        if not interrupt_id or not nonce:
            raise InterruptError("interrupt_id and nonce are required")
        input_value = {} if input_value is None else input_value
        session = self._session_state(pi_session_id, pi_session_revision, pi_session_storage_ref)
        with self.database.transaction() as c:
            run = c.execute("SELECT id FROM runs WHERE id=? AND thread_id=?", [run_id, thread_id]).fetchone()
            if not run:
                raise InterruptNotFound("run not found")
            existing = c.execute("SELECT id FROM agent_checkpoints WHERE thread_id=? AND interrupt_id=?", [thread_id, interrupt_id]).fetchone()
            if existing:
                current = self._read(c, thread_id, interrupt_id)
                if current.get("nonce") != nonce or current.get("run_id") != run_id or current.get("tool_name") != tool_name or current.get("input") != input_value:
                    raise InterruptConflict("interrupt payload conflicts with existing request")
                return current
            seq = last_event_seq if last_event_seq is not None else c.execute("SELECT COALESCE(MAX(sequence),0) FROM agui_events WHERE thread_id=?", [thread_id]).fetchone()[0]
            if not seq or not c.execute("SELECT 1 FROM agui_events WHERE thread_id=? AND sequence=?", [thread_id, seq]).fetchone():
                raise InterruptError("checkpoint requires an existing event sequence")
            operation_id = tool_operation_id or str(uuid4())
            c.execute("INSERT INTO tool_operations(id,idempotency_key,thread_id,run_id,tool_name,input_json,input_hash,status,approval_id) VALUES (?,?,?,?,?,?,?,'waiting_approval',?)", [operation_id, nonce, thread_id, run_id, tool_name, canonical_json(input_value), payload_hash(input_value), interrupt_id])
            checkpoint_id = str(uuid4())
            state = {"nonce": nonce, "interrupt_id": interrupt_id, "tool_name": tool_name, "input": input_value, "session": session}
            c.execute("INSERT INTO agent_checkpoints(id,thread_id,run_id,tool_call_id,interrupt_id,pi_session_id,last_event_seq,agent_state_json) VALUES (?,?,?,?,?,?,?,?::JSON)", [checkpoint_id, thread_id, run_id, tool_call_id, interrupt_id, pi_session_id, seq, canonical_json(state)])
        return self._read(self.database.connection, thread_id, interrupt_id)

    def resolve_interrupt(self, thread_id: str, interrupt_id: str, nonce: str,
                          status: str, payload: dict[str, Any], payload_hash_value: str | None = None) -> dict[str, Any]:
        if status not in {"resolved", "cancelled"}:
            raise InterruptError("status must be resolved or cancelled")
        if not isinstance(payload, dict) or set(payload) != {"approved"} or not isinstance(payload["approved"], bool):
            raise InterruptError("payload must be {approved: boolean}")
        phash = payload_hash(payload)
        if payload_hash_value is not None and payload_hash_value != phash:
            raise InterruptError("payload hash mismatch")
        with self.database.transaction() as c:
            row = c.execute("SELECT cp.id,cp.run_id,cp.agent_state_json,op.id,op.status FROM agent_checkpoints cp JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id WHERE cp.thread_id=? AND cp.interrupt_id=?", [thread_id, interrupt_id]).fetchone()
            if not row:
                raise InterruptNotFound("interrupt not found")
            state = json.loads(row[2]) if isinstance(row[2], str) else row[2]
            if state.get("nonce") != nonce:
                raise InterruptError("nonce mismatch")
            receipt = c.execute("SELECT id,status,payload_hash,payload_json,tool_operation_id,checkpoint_id FROM resume_receipts WHERE thread_id=? AND interrupt_id=? AND status=? AND payload_hash=?", [thread_id, interrupt_id, status, phash]).fetchone()
            if receipt:
                return self._normalized(row, receipt, status, payload, interrupt_id)
            if row[4] != "waiting_approval":
                raise InterruptConflict("interrupt already resolved or requires manual review")
            operation_status = "approved" if status == "resolved" and payload["approved"] else "rejected" if status == "resolved" else "cancelled"
            c.execute("UPDATE tool_operations SET status=? WHERE id=? AND status='waiting_approval'", [operation_status, row[3]])
            receipt_id = str(uuid4())
            c.execute("INSERT INTO resume_receipts(id,thread_id,interrupt_id,status,payload_hash,payload_json,tool_operation_id,checkpoint_id) VALUES (?,?,?,?,?,?,?,?)", [receipt_id, thread_id, interrupt_id, status, phash, canonical_json(payload), row[3], row[0]])
        receipt = (receipt_id, status, phash, canonical_json(payload), row[3], row[0])
        return self._normalized(row, receipt, status, payload, interrupt_id)

    def resolve_interrupt_set(self, thread_id: str, decisions: list[dict[str, Any]]) -> dict[str, Any]:
        """Resolve the complete persisted approval set in one database transaction.

        A retry is accepted only when every submitted decision exactly matches its
        durable receipt.  This keeps a caller retry after a lost HTTP response safe.
        """
        if not decisions:
            raise InterruptError("decisions must not be empty")
        decision_by_id: dict[str, dict[str, Any]] = {}
        for decision in decisions:
            interrupt_id = decision.get("interrupt_id")
            if not isinstance(interrupt_id, str) or not interrupt_id:
                raise InterruptError("interrupt_id is required")
            if interrupt_id in decision_by_id:
                raise InterruptError("duplicate interrupt_id")
            self._validate_decision(decision)
            decision_by_id[interrupt_id] = decision

        with self.database.transaction() as c:
            open_rows = c.execute(
                "SELECT cp.interrupt_id,cp.id,cp.run_id,cp.agent_state_json,op.id,op.status "
                "FROM agent_checkpoints cp "
                "JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id "
                "WHERE cp.thread_id=? AND op.status='waiting_approval' "
                "ORDER BY cp.created_at,cp.interrupt_id",
                [thread_id],
            ).fetchall()
            open_ids = {row[0] for row in open_rows}
            submitted_ids = set(decision_by_id)

            if open_rows:
                if submitted_ids != open_ids:
                    raise InterruptError("decision set must contain exactly every open interrupt")
                rows = open_rows
                replayed = False
            else:
                placeholders = ",".join("?" for _ in submitted_ids)
                rows = c.execute(
                    "SELECT cp.interrupt_id,cp.id,cp.run_id,cp.agent_state_json,op.id,op.status "
                    "FROM agent_checkpoints cp "
                    "JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id "
                    f"WHERE cp.thread_id=? AND cp.interrupt_id IN ({placeholders}) "
                    "ORDER BY cp.created_at,cp.interrupt_id",
                    [thread_id, *submitted_ids],
                ).fetchall()
                if len(rows) != len(submitted_ids):
                    raise InterruptConflict("decision set does not match a resolved interrupt set")
                replayed = True

            prepared: list[tuple[Any, dict[str, Any], str, Any]] = []
            replay_set_ids: set[str] = set()
            for row in rows:
                interrupt_id = row[0]
                decision = decision_by_id[interrupt_id]
                state = json.loads(row[3]) if isinstance(row[3], str) else row[3]
                if state.get("nonce") != decision["nonce"]:
                    raise InterruptConflict(f"nonce mismatch for interrupt {interrupt_id}")
                phash = payload_hash(decision["payload"])
                supplied_hash = decision.get("payload_hash")
                if supplied_hash is not None and supplied_hash != phash:
                    raise InterruptConflict(f"payload hash mismatch for interrupt {interrupt_id}")
                receipt = c.execute(
                    "SELECT id,status,payload_hash,payload_json,tool_operation_id,checkpoint_id,decision_set_id "
                    "FROM resume_receipts WHERE thread_id=? AND interrupt_id=?",
                    [thread_id, interrupt_id],
                ).fetchone()
                if replayed:
                    if not receipt or receipt[1] != decision["status"] or receipt[2] != phash:
                        raise InterruptConflict(f"decision conflicts with receipt for interrupt {interrupt_id}")
                    if not receipt[6]:
                        raise InterruptConflict("decision was not resolved as an atomic set")
                    replay_set_ids.add(receipt[6])
                elif receipt or row[5] != "waiting_approval":
                    raise InterruptConflict(f"interrupt {interrupt_id} is already resolved")
                prepared.append((row, decision, phash, receipt))

            if replayed:
                if len(replay_set_ids) != 1:
                    raise InterruptConflict("decisions do not belong to one atomic set")
                replay_members = {
                    item[0] for item in c.execute(
                        "SELECT interrupt_id FROM resume_receipts WHERE thread_id=? AND decision_set_id=?",
                        [thread_id, next(iter(replay_set_ids))],
                    ).fetchall()
                }
                if replay_members != submitted_ids:
                    raise InterruptConflict("decision set replay must match original membership")

            receipts: list[dict[str, Any]] = []
            decision_set_id = str(uuid4()) if not replayed else next(iter(replay_set_ids))
            for row, decision, phash, receipt in prepared:
                interrupt_id = row[0]
                normalized_row = (row[1], row[2], row[3], row[4], row[5])
                if not replayed:
                    approved = decision["status"] == "resolved" and decision["payload"]["approved"]
                    operation_status = "approved" if approved else "rejected" if decision["status"] == "resolved" else "cancelled"
                    c.execute("UPDATE tool_operations SET status=? WHERE id=?", [operation_status, row[4]])
                    receipt_id = str(uuid4())
                    c.execute(
                        "INSERT INTO resume_receipts(id,thread_id,interrupt_id,status,payload_hash,payload_json,tool_operation_id,checkpoint_id,decision_set_id) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        [receipt_id, thread_id, interrupt_id, decision["status"], phash,
                         canonical_json(decision["payload"]), row[4], row[1], decision_set_id],
                    )
                    receipt = (receipt_id, decision["status"], phash,
                               canonical_json(decision["payload"]), row[4], row[1])
                receipts.append(self._normalized(
                    normalized_row, receipt, decision["status"], decision["payload"], interrupt_id,
                ))

            checkpoints = [self._get_checkpoint(c, thread_id, row[0]) for row in rows]
        return {"thread_id": thread_id, "receipts": receipts, "checkpoints": checkpoints, "replayed": replayed}

    @staticmethod
    def _validate_decision(decision: dict[str, Any]) -> None:
        if decision.get("status") not in {"resolved", "cancelled"}:
            raise InterruptError("status must be resolved or cancelled")
        if not isinstance(decision.get("nonce"), str) or not decision["nonce"]:
            raise InterruptError("nonce is required")
        payload = decision.get("payload")
        if not isinstance(payload, dict) or set(payload) != {"approved"} or not isinstance(payload["approved"], bool):
            raise InterruptError("payload must be {approved: boolean}")

    def begin_operation(self, thread_id: str, operation_id: str) -> dict[str, Any]:
        with self.database.transaction() as c:
            row = c.execute("SELECT id,status FROM tool_operations WHERE id=? AND thread_id=?", [operation_id, thread_id]).fetchone()
            if not row: raise InterruptNotFound("operation not found")
            if row[1] != "approved": raise InterruptConflict("operation is not approved")
            c.execute("UPDATE tool_operations SET status='executing' WHERE id=?", [operation_id])
        return {"id": operation_id, "status": "executing"}

    def operation_status(self, thread_id: str, operation_id: str) -> dict[str, Any]:
        row = self.database.connection.execute("SELECT status,result_json FROM tool_operations WHERE id=? AND thread_id=?", [operation_id, thread_id]).fetchone()
        if not row: raise InterruptNotFound("operation not found")
        result = json.loads(row[1]) if row[1] else None
        return {"id": operation_id, "status": row[0], "result": result}

    def complete_operation(self, thread_id: str, operation_id: str, *, result: Any = None, error: Any = None) -> dict[str, Any]:
        with self.database.transaction() as c:
            row = c.execute("SELECT id,status FROM tool_operations WHERE id=? AND thread_id=?", [operation_id, thread_id]).fetchone()
            if not row: raise InterruptNotFound("operation not found")
            if row[1] != "executing": raise InterruptConflict("operation is not executing")
            if error is not None:
                c.execute("UPDATE tool_operations SET status='failed',error_json=?::JSON WHERE id=?", [canonical_json(error), operation_id])
                final = "failed"
            else:
                c.execute("UPDATE tool_operations SET status='succeeded',result_json=?::JSON WHERE id=?", [canonical_json(result), operation_id])
                final = "succeeded"
        return {"id": operation_id, "status": final}

    def get_checkpoint(self, thread_id: str, interrupt_id: str) -> dict[str, Any]:
        """Return only the immutable, service-recorded resume context for an interrupt."""
        return self._get_checkpoint(self.database.connection, thread_id, interrupt_id)

    def _get_checkpoint(self, connection, thread_id: str, interrupt_id: str) -> dict[str, Any]:
        row = connection.execute(
            "SELECT cp.id,cp.run_id,cp.tool_call_id,cp.pi_session_id,cp.last_event_seq,cp.agent_state_json,"
            "op.id,op.tool_name,op.input_json,e.event_type,e.payload_json,r.input_json "
            "FROM agent_checkpoints cp JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id "
            "JOIN agui_events e ON e.thread_id=cp.thread_id AND e.sequence=cp.last_event_seq "
            "JOIN runs r ON r.id=cp.run_id "
            "WHERE cp.thread_id=? AND cp.interrupt_id=?",
            [thread_id, interrupt_id],
        ).fetchone()
        if not row:
            raise InterruptNotFound("interrupt checkpoint not found")
        state = json.loads(row[5]) if isinstance(row[5], str) else row[5]
        input_value = json.loads(row[8]) if isinstance(row[8], str) else row[8]
        original_input = json.loads(row[11]) if isinstance(row[11], str) else row[11]
        messages = original_input.get("messages", []) if isinstance(original_input, dict) else original_input if isinstance(original_input, list) else []
        event_data = json.loads(row[10]) if isinstance(row[10], str) else row[10]
        evidence = event_data.get("citations", []) if isinstance(event_data, dict) else []
        session = state.get("session")
        return {
            "checkpoint_id": row[0], "interrupt_id": interrupt_id, "run_id": row[1],
            "operation_id": row[6], "tool_call_id": row[2], "tool_name": row[7],
            "input": input_value, "nonce": state.get("nonce"), "last_event_seq": row[4],
            "last_event": {"type": row[9], "data": event_data}, "messages": messages, "evidence": evidence,
            "session": session if session else None,
        }

    def open_interrupts(self, thread_id: str) -> list[dict[str, Any]]:
        """Durable source of truth used after a Fastify restart."""
        rows = self.database.connection.execute(
            "SELECT cp.interrupt_id,cp.run_id,op.id FROM agent_checkpoints cp "
            "JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id "
            "WHERE cp.thread_id=? AND op.status='waiting_approval' ORDER BY cp.created_at",
            [thread_id],
        ).fetchall()
        return [{"interrupt_id": row[0], "run_id": row[1], "operation_id": row[2]} for row in rows]

    @staticmethod
    def _normalized(row, receipt, status, payload, interrupt_id):
        return {"interrupt_id": interrupt_id, "run_id": row[1], "operation_id": receipt[4], "checkpoint_id": receipt[5], "receipt_id": receipt[0], "status": status, "payload": payload}

    def _read(self, c, thread_id, interrupt_id):
        row = c.execute("SELECT cp.id,cp.run_id,cp.agent_state_json,op.id,op.status FROM agent_checkpoints cp JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id WHERE cp.thread_id=? AND cp.interrupt_id=?", [thread_id, interrupt_id]).fetchone()
        if not row: raise InterruptNotFound("interrupt not found")
        state = json.loads(row[2]) if isinstance(row[2], str) else row[2]
        return {"interrupt_id": interrupt_id, "run_id": row[1], "operation_id": row[3], "checkpoint_id": row[0], "status": row[4], "nonce": state.get("nonce"), "input": state.get("input"), "tool_name": state.get("tool_name")}

    @staticmethod
    def _session_state(session_id: str | None, revision: int | None, storage_ref: str | None) -> dict[str, Any] | None:
        supplied = (session_id, revision, storage_ref)
        if all(value is None for value in supplied):
            return None
        if not isinstance(session_id, str) or not session_id or not isinstance(revision, int) or revision < 0:
            raise InterruptError("invalid Pi session metadata")
        if not isinstance(storage_ref, str) or not storage_ref:
            raise InterruptError("Pi session storage ref is required")
        ref = PurePosixPath(storage_ref)
        if ref.is_absolute() or ".." in ref.parts or len(ref.parts) < 3 or ref.parts[0] != "sessions":
            raise InterruptError("Pi session storage ref must be repository-relative under sessions")
        return {"session_id": session_id, "revision": revision, "storage_ref": storage_ref}
