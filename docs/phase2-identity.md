# Phase 2 预告：身份（可验证 provenance）

> 本期（Phase 1）交付「意图→审批→审计→回滚」四环 + **未验证**署名。身份整环留 Phase 2。
> 权威：`08-架构设计.md §8.9`。本文记录 Phase 1 已埋的钩子，Phase 2 **只增强、不重构**。

## 为什么身份留后

不是"能不能做"，是"能做到多强"。文件系统层所有写入同进程、同 OS 用户，纯 fs 层
**无法证明变更主体**（07 调研里 ClawSec、Sleeper Channels 都卡在此）。所以本期诚实地把
`author.verified` 恒置 `false`，schema 预留全部字段等待 Phase 2 填强。

## Phase 1 已埋的钩子（前向兼容）

| 位置 | 钩子 | 现状 | Phase 2 用途 |
|---|---|---|---|
| `src/core/normalizer.ts` | `resolveAuthor(ctx)` | 恒返回 `{verified:false}` | in-band session 绑定后提升 verified |
| ticket schema (`12.3`) | `author.{type,id,verified}` / `session_id` | 字段齐全、值未验证 | 直接填真值，不改结构 |
| `src/adapters/openclaw/organ-audit.ts` | `organ-audit.jsonl`（pid/ppid/cwd/argv/prevHash/nextHash） | **write-only 种子** | Bash 绕过按 pid/argv/时间窗反关联会话 |
| 事件 `ctx.pid/argv/session_id` | 采集但 out-of-band 多为 null | — | in-band 带真实 session |

## Phase 2 路线（08 §8.9）

1. **in-band 会话绑定**：把 `session_id` 从 Hermes `skill_provenance._write_origin` ContextVar
   一路带到账本 → `verified:true`。这是最高置信度路径。
2. **Bash 绕过关联**：fs watcher 事件按 `pid/argv/时间窗` 反向关联回会话日志。
   **复用本人 Bondie 已验证的归因经验**：
   - `mtime ≠ 编辑时间 → 假动态`（serverFiles.mtime 是最后同步时间）→ 靠内容变更判定 + 同步爆发抑制；
   - `last-syncer 偏斜` → 用 `getHistory` 从"最后同步者"纠正到"真作者"；
   - 默认关 + 全防御（getHistory 曾返回空）。
   这与 organ-audit 的 pid/argv 种子是同一个 provenance 难题，有现成教训。
3. **防篡改**：账本哈希链（本期已实现 `verify-ledger`）+ ClawSec 式 SHA256 基线自愈。
4. **可选 attestation**：借 Sleeper Channels 的 owner 一次性确认，用于 critical 器官。
5. **外部审批**：critical/delete → 自动开 issue/PR，reviewer approve 后 replay pending
   （本期已有 `approve/reject` 的 held 闭环，Phase 2 换成外部触发即可）。

## 其它 Phase 2 项

- OpenClaw SQLite trigger 级审计表（本期是 dump-to-md，丢日内中间态）。
- Hermes `git init ~/.hermes` 器官纳版本控制。
- symlink 逃逸器官（`.agents/skills/*`、`Hello-World/*`）用 submodule/多 repo 纳入
  （本期显式跳过 + 审计说明，见 `watcher.ts` 的 symlink-escape guard 与内嵌 git 仓库限制）。
