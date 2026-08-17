"""Durable interrupt approval state machine for AG-UI runs."""
import json
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
                          last_event_seq: int | None = None) -> dict[str, Any]:
        if not interrupt_id or not nonce:
            raise InterruptError("interrupt_id and nonce are required")
        input_value = {} if input_value is None else input_value
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
            state = {"nonce": nonce, "interrupt_id": interrupt_id, "tool_name": tool_name, "input": input_value}
            c.execute("INSERT INTO agent_checkpoints(id,thread_id,run_id,interrupt_id,last_event_seq,agent_state_json) VALUES (?,?,?,?,?,?::JSON)", [checkpoint_id, thread_id, run_id, interrupt_id, seq, canonical_json(state)])
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

    @staticmethod
    def _normalized(row, receipt, status, payload, interrupt_id):
        return {"interrupt_id": interrupt_id, "run_id": row[1], "operation_id": receipt[4], "checkpoint_id": receipt[5], "receipt_id": receipt[0], "status": status, "payload": payload}

    def _read(self, c, thread_id, interrupt_id):
        row = c.execute("SELECT cp.id,cp.run_id,cp.agent_state_json,op.id,op.status FROM agent_checkpoints cp JOIN tool_operations op ON op.approval_id=cp.interrupt_id AND op.thread_id=cp.thread_id WHERE cp.thread_id=? AND cp.interrupt_id=?", [thread_id, interrupt_id]).fetchone()
        if not row: raise InterruptNotFound("interrupt not found")
        state = json.loads(row[2]) if isinstance(row[2], str) else row[2]
        return {"interrupt_id": interrupt_id, "run_id": row[1], "operation_id": row[3], "checkpoint_id": row[0], "status": row[4], "nonce": state.get("nonce"), "input": state.get("input"), "tool_name": state.get("tool_name")}
