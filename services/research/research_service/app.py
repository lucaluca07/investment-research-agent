import os
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from pydantic import BaseModel

from .db import Database
from .runs import IllegalTransition, RunStore
from .tools import citation_ids_exist, company_snapshot, input_hash, seed_fixture_citations


class ChatRequest(BaseModel):
    chat_id: str | None = None


class PiSessionRequest(BaseModel):
    pi_session_id: str


class RunRequest(BaseModel):
    chat_id: str
    pi_session_id: str
    model: str


class SnapshotRequest(BaseModel):
    ticker: str


class NoteRequest(BaseModel):
    run_id: str
    idempotency_key: str
    title: str
    body: str
    citation_ids: list[str]


def create_app(database_path: str = ":memory:") -> FastAPI:
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
    def save_note(payload: NoteRequest, request: Request) -> dict[str, Any]:
        run_store = store(request)
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
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (KeyError, IllegalTransition) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/chats", status_code=status.HTTP_201_CREATED)
    def create_chat(payload: ChatRequest, request: Request) -> dict[str, str]:
        chat_id = payload.chat_id or str(uuid4())
        store(request).create_chat(chat_id)
        return {"id": chat_id}

    @app.get("/v1/chats/{chat_id}/messages")
    def messages(chat_id: str, request: Request) -> dict[str, list[Any]]:
        exists = store(request).database.connection.execute(
            "SELECT 1 FROM chats WHERE id = ?", [chat_id]
        ).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="chat not found")
        return {"messages": []}

    @app.post("/v1/research-runs", status_code=status.HTTP_201_CREATED)
    def create_run(payload: RunRequest, request: Request) -> dict[str, Any]:
        try:
            run = store(request).create_run(payload.chat_id, payload.pi_session_id, payload.model)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "id": run.id, "chat_id": run.chat_id, "pi_session_id": run.pi_session_id,
            "model": run.model, "created_at": run.created_at,
        }

    @app.patch("/v1/chats/{chat_id}/pi-session")
    def update_pi_session(chat_id: str, payload: PiSessionRequest, request: Request) -> dict[str, str]:
        store(request).update_pi_session(chat_id, payload.pi_session_id)
        return {"chat_id": chat_id, "pi_session_id": payload.pi_session_id}

    @app.get("/v1/test/counts")
    def counts(request: Request) -> dict[str, int]:
        if os.getenv("IRA_TEST_MODE") != "1":
            raise HTTPException(status_code=404, detail="not found")
        connection = store(request).database.connection
        return {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("chats", "research_runs", "research_run_steps", "research_notes", "citations")
        }

    return app
