import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from .agui_store import AguiStore
from .db import Database
from .runs import CitationOwnershipConflict, IllegalTransition, RunStore
from .tools import citation_ids_exist, company_snapshot, input_hash, seed_fixture_citations
from .interrupts import InterruptStore, InterruptError, InterruptConflict, InterruptNotFound

logger = logging.getLogger(__name__)


class RequestModel(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def normalize_non_blank_strings(cls, value: Any) -> Any:
        if isinstance(value, str):
            normalized = value.strip()
            if not normalized:
                raise ValueError("value must not be blank")
            return normalized
        return value


class ChatRequest(RequestModel):
    chat_id: str | None = None
    pi_session_id: str | None = None


class PiSessionRequest(RequestModel):
    pi_session_id: str


class MessageRequest(RequestModel):
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1)
    idempotency_key: str | None = None


class RunRequest(RequestModel):
    chat_id: str
    pi_session_id: str
    model: str
    idempotency_key: str | None = None


class RunStatusRequest(RequestModel):
    status: Literal["running", "succeeded", "failed", "cancelled"]
    error: dict[str, Any] | None = None


class EventRequest(RequestModel):
    type: str
    data: dict[str, Any]


class SnapshotRequest(RequestModel):
    ticker: str


class NoteRequest(RequestModel):
    run_id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    citation_ids: list[str] = Field(min_length=1)


class InterruptRequest(RequestModel):
    thread_id: str = Field(min_length=1)
    interrupt_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    nonce: str = Field(min_length=1)
    tool_name: str = ""
    input: Any = Field(default_factory=dict)
    last_event_seq: int | None = Field(default=None, ge=1)
    tool_call_id: str | None = None
    pi_session_id: str | None = None
    pi_session_revision: int | None = Field(default=None, ge=0)
    pi_session_storage_ref: str | None = None


class ResolveInterruptRequest(RequestModel):
    nonce: str = Field(min_length=1)
    status: Literal["resolved", "cancelled"]
    payload: dict[str, Any]
    payload_hash: str | None = None


class OperationReferenceRequest(RequestModel):
    thread_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)


class CompleteOperationRequest(OperationReferenceRequest):
    result: Any = None
    error: Any = None


def create_app(database_path: str = ":memory:", test_mode: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = Database(database_path)
        run_store = RunStore(database)
        agui_store = AguiStore(database)
        interrupt_store = InterruptStore(database)
        seed_fixture_citations(run_store)
        run_store.recover_incomplete_runs()
        app.state.database = database
        app.state.run_store = run_store
        app.state.agui_store = agui_store
        app.state.interrupt_store = interrupt_store
        try:
            yield
        finally:
            database.close()

    app = FastAPI(lifespan=lifespan)

    def store(request: Request) -> RunStore:
        return request.app.state.run_store

    def agui(request: Request) -> AguiStore:
        return request.app.state.agui_store

    def interrupts(request: Request) -> InterruptStore:
        return request.app.state.interrupt_store

    @app.post("/v1/internal/interrupts")
    def request_interrupt(payload: InterruptRequest, request: Request) -> dict[str, Any]:
        try:
            return interrupts(request).request_interrupt(
                payload.thread_id, payload.interrupt_id, run_id=payload.run_id,
                nonce=payload.nonce, tool_name=payload.tool_name,
                input_value=payload.input, last_event_seq=payload.last_event_seq, tool_call_id=payload.tool_call_id,
                pi_session_id=payload.pi_session_id, pi_session_revision=payload.pi_session_revision,
                pi_session_storage_ref=payload.pi_session_storage_ref,
            )
        except KeyError as exc: raise HTTPException(status_code=422, detail=f"missing field: {exc.args[0]}") from exc
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc
        except InterruptError as exc: raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.get("/v1/internal/interrupts/{thread_id}/{interrupt_id}/checkpoint")
    def get_interrupt_checkpoint(thread_id: str, interrupt_id: str, request: Request) -> dict[str, Any]:
        try:
            return interrupts(request).get_checkpoint(thread_id, interrupt_id)
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/v1/internal/interrupts/{thread_id}")
    def open_interrupts(thread_id: str, request: Request) -> list[dict[str, Any]]:
        return interrupts(request).open_interrupts(thread_id)

    @app.post("/v1/internal/interrupts/{thread_id}/{interrupt_id}/resolve")
    def resolve_interrupt(thread_id: str, interrupt_id: str, payload: ResolveInterruptRequest, request: Request) -> dict[str, Any]:
        try:
            return interrupts(request).resolve_interrupt(thread_id, interrupt_id, payload.nonce, payload.status, payload.payload, payload.payload_hash)
        except KeyError as exc: raise HTTPException(status_code=422, detail=f"missing field: {exc.args[0]}") from exc
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc
        except InterruptError as exc: raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.post("/v1/internal/operations/begin")
    def begin_operation(payload: OperationReferenceRequest, request: Request) -> dict[str, Any]:
        try:
            return interrupts(request).begin_operation(payload.thread_id, payload.operation_id)
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc
        except InterruptError as exc: raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.post("/v1/internal/operations/status")
    def operation_status(payload: OperationReferenceRequest, request: Request) -> dict[str, Any]:
        try:
            return interrupts(request).operation_status(payload.thread_id, payload.operation_id)
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/v1/internal/operations/complete")
    def complete_operation(payload: CompleteOperationRequest, request: Request) -> dict[str, Any]:
        try:
            if payload.error is not None:
                return interrupts(request).complete_operation(payload.thread_id, payload.operation_id, error=payload.error)
            return interrupts(request).complete_operation(payload.thread_id, payload.operation_id, result=payload.result)
        except InterruptNotFound as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc
        except InterruptError as exc: raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.post("/v1/threads", status_code=status.HTTP_201_CREATED)
    def create_thread(payload: dict[str, Any], request: Request) -> dict[str, Any]:
        return agui(request).create_thread(payload.get("id"), payload.get("title", ""))

    @app.get("/v1/threads")
    def list_threads(request: Request) -> list[dict[str, Any]]:
        return agui(request).list_threads()

    @app.post("/v1/threads/{thread_id}/runs", status_code=status.HTTP_201_CREATED)
    def create_agui_run(thread_id: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
        try:
            return agui(request).create_run(thread_id, payload.get("idempotency_key", str(uuid4())), payload.get("input", payload), payload.get("model"))
        except KeyError as exc: raise HTTPException(status_code=404, detail="thread not found") from exc
        except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/threads/{thread_id}/events:batch")
    def append_agui_events(thread_id: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
        try: return {"events": agui(request).append_events(thread_id, payload["run_id"], payload.get("events", []))}
        except KeyError as exc: raise HTTPException(status_code=404, detail="run not found") from exc

    @app.get("/v1/threads/{thread_id}/events")
    def list_agui_events(thread_id: str, request: Request, after: int = 0) -> list[dict[str, Any]]:
        return agui(request).list_events(thread_id, after)

    @app.get("/v1/threads/{thread_id}/state")
    def get_agui_state(thread_id: str, request: Request) -> dict[str, Any]:
        try: return agui(request).get_state(thread_id)
        except KeyError as exc: raise HTTPException(status_code=404, detail="thread not found") from exc

    @app.post("/v1/runs/{run_id}/transition")
    def transition_agui_run(run_id: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
        try: return agui(request).transition_run(run_id, payload["status"], payload.get("error"), payload.get("emit_event", True))
        except KeyError as exc: raise HTTPException(status_code=404, detail="run not found") from exc
        except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/tools/query-company-snapshot")
    def query_snapshot(payload: SnapshotRequest) -> dict[str, Any]:
        try:
            return company_snapshot(payload.ticker)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/tools/save-research-note")
    def save_note(
        payload: NoteRequest,
        request: Request,
        x_ira_test_fail_after_note: str | None = Header(default=None),
    ) -> dict[str, Any]:
        run_store = store(request)
        if len(payload.citation_ids) != len(set(payload.citation_ids)):
            raise HTTPException(status_code=422, detail="duplicate citation id")
        if not citation_ids_exist(run_store, payload.citation_ids):
            raise HTTPException(status_code=422, detail="invalid citation id")
        try:
            return run_store.save_research_note(
                payload.run_id,
                payload.idempotency_key,
                input_hash(payload.title, payload.body, payload.citation_ids),
                payload.title,
                payload.body,
                payload.citation_ids,
                fault_after_note=(
                    test_mode
                    and os.getenv("IRA_TEST_MODE") == "1"
                    and x_ira_test_fail_after_note == "1"
                ),
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except CitationOwnershipConflict as exc:
            raise HTTPException(status_code=409, detail="citation already belongs to another note") from exc
        except (KeyError, IllegalTransition) as exc:
            code = 404 if isinstance(exc, KeyError) else 409
            raise HTTPException(status_code=code, detail="run not found" if code == 404 else str(exc)) from exc
        except RuntimeError:
            logger.exception("research note fault or persistence failure")
            raise HTTPException(status_code=500, detail="internal server error") from None

    @app.post("/v1/chats", status_code=status.HTTP_201_CREATED)
    def create_chat(payload: ChatRequest, request: Request) -> dict[str, str]:
        chat_id = payload.chat_id or str(uuid4())
        pi_session_id = payload.pi_session_id or str(uuid4())
        store(request).create_chat(chat_id, pi_session_id)
        return {"id": chat_id, "pi_session_id": pi_session_id}

    @app.get("/v1/chats")
    def list_chats(request: Request) -> list[dict[str, Any]]:
        return store(request).list_chats()

    @app.get("/v1/chats/{chat_id}")
    def get_chat(chat_id: str, request: Request) -> dict[str, Any]:
        try:
            return store(request).get_chat(chat_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        except IllegalTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/v1/chats/{chat_id}/messages")
    def messages(chat_id: str, request: Request) -> dict[str, list[Any]]:
        try:
            messages = store(request).list_messages(chat_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"messages": [
            {"id": message.id, "chat_id": message.chat_id, "role": message.role,
             "content": message.content, "created_at": message.created_at}
            for message in messages
        ]}

    @app.post("/v1/chats/{chat_id}/events")
    def append_event(chat_id: str, payload: EventRequest, request: Request) -> dict[str, Any]:
        try:
            return store(request).append_event(chat_id, payload.type, payload.data)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc

    @app.get("/v1/chats/{chat_id}/events")
    def list_events(chat_id: str, request: Request, after: int = 0) -> list[dict[str, Any]]:
        try:
            return store(request).list_events(chat_id, after)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc

    @app.post("/v1/chats/{chat_id}/messages", status_code=status.HTTP_201_CREATED)
    def append_message(chat_id: str, payload: MessageRequest, request: Request) -> dict[str, Any]:
        try:
            message = store(request).append_message(chat_id, payload.role, payload.content, payload.idempotency_key)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {
            "id": message.id, "chat_id": message.chat_id, "role": message.role,
            "content": message.content, "created_at": message.created_at,
        }

    @app.post("/v1/research-runs", status_code=status.HTTP_201_CREATED)
    def create_run(payload: RunRequest, request: Request) -> dict[str, Any]:
        try:
            run = store(request).create_run(payload.chat_id, payload.pi_session_id, payload.model, payload.idempotency_key)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except IllegalTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception:
            logger.exception("failed to create research run")
            raise HTTPException(status_code=500, detail="internal server error") from None
        return {
            "id": run.id, "chat_id": run.chat_id, "pi_session_id": run.pi_session_id,
            "model": run.model, "created_at": run.created_at, "status": run.status, "error": run.error, "replayed": run.replayed,
        }

    @app.patch("/v1/chats/{chat_id}/pi-session")
    def update_pi_session(chat_id: str, payload: PiSessionRequest, request: Request) -> dict[str, str]:
        try:
            store(request).update_pi_session(chat_id, payload.pi_session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        return {"chat_id": chat_id, "pi_session_id": payload.pi_session_id}

    @app.patch("/v1/research-runs/{run_id}")
    def update_run(run_id: str, payload: RunStatusRequest, request: Request) -> dict[str, str]:
        try:
            store(request).update_run(run_id, payload.status, payload.error)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        return {"id": run_id, "status": payload.status}

    @app.get("/v1/research-runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict[str, Any]:
        try:
            run = store(request).get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        return {"id": run.id, "chat_id": run.chat_id, "pi_session_id": run.pi_session_id,
                "model": run.model, "created_at": run.created_at, "status": run.status,
                "error": run.error, "replayed": run.replayed}

    @app.get("/v1/test/counts")
    def counts(request: Request) -> dict[str, int]:
        if not test_mode or os.getenv("IRA_TEST_MODE") != "1":
            raise HTTPException(status_code=404, detail="not found")
        with store(request).database.read() as connection:
            return {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("chats", "research_runs", "research_run_steps", "research_notes", "citations")
            }

    return app
