from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

StepStatus = Literal[
    "pending", "running", "succeeded", "failed", "waiting_approval", "cancelled"
]


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
    status: StepStatus
    idempotency_key: str
    input_hash: str
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    retryable: bool = False


@dataclass(frozen=True)
class ApprovalRequest:
    id: str
    step_id: str
    status: Literal["pending", "approved", "rejected"]
    payload: dict[str, Any]
    actor: str | None = None
    reason: str | None = None
