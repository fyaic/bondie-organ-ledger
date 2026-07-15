# PRD —— OrganLedger 跨平台兼容加固

## 一、用户故事
作为 **OrganLedger 的维护者**，我希望这个治理层**在 Windows 和 macOS 上行为完全一致、测试全绿、且账本哈希链不会因平台差异而断裂**，以便**任何人在任一平台 clone 后都能直接 `init` + 跑 daemon，账本可跨机器验证、可信任**。

## 二、需求表述

**用户要的是什么？**
把 OrganLedger 从「设计上兼顾 Win/Mac、但只在 Linux CI 上验证过」提升到「Win/Mac 均已修复真实漏洞、CI 三平台矩阵守护、Mac 真机跑通核心流程」。

**成功标准（验收）：**
1. **BLOCKER 全消**：新增 `.gitattributes` 钉死 LF；消除所有会在 Windows 引入 CRLF 或错误解析 CRLF 的代码路径 → 账本哈希链在 Win/Mac 上对同一改动产出**相同的 before/after hash**。
2. **MAJOR 全修**：Windows 下 daemon 能优雅关闭（SIGBREAK）；python 探测在缺 python 时优雅跳过而非崩溃。
3. **CI 三矩阵**：`.github/workflows/ci.yml` 在 `ubuntu-latest` + `windows-latest` + `macos-latest` 上跑 `node --test`，全绿。
4. **测试不回归**：`node --test test/*.test.ts` 在 Windows 本机全绿；改动前后核心测试数不减少。
5. **Mac 真机验证清单**：产出 `06-Mac真机验证清单.md`，人类可照单在 Mac 上跑通 init → daemon → dashboard → reveal → 哈希链校验。

## 三、范围边界

### 包含
- [ ] `.gitattributes` 创建 + 已入库文件按 LF 重新正规化
- [ ] `backfill.ts` 等所有裸 `split("\n")` → `split(/\r?\n/)`
- [ ] Windows `SIGBREAK` 优雅关闭
- [ ] `hermes.test.ts` python 可用性探测（缺失则 skip 而非 fail）
- [ ] CI 三平台矩阵
- [ ] 少量 MINOR 加固（UNC 路径注释、xdg-open 存在性——见决策树）
- [ ] Mac 真机验证清单（人类执行）
- [ ] 全量测试 Windows 本机跑绿

### 不包含（二期 / 明确排除）
- [ ] **mac/Linux 自启动生产化**：`autostart.ts` 目前 mac 只输出 `.plist` 模板 + 手动安装指引。本次**保持现状**，不做 launchd/systemd 的自动安装与真机验证（launchd 自启动属于超出「代码级加固」的范畴）。决策树标 ⏳。
- [ ] Linux 专属打磨（`xdg-open` 缺失在最小系统）——仅加一行防御，不深追。
- [ ] 任何账本格式 / 序列化字节的改变。
- [ ] 新增运行时依赖。
- [ ] 重构「已做对」的跨平台代码（见 02 矩阵的“勿动”清单）。

## 四、关键约束
1. **哈希链字节稳定**：不得改变 `canonicalJson` / 账本记录序列化。
2. **无构建、无新依赖、就地修改**。
3. **时间**：120 分钟；每步改完即跑测试。
4. **神圣测试**：`test/core.test.ts`、`test/attribution.test.ts`、`test/provenance.test.ts` 是哈希链守护，任何改动必须让它们保持绿。
