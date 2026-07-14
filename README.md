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

## Onboarding（新用户，零手写 JSON）

```bash
npm install
node src/cli/index.ts init        # 探测 OpenClaw/Hermes → 生成 config → 建目录 → 首扫水位 → 自检
node src/cli/index.ts daemon      # 开始治理
```

`init` 六步：环境探测 → 生成/合并 `config.json` → 建 v2 分区目录 + `VERSION` → （旧布局则）无损迁移 →
首扫水位（写 target `.gitignore` + scoped 快照，排除运行期 churn/密钥/大二进制/内嵌仓库/memory 二进制 sqlite）→ 自检。
非交互：`init --yes [--openclaw <p>] [--hermes <p>] [--home <p>] [--no-snapshot] [--autostart]`。**幂等**：重复 `init` 安全。

生命周期：
```bash
organledger doctor        # 健康报告（env/paths/config/audit/runtime/capacity 🟢🟡🔴）
organledger paths         # 每个产物在哪（含类别与是否存在）
organledger reset         # 默认 --keep-audit：清 state/logs/cache，保留 ledger/config
organledger reset --all --confirm   # 先备份再全清
organledger uninstall     # 停 daemon 提示 + 移除自启；绝不动 target 内 .git/audit
organledger autostart     # 装登录自启（Windows 计划任务）
```

## 数据 / 日志布局（v2，五类分区）

产品级第一原则：**config / audit / state / logs / cache 分区落盘**，生命周期各异（`04-数据与日志布局规范.md`）。

```
$ORGANLEDGER_HOME/            # 默认 ~/.organledger，ORGANLEDGER_HOME 或 --home 覆盖
├── config.json  VERSION      # [config] 备份
├── ledger/tickets.jsonl held/  # [audit] ★真相源，最需备份，永久不可变★
├── reports/audit/*.md        # [audit] 日报
├── state/events/{inbox.jsonl,processed/}  state/daemon.lock  # [state] 停机可清
├── logs/daemon-YYYY-MM-DD.log(.err)       # [logs] OrganLedger 自身运行日志，按天轮转保留14天
└── cache/                    # [cache] 可重算，随时删
```

> **审计留痕 ≠ 运行日志**：前者(tickets/git/organ-audit/report)是治理产品输出、是资产要保护；
> 后者(daemon 起停/drain 报错/watch EPERM)是排障用、会过期能删。物理分离。运行日志**不含文件内容/密钥**。

**无损迁移**：旧扁平布局（`events/`、`daemon.lock` 在根）→ v2 时，先整目录备份 `~/.organledger.bak-<ts>`，
audit 类（`ledger/`）原地不动，只移 state/日志类；迁移后 `verify-ledger` 必须通过、ticket 零丢失（红线）。

## 底层运行

```bash
npm install
node src/cli/index.ts daemon      # 启动消费者 + OpenClaw watcher（单实例，唯一 committer）
```

配置在 `$ORGANLEDGER_HOME/config.json`（监听目标、分级规则、时间窗、ignore globs、log_level/保留期）。

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

## 源码目录

```
src/
├── core/     inbox daemon normalizer classifier gate committer ledger pipeline
├── adapters/openclaw/  watcher organ-audit sqlite-dump
├── adapters/hermes/    shim.py
├── onboard/  init detect migrate logger doctor lifecycle autostart   # Phase 1.5
└── cli/      index report rollback approve
```

## 测试

```bash
node --test test/*.test.ts        # 25 个：核心 + classifier + hermes 跨语言 + onboarding(迁移/logger/paths v2)
python -m pytest test/test_hermes_shim.py   # 2 个：shim schema 同构
npm run typecheck                  # tsc --noEmit
```

- `core.test`：ticket/commit/哈希链、去抖、session合并、held、篡改检测、单实例锁、重放幂等
- `onboard.test`：v1→v2 非破坏迁移(链不断/零丢/幂等)、paths v2、logger 落盘+轮转+不落敏感、loadConfigSafe 未初始化不崩

## 数据契约

见 `AIC-000/T-B Agent体检报告/12-数据契约速查表.md`（event / ticket / commit message / config schema）。
