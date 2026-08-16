import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from .db import Database
from .runs import IllegalTransition, RunStore
from .tools import citation_ids_exist, company_snapshot, input_hash, seed_fixture_citations

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


class PiSessionRequest(RequestModel):
    pi_session_id: str


class RunRequest(RequestModel):
    chat_id: str
    pi_session_id: str
    model: str


class SnapshotRequest(RequestModel):
    ticker: str


class NoteRequest(RequestModel):
    run_id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    citation_ids: list[str] = Field(min_length=1)


class MessageRequest(RequestModel):
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


def create_app(database_path: str = ":memory:", test_mode: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = Database(database_path)
        run_store = RunStore(database)
        seed_fixture_citations(run_store)
        app.state.database = database
        app.state.run_store = run_store
        try:
            yield
        finally:
            database.close()

    app = FastAPI(lifespan=lifespan)

    def store(request: Request) -> RunStore:
        return request.app.state.run_store

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
        except (KeyError, IllegalTransition) as exc:
            code = 404 if isinstance(exc, KeyError) else 409
            raise HTTPException(status_code=code, detail="run not found" if code == 404 else str(exc)) from exc
        except RuntimeError:
            logger.exception("research note fault or persistence failure")
            raise HTTPException(status_code=500, detail="internal server error") from None

    @app.post("/v1/chats", status_code=status.HTTP_201_CREATED)
    def create_chat(payload: ChatRequest, request: Request) -> dict[str, str]:
        chat_id = payload.chat_id or str(uuid4())
        store(request).create_chat(chat_id)
        return {"id": chat_id}

    @app.get("/v1/chats/{chat_id}/messages")
    def messages(chat_id: str, request: Request) -> dict[str, list[Any]]:
        try:
            messages = store(request).list_messages(chat_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        return {"messages": [
            {"id": message.id, "chat_id": message.chat_id, "role": message.role,
             "content": message.content, "created_at": message.created_at}
            for message in messages
        ]}

    @app.post("/v1/chats/{chat_id}/messages", status_code=status.HTTP_201_CREATED)
    def append_message(chat_id: str, payload: MessageRequest, request: Request) -> dict[str, Any]:
        try:
            message = store(request).append_message(chat_id, payload.role, payload.content)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        return {
            "id": message.id, "chat_id": message.chat_id, "role": message.role,
            "content": message.content, "created_at": message.created_at,
        }

    @app.post("/v1/research-runs", status_code=status.HTTP_201_CREATED)
    def create_run(payload: RunRequest, request: Request) -> dict[str, Any]:
        try:
            run = store(request).create_run(payload.chat_id, payload.pi_session_id, payload.model)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid research run request") from exc
        except Exception:
            logger.exception("failed to create research run")
            raise HTTPException(status_code=500, detail="internal server error") from None
        return {
            "id": run.id, "chat_id": run.chat_id, "pi_session_id": run.pi_session_id,
            "model": run.model, "created_at": run.created_at,
        }

    @app.patch("/v1/chats/{chat_id}/pi-session")
    def update_pi_session(chat_id: str, payload: PiSessionRequest, request: Request) -> dict[str, str]:
        try:
            store(request).update_pi_session(chat_id, payload.pi_session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat not found") from exc
        return {"chat_id": chat_id, "pi_session_id": payload.pi_session_id}

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
