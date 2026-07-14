# Hermes 接入指南（in-band 适配器）

> 本期**不改 Hermes 主体**（本机 `~/.hermes` 仅 `scripts/`，未落地）。这里给出接入点与
> 一行挂载代码，待 Hermes 真正运行时贴上即可。核心（TypeScript）无需感知 Python 的存在——
> 跨语言边界只有一个 `~/.organledger/events/inbox.jsonl`。

## 1. 原理

Hermes 是 Python、天然 in-band（上下文最全）。适配器只做一件事：在器官写入的落点旁
**追加一条标准事件到 inbox**。分级、门控、commit、账本全部由 TS 核心串行消费。

```
Hermes 写器官 → emit_organ_event(...) → inbox.jsonl → 同一个 TS 消费者守护进程
```

## 2. 两个挂载点

### 挂载点 A：`write_approval.stage_write()`（推荐主锚点）
这是 Hermes 器官写入的统一收口。在一次 staged write 真正落盘后追加事件：

```python
from organledger.shim import emit_organ_event, sha256_text  # 按实际部署路径调整

def stage_write(path, new_text, *, origin=None, session_id=None, reason=None):
    before = _read_if_exists(path)          # Hermes 已有的读取
    _do_write(path, new_text)               # Hermes 原有落盘
    emit_organ_event(
        path=_relative_to_organ_home(path), # 相对器官 home，如 "skills/note/SKILL.md"
        op="update" if before is not None else "create",
        origin=origin,                      # foreground | background_review | cron
        session_id=session_id,              # 来自 skill_provenance._write_origin ContextVar
        author_hint="agent",
        reason=reason,
        before_hash=sha256_text(before),
        after_hash=sha256_text(new_text),
    )
```

### 挂载点 B：`skill_manager_tool` / `memory_tool`
若某些写路径不经过 `stage_write`（如直接删除 skill、写 memory），在其落点同样补一行
`emit_organ_event(..., op="delete"/"update")`。删除时 `after_hash=None`。

### session_id 来源：`skill_provenance._write_origin`
Hermes 的 `_write_origin` ContextVar（已启用）是天然 session 锚点。把当前 `session_id`
从该 ContextVar 读出传入 `emit_organ_event`，即可让账本带上会话线索（Phase 2 用它把
`verified` 提升为 true——见 `phase2-identity.md`）。

## 3. 部署 shim

把 `src/adapters/hermes/shim.py` 放到 Hermes 可 import 的位置（或 `pip install -e`）。
默认写入 `~/.organledger/events/inbox.jsonl`；可用环境变量 `ORGANLEDGER_HOME` 覆盖。

## 4. 器官纳 git（⏳ Phase 2）

`git init ~/.hermes` 把 `{skills,memories,cron,config.yaml}` 纳入版本控制，留到 Hermes
真正落地时做（08 §8.8）。本期核心已支持 `git:false` 的 target（只记账本、不 commit），
故即使 Hermes 未纳 git，事件也能被归一化为 ticket。

## 5. 验证

```bash
python src/adapters/hermes/shim.py          # 追加一条 demo 事件到 inbox
python -m pytest test/test_hermes_shim.py    # schema 同构
node --test test/hermes.test.ts              # shim 行 → TS 核心归一为 verified:false 的 ticket
```
