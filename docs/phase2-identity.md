# Phase 2：身份 / 主使归因（已实现）

> **状态：已交付。** 本文上半部分记录本轮实际交付的「主使(principal)归因层」；
> 下半部分保留 Phase 1 埋下的钩子与最初设想（供对照）。契约细节见
> [`principal-turn-contract.md`](./principal-turn-contract.md)。

## 本轮交付了什么（三轴归因 + turn-id 关联法）

**核心洞察（与最初设想的分歧，诚实记录）：** 最初 Phase 2 设想是"把
`author.verified` 提升为 true"。但那条路在文件系统层证不了（同进程/同 OS 用户）。
本轮改走**更诚实**的路：`TicketAuthor.verified` **仍恒字面 false 不动**，另加一个
**独立、可选、加法式**的 `Attribution` 维度，带它自己的 verified 语义——只有
**IM 平台认证 + 运行时证言**的主使才 `verified:true`（且必注明 `platform-attested`，
非密码学证明）。

**三轴模型**：一次器官改动有三个"谁"——
| 轴 | 含义 | 取值 |
|---|---|---|
| **Writer（手）** | 谁的进程写了字节 | agent-runtime / local / git / unknown |
| **Principal（主使）** | 谁的请求导致的 | im-user（渠道+id）/ local / autonomous / unknown |
| **Autonomy（自主度）** | 被要求还是自发 | requested / self / unknown（忠实性不可证，best-effort） |

用户痛点＝ **Writer=agent 但 Principal=IM 外部用户**，此前 Principal 丢失。

**核心定理 → 唯一解法：** 意图无法从文件系统事后重建 →
必须**写入时刻 in-band 捕获**，账本再 JOIN。给定"半强插桩（有钩子/中间件）"，走
**turn-id 关联法**：
```
IM 入口(hook) ──记──> state/principal/turns.jsonl {turn_id, session_id, principal{渠道,id,attested}, ts}
agent 写器官(shim) ──发──> OrganEvent{…, ctx.turn_id, ctx.session_id}
normalizer ──JOIN(turn_id > session > 时间窗)──> ticket.attribution{writer:agent, principal:<那个IM用户>, autonomy:requested, match}
out-of-band / 无 turn ──> writer&principal = local/unknown, verified:false
```

**实现落点**：
- `src/types.ts` — `Attribution` / `Principal` / `TurnRecord` + 枚举（加法式，哈希链不破）；`Ticket.attribution?`、`EventCtx.turn_id?`。
- `src/core/principal-index.ts` — 读 `state/principal/turns.jsonl`，`byTurn / bySession(仅单一主使) / nearestInSession(±5min,弱)`，append-only tail、缺流/坏行容错。
- `src/core/normalizer.ts` — `resolveAttribution()` 四分支 + `clampPrincipal()` 诚实钳制（非 im-user / 非 attested 一律强制 verified:false）。
- `src/adapters/wecom/principal-turn.ts` — WeCom 入口的**参考实现**（契约写方）；真插桩在仓外 WeCom bridge `monitor.ts:handleWecomMessage`（边界标注）。
- `src/adapters/hermes/shim.py` — `emit_organ_event` 增 `turn_id/session_id` 透传（取不到→null→降级）。
- 看板 — 卡片主使徽标 + 抽屉主使块（诚实文案）+ 按主使/渠道过滤；`organledger attribution --stats`（含 unknown 占比，no silent gaps）。

## 头号红线：诚实分层（自动化断言锁死）

| 情况 | verified | 备注 |
|---|---|---|
| IM 外部用户（WeCom/飞书，平台认证+运行时证言） | **true** | 必带 `attestation:"platform-attested"`（非密码学） |
| agent 自主（有 turn 无 principal） | false | `principal.kind:autonomous`, `autonomy:self` |
| 本机（你/CC/agent 本地） | **永远 false** | 统一 `local-unverified`，不细分、不猜 |
| 未插桩 / out-of-band / 无 turn | false | `unknown` |

- `autonomy:"requested"` **≠** 写入忠实于请求（忠实性不可证，看板显式标"忠实性未证"）。
- `attested` **≠** 密码学证明（运行时被攻陷可伪造）→ 看板写"渠道认证·运行时证言"，**绝不**写"已证明"。
- `match:"time-window"` = 弱关联，看板标"（弱）"。

## 信任模型与边界（诚实声明）

- **attested ≠ proven**：可信度 = 平台认证 + agent 运行时如实上报；运行时被攻陷可伪造 → 非密码学不可抵赖。这是 Phase 2 的边界，签名/凭证链留 Phase 3。
- **requested ≠ faithful**：能证"本轮有 X 的消息"，证不了"这次写入忠实于 X 的请求"。
- **本机不可归因**：本机改动统一 local-unverified，不声称是你还是 agent（用户明确只要这一档）。
- **IM 桥/插件在 organledger 仓外**：其正确性依赖你的基础设施；organledger 只定契约 + 消费 + 参考实现，缺入口则降级。
- **飞书**：本轮为黑盒（无可控入站 channel 源）→ D8 ⏳ 降级，该渠道 principal=unknown；契约 + hook 模板见 principal-turn-contract.md，官方插件开放中间件即可接通。

## 留作 Phase 3 的⏳扩展点

- 忠实性判定（写入是否真照请求）——本轮只给 best-effort 标签 + 显式不确定。
- 密码学不可抵赖（签名/凭证链）——本轮 attested 即可。
- 本机 user vs CC vs agent 自主细分（OS 写入审计/PID 反关联）——用户明确不做。

---

# （历史）Phase 2 预告与 Phase 1 钩子（对照保留）

> 以下为 Phase 1 时期写下的预告，记录当时埋的钩子与最初设想。**实际交付以上半部分为准**
> （最初"提升 author.verified"的设想被更诚实的"独立 Attribution 维度"取代）。
> 权威：`08-架构设计.md §8.9`。

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
