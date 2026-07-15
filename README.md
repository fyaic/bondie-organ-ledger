# OrganLedger（器官账本）

> 平台无关的 **Agent 器官文件自修改治理层** —— 给 AI Agent 自我修改的 skills / agents / cron / memory / flows 补上「**意图 → 审批 → 审计 → 回滚**」闭环。

Agent 会自己改自己的"器官"，但这些写操作**没身份、没意图、没审批、没历史、没可观测性**。
OrganLedger 站在 OpenClaw / Hermes 之外，把每次器官改动自动记成**带意图的变更单 + git 版本 + 防篡改哈希链账本**，可日报、可回滚、高危可拦审，并配一个本地只读审计看板。

> 状态：Phase 1（治理引擎）+ 1.5（onboarding / 布局 / 本地看板）+ 1.6（**来源 Provenance**）+ 1.7（活动日志 + 隐私热力）+ 1.8（文件树热力 + OS 定位）+ **Phase 2（主使归因 Attribution）** 均已实现并测试通过。
> **三轴诚实模型**（`verified` 分维，绝不 overclaim "证明了谁改的"）：
> - **来源(provenance)**：器官"从哪个 remote/commit 来"→ 内容寻址**可验证**（`provenance.verified:true`）。
> - **主使(principal)**：IM 用户经**平台认证 + 运行时证言 attested**（Phase 2；**attested ≠ 密码学证明**）；本机 local-unverified；agent 自主 self。
> - **作者身份(author.verified)**：**恒 `false`**——谁按下的手，仍不声称证明。`requested ≠ 忠实`、本机不可归因。

## 🚀 快速开始（新用户从这里）

> 需要 **Node ≥ 24**（用原生 TS type-strip 直接跑 `.ts`，无构建步骤）。`node -v` 先确认。
> 贡献 / 本机实测的最佳实践（数据隔离、`--home` 验收、看板进程管理、提交陷阱）见 [`DEV-README.md`](DEV-README.md)。

```bash
# 0) 装依赖 + 安装 CLI 命令 —— 一次即可，之后全局用 `organledger xxx`
npm install            # 唯一第三方依赖 chokidar
npm link               # 注册全局 `organledger` 命令（Win: 装到 npm 全局 bin，已在 PATH）
organledger --help     # 验证：能打出命令列表就说明装好了

# 1) 一键 onboard —— 探测你的 OpenClaw/Hermes、生成配置、建目录、设首扫水位、自检。全程零手写 JSON
#    首扫水位会往 target repo 写 1 条 scoped commit，交互模式下会先 y/N 询问（--yes 免询问，--no-snapshot 跳过）
organledger init

# 2) 开始治理 —— 挂后台常驻，Agent 一改器官文件就自动记账（生成变更单 + git commit + 哈希链账本）
organledger daemon

# 3) 看审计看板（另开一个终端）—— http://localhost:7377
#    三视图：看板 / 日志 / 文件树；看板含「来源面板」+「主使徽标」（👤IM用户·渠道认证 / 🤖agent自主 / 🖥本机未验证 / ❔未知）
#    文件树：左键定位文件 · 右键在资源管理器/访达打开文件夹（reveal）
organledger dashboard --open

# 4) 日常复盘 / 撤销 / 发现更多
organledger report --date today          # 今日改了啥
organledger rollback --change <change_id> # 改错了一键安全退回
organledger provenance                   # 器官来源图（remote/branch/落后上游）
organledger heatmap                      # 文件树热力（颜色=改动频率，无内容）
organledger attribution --stats          # 主使分布（im-user/本机/自主/unknown 占比，含未插桩=unknown）
organledger doctor                       # onboard 是否齐、各视图就绪度、归因接没接
```

> onboard 后**看板全视图即满**：`init` 的「预热」步已生成 `state/provenance.json` + `state/heatmap.json`（只读非致命，`--no-prime` 可跳过）。回访重跑 `init` 会刷新这些 state 并提示"新视图已就绪"。

- **没装 CLI 命令？** 没跑 `npm link` 前 `organledger` 不存在（会报"不是内部或外部命令"）。要么先 `npm link`，要么在仓库目录内用等价写法 `node src/cli/index.ts <cmd>`（或 `npm run ol -- <cmd>`）。
- 卸载全局命令：仓库目录里 `npm unlink -g organledger`。
- 所有数据都在 `~/.organledger`（配置 / 账本 / 日报 / 运行日志），要备份就备份 `ledger/` + `config.json`。
- 遇到问题：`node src/cli/index.ts doctor`（健康自检）、`... paths`（东西都在哪）。
- **它不是 skill**，是旁挂在 OpenClaw/Hermes 之外的独立治理进程；OpenClaw 感知不到它。

## 地基决策（不要动）

```
适配器(只 append 事件) → events/inbox.jsonl → 单一消费者守护进程
   → 归一化 → 分级 → 门控 → 单一 committer(去抖+session合并) → git + 哈希链账本
   → Reporter 日报 / Rollback 回滚
```

- **唯一 committer**：只有守护进程写 git 和账本，适配器只 append 事件 → 解双写竞态。
- **session 合并**：同 session/窗口多文件 → 一个逻辑 commit → 解提交噪音。
- **统一 JSONL schema**：in-band(Hermes) / out-of-band(OpenClaw) 两源天然归一。

## 诚实边界（三轴模型）

- **三轴分层归因**（`verified` 各自独立，绝不 overclaim）：
  - **来源(provenance)** 可内容寻址**验证**（1.6，`provenance.verified:true`）；
  - **主使(principal)** 仅 IM 用户经**平台认证 + 运行时证言 attested** 才 `verified:true`（Phase 2；**attested ≠ 密码学证明**，运行时被攻陷可伪造）；本机 local-unverified；agent 自主 self；未插桩 unknown；`requested ≠ 忠实`（能证本轮有该请求，证不了写入忠实于请求）。
  - **作者身份(author.verified)** **恒 `false`**——谁按下的手仍不声称证明（见 `docs/phase2-identity.md`）。
- **非破坏**：任何回滚/提交只操作明确文件，绝无 `git add -A` / `checkout` / `reset` 用户改动；回滚前建 safety 分支。
- **门控默认 observe**：仅 `severity=critical` 或 `op=delete` 才 `held`（阻塞待确认）。
- symlink 逃逸 repo 外的器官：**治理边界外**，跳过 + 审计说明。
- **内嵌 git 仓库型 skill**：Phase 1.6 起**已纳入治理**——每个内嵌 repo 是一个独立 `GitSource`，回填其历史并附可验证来源（见「器官来源 / Provenance」）。

## 技术栈

- 核心 + OpenClaw 适配器：**TypeScript（Node 24 原生 type-stripping，无需 ts-node/tsc 运行）**。
- SQLite memory 投影：内置 `node:sqlite`（无需 better-sqlite3 原生编译）。
- Hermes 适配器：Python 3.12 薄 shim（只 append JSONL）。
- 唯一第三方依赖：`chokidar`（文件监听）。

## 跨平台兼容性（Windows + macOS + Linux）

Win/Mac 行为一致、测试全绿、**账本哈希链跨平台不断裂**。`feat/cross-platform` 已加固：

- **行尾钉 LF（哈希链命脉）**：根级 `.gitattributes`（`* text=auto eol=lf`）。无它则 Windows `core.autocrlf=true` 会在 checkout 注入 CRLF，令 `fileSha()` 对工作区算的 hash 与 HEAD(LF) 不符 → 链断。clone 后 `git ls-files --eol` 应全 `lf`。
- **CRLF 解析容错**：解析 git 输出 / 磁盘文本一律 `split(/\r?\n/)`，行尾残 `\r` 不会污染字段。
- **Windows 优雅关闭**：Windows 无 `SIGTERM`，daemon 额外注册 `SIGBREAK`（Ctrl-Break / 计划任务停止）+ 一次性 guard，干净释放 `daemon.lock`。
- **macOS 符号链接路径**：`resolveSources` 用 `fs.realpathSync` 规范化 home，与 `git rev-parse --show-toplevel` 的真实路径可比（`/var`、`/tmp` 是指向 `/private` 的软链），否则嵌套 embedded 仓库检测会失效。
- **python 探测**：缺 python 时跨语言 shim 测试 `skip` 而非 `fail`。
- **CI 三平台矩阵**：`.github/workflows/ci.yml` 在 `ubuntu / windows / macos` 上跑 `typecheck + test`（`node --test` 自带 glob 展开，三平台一致）。

> 详见 [`DEV-README.md`](DEV-README.md) §8 与 `harness/` 加固记录。

## Onboarding（新用户，零手写 JSON）

```bash
npm install
node src/cli/index.ts init        # 探测 OpenClaw/Hermes → 生成 config → 建目录 → 首扫水位 → 自检
node src/cli/index.ts daemon      # 开始治理
```

`init` 八步：环境探测 → 生成/合并 `config.json` → 建 v2 分区目录 + `VERSION` → （旧布局则）无损迁移 →
**历史回填**（把 target git 历史回放成 ticket，装上即有纵深，见下）→ 首扫水位（写 target `.gitignore` + scoped 快照，排除运行期 churn/密钥/大二进制/内嵌仓库/memory 二进制 sqlite）→
**预热 dashboard state**（生成 `state/provenance.json` + `state/heatmap.json`，让「来源 / 文件树」视图首开即满；**只读 target、失败非致命**、`--no-prime` 跳过）→ 自检 → 完成语（枚举三视图 / reveal / 新命令）。
首扫水位会向 target repo 写 1 条 commit：交互模式先 `y/N` 询问，`--yes` 免询问直接建，`--no-snapshot` 跳过（可日后再 `init`）。
非交互：`init --yes [--openclaw <p>] [--hermes <p>] [--home <p>] [--no-snapshot] [--no-backfill] [--full-history] [--no-prime] [--autostart]`。**幂等**：重复 `init` 安全（回访会刷新 state 并提示"新视图已就绪"）。

### 历史回填（新装即有纵深，不再空看板）

水位线只保证"从现在起观测"，**装上那一刻之前的器官变更史默认不入账 → 看板初见为空**。
`init` 会自动把 target 的 **git history 回放成回填 ticket**，让看板一上来就有器官演化史：

```bash
organledger backfill                 # 近 90 天历史 → 回填 ticket（默认）
organledger backfill --full-history  # 全量历史
organledger backfill --since-days 30 # 自定义窗口
organledger backfill --reflog        # 额外回填 reflog 上游更新事件（pull/merge/clone）
```

- **只读 target**：仅 `git log/show`，绝不写 target；**幂等 + 增量**：按 `git_commit` 去重，重跑只补新提交。
- **一次 commit = 一个 squash 组**（`session_id=git:<sha>`）；`op`/前后 blob hash/`git_commit` 均取自 git；`severity` 复用分级器。
- **复用 D-005 排除**：`cron/runs`、`flows/tasks` sqlite、`memory/*.sqlite`、`*.log` 等运行期 churn 一律不回填（真机实测 21 commit 回填 426 ticket、丢弃 133 个 churn 文件）。
- **诚实边界**：`author.verified` 恒 `false`。git author 仅作**未验证 hint** 存入 `author.id`（`git:<name> <email>`），**不声称证明了谁改的**——自动 commit 会让作者被 last-committer 偏斜。
- **红线**：回填后 `verify-ledger` 必须通过（`init` 步骤 4 内联校验）。回填在**空账本**上最干净；对已有 ticket 的老库回填 append 到链尾，历史 `created_at` 早于既有 ticket（时间非单调，但链完整）。

> **让你的编码终端 Agent 一键填充看板**：把 [`prompts/populate-dashboard-history.md`](prompts/populate-dashboard-history.md)
> 丢给 Claude Code / Cursor / Codex（或直接说"运行 `prompts/populate-dashboard-history.md` 里的任务"）,
> 它会按内置守则**先停 daemon（含 Windows 真实 PID 停法）→ 回填 → verify-ledger → 打开看板**,全程只读 target、幂等安全。
>
> 另两个可复用提示词：
> - [`prompts/prime-dashboard-views.md`](prompts/prime-dashboard-views.md) —— 让 Agent 一键 `provenance` + `heatmap`（+按需 `backfill --reflog`）**点亮全部视图**（只读、幂等）。
> - [`prompts/wire-wecom-attribution.md`](prompts/wire-wecom-attribution.md) —— 引导 Agent 按 [`docs/principal-turn-contract.md`](docs/principal-turn-contract.md) 给**自建 WeCom 桥**收消息处插桩，把 IM 主使喂进归因。**硬红线**：只对平台认证的真实 userid 标 attested、**绝不伪造 verified**、`attested ≠ proven`、仓外改动显式边界标注、不动 organledger 仓自身。

## 器官来源 / Provenance（Phase 1.6）

**现场事实**：`~/.openclaw` 是父仓库，但 `skills/` 下往往是**十几个各自独立的 GitHub repo**（非 submodule、无 gitlink）——
父仓库 `git log` 看不到它们，旧账本对这些 skill 全盲。Phase 1.6 补上"**器官从哪个 remote/分支/commit 来、何时从上游更新、是否偏离上游**"这一维。

**核心概念——`verified` 拆成两维**：
- **来源可验证**：commit SHA 是内容寻址、remote/branch 来自 config → `provenance.verified: true` 是密码学/配置事实。
- **身份不可验证**："谁按下 pull / 谁改的"无法证明 → `author.verified` **恒 `false`**（Phase 2 才碰）。
- 抽屉如实写：`✅ 来源已验证（内容寻址）· ⚠️ 身份未验证`。

```bash
organledger provenance            # 扫描每个器官文件夹的 git 源 → 打印表 + 落 state/provenance.json（只读）
organledger provenance --fetch    # 唯一联网例外：先 git fetch（只 fetch 不 merge）刷新 领先/落后
organledger provenance --json     # 仅输出 JSON（脚本用）
organledger backfill --reflog     # 回填 reflog 上游更新事件（pull/merge/clone，含 from→to + 时间）
```

- **多 GitSource**：父仓库 + 每个内嵌 repo 各是一个 source；用 `git rev-parse --show-toplevel` 判定（死 `.git` 目录自动折叠进父，不成幻影 source）。
- **来源地图**（`GitSource`）：每源的 `{repo_root, remote_url, branch, head, upstream, ahead, behind, dirty}`；离线时 ahead/behind 标 `as of last fetch`（诚实）。
- **每 ticket 附来源**：回填的每条 content ticket 带 `provenance{kind:"content", remote_url, branch, to_commit=commit, verified:true}`；`file` 用相对 target.home 全路径（如 `skills/eye-on/SKILL.md`），看板口径统一。
- **上游更新事件**：`--reflog` 把 pull/merge/clone 变成 repo 级 ticket（`before→after=git:from→to`、时间取自 reflog）。诚实局限：reflog 默认 ~90 天 gc，更早不可恢复；窗口内无 pull 属**真实结果非失败**。
- **看板**：新增「器官来源」面板（读 `state/provenance.json`，**看板绝不跑 git**）+ 抽屉来源块 + 「上游更新 / 本地改动」过滤（**来源**轴只判"从哪来"、可验证；"谁改的"归**修改者**轴，见 Phase 2）。
- **doctor**：新增 provenance 段，列各 source 的 remote/branch/dirty/落后标记。

生命周期：
```bash
organledger doctor        # 健康报告（env/paths/config/audit/runtime/capacity 🟢🟡🔴）
organledger paths         # 每个产物在哪（含类别与是否存在）
organledger reset         # 默认 --keep-audit：清 state/logs/cache，保留 ledger/config
organledger reset --all --confirm   # 先备份再全清
organledger uninstall     # 停 daemon 提示 + 移除自启；绝不动 target 内 .git/audit
organledger autostart     # 装登录自启（Windows 计划任务）
```

## 活动日志 + 隐私热力图（Phase 1.7，面向非工程师）

工程化的看板（按 status 分列 + 来源面板）对**非工程师用户可读性不够**。1.7 加两个面向直觉的可视化，**两种不同的隐私姿态**：

| 视图 | 暴露什么 | **不**暴露什么 |
|---|---|---|
| **日志 / Activity（A）** | 白话的"改了什么 / 在哪 / 来自哪个上游"（路径、op、来源 remote、commit 主题） | 文件内容、diff |
| **热力图 / Heatmap（B）** | **仅**结构 + 颜色(=改动频率) + "N 次改动·最近日期" | **一切**文件详情：内容、diff、（敏感路径的）名字都打码 |

> 头号红线（等同 1.6 的 `author.verified`）：`heatmap.json` 与 `/api/activity` **绝不含**文件内容/diff/hash/reason/密钥；热力图**无任何**"看文件详情"入口，点击最多弹计数 tooltip；敏感路径**默认打码但仍显热度**。

**A —— 活动日志**：服务端从**已加载的 tickets** 聚合成按天白话叙事（**零新增 fs 遍历/git**）。
- `/api/activity?window=all|Nd` → `ActivityDay[]`：每天含 新增/更新/删除 计数、按文件夹/skill 的 rollup、上游更新事件数、**中文白话摘要**（如"meeting-workflow 技能新增 115 文件 · 从 Bondie 拉取更新 1 次"）。
- 看板「日志」tab：按天倒序卡片（日期+周几+计数 pill+上游 pill）；点某天 → 抽屉列当天逐条（路径/op/来源/commit 主题，**无内容/diff**）。
- 混合时区（`+08:00`/`-07:00` 混排）统一走 `util.localDay()` 落**本地日**，与日报/看板同一口径。

**B —— 隐私热力图**：一个**只读 CLI 命令**遍历目录、落 `state/heatmap.json`，看板只读该文件（照抄 provenance 模式）。
```bash
organledger heatmap                       # 默认 changed-only：树=账本出现过的 path 并集（结构上不可能泄露账本没有的东西）
organledger heatmap --full-tree           # 额外只读遍历 target 补齐"存在但从未改动"的节点（change_count=0）
organledger heatmap --window 30d          # 只算近 N 天的频率
organledger heatmap --redact "<glob>,..." # 追加敏感 glob（默认已含 **/agents/main/**、**/credentials/**、**/.env*、**/*.key|pem、**/*device-auth*、**/auth-profiles*、memory/*.sqlite*、**/secrets/**）
organledger heatmap --json                # 仅打印 JSON（不落盘）
```
- **频率数据源 = 账本 ticket 计数**（叶子=该路径 ticket 数；目录=后代之和）。账本已排除运行期 churn/密钥、且无内容 → derive 天然隐私安全、口径与治理一致。
- **有界（防 node_modules 15 万文件爆炸）**：`config.ignore` + 硬排除 `node_modules/.git/.venv/venv/__pycache__` + `MAX_NODES=5000 / MAX_DEPTH=6 / MAX_CHILDREN=200`；超限**折叠**成 `…(已折叠 N 项)` 并标 `truncated`（no silent caps）。真机 `~/.openclaw --full-tree` 实测 <5000 节点、深度≤6、秒级。
- **只读铁律**：fs 遍历**只在 `heatmap` 命令**（只 `readdirSync` 拿名字/类型，**绝不** `readFileSync` target 内容）；看板 `/api/heatmap` 只 `fs.readFile` 该文件。
- 看板「热力图」tab：**手写 squarified treemap（禁 d3）**，颜色 = `change_count` 对数色阶（浅奶油→深赤陶）；**点击只弹计数 tooltip、无下钻**；敏感节点打码为 `•••`（🔒 标记、热度保留）；控件：打码标记开关 / 复制生成命令；图例"改动频率 低→高"。
- `doctor` 增 heatmap 段（快照存在/新鲜/节点数/是否 truncated）；`paths` 列 `state/heatmap.json` 归 state（可重算，`reset --keep-audit` 可清）。

## 文件树热力 + OS 定位（Phase 1.8，替换 1.7 的 treemap）

用户反馈 1.7 的 treemap 色块"还要再动脑分析"。1.8 把「热力图」视图**换成一棵竖排、可折叠的文件树**——**观感等同资源管理器 / VS Code 侧栏**，**改动越多的行颜色越深**，一眼看出哪个文件有异动；**点文件直接在资源管理器 / 访达里定位**。后端 `heatmap.json` 树结构复用，重心在前端文件树 + 新的 `/api/reveal`。

**隐私姿态转变（与 1.7 不同）**：1.7 是"只看颜色、不看任何详情"；1.8 用户主动要点开真实文件，于是：
- **看板内仍不内联**文件内容 / diff（**永不**做在看板里）；要看内容 → **点击跳 OS 文件管理器**（用户自己的可信本机）。
- **文件名默认真实**（本机导航需要）；`--redact` / 看板「打码」开关可开（截图/分享用，打码行 `•••` 且**禁止定位**）。

```bash
organledger heatmap                       # 默认=完整器官树(像文件浏览器)：真实文件夹结构 + 未改动文件(0 热度)，排除 node_modules/.git/…
organledger heatmap --changed-only        # 仅账本改动过的 path（1.7 的旧默认，作为过滤态）
organledger heatmap --window 30d          # 只算近 N 天的频率
organledger heatmap --redact "<glob>,..." # 打码敏感名并置空 rel_path（默认关；截图/分享用）
```
- **HeatNode 加 `rel_path`**（target 相对全路径，供 reveal 构造绝对路径）；同层**文件夹在前、按名升序**（贴近 Explorer）；有界逻辑（MAX_*+排除+折叠 truncated）**原样复用不放松**。
- 看板「文件树」tab：**手写递归可折叠树（禁 d3）**——三角展开符 / 文件夹图标 / 缩进表层级 / **行背景=频率对数色阶**（浅→深；暗色主题为 沉底棕→发光金）/ 右侧"N 次·最近日"；默认展开前 2 层；控件：全部展开·收起 / 只看改动 / 打码 / 复制生成命令 / 图例。折叠节点显示 `…(已折叠 N 项)`。
- **`/api/reveal`（头号红线）**：`GET|POST /api/reveal?system=&path=&mode=select|open`。左键=定位（`select`）；**右键菜单**：文件→定位、文件夹→**打开该文件夹**（`open`）或在上级定位。命令：win `explorer /select,`｜`explorer <dir>`、mac `open -R`｜`open <dir>`、linux `xdg-open <dir>`。安全模型：`system`→target 根、拒 `..`/绝对路径、`realpath(home/path)` 必须仍在 `realpath(home)` 之内（**防符号链接逃逸**）、否则 **403 不 spawn**；spawn 用**参数数组不经 shell**（防注入）、**只定位不执行**、仅 `127.0.0.1`。`open` 模式**只对目录生效**——服务端对文件强制回退为 `select`，**文件永不被打开/执行**（`绝不 start <file>`）。逻辑在 `src/dashboard/reveal.ts` 的纯函数 `resolveReveal`（**先校验、零 spawn**，故越界可被单测证明"根本没机会 spawn"）。
- **多器官可选**：文件树按 target 分组，每个 organ（openclaw / hermes / …）一棵根；hermes 等**可选**，配置了就出现，`HeatmapTarget.exists=false` 时前端显示"目录不存在——配置并落地后自动出现"（不崩、不造假）。
- **看板只读自证**：`grep -r "spawn\|child_process\|\"git\"" src/dashboard/` → spawn **仅** `reveal.ts`；`readdir` **仅**账本态（held/reports），**零** target 遍历、**零** git、**零**内联内容入口。

## 抽屉简报 → 本机 Coding Agent（Phase 1.9）

用户想把一次（或一天）的改动**一键复制成一段自然语言简报**，粘贴给自己**本机的 coding agent** 做更深的内容级分析。核心 hand-off：**看板给指针，本机 agent 取内容**。

- **两处入口**：单条改动抽屉「📋 复制此改动简报」；「日志」当天改动抽屉「📋 复制当天简报」。纯前端，无新端点、无后端改动。
- **简报 = 元数据 + 自然语言任务框架**：概览（当天白话摘要）+ 逐条记录（path / op / system / change_id / 状态 / severity / **原因** / **git commit** / **before→after hash** / 来源 / 主使 / 时间）+「如何深入」段（教 agent 用 `git -C <器官仓库> show <commit>` 取真实 diff、按 hash 校验、判断改动是否忠实于「原因」、必要时 `organledger rollback --change <id> --confirm`）。
- **红线一致**：简报字段**全部来自抽屉已展示的元数据**，**不新增暴露**；看板按定义无文件内容/diff，故简报**只带指针**，内容级分析交给用户可信本机的 agent（已断言 `/api/activity/day` payload 无 content/diff/patch 字段）。

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
organledger backfill [--full-history] [--since-days N] [--reflog]  # 回放 target 各 GitSource 历史入账（幂等；--reflog 加上游更新事件）
organledger provenance [--fetch] [--json]  # 扫描各器官文件夹 git 源 → state/provenance.json（只读）
organledger attribution --stats [--date today|YYYY-MM-DD] [--json]  # 主使(principal)分布：im-user/自主/本机/unknown 占比（诚实，含未插桩=unknown，no silent gaps）
organledger heatmap [--window all|Nd] [--changed-only] [--redact[=glob,...]] [--json]  # 文件树热力(颜色=频率) → state/heatmap.json（只读，绝不读文件内容）
organledger report [--date today|YYYY-MM-DD]  # 器官审计日报
organledger rollback --change <id> | --session <id> | --before <ts> [--confirm]
organledger approve <change_id>               # held → replay commit
organledger reject  <change_id>               # 丢弃 held
organledger verify-ledger                     # 校验哈希链完整性
organledger status                            # 快速摘要
organledger dashboard [--port 7377] [--theme light|dark] [--open]  # 本地只读审计看板
```

## 审计看板（本地只读，Creme brulee 风格）

```bash
organledger dashboard            # → http://localhost:7377（只读，仅 127.0.0.1）
```

顶部**三视图 tab（看板 / 日志 / 文件树）**，默认「看板」。
- **看板**：**按 status 分列**（待确认 / 已观测 / 已批准 / 已拒绝 / 已回滚），卡片按 severity 左色条，**待确认列 terracotta 聚光**；顶部 KPI（待确认 / 改动数 / 涉及文件 / 严重度 / 系统分布）+ 近期日报 + 器官来源面板；点卡片看细节抽屉（reason / hash / commit / session / author 未验证 + 一键复制简报给本机 coding agent）；筛选（近7天·今日·全部 / 系统 / 严重度 / 关键字）；亮暗双模。
- **日志**：见「活动日志（Phase 1.7）」——白话按天日志（颜色=频率、无内容/diff）。
- **文件树**：见「文件树热力 + OS 定位（Phase 1.8）」——竖排可折叠文件树，行色越深=改动越多，点文件夹展开/收起、**点文件在资源管理器/访达定位**（看板不显示文件内容）。

- **只读铁律**（架构级）：看板**绝不写 git / 账本 / daemon 锁**，只 `fs.readFile` 审计数据。approve/reject 只"复制命令供终端执行"，不直接改写（守住唯一 committer）。
- **零依赖零构建**：`node:http` + 原生 HTML/CSS/JS 单页（`src/dashboard/public/`）。视觉令牌取自 Obsidian 主题 Creme brulee（暖米底 / 暖棕字 / terracotta 强调 / 衬线标题 / 软圆角）。
- 默认视图 `近 7 天`（器官改动稀疏，避免"今日"默认空白）。

## 源码目录

```
src/
├── core/     inbox daemon normalizer classifier gate committer ledger pipeline principal-index  # +principal-index(Phase 2 主使 turn 流索引)
├── adapters/openclaw/  watcher organ-audit sqlite-dump
├── adapters/hermes/    shim.py                       # Phase 2: emit_organ_event 带 turn_id/session_id
├── adapters/wecom/     principal-turn.ts             # Phase 2: WeCom 入口 turn record 参考实现（契约写方；真插桩在仓外 bridge）
├── onboard/  init detect migrate logger doctor lifecycle autostart backfill provenance heatmap  # Phase 1.5 + 1.6(provenance) + 1.7/1.8(file-tree heatmap)
├── dashboard/  server data activity heatmap-read reveal public/(index.html dashboard.css dashboard.js)  # 只读看板（来源面板 + 日志 + 文件树热力 + 主使归因徽标/过滤/attribution --stats）
└── cli/      index report rollback approve

prompts/
├── populate-dashboard-history.md   # 交给编码 Agent 一键回填看板历史的可复用任务提示
├── prime-dashboard-views.md        # 一键 provenance+heatmap(+backfill) 点亮全部视图（只读）
└── wire-wecom-attribution.md       # 引导给自建 WeCom 桥插桩喂主使（含诚实红线 + 仓外边界）
```

## 测试

```bash
node --test test/*.test.ts        # 84 个：核心 + classifier + hermes 跨语言 + onboarding(迁移/logger/paths v2/回填) + dashboard(列映射/KPI/筛选) + provenance(多源扫描/来源注入/加法式链/reflog) + activity(按天聚合/白话/上游) + heatmap(频率/有界/rel_path/整树默认/排序/**隐私断言**) + reveal(**路径安全断言**) + attribution(主使归因 turn 关联/**诚实分层断言**)
python -m pytest test/test_hermes_shim.py   # 2 个：shim schema 同构
npm run typecheck                  # tsc --noEmit
```

- `core.test`：ticket/commit/哈希链、去抖、session合并、held、篡改检测、单实例锁、重放幂等
- `onboard.test`：v1→v2 非破坏迁移(链不断/零丢/幂等)、paths v2、logger 落盘+轮转+不落敏感、loadConfigSafe 未初始化不崩、**git 历史回填(链不断/verified 恒 false/churn 丢弃/幂等增量/非 git 安全)**
- `provenance.test`：多 GitSource 扫描(父+内嵌各成源)、inspectSource(remote/branch/dirty，无 upstream 不崩)、**加法式 schema 红线(provenance 可选，老 ticket 字节不变，链 intact)**、内嵌 repo content 回填带 verified provenance 而 author 恒未验证、reflog merge→上游更新 ticket(from→to/幂等) / commit-only 安全 no-op
- `activity.test`：混合时区→同一本地日聚合、文件夹 rollup + 白话摘要、上游 pull 计数与 remote 短名、逐条明细无内容/diff、空账本安全
- `heatmap.test`：changed-only 频率(叶子/目录聚合)、window 过滤、有界 full-tree(排除 node_modules/.git + 巨目录折叠 truncated + 深度封顶)、缺失 target 安全 no-op、**rel_path(root空/叶真实路径)**、**整树默认含未改动节点**、**排序 dir 在前按名(D4)**、**隐私断言①字段白名单(无内容/diff/hash/reason/密钥)**、**隐私断言②--redact 打码名+置空 rel_path 留热度**
- `reveal.test`：合法 in-target 路径解析 ok、**安全断言①穿越/绝对/空路径→403 且 spawn 零调用**、**安全断言②符号链接逃逸被 realpath 容纳校验拒(403)**、未知 system/不存在路径→404、`osRevealCommand` 只定位(select/-R)不执行且参数数组无 shell、`revealInOS` 以数组传 spawn(detached/stdio ignore)
- `attribution.test`：**加法式 schema 红线(attribution 可选，老 ticket 字节不变，链 intact)**、PrincipalIndex(byTurn/bySession 仅单一主使/nearest±窗/缺流不崩/坏行跳过/append-tail)、resolveAttribution 四分支(turn/session/time-window 命中→im-user/verified/attested/requested；有 ctx 无主使→autonomous/self；无 ctx→unknown；out-of-band→**本机永不 verified**)、**诚实钳制(非 im-user / 非 platform-attested 强制 verified:false)**、WeCom 参考实现映射、**模拟端到端(emit→index→JOIN + daemon 提交票据带 wecom 主使/链 intact)**、看板主使过滤、**attribution --stats 未插桩计入 unknown(no silent gaps) + 四档守恒**

## 数据契约

- **类型定义**：`src/types.ts`（`OrganEvent` / `Ticket` / `Config` 等）。
- **变更单（ticket）**：哈希链账本 `~/.organledger/ledger/tickets.jsonl`，每条含 `change_id / system / author{verified:false} / file / op / before_hash / after_hash / severity / status / git_commit / prev_ticket_hash`。
- **commit message**：`[chg-<id>][<system>][session:<id>] <op> <file>` + reason/severity/status。
- **config**：`~/.organledger/config.json`（监听目标、分级规则、时间窗、ignore globs、log_level/保留期）。

## 身份 / 主使归因（Phase 2，已实现）

给账本补"**主使(principal)是谁**"这一维：一次器官改动，是**某 IM 外部用户的请求**、
**agent 自主**、还是**本机（你/CC，难分）**——诚实分层、可过滤、只对可验证的部分标已验证。
详见 [`docs/phase2-identity.md`](docs/phase2-identity.md) 与
[`docs/principal-turn-contract.md`](docs/principal-turn-contract.md)。

**要解决的真问题**：Writer(手)≠Principal(意图源)。agent 替 IM 外部用户干活，此前被记成
"agent 改的"，丢了"其实是那个外部用户让它改的"。

**三轴归因**：`Writer`(谁写字节) / `Principal`(谁的请求) / `Autonomy`(被要求还是自发)。
`Attribution` 是 ticket 的**可选加法字段**（仿 1.6 provenance，哈希链不破，
`TicketAuthor.verified` 仍恒字面 false）。

**turn-id 关联法（核心机制）**：意图无法从文件系统事后重建 → **写时 in-band 捕获**。
IM 入口(hook)记 `state/principal/turns.jsonl` 的 turn record（含 principal+turn_id+session）；
agent 写器官(shim)带 `turn_id`；normalizer 按 `turn_id > session > 时间窗(弱)` **JOIN**。
入口缺失则降级 unknown/local，**契约优先，organledger 侧照常运行**。

**头号红线：诚实分层（自动化断言锁死）**
| 情况 | verified | 备注 |
|---|---|---|
| IM 外部用户(WeCom/飞书,平台认证+运行时证言) | **true** | 必带 `attestation:"platform-attested"`（**非**密码学证明） |
| agent 自主(有 turn 无 principal) | false | `kind:autonomous, autonomy:self` |
| 本机(你/CC/agent 本地) | **永远 false** | 统一 `local-unverified`，不猜 |
| 未插桩/out-of-band/无 turn | false | `unknown` |

- `autonomy:"requested"` **≠** 忠实（看板标"忠实性未证"）；`attested` **≠** proven（看板写"渠道认证·运行时证言"，绝不写"已证明"）；`match:time-window` 标"弱关联"。
- **渠道**：WeCom(自建 bridge，真插桩参考实现) ✅；飞书(官方插件黑盒) → **D8 ⏳ 降级**，契约+hook 模板已备，principal=unknown 非失败。

**看板**：卡片主使徽标（👤 渠道·用户 / 🤖 agent 自主 / 🖥 本机(未验证) / ❔ 未知）+ 抽屉主使块（诚实限定语）+ 按主使/渠道过滤；`organledger attribution --stats` 展示各档占比（含 unknown，no silent gaps）。

## Phase 3（未做，路线）

密码学不可抵赖（签名/凭证链，替代 attested）、autonomy 忠实性判定（写入是否真照请求）、
本机 user vs CC vs agent 细分（OS 写入审计/PID 反关联）、外部 issue/PR 审批闭环。
**本轮 attested = 平台认证 + 运行时证言，是 Phase 2 的诚实边界；Phase 3 才谈签名。**
