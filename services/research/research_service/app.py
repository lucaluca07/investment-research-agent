from contextlib import asynccontextmanager
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agui_store import AguiStore
from .db import Database
from .interrupts import InterruptError, InterruptNotFound, InterruptStore
from .tools import company_snapshot



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


class ApprovalPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approved: bool


class InterruptDecision(RequestModel):
    model_config = ConfigDict(extra="forbid")
    interrupt_id: str = Field(min_length=1)
    nonce: str = Field(min_length=1)
    status: Literal["resolved", "cancelled"]
    payload: ApprovalPayload
    payload_hash: str | None = None


class ResolveInterruptSetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decisions: list[InterruptDecision] = Field(min_length=1)

    @field_validator("decisions")
    @classmethod
    def interrupt_ids_must_be_unique(cls, decisions: list[InterruptDecision]) -> list[InterruptDecision]:
        ids = [decision.interrupt_id for decision in decisions]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate interrupt_id")
        return decisions


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
        agui_store = AguiStore(database)
        interrupt_store = InterruptStore(database)
        app.state.database = database
        app.state.agui_store = agui_store
        app.state.interrupt_store = interrupt_store
        try:
            yield
        finally:
            database.close()

    app = FastAPI(lifespan=lifespan)

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

    @app.post("/v1/internal/interrupts/{thread_id}/resolve-set")
    def resolve_interrupt_set(thread_id: str, payload: ResolveInterruptSetRequest, request: Request) -> dict[str, Any]:
        try:
            decisions = [decision.model_dump() for decision in payload.decisions]
            return interrupts(request).resolve_interrupt_set(thread_id, decisions)
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
        try: return agui(request).transition_run(run_id, payload["status"], payload.get("error"), payload.get("emit_event", True), payload.get("event_type"), payload.get("event_data"))
        except KeyError as exc: raise HTTPException(status_code=404, detail="run not found") from exc
        except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/tools/query-company-snapshot")
    def query_snapshot(payload: SnapshotRequest) -> dict[str, Any]:
        try:
            return company_snapshot(payload.ticker)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app
