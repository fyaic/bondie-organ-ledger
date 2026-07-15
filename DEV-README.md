# DEV-README —— 开发 / 实测最佳实践

面向**贡献者与自测**。产品说明看 [`README.md`](README.md)；本文件只讲"怎么在本机跑起来、怎么用真数据验收、怎么不弄脏东西"。

---

## 0. 环境前提

- **Node ≥ 24**（用原生 TS type-strip 直接跑 `.ts`，**无构建步骤**）。`node -v` 先确认。
- 唯一第三方运行依赖 `chokidar`；treemap 等一律手写，**禁引重依赖（d3 等）**。
- 跨平台，但下文命令以 **Windows + git-bash** 为主（作者环境）。

```bash
npm install        # 装依赖
npm link           # 注册全局 `organledger` 命令（一次即可；Win 装到 npm 全局 bin，已在 PATH）
organledger --help # 验证装好
```

> 不想装全局命令：在仓库目录内用等价写法 `node src/cli/index.ts <cmd>`（或 `npm run ol -- <cmd>`）。
> 卸载：`npm unlink -g organledger`。

---

## 1. 数据隔离铁律（**别弄脏**）

本仓库是**要分发的产品**。任何实测都**不得**污染分发物或用户真实账本。

| 位置 | 是什么 | 规矩 |
|---|---|---|
| 仓库工作树 | 要分发的源码 | **零** ledger 数据进 git；提交前 `git status` 必须干净 |
| `~/.organledger` | 用户**默认真实账本** | 实测**不碰它**（daemon 才写它） |
| `~/.organledger-demo` | **实测/验收专用**账本（可含真数据回填） | 所有自测都 `--home` 指到这里 |

- **账本数据永远在仓库外**（`~` 下），git 仓库里不该出现任何 `.organledger*` 文件。
- 需要"真实效果"验收时，用一个**独立的 demo 账本**承载真数据（`organledger backfill` 从真实 target 的 git 历史回填），而不是往默认 `~/.organledger` 里灌。
- 默认 home 若被 reset 过，旧数据会在 `~/.organledger.bak-<ts>`，**不要覆盖**。

---

## 2. 实测 / 验收工作流（每次要看真实效果）

```bash
# 用独立 demo 账本承载真数据（一次性；从真实 target git 历史回填，带来源）
organledger init --home ~/.organledger-demo --openclaw ~/.openclaw --yes --no-snapshot
organledger backfill --home ~/.organledger-demo --full-history --reflog

# 每次实测：重算文件树 + 起看板（三视图：看板 / 日志 / 文件树）
organledger heatmap   --home ~/.organledger-demo             # 默认=完整器官树（1.8 起）
organledger dashboard --home ~/.organledger-demo --open      # 默认 http://localhost:7377
```

- 嫌每次带 `--home` 烦：`export ORGANLEDGER_HOME=~/.organledger-demo`，之后 `organledger dashboard` 直接就是真数据；默认家目录与分发仓库**都不受影响**。
- **看板默认视图是「近 7 天」**——器官改动稀疏时会显空。验收历史请把日期筛选切到「全部」。

---

## 3. 看板服务生命周期（Windows 陷阱）

看板是只读常驻进程。**停它要按真实 PID**，不能用 git-bash 的 `$!`（那是 wrapper PID，杀不掉真进程）。

```bash
# 找占用某端口的真实 PID 并停掉（起新看板前先清旧的）
powershell.exe -NoProfile -Command "(Get-NetTCPConnection -LocalPort 7377 -State Listen -ErrorAction SilentlyContinue).OwningProcess"
powershell.exe -NoProfile -Command "Stop-Process -Id <PID> -Force"
```

- **端口占用 = 旧看板还在**：Node 启动即定型、不热重载，旧进程会跑旧代码（曾导致点「日志」→ `/api/activity` 404）。改完代码务必**重启**看板。
- 前端资源（HTML/JS/CSS）每次请求现读盘 + `Cache-Control: no-cache`，浏览器不会缓存旧前端；但**后端路由变更必须重启进程**。

---

## 4. 质量门（提交前必过）

```bash
node --test test/*.test.ts        # 全部 TS 测试
python -m pytest test/            # hermes shim 跨语言测试
npm run typecheck                 # tsc --noEmit（Node24 type-strip 限制：无 enum / parameter-props / namespace）
```

- 新增功能**加测试**；隐私相关功能**必须带隐私断言**（见 §5）。
- 回归红线：既有测试全绿、哈希链 `organledger verify-ledger` intact、`author.verified` 恒 `false`。

---

## 5. 不可破的产品红线（改这些模块前先读）

- **隐私（头号）**：`state/heatmap.json` 与 `/api/activity` **绝不含**文件内容 / diff / hash / `reason` / 密钥。
  - **看板不内联内容**：文件树**无任何**"看文件内容 / 看 diff"入口；要看内容 → 点文件走 `/api/reveal` 在 **OS 文件管理器**里定位（1.8 姿态转变，见 [[organledger-filetree-heatmap]]）。
  - 文件名**默认真实**（本机导航需要），`redacted:true` 仅是敏感标记；`--redact` / 看板「打码」开关才把名字→`•••`、`rel_path→""`、并禁止 reveal（截图/分享用）。`change_count` 始终保留。
  - `test/heatmap.test.ts` 2 条隐私断言（字段白名单 + `--redact` 打码留热度）+ `test/reveal.test.ts` 2 条安全断言（越界 403 零 spawn + 符号链接逃逸被拒），改动别让它们变红。
- **reveal 安全（1.8 头号红线）**：`/api/reveal` 只能定位 target **根内**文件——`resolveReveal`（`src/dashboard/reveal.ts`）先 realpath 越界校验、拒 `..`/绝对路径、**再** spawn；spawn 用**参数数组不经 shell**、**只 select/-R 不执行**、仅 `127.0.0.1`。越界 = 403 不 spawn。
- **看板只读**：`src/dashboard/` 里 spawn/`child_process` **只允许**出现在 `reveal.ts`（用户显式触发的本机定位）；`readdir` **只允许**账本态（held/reports），**绝不**遍历 target、**绝不** git。
  - 目录遍历**只在 CLI 命令**（`organledger heatmap`，只 `readdirSync` 拿名字/类型，**绝不** `readFileSync` target 内容）；看板只 `fs.readFile` state/*.json（+ reveal 定位）。
  - 自证：`grep -rE 'spawn|child_process|"git"' src/dashboard/` → spawn 仅 `reveal.ts`、无 git。
- **有界**：完整树遍历尊重 `config.ignore` + 硬排除 `node_modules/.git/.venv/venv/__pycache__` + `MAX_NODES=5000 / MAX_DEPTH=6 / MAX_CHILDREN=200`，超限折叠并标 `truncated`（no silent caps）。
- **加法式**：不改 ticket schema、不碰哈希链、`verified` 二维语义不变。

---

## 6. 提交陷阱

- **绝不 `git add -A` / `git add .`**：仓库里有未跟踪的 `.github/`（`ci.yml`），误加进提交会触发 workflow-scope 推送失败。**逐文件 `git add`**，提交前 `git diff --cached --name-only` 确认 `.github` 不在其中。
- favicon 等二进制资产走 `sendBinary`（Buffer），不要用读 utf8 的 `sendStatic`（会损坏字节）。

---

## 7. 常用自检命令

```bash
organledger doctor  --home ~/.organledger-demo   # 健康报告（含 heatmap 段：快照存在/新鲜/节点数/truncated）
organledger paths   --home ~/.organledger-demo   # 每个产物落在哪（heatmap.json / provenance.json 归 state）
organledger status  --home ~/.organledger-demo   # 快速摘要 + 链完整性
```

---

## 8. 跨平台兼容性（Windows + macOS）

> `feat/cross-platform` 分支的加固成果。目标：Win/Mac 行为一致、测试全绿、**账本哈希链跨平台不断裂**。

- **行尾钉 LF（哈希链命脉）**：仓库根 `.gitattributes` 用 `* text=auto eol=lf` + 二进制 `binary` 标注。
  无此文件时 Windows 默认 `core.autocrlf=true` 会在 checkout 注入 CRLF，使 `fileSha()` 对工作区算的 hash 与 HEAD(LF) 不符 → 链断。clone 后应 `git ls-files --eol` 确认全 `lf`。
- **CRLF 解析容错**：所有解析「git 输出 / 磁盘文本」的 `split` 统一用 `/\r?\n/`（`backfill.ts`、`init.ts` 等），避免行尾残 `\r` 导致字段错位。切割「内存里自己拼的 `\n` 串」的 split 保持不动。
- **Windows 优雅关闭**：Windows 无 `SIGTERM`，daemon 额外注册 `SIGBREAK`（Ctrl-Break / 计划任务停止路径），并加一次性 guard 防重入，确保释放 `daemon.lock`。
- **macOS 符号链接路径**：`provenance.ts:resolveSources` 的 `homeAbs` 用 `fs.realpathSync` 规范化，与 `git rev-parse --show-toplevel` 的真实路径可比。macOS 上 `/var`、`/tmp` 是指向 `/private` 的符号链接，否则嵌套 embedded 仓库检测会全部失效。
- **python 探测**：`hermes.test.ts` 缺 python 时 `skip` 而非 `fail`（跨语言 shim 测试）。
- **CI 三平台矩阵**：`.github/workflows/ci.yml` 在 `ubuntu / windows / macos` 上跑 `npm run typecheck && npm test`（Node 24 的 `--test` 自带 glob 展开，三平台一致）。
  ⚠️ 见 §6：推送 `.github/workflows/*` 需要 GitHub token 带 `workflow` scope，否则 `git push` 会被拒。该文件在本分支已单独成一个 commit，便于按需取舍。
- **未纳入（二期）**：`autostart.ts` 的 mac launchd / Linux systemd 自启动生产化（当前仅输出模板），Linux 最小系统 `xdg-open` 深度适配。
