"""Hermes in-band adapter shim (Python 3.12).

The ONLY job of this shim: translate one organ write into a standard event and
append it (atomically) to the shared inbox. It touches no git, does no gating —
the TypeScript core is the single consumer/committer. Cross-language coupling is
a single JSONL file, so the core never needs to know Python exists.

Mount points (see docs/hermes-integration.md):
  * write_approval.stage_write()      -> emit after a staged write lands
  * skill_manager_tool / memory_tool  -> emit on skill/memory mutations
  * skill_provenance._write_origin     -> source of session_id / origin

Phase-1 honesty boundary: the event carries NO `verified` field; the core
normalizes every author to verified=false (08 §8.5).
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _default_inbox() -> Path:
    home = os.environ.get("ORGANLEDGER_HOME") or os.path.join(
        os.path.expanduser("~"), ".organledger"
    )
    return Path(home) / "events" / "inbox.jsonl"


def sha256_text(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def emit_organ_event(
    path: str,
    op: str,  # "create" | "update" | "delete"
    *,
    origin: Optional[str] = None,       # foreground | background_review | cron | user
    session_id: Optional[str] = None,
    author_hint: Optional[str] = None,  # agent | user | cron
    reason: Optional[str] = None,
    before_hash: Optional[str] = None,
    after_hash: Optional[str] = None,
    pid: Optional[int] = None,
    inbox: Optional[Path] = None,
) -> dict:
    """Build a 12.2-schema event and append it to the inbox. Returns the event."""
    event = {
        "event_id": "evt-" + str(uuid.uuid4()),
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "system": "hermes",
        "source": "in-band",
        "path": path.replace("\\", "/"),
        "op": op,
        "before_hash": before_hash,
        "after_hash": after_hash,
        "ctx": {
            "session_id": session_id,
            "origin": origin,
            "author_hint": author_hint,
            "reason": reason,
            "pid": pid if pid is not None else os.getpid(),
            "argv": None,
        },
    }
    target = inbox or _default_inbox()
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False) + "\n"
    # O_APPEND: atomic append across processes/languages.
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)
    return event


if __name__ == "__main__":
    # smoke: emit a demo event to the configured inbox
    evt = emit_organ_event(
        "skills/note/SKILL.md",
        "update",
        origin="foreground",
        session_id="sess-demo",
        author_hint="agent",
        reason="demo emit from hermes shim",
        after_hash=sha256_text("hello"),
    )
    print(json.dumps(evt, ensure_ascii=False, indent=2))
