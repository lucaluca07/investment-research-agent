"""Durable AG-UI thread, run, and event persistence."""
import hashlib
import json
from uuid import uuid4

from .db import Database


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def payload_hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


class AguiStore:
    def __init__(self, database: Database):
        self.database = database

    def create_thread(self, thread_id=None, title=""):
        thread_id = thread_id or str(uuid4())
        with self.database.transaction() as c:
            c.execute("INSERT INTO threads(id,title) VALUES (?,?) ON CONFLICT(id) DO NOTHING", [thread_id, title])
            row = c.execute("SELECT id,title,title_source,title_locked,created_at FROM threads WHERE id=?", [thread_id]).fetchone()
        return self._thread(row)

    def list_threads(self):
        with self.database.read() as c:
            rows = c.execute("SELECT id,title,title_source,title_locked,created_at FROM threads ORDER BY created_at,id").fetchall()
        return [self._thread(r) for r in rows]

    def create_run(self, thread_id, idempotency_key, input_value=None, model=None, run_id=None):
        input_value = input_value or {}
        ihash = payload_hash(input_value)
        with self.database.transaction() as c:
            if not c.execute("SELECT 1 FROM threads WHERE id=?", [thread_id]).fetchone():
                raise KeyError(thread_id)
            existing = c.execute("SELECT id,status,model,input_hash,created_at FROM runs WHERE thread_id=? AND idempotency_key=?", [thread_id, idempotency_key]).fetchone()
            if existing:
                if existing[3] != ihash: raise ValueError("idempotency key payload mismatch")
                return {"run": self._run(existing, thread_id, idempotency_key, True), "replayed": True, "last_event_seq": self._next_sequence(c, thread_id) - 1}
            run_id = run_id or str(uuid4())
            c.execute("INSERT INTO runs(id,thread_id,idempotency_key,model,input_json,input_hash,status) VALUES (?,?,?,?,?::JSON,?,'running')", [run_id, thread_id, idempotency_key, model, canonical_json(input_value), ihash])
            seq = self._next_sequence(c, thread_id)
            c.execute("INSERT INTO agui_events(thread_id,sequence,run_id,event_type,payload_json) VALUES (?,?,?,?,?::JSON)", [thread_id, seq, run_id, "RUN_STARTED", canonical_json({"run_id": run_id, "input": input_value})])
            seq += 1
            messages = input_value.get("messages", []) if isinstance(input_value, dict) else []
            c.execute("INSERT INTO agui_events(thread_id,sequence,run_id,event_type,payload_json) VALUES (?,?,?,?,?::JSON)", [thread_id, seq, run_id, "MESSAGES_SNAPSHOT", canonical_json({"messages": messages})])
            c.execute("INSERT INTO message_snapshots(id,thread_id,last_event_seq,messages_json,agent_state_json,schema_version) VALUES (?,?,?,?,?::JSON,1)", [str(uuid4()), thread_id, seq, canonical_json(messages), canonical_json({})])
            row = c.execute("SELECT id,status,model,input_hash,created_at FROM runs WHERE id=?", [run_id]).fetchone()
        return {"run": self._run(row, thread_id, idempotency_key, False), "replayed": False, "last_event_seq": seq}

    def append_events(self, thread_id, run_id, events):
        with self.database.transaction() as c:
            if not c.execute("SELECT 1 FROM runs WHERE id=? AND thread_id=?", [run_id, thread_id]).fetchone(): raise KeyError(run_id)
            seq = self._next_sequence(c, thread_id); result = []
            for event in events:
                event_type = event.get("type") or event.get("event_type")
                data = event.get("data", event.get("payload", {}))
                c.execute("INSERT INTO agui_events(thread_id,sequence,run_id,event_type,payload_json) VALUES (?,?,?,?,?::JSON)", [thread_id, seq, run_id, event_type, canonical_json(data)])
                result.append({"thread_id": thread_id, "sequence": seq, "run_id": run_id, "type": event_type, "data": data})
                seq += 1
        return result

    def list_events(self, thread_id, after=0):
        with self.database.read() as c:
            rows = c.execute("SELECT sequence,run_id,event_type,payload_json,created_at FROM agui_events WHERE thread_id=? AND sequence>? ORDER BY sequence", [thread_id, after]).fetchall()
        return [{"thread_id": thread_id, "sequence": r[0], "run_id": r[1], "type": r[2], "data": json.loads(r[3]) if isinstance(r[3], str) else r[3], "created_at": r[4]} for r in rows]

    def get_state(self, thread_id):
        with self.database.read() as c:
            thread = c.execute("SELECT id,title,title_source,title_locked,created_at FROM threads WHERE id=?", [thread_id]).fetchone()
            if not thread: raise KeyError(thread_id)
            last = c.execute("SELECT COALESCE(MAX(sequence),0) FROM agui_events WHERE thread_id=?", [thread_id]).fetchone()[0]
            runs = c.execute("SELECT id,status,model,input_hash,created_at,idempotency_key FROM runs WHERE thread_id=? ORDER BY created_at", [thread_id]).fetchall()
        return {"thread": self._thread(thread), "last_event_seq": last, "runs": [self._run(r[:5], thread_id, r[5], False) for r in runs]}

    def transition_run(self, run_id, status, error=None):
        allowed = {"pending", "running", "completed", "interrupted", "failed", "cancelled"}
        if status not in allowed: raise ValueError("invalid run status")
        with self.database.transaction() as c:
            row = c.execute("SELECT id,thread_id,idempotency_key,status,model,input_hash,created_at FROM runs WHERE id=?", [run_id]).fetchone()
            if not row: raise KeyError(run_id)
            if row[3] != status:
                c.execute("UPDATE runs SET status=?,error_json=?::JSON,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,CURRENT_TIMESTAMP) ELSE started_at END,completed_at=CASE WHEN ? IN ('completed','interrupted','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=?", [status, canonical_json(error) if error is not None else "null", status, status, run_id])
                seq = self._next_sequence(c, row[1]); typ = "RUN_FINISHED" if status in {"completed","interrupted","failed","cancelled"} else "RUN_STARTED"
                c.execute("INSERT INTO agui_events(thread_id,sequence,run_id,event_type,payload_json) VALUES (?,?,?,?,?::JSON)", [row[1], seq, run_id, typ, canonical_json({"status": status, "error": error})])
                row = c.execute("SELECT id,thread_id,idempotency_key,status,model,input_hash,created_at FROM runs WHERE id=?", [run_id]).fetchone()
        return {"id": row[0], "thread_id": row[1], "idempotency_key": row[2], "status": row[3], "model": row[4], "input_hash": row[5], "created_at": row[6], "replayed": False}

    @staticmethod
    def _next_sequence(c, thread_id):
        return c.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM agui_events WHERE thread_id=?", [thread_id]).fetchone()[0]

    @staticmethod
    def _thread(r):
        return {"id": r[0], "title": r[1], "title_source": r[2], "title_locked": r[3], "created_at": r[4]}

    @staticmethod
    def _run(r, thread_id, key, replayed):
        return {"id": r[0], "thread_id": thread_id, "idempotency_key": key, "status": r[1], "model": r[2], "input_hash": r[3], "created_at": r[4], "replayed": replayed}
