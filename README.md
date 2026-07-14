# OrganLedger（器官账本）— Phase 1

平台无关的 **Agent 器官文件（skills / agents / cron / memory / flows）自修改治理层**。
Agent 会自己改自己的"器官"，但这些写操作没身份、没意图、没审批、没历史、没可观测性。
OrganLedger 给它们补上「**意图 → 审批 → 审计 → 回滚**」闭环。

> 权威架构：`AIC-000/T-B Agent体检报告/08-架构设计.md`。本仓库是其 Phase 1 实现。

## 地基决策（不要动）

```
适配器(只 append 事件) → events/inbox.jsonl → 单一消费者守护进程
   → 归一化 → 分级 → 门控 → 单一 committer(去抖+session合并) → git + 哈希链账本
   → Reporter 日报 / Rollback 回滚
```

- **唯一 committer**：只有守护进程写 git 和账本，适配器只 append 事件 → 解双写竞态。
- **session 合并**：同 session/窗口多文件 → 一个逻辑 commit → 解提交噪音。
- **统一 JSONL schema**：in-band(Hermes) / out-of-band(OpenClaw) 两源天然归一。

## 诚实边界（Phase 1）

- **身份留 Phase 2**：`author.verified` 恒 `false`，**不声称已证明谁改的**（见 `docs/phase2-identity.md`）。
- **非破坏**：任何回滚/提交只操作明确文件，绝无 `git add -A` / `checkout` / `reset` 用户改动；回滚前建 safety 分支。
- **门控默认 observe**：仅 `severity=critical` 或 `op=delete` 才 `held`（阻塞待确认）。
- symlink 逃逸 repo 外的器官、内嵌 git 仓库型 skill：**治理边界外**，跳过 + 审计说明。

## 技术栈

- 核心 + OpenClaw 适配器：**TypeScript（Node 24 原生 type-stripping，无需 ts-node/tsc 运行）**。
- SQLite memory 投影：内置 `node:sqlite`（无需 better-sqlite3 原生编译）。
- Hermes 适配器：Python 3.12 薄 shim（只 append JSONL）。
- 唯一第三方依赖：`chokidar`（文件监听）。

## 安装 & 运行

```bash
npm install
node src/cli/index.ts daemon      # 启动消费者 + OpenClaw watcher（单实例，唯一 committer）
```

配置在 `~/.organledger/config.json`（监听目标、分级规则、时间窗、ignore globs）。

## CLI

```bash
organledger daemon                            # 守护进程（consumer + watcher）
organledger once                              # 只 drain+flush 一次后退出
organledger report [--date today|YYYY-MM-DD]  # 器官审计日报
organledger rollback --change <id> | --session <id> | --before <ts> [--confirm]
organledger approve <change_id>               # held → replay commit
organledger reject  <change_id>               # 丢弃 held
organledger verify-ledger                     # 校验哈希链完整性
organledger status                            # 快速摘要
```

## 目录

```
~/.organledger/                 运行期数据
├── config.json
├── events/{inbox.jsonl,processed/}
├── ledger/{tickets.jsonl,held/<id>.json}
└── reports/audit/YYYY-MM-DD.md

src/
├── core/     inbox daemon normalizer classifier gate committer ledger pipeline
├── adapters/openclaw/  watcher organ-audit sqlite-dump
├── adapters/hermes/    shim.py
└── cli/      index report rollback approve
```

## 测试

```bash
node --test test/core.test.ts     # 核心：ticket/commit/哈希链、去抖、session合并、held、篡改检测、单实例锁、重放幂等
node --test test/hermes.test.ts   # 跨语言：shim 行 → TS 归一为 verified:false 的 ticket
node --test test/classifier.test.ts
python -m pytest test/test_hermes_shim.py
npm run typecheck                  # tsc --noEmit
```

## 数据契约

见 `AIC-000/T-B Agent体检报告/12-数据契约速查表.md`（event / ticket / commit message / config schema）。
