"""pytest: the shim's appended line is a valid 12.2 event (schema-isomorphic)."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "adapters" / "hermes"))
import shim  # noqa: E402


def test_emit_appends_valid_event(tmp_path):
    inbox = tmp_path / "events" / "inbox.jsonl"
    evt = shim.emit_organ_event(
        "skills/note/SKILL.md",
        "update",
        origin="foreground",
        session_id="sess-1",
        author_hint="agent",
        reason="unit test",
        after_hash=shim.sha256_text("body"),
        inbox=inbox,
    )
    lines = inbox.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    last = json.loads(lines[-1])

    # 12.2 schema shape
    assert last["event_id"].startswith("evt-")
    assert last["system"] == "hermes"
    assert last["source"] == "in-band"
    assert last["op"] == "update"
    assert last["path"] == "skills/note/SKILL.md"
    assert last["after_hash"].startswith("sha256:")
    assert "verified" not in last  # event layer has no verified field
    ctx = last["ctx"]
    for k in ("session_id", "origin", "author_hint", "reason", "pid", "argv"):
        assert k in ctx
    assert ctx["session_id"] == "sess-1"
    assert last == evt  # returned object equals what was written


def test_atomic_append_multiple(tmp_path):
    inbox = tmp_path / "inbox.jsonl"
    for i in range(5):
        shim.emit_organ_event(f"skills/s{i}/SKILL.md", "create", inbox=inbox)
    lines = inbox.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 5
    assert all(json.loads(l)["system"] == "hermes" for l in lines)
