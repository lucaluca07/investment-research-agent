from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class ResearchRun:
    id: str
    chat_id: str
    pi_session_id: str
    model: str
    created_at: datetime | None = None


@dataclass(frozen=True)
class ResearchRunStep:
    id: str
    run_id: str
    step_name: str
    status: str
    idempotency_key: str
    input_hash: str
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    retryable: bool = False


@dataclass(frozen=True)
class ApprovalRequest:
    id: str
    step_id: str
    status: str
    payload: dict[str, Any]
    actor: str | None = None
    reason: str | None = None
