# 执行 Todo —— OrganLedger 跨平台加固

> 当前 Phase：✅ 全部核心 + 后置 A/B/C 完成（待人类 push + Win 侧验证）
> 会话开始时间：2026-07-15 18:54 CST（macOS 执行，非计划假设的 Windows）
> 当前分支：feat/cross-platform（已存在，直接沿用）

## 已完成
| 序号 | 任务 | Phase | 完成 | 测试结果 |
|------|------|-------|------|---------|
| T0 | 环境探测 + 绿色基线（node v26 / git 2.53）| P-1 | ✅ | 基线 86 pass / 4 fail（4=既有 macOS bug）|
| T1 | 建 `.gitattributes` + `--renormalize` | P1 | ✅ | 4 个 dashboard 文件从 CRLF→LF；测试不回归 |
| T2 | backfill.ts:190 CRLF + init.ts:155/189 同类 | P2 | ✅ | 哈希链测试全绿 |
| T3 | Windows SIGBREAK + 一次性 guard | P3 | ✅ | typecheck 绿 |
| T4 | hermes 测试 python 探测（缺则 skip）| P4 | ✅ | 本机有 python3，pass |
| T6 | CI 三平台矩阵（**从零创建** ci.yml）| P4 | ✅ | 本机模拟 `npm ci && typecheck && test` 全绿 |
| T5 | reveal UNC 注释（`//` 形态）| P6 | ✅ | reveal 7/7 绿 |
| **T-extra** | **macOS 符号链接 BLOCKER 修复**（provenance.ts）| 后置A | ✅ | provenance 4 fail → 7/7 全绿 |
| T7 | 全量测试全绿 | P5 | ✅ | **90 pass / 0 fail / 0 skip**（基线 86→90）|
| T8 | 校对 06-Mac清单 + DEV-README §8 + commit | P6 | ✅ | 子命令名全对得上 |
| T9 | 后置 A/B/C 打磨 | 后置 | ✅ | B:diff 审查通过（未碰 C 区/canonicalJson）; C:DEV-README §8 |

## 进行中
| — | （空，全部完成）| | | |

## 已知阻塞
| — | （无）| | | | | |

## 待人类跟进（执行者产出后标注）
| 项 | 说明 | 状态 |
|----|------|------|
| **CI push（workflow scope）** | ci.yml 已单独成一个 commit。⚠️ DEV-README §6：推送 `.github/workflows/*` 需 GitHub token 带 `workflow` scope，否则 push 被拒。人类 push 后在 GitHub 观察三平台是否全绿 | ⏳ 待 push |
| Windows 真机验证 | 情况反转——代码在 Mac 上做的，Win 侧尚未真机跑。人类需在 Windows 上 clone 本分支跑 `npm test` + init/daemon/SIGBREAK | ⏳ 待验证 |
| Mac 真机验证 | 执行者已在 Mac 预跑 90/90 全绿；06 清单已校对，建议人类独立复跑一遍 | ✅ 预验证/待复核 |
| 跨平台哈希金验证 | Win 与 Mac 对同一 LF 内容的 fileSha 应相同（06 验证5）| ⏳ 待双机对比 |

## 进度摘要
> 5 项核心任务全做完 + 额外修复 1 个 macOS 专属 BLOCKER（Windows 参谋长看不到的）。
> 全量测试从基线 86/4 → **90/90 全绿**，typecheck 绿，diff 审查通过（未碰哈希链序列化/C 区）。
> CI 三矩阵从零创建（单独 commit，便于按 workflow-scope 取舍）。
> 剩余为人类侧：push CI（需 workflow scope）+ Windows 真机验证 + 跨平台哈希金对比。
