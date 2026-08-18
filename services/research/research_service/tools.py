import hashlib
import json
from importlib.resources import files
from typing import Any



def company_snapshot(ticker: str) -> dict[str, Any]:
    if ticker != "300476.SZ":
        raise ValueError("unsupported ticker")
    resource = files("research_service").joinpath("data/shenghong_snapshot.json")
    return json.loads(resource.read_text())


def input_hash(title: str, body: str, citation_ids: list[str]) -> str:
    payload = json.dumps(
        {"title": title, "body": body, "citation_ids": citation_ids},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()

