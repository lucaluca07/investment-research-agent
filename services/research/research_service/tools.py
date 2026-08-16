import hashlib
import json
from pathlib import Path
from typing import Any

from .runs import RunStore

SNAPSHOT_PATH = Path(__file__).parents[1] / "tests" / "fixtures" / "shenghong_snapshot.json"


def company_snapshot(ticker: str) -> dict[str, Any]:
    if ticker != "300476.SZ":
        raise ValueError("unsupported ticker")
    return json.loads(SNAPSHOT_PATH.read_text())


def input_hash(title: str, body: str, citation_ids: list[str]) -> str:
    payload = json.dumps(
        {"title": title, "body": body, "citation_ids": citation_ids},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def seed_fixture_citations(run_store: RunStore) -> None:
    snapshot = company_snapshot("300476.SZ")
    with run_store.database.transaction() as connection:
        for citation in snapshot["citations"]:
            connection.execute(
                "INSERT INTO citations (id, document_id, title, published_at, locator) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                [
                    citation["document_id"], citation["document_id"], citation["title"],
                    citation["published_at"], citation["locator"],
                ],
            )


def citation_ids_exist(run_store: RunStore, citation_ids: list[str]) -> bool:
    if not citation_ids:
        return False
    count = run_store.database.connection.execute(
        "SELECT COUNT(*) FROM citations WHERE id IN (SELECT UNNEST(?))", [citation_ids]
    ).fetchone()[0]
    return count == len(set(citation_ids))
