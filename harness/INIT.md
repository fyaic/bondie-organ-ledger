# INIT —— OrganLedger 跨平台（Win + Mac）兼容加固 Harness

> 你是**执行者（Executor）**。本文件是你的开机引导。读完后按第四节 BOOT 顺序行动。
> 参谋长已把 95% 的决策预置在本目录文件中。遇到问题**先查文件，不反问人类**。

---

## 一、配置区（CONFIG）—— 人类填写，AI 只读

```yaml
# 本次不涉及 Linear，故省略 linear 区块。

git:
  target_branch: "feat/cross-platform"   # 【必填】所有改动提交到此分支；P-1 阶段负责创建
  remote: ""                              # 本地仓库，无需远程

project:
  source_path: "C:\\Hello-World\\organledger"   # 【必填】被加固的仓库（就地修改，源=目标）
  target_path: "C:\\Hello-World\\organledger"   # 【必填】同上
  plan_path:   "C:\\Users\\ryshi\\Documents\\Harness-Design\\organledger-兼容加固"  # 【必填】本 Harness 目录
  src_dir:     "C:\\Hello-World\\organledger\\src"
  test_dir:    "C:\\Hello-World\\organledger\\test"
  ci_file:     "C:\\Hello-World\\organledger\\.github\\workflows\\ci.yml"

runtime:
  mode: "完整实现"              # 【必填】不允许因“麻烦”而砍需求；🔴 仅用于技术上不可能项
  total_budget_minutes: 120     # 【必填】硬性总预算
  pomodoro_minutes: 25          # 【必填】工作节拍
```

**人类侧环境事实（参谋长已确认）：**
- 本机 = **Windows 11**（执行者在这里写代码 + 跑 Windows 真机测试）。
- 人类**拥有一台 Mac**，可在收尾阶段按 `06-Mac真机验证清单.md` 亲自真机验证。
- 目标 = 让 OrganLedger 在 **Windows 与 macOS 上行为一致、测试全绿、账本哈希链跨平台不断裂**。

---

## 二、项目背景（CONTEXT）—— 你必须理解

**这是什么项目？**
OrganLedger 是一个「Agent 器官自修改治理层」（Phase 1）。它用 **git + append-only JSONL 账本 + SHA256 哈希链** 记录并治理对 OpenClaw/Hermes 等 Agent 家目录的文件改动。技术栈：**原生 Node.js ≥24 + TypeScript（靠 Node 24 的类型剥离直接跑 `.ts`，无构建步骤）**，唯一运行时依赖是 `chokidar`。

**核心挑战是什么？**
这个项目**设计上已经很注意跨平台**（路径正规化、`process.platform` 分支、`node:sqlite` 内建模块、优雅降级都做得好）。本次任务**不是重写**，而是**堵住少数几个真实的跨平台漏洞**——其中两个是 **BLOCKER 级**：会在 Windows 上**静默破坏账本哈希链**。这是一个「外科手术式加固」，不是「大改造」。

**关键技术约束：**
1. **哈希链神圣不可动**：`sha256(canonicalJson(...))` 的字节必须跨平台稳定。任何改动**不得改变账本记录的序列化字节**。你改的是「读文件时的换行/路径处理」和「CRLF 注入源头」，不是账本格式本身。
2. **无构建步骤**：直接 `node --test test/*.test.ts`、`node src/cli/index.ts`。不要引入 webpack/tsc 产物。
3. **不加运行时依赖**：除非决策树明确允许，不 `npm install` 新包。SIGBREAK/换行处理都用 Node 内建能力。
4. **就地修改**：source_path == target_path。你在 `C:\Hello-World\organledger` 上直接改。

---

## 三、Harness 核心规则（HARNESS）—— 你必须遵守

### 规则 1：预授权决策，不反问
所有技术决策已在 `03-平台适配决策树.md` + `04-代码加固实施手册.md` 中预置到 file:line 级别。遇到技术问题，先查这两个文件。

### 规则 2：跳过并继续，不停下来等
遇到阻塞：① 查决策树/实施手册 → 有方案 → 执行 → 继续；② 完全未知 → 写入 `TODO.md` 的「已知阻塞」+ `99-执行偏差日志.md` + 代码里加 `// TODO(xplat): 原因` → 跳过 → 做下一项。**绝不停下等人类。**

### 规则 3：改一处，测一次
每完成一个 BLOCKER/MAJOR 修复，立刻 `node --test test/*.test.ts` 跑全量测试。**哈希链相关的改动尤其要跑 `test/core.test.ts` 和 `test/attribution.test.ts`。** 绿了才进下一项。

### 规则 4：文件即状态层
进度写 `TODO.md`，偏差写 `99-执行偏差日志.md`。不靠记忆。会话重置后从这两个文件 + 本 INIT 恢复。

### 规则 5：完整实现模式（runtime.mode = 完整实现）
决策树里 🔴（砍掉）**极少**，只在「技术上不可能」时出现。你**不允许**因为「实现麻烦」就跳过一个 🟢/🟡 项。跨平台修复大多是小改动，没有偷懒空间。

### 规则 6：不碰「已做对」的东西
`02-差异分析矩阵.md` 明确列出了**已经跨平台正确、不要动**的部分（路径正规化、chokidar 正则、`process.kill(pid,0)`、`node:sqlite` 降级等）。**不要“顺手优化”它们**——每一次改动都是引入回归的风险。

---

## 四、启动命令（BOOT）—— 你开始工作的第一件事

```
Step 1: 读 00-README.md            （5 分钟总览，理解文件地图）
Step 2: 读 TODO.md                 （了解当前进度；若首次执行，全部待开始）
Step 3: 读 03-平台适配决策树.md     （掌握每个特性怎么处理）
Step 4: 读 04-代码加固实施手册.md   （拿到 file:line 级修复清单——这是你的主战场）
Step 5: 在 TODO.md 记录会话开始时间，进入 Phase -1
Step 6: 执行 Phase -1 环境探测（见 09-执行时序与里程碑.md）
Step 7: 按里程碑 P1 → P6 执行，每步跑自检清单（10-AI自检清单.md）
Step 8: 核心完成后进入后置三轮打磨，直到 120 分钟耗尽或人类喊停
```

---

## 五、启动检查清单（Phase -1 用）

- [ ] 已读 INIT.md / 00-README.md / 03-决策树 / 04-实施手册
- [ ] `C:\Hello-World\organledger\.git` 存在（是 git 仓库）
- [ ] `node --version` ≥ v24
- [ ] `git --version` 可用
- [ ] `C:\Hello-World\organledger\src\onboard\backfill.ts` 存在（BLOCKER 修复点）
- [ ] `C:\Hello-World\organledger\.gitattributes` **不存在**（确认这是待创建项）
- [ ] `node --test test/*.test.ts` 在**修改前**能跑通（拿到绿色基线，才知道后面是不是自己改坏的）
- [ ] 已确认总预算 120 分钟

---

## 六、探索命令速查（Windows PowerShell / Git-Bash）

```bash
# 基线：改动前跑一次全量测试，记录结果到 99-偏差日志
cd /c/Hello-World/organledger && node --test test/*.test.ts

# 创建工作分支
git -C /c/Hello-World/organledger checkout -b feat/cross-platform

# 找出所有“裸 split('\n')”（CRLF 风险点）
grep -rn 'split("\\\\n")' src --include=*.ts

# 确认 .gitattributes 缺失
ls /c/Hello-World/organledger/.gitattributes

# 查看 CI runner
cat /c/Hello-World/organledger/.github/workflows/ci.yml
```
