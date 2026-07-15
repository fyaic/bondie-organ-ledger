const STATUS_META = [
  ["held", "待确认"],
  ["observed", "已观测"],
  ["approved", "已批准"],
  ["rejected", "已拒绝"],
  ["rolled_back", "已回滚"],
];

const SEVERITY_META = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];

const SEVERITY_COLORS = {
  critical: "var(--ol-red)",
  high: "var(--ol-orange)",
  medium: "var(--ol-yellow)",
  low: "var(--ol-green)",
};

const PILL_COLORS = {
  create: ["rgba(var(--ol-green-rgb), 0.14)", "var(--ol-green)"],
  update: ["rgba(var(--ol-orange-rgb), 0.14)", "var(--ol-orange)"],
  delete: ["rgba(var(--ol-red-rgb), 0.14)", "var(--ol-red)"],
  openclaw: ["rgba(102, 140, 179, 0.14)", "var(--ol-blue)"],
  hermes: ["rgba(91, 168, 190, 0.14)", "var(--ol-cyan)"],
  // severity pills — mirror the left color-bar so the pill is not a gray fallback
  critical: ["rgba(var(--ol-red-rgb), 0.14)", "var(--ol-red)"],
  high: ["rgba(var(--ol-orange-rgb), 0.14)", "var(--ol-orange)"],
  medium: ["rgba(var(--ol-yellow-rgb), 0.14)", "var(--ol-yellow)"],
  low: ["rgba(var(--ol-green-rgb), 0.14)", "var(--ol-green)"],
};

const SYSTEM_COLORS = {
  openclaw: "var(--ol-blue)",
  hermes: "var(--ol-cyan)",
};

const DATE_LABEL = { recent: "近 7 天", today: "今日", all: "全部" };

const state = {
  board: null,
  pollTimer: null,
  view: "status",
  topview: "board",
  activity: null,
  heatmap: null,
  // file-tree view state (Phase 1.8): which dirs are expanded (by rel_path),
  // whether to show only changed nodes, and whether to mask sensitive names.
  tree: { expanded: new Set(), changedOnly: false, mask: false, seeded: false },
};

const el = {
  board: document.querySelector("#board"),
  status: document.querySelector("#status"),
  viewButtons: [...document.querySelectorAll("[data-view]")],
  topnavButtons: [...document.querySelectorAll("[data-topview]")],
  boardGroups: [...document.querySelectorAll('[data-viewgroup="board"]')],
  boardControls: document.querySelector("#boardControls"),
  activityControls: document.querySelector("#activityControls"),
  heatmapControls: document.querySelector("#heatmapControls"),
  date: document.querySelector("#dateFilter"),
  system: document.querySelector("#systemFilter"),
  severity: document.querySelector("#severityFilter"),
  provenance: document.querySelector("#provenanceFilter"),
  principal: document.querySelector("#principalFilter"),
  principalNote: document.querySelector("#principalNote"),
  sources: document.querySelector("#sourcesPanel"),
  q: document.querySelector("#queryFilter"),
  refresh: document.querySelector("#refreshButton"),
  poll: document.querySelector("#pollToggle"),
  theme: document.querySelector("#themeButton"),
  kpiHeld: document.querySelector("#kpiHeld"),
  kpiTotal: document.querySelector("#kpiTotal"),
  kpiFiles: document.querySelector("#kpiFiles"),
  severityDots: document.querySelector("#severityDots"),
  systemDots: document.querySelector("#systemDots"),
  reportsBar: document.querySelector("#reportsBar"),
  // activity view
  activityView: document.querySelector("#activityView"),
  activityStatus: document.querySelector("#activityStatus"),
  activityTimeline: document.querySelector("#activityTimeline"),
  activityWindow: document.querySelector("#activityWindow"),
  // heatmap view
  heatmapView: document.querySelector("#heatmapView"),
  heatmapStatus: document.querySelector("#heatmapStatus"),
  heatmapCanvas: document.querySelector("#heatmapCanvas"),
  heatmapLegend: document.querySelector("#heatmapLegend"),
  heatmapMeta: document.querySelector("#heatmapMeta"),
  heatmapRedactToggle: document.querySelector("#heatmapRedactToggle"),
  heatmapCmdButton: document.querySelector("#heatmapCmdButton"),
  treeExpandAll: document.querySelector("#treeExpandAll"),
  treeCollapseAll: document.querySelector("#treeCollapseAll"),
  treeChangedOnly: document.querySelector("#treeChangedOnly"),
  drawer: document.querySelector("#drawer"),
  drawerBody: document.querySelector("#drawerBody"),
  drawerClose: document.querySelector("#drawerClose"),
  overlay: document.querySelector("#overlay"),
  toast: document.querySelector("#toast"),
};

init();

function init() {
  bindEvents();
  syncThemeButton();
  loadBoard();
  loadSources();
}

function bindEvents() {
  for (const button of el.topnavButtons) {
    button.addEventListener("click", () => setTopView(button.dataset.topview));
  }
  for (const button of el.viewButtons) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  for (const control of [el.date, el.system, el.severity, el.provenance, el.principal].filter(Boolean)) {
    control.addEventListener("change", loadBoard);
  }
  el.q.addEventListener("input", debounce(loadBoard, 180));
  el.activityWindow.addEventListener("change", loadActivity);
  el.heatmapRedactToggle.addEventListener("change", () => {
    state.tree.mask = el.heatmapRedactToggle.checked;
    if (state.heatmap) renderHeatmap(state.heatmap);
  });
  el.treeChangedOnly.addEventListener("change", () => {
    state.tree.changedOnly = el.treeChangedOnly.checked;
    if (state.heatmap) renderHeatmap(state.heatmap);
  });
  el.treeExpandAll.addEventListener("click", () => expandAll(true));
  el.treeCollapseAll.addEventListener("click", () => expandAll(false));
  el.heatmapCmdButton.addEventListener("click", copyHeatmapCommand);
  el.refresh.addEventListener("click", refreshCurrentView);
  el.poll.addEventListener("change", togglePolling);
  el.theme.addEventListener("click", toggleTheme);
  el.drawerClose.addEventListener("click", closeDrawer);
  el.overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeDrawer(); closeContextMenu(); }
  });
  window.addEventListener("scroll", closeContextMenu, true);
  window.addEventListener("resize", debounce(() => {
    if (state.topview === "heatmap" && state.heatmap) renderHeatmap(state.heatmap);
  }, 200));
}

// ===== top-level view switch (看板 | 日志 | 热力图) — D10 ==================
// Default is 看板. Switching only shows/hides sections; the existing board view
// and its read-only red line are untouched.
function setTopView(topview) {
  const valid = ["board", "activity", "heatmap"];
  state.topview = valid.includes(topview) ? topview : "board";
  for (const button of el.topnavButtons) {
    button.classList.toggle("active", button.dataset.topview === state.topview);
  }
  const isBoard = state.topview === "board";
  const isActivity = state.topview === "activity";
  const isHeatmap = state.topview === "heatmap";

  for (const node of el.boardGroups) node.hidden = !isBoard;
  el.boardControls.hidden = !isBoard;
  el.activityControls.hidden = !isActivity;
  el.heatmapControls.hidden = !isHeatmap;
  el.activityView.hidden = !isActivity;
  el.heatmapView.hidden = !isHeatmap;

  if (isActivity && !state.activity) loadActivity();
  // repaint on show (not just first load): the heat ramp is theme-keyed, so a
  // theme toggle while on another tab must not leave stale-palette cells here.
  if (isHeatmap) {
    if (state.heatmap) renderHeatmap(state.heatmap);
    else loadHeatmap();
  }
  updatePrincipalNote();
}

// The 本机 (local) filter can only tell that a change came from THIS device — it
// cannot say whether the user or a local agent made it. Surface that honestly as
// a small note, shown only on the board when 本机 is the selected 修改者.
function updatePrincipalNote() {
  if (!el.principalNote) return;
  const show = state.topview === "board" && el.principal && el.principal.value === "local";
  el.principalNote.hidden = !show;
}

function refreshCurrentView() {
  if (state.topview === "activity") loadActivity();
  else if (state.topview === "heatmap") loadHeatmap();
  else { loadBoard(); loadSources(); }
}

async function loadBoard() {
  updatePrincipalNote();
  setStatus("loading", "加载审计数据...");
  try {
    const params = new URLSearchParams({
      date: el.date.value,
      system: el.system.value,
      severity: el.severity.value,
      provenance: el.provenance.value,
      principal: el.principal ? el.principal.value : "all",
      q: el.q.value.trim(),
    });
    const response = await fetch(`/api/board?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.board = await response.json();
    render(state.board);
    const label = DATE_LABEL[el.date.value] || el.date.value;
    const emptyMsg = el.date.value === "all"
      ? "暂无器官改动记录"
      : `${label}暂无器官改动 —— 可切换到「全部」查看历史`;
    setStatus(state.board.kpi.total ? "ready" : "empty", state.board.kpi.total ? "" : emptyMsg);
  } catch (error) {
    setStatus("error", `读取失败：${error.message || "未知错误"}。请重试。`);
  }
}

function render(board) {
  el.kpiHeld.textContent = board.kpi.held;
  el.kpiTotal.textContent = board.kpi.total;
  el.kpiFiles.textContent = board.kpi.files;
  el.severityDots.replaceChildren(...Object.entries(board.kpi.severity).map(([name, count]) =>
    dot(SEVERITY_COLORS[name], `${name} ${count}`)));

  // G3: system distribution (computed server-side, now surfaced)
  const systems = board.kpi.systems || {};
  el.systemDots.replaceChildren(...Object.entries(systems)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => dot(SYSTEM_COLORS[name] || "var(--ol-text-muted)", `${name} ${count}`)));

  // G4: recent reports (computed server-side, now surfaced)
  const reports = board.kpi.reports || [];
  if (reports.length) {
    el.reportsBar.hidden = false;
    el.reportsBar.replaceChildren(
      Object.assign(document.createElement("span"), { className: "reports-label", textContent: "近期日报" }),
      ...reports.map((name) => Object.assign(document.createElement("span"), {
        className: "report-chip",
        textContent: name.replace(/\.md$/, ""),
      })),
    );
  } else {
    el.reportsBar.hidden = true;
  }

  renderBoardColumns(board);
}

// G5: 器官来源面板 — reads /api/provenance (state/provenance.json). The board
// NEVER runs git; this is a pure file read served by the server.
async function loadSources() {
  try {
    const response = await fetch("/api/provenance");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderSources(await response.json());
  } catch {
    el.sources.hidden = true;
  }
}

function renderSources(payload) {
  if (!payload || payload.missing || !payload.report) {
    el.sources.hidden = false;
    el.sources.replaceChildren(Object.assign(document.createElement("div"), {
      className: "sources-empty",
      textContent: "暂无来源地图 —— 运行 `organledger provenance` 生成 state/provenance.json 后刷新。",
    }));
    return;
  }
  const report = payload.report;
  const groups = report.targets || [];
  const allSources = groups.flatMap((g) => (g.sources || []).map((s) => ({ ...s, system: g.system })));
  el.sources.hidden = false;

  const header = document.createElement("div");
  header.className = "sources-header";
  const asOf = report.fetched ? "已刷新" : "ahead/behind 为上次 fetch 时";
  header.innerHTML = `<h2>器官来源 / Sources</h2><span class="sources-sub">${allSources.length} 个 git 源 · ${escapeHtml(asOf)}</span>`;

  const table = document.createElement("div");
  table.className = "sources-table";
  const headRow = document.createElement("div");
  headRow.className = "source-row head";
  headRow.innerHTML =
    `<span>器官</span><span>Remote</span><span>分支</span><span>HEAD</span><span>↕ 上游</span><span class="src-badges">状态</span>`;
  table.append(headRow, ...allSources.map(renderSourceRow));
  el.sources.replaceChildren(header, table);
}

function renderSourceRow(s) {
  const row = document.createElement("div");
  row.className = "source-row";
  const dir = s.is_nested ? s.rel : `${s.system || ""} (parent)`;
  const head = s.head_commit ? s.head_commit.slice(0, 7) : "—";
  const ab = s.upstream
    ? `<span class="ab">↓${s.behind ?? "?"} ↑${s.ahead ?? "?"}</span>`
    : `<span class="ab muted">无 upstream</span>`;
  const dirty = s.dirty ? `<span class="badge dirty">本地改动</span>` : "";
  const behindBadge = (s.behind ?? 0) > 0 ? `<span class="badge behind">落后 ${s.behind}</span>` : "";
  row.innerHTML = `
    <span class="src-dir" title="${escapeAttr(s.repo_root || "")}">${escapeHtml(dir)}</span>
    <span class="src-remote">${escapeHtml(s.remote_url || "（无 remote）")}</span>
    <span class="src-branch">@${escapeHtml(s.branch || "detached")}</span>
    <span class="src-head">${escapeHtml(head)}</span>
    ${ab}
    <span class="src-badges">${behindBadge}${dirty}</span>
  `;
  return row;
}

function dot(color, text) {
  const item = document.createElement("span");
  item.className = "severity-dot";
  item.style.setProperty("--dot-color", color);
  item.textContent = text;
  return item;
}

function renderBoardColumns(board) {
  if (state.view === "severity") {
    const cards = flattenCards(board);
    el.board.replaceChildren(...SEVERITY_META.map(([severity, title]) => {
      return renderColumn(severity, title, cards.filter((card) => card.severity === severity));
    }));
    return;
  }

  el.board.replaceChildren(...STATUS_META.map(([status, title]) => renderColumn(status, title, board.columns[status] || [])));
}

function flattenCards(board) {
  return STATUS_META.flatMap(([status]) => board.columns[status] || []);
}

function renderColumn(status, title, cards) {
  const column = document.createElement("section");
  column.className = `column ${status}`;
  column.innerHTML = `
    <header class="column-header">
      <h2>${title}</h2>
      <span class="count">${cards.length}</span>
    </header>
  `;
  const list = document.createElement("div");
  list.className = "cards";
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "（无）";
    list.append(empty);
  } else {
    list.append(...cards.map(renderCard));
  }
  column.append(list);
  return column;
}

function renderCard(card) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ticket-card ${card.status}`;
  button.style.setProperty("--severity-color", SEVERITY_COLORS[card.severity] || "var(--ol-text-muted)");
  button.innerHTML = `
    <span class="card-main">
      <span class="file">${escapeHtml(card.file)}</span>
      ${pill(card.op)}
    </span>
    <span class="change">${escapeHtml(card.change_id)}</span>
    <span class="meta">
      ${pill(card.severity)}
      ${pill(card.system)}
      ${principalBadge(card.attribution)}
    </span>
    <span class="time">${formatDate(card.created_at)}</span>
  `;
  button.addEventListener("click", () => openDrawer(card));
  return button;
}

// Compact principal (who-caused-it) badge for cards. Honest, four buckets:
//   👤 IM user (channel-authenticated) / 🤖 agent autonomous / 🖥 local (unverified) / ❔ unknown.
// A card with no attribution is treated as unknown (never silently blank).
function principalBadge(a) {
  const p = a && a.principal;
  if (!p || p.kind === "unknown") return `<span class="pill principal-pill unknown" title="主使未知（未插桩/无 turn）">❔ 主使未知</span>`;
  if (p.kind === "im-user") {
    const ch = p.channel === "feishu" ? "飞书" : p.channel === "wecom" ? "企业微信" : (p.channel || "IM");
    const name = escapeHtml(p.display || p.id || "?");
    return `<span class="pill principal-pill im" title="平台认证·运行时证言（非密码学证明）">👤 ${escapeHtml(ch)}·${name}</span>`;
  }
  if (p.kind === "autonomous") return `<span class="pill principal-pill auto" title="agent 自主（有 turn 无主使）">🤖 agent 自主</span>`;
  return `<span class="pill principal-pill local" title="本机改动，不区分你/CC/agent">🖥 本机（未验证）</span>`;
}

function openDrawer(card) {
  el.drawerBody.innerHTML = `
    <h2>${escapeHtml(card.file)}</h2>
    <span class="change">${escapeHtml(card.change_id)}</span>
    <div class="detail-grid">
      ${detail("状态", statusLabel(card.status))}
      ${detail("操作", card.op)}
      ${detail("系统", card.system)}
      ${detail("原因", card.reason || "未提供")}
      ${detail("Before hash", card.before_hash || "null")}
      ${detail("After hash", card.after_hash || "null")}
      ${detail("Git commit", card.git_commit || "null")}
      ${detail("Session", card.session_id || "null")}
      ${detail("Author", card.author_verified ? "已验证" : "未验证署名")}
      ${detail("时间", card.created_at)}
    </div>
    ${attributionBlock(card.attribution)}
    ${provenanceBlock(card.provenance)}
    ${actionsBlock(card)}
    ${briefingBlock("此改动")}
  `;

  drawerBriefing = buildCardBriefing(card);
  // wire copy-command buttons (approve/reject/rollback) — only those with a command
  for (const btn of el.drawerBody.querySelectorAll(".command-button[data-command]")) {
    btn.addEventListener("click", () => copyCommand(btn.dataset.command));
  }
  const briefBtn = el.drawerBody.querySelector(".briefing-button");
  if (briefBtn) briefBtn.addEventListener("click", copyBriefing);
  el.drawer.classList.add("open");
  el.drawer.setAttribute("aria-hidden", "false");
  el.overlay.hidden = false;
}

const STATUS_LABEL = Object.fromEntries(STATUS_META);
function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

// Contextual next-steps for a card. The board is READ-ONLY (single-writer
// invariant), so actions are terminal commands the user copies — this block is
// what makes the held/approve/reject/rollback loop discoverable instead of
// feeling unfinished.
function cardActions(card) {
  const id = card.change_id;
  if (card.status === "held") {
    return [
      { label: "✅ 同意并落地", cmd: `organledger approve ${id}`, hint: "回放为一次 git commit，移出待确认" },
      { label: "✋ 拒绝", cmd: `organledger reject ${id}`, hint: "丢弃该改动（不写 git），账本记一条 rejected" },
    ];
  }
  if (card.status === "observed" || card.status === "approved") {
    return [
      { label: "↩️ 回滚此改动", cmd: `organledger rollback --change ${id} --confirm`, hint: "安全退回改动前（回滚前自动建 safety 分支）" },
    ];
  }
  return []; // rejected / rolled_back are terminal
}

function actionsBlock(card) {
  const actions = cardActions(card);
  const rows = actions.length
    ? actions
        .map(
          (a) => `
      <div class="action-row">
        <div class="action-meta"><span class="action-label">${escapeHtml(a.label)}</span><span class="action-hint">${escapeHtml(a.hint)}</span></div>
        <button class="command-button" type="button" data-command="${escapeAttr(a.cmd)}">复制命令</button>
        <code class="action-cmd">${escapeHtml(a.cmd)}</code>
      </div>`,
        )
        .join("")
    : `<div class="action-empty">终态，无后续操作（${escapeHtml(statusLabel(card.status))}）。</div>`;
  return `
    <div class="actions-block">
      <div class="actions-head">操作 <span class="actions-sub">看板只读，命令在终端执行（守单一 writer，防并发写坏哈希链）</span></div>
      ${rows}
    </div>`;
}

function closeDrawer() {
  el.drawer.classList.remove("open");
  el.drawer.setAttribute("aria-hidden", "true");
  el.overlay.hidden = true;
}

async function copyCommand(command) {
  await navigator.clipboard.writeText(command);
  showToast("命令已复制，只在终端执行。");
}

// ============================================================================
// Coding-agent briefing — the drawer hand-off. The board has NO file content /
// diff (by design), so this assembles a natural-language + record "简报" from the
// SAME metadata already shown in the drawer (path / op / reason / hash / commit /
// source / principal) and frames it as a task for the user's OWN local coding
// agent: "here are the pointers — you go read the real diffs via git." Board =
// read-only pointers; the deep, content-level analysis happens on the user's
// machine. Nothing new is exposed; it just re-packages the drawer into a prompt.
// ============================================================================
let drawerBriefing = "";

const BRIEFING_INTRO =
`你是我本机的 coding agent。下面是 OrganLedger 审计看板导出的「Agent 器官文件」改动记录——只含元数据，不含文件内容 / diff（看板按设计从不读取文件内容）。
请据此深入分析：这些改动实际改了什么、是否符合其声明的「原因」、是否触及敏感或删除、是否需要回滚。看板拿不到内容，请你在本机用 git / 文件系统核对真实改动。`;

const BRIEFING_HOWTO =
`## 如何深入（在本机执行）
- 看板无文件内容——用 git 看真实改动：\`git -C <器官仓库根> show <commit>\`（commit 见每条记录）。
- 用 before→after hash 定位 / 校验改了哪些文件。
- 判断维度：改动是否与其「原因」一致？是否越权 / 触及敏感 / 删除？
- 若判定需退回：\`organledger rollback --change <change_id> --confirm\`（回滚前自动建 safety 分支）。`;

function briefingSource(p) {
  if (!p) return "来源未标记";
  if (["pull", "merge", "clone"].includes(p.kind)) {
    return `上游更新（${KIND_LABEL[p.kind] || p.kind}）自 ${p.remote_url || "（无 remote）"} @${p.branch || "detached"}`;
  }
  return "本地改动（非上游拉取）";
}

function briefingPrincipal(a) {
  const p = a && a.principal;
  if (!p || p.kind === "unknown") return "主使未知（未插桩 / 无 turn）";
  if (p.kind === "im-user") {
    const ch = p.channel === "feishu" ? "飞书" : p.channel === "wecom" ? "企业微信" : (p.channel || "IM");
    const v = p.verified && p.attestation === "platform-attested"
      ? "已认证（渠道·运行时证言，非密码学证明）"
      : "未认证";
    return `IM 用户 ${ch}·${p.display || p.id || "?"}（${v}）`;
  }
  if (p.kind === "autonomous") return "agent 自主（有本轮上下文，无外部主使）";
  return "本机改动（你 / Claude Code / 本地 agent，不区分）";
}

function briefingItem(c, index) {
  const lines = [
    `${index}. [${c.op}] ${c.file} · ${c.system}`,
    `   - change_id: ${c.change_id} · 状态: ${statusLabel(c.status)} · 严重度: ${c.severity}`,
  ];
  if (c.reason) lines.push(`   - 原因（提交说明）: ${c.reason}`);
  if (c.git_commit) lines.push(`   - git commit: ${c.git_commit}  ← \`git show ${c.git_commit}\` 看真实 diff`);
  if (c.before_hash || c.after_hash) {
    lines.push(`   - before→after: ${(c.before_hash || "∅").slice(0, 12)} → ${(c.after_hash || "∅").slice(0, 12)}`);
  }
  lines.push(`   - 来源: ${briefingSource(c.provenance)}`);
  lines.push(`   - 主使: ${briefingPrincipal(c.attribution)}`);
  lines.push(`   - 时间: ${c.created_at}`);
  return lines.join("\n");
}

function buildDayBriefing(date, summary, items) {
  const head = `# OrganLedger 改动简报 · ${date}（当天 ${items.length} 处改动）`;
  const overview = summary && summary.length
    ? `## 概览\n${summary.map((s) => `- ${s}`).join("\n")}`
    : "";
  const detail = `## 改动明细（${items.length} 条）\n${items.map((c, i) => briefingItem(c, i + 1)).join("\n\n")}`;
  return [head, BRIEFING_INTRO, overview, detail, BRIEFING_HOWTO].filter(Boolean).join("\n\n");
}

function buildCardBriefing(card) {
  const head = `# OrganLedger 改动简报 · ${card.file}`;
  const detail = `## 改动记录\n${briefingItem(card, 1)}`;
  return [head, BRIEFING_INTRO, detail, BRIEFING_HOWTO].filter(Boolean).join("\n\n");
}

// The drawer block that surfaces the button. `scopeLabel` = "当天" | "此改动".
function briefingBlock(scopeLabel) {
  return `
    <div class="briefing-block">
      <div class="actions-head">给 Coding Agent 深入分析 <span class="actions-sub">看板只有元数据（改了什么 / 在哪 / 来源 / 主使）。复制这段自然语言简报，粘贴给你本机的 coding agent，让它用 git 核对真实 diff 并判断安全性。</span></div>
      <button class="briefing-button" type="button">📋 复制${escapeHtml(scopeLabel)}简报给 Coding Agent</button>
    </div>`;
}

async function copyBriefing() {
  if (!drawerBriefing) return;
  await navigator.clipboard.writeText(drawerBriefing);
  showToast("已复制改动简报 —— 粘贴给本机 coding agent 深入分析（含 git 核对指引，不含文件内容）。");
}

function detail(label, value) {
  return `<div class="detail-item"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`;
}

const KIND_LABEL = {
  content: "文件历史", pull: "上游 pull", merge: "上游 merge", clone: "clone",
  "local-commit": "本地提交", "history-move": "HEAD 移动",
};

// Drawer provenance block: shows the SOURCE dimension. Source is verifiable
// (content-addressed SHA / config), identity is NOT — the copy makes that split
// explicit so no one reads "verified" as "we know who did it".
function provenanceBlock(p) {
  if (!p) return "";
  const isUpstream = ["pull", "merge", "clone"].includes(p.kind);
  const move = p.from_commit || p.to_commit
    ? `<div class="prov-move"><code>${escapeHtml((p.from_commit || "∅").slice(0, 8))}</code> → <code>${escapeHtml((p.to_commit || "∅").slice(0, 8))}</code></div>`
    : "";
  return `
    <div class="provenance ${isUpstream ? "upstream" : "local"}">
      <div class="prov-head">
        <span class="prov-kind">${escapeHtml(KIND_LABEL[p.kind] || p.kind)}</span>
        ${isUpstream ? `<span class="badge upstream-badge">上游更新</span>` : `<span class="badge agent-badge">本地改动</span>`}
      </div>
      <div class="prov-src">来自 <code>${escapeHtml(p.remote_url || "（无 remote）")}</code> <span class="prov-branch">@${escapeHtml(p.branch || "detached")}</span></div>
      ${move}
      <div class="prov-verify">✅ 来源已验证（内容寻址）· ⚠️ 身份未验证（谁改的仍不可证）</div>
    </div>
  `;
}

const MATCH_LABEL = {
  "turn-id": "精确关联（turn-id）", "session": "会话关联", "time-window": "时间窗关联（弱）", "none": "未关联",
};

// Drawer attribution block: the PRINCIPAL (who-caused-it) dimension. The copy is
// deliberately honest — it separates "whose hand wrote it" (writer) from "whose
// request caused it" (principal), never claims local changes are attributable,
// marks attested (not "proven"), flags weak time-window matches, and states that
// "requested" does NOT prove the write was faithful to the request.
function attributionBlock(a) {
  if (!a) return "";
  const p = a.principal;
  const writerLabel = { "agent-runtime": "agent 运行时", "local": "本机", "git": "git", "unknown": "未知" }[a.writer] || a.writer;
  let who, verifyLine, cls;
  if (p.kind === "im-user") {
    const ch = p.channel === "feishu" ? "飞书" : p.channel === "wecom" ? "企业微信" : (p.channel || "IM");
    who = `👤 来自 ${escapeHtml(ch)} 用户 <code>${escapeHtml(p.display || p.id || "?")}</code> 的请求 · 经 ${escapeHtml(writerLabel)} 执行`;
    verifyLine = p.verified && p.attestation === "platform-attested"
      ? `✅ 已认证（渠道认证·运行时证言）—— <em>非密码学证明，运行时被攻陷可伪造</em>`
      : `⚠️ 未认证的 IM 主使`;
    cls = "im";
  } else if (p.kind === "autonomous") {
    who = `🤖 agent 自主（有本轮上下文但无外部主使）`;
    verifyLine = `⚠️ 未验证 · 自主度：自发（self）`;
    cls = "auto";
  } else if (p.kind === "local") {
    who = `🖥 本机改动（你 / Claude Code / agent 本地，<strong>不区分</strong>）`;
    verifyLine = `⚠️ 本机永远未验证（by design，不猜是谁）`;
    cls = "local";
  } else {
    who = `❔ 主使未知（未插桩 / 无 turn）`;
    verifyLine = `⚠️ 未关联到任何主使记录`;
    cls = "unknown";
  }
  const autonomyLine = a.autonomy === "requested"
    ? `<div class="attr-caveat">📩 据本轮请求（<strong>忠实性未证</strong>：能证有该请求，证不了写入忠实于请求）</div>`
    : "";
  const matchLine = (a.match && a.match !== "none")
    ? `<div class="attr-match ${a.match === "time-window" ? "weak" : ""}">关联强度：${escapeHtml(MATCH_LABEL[a.match] || a.match)}${a.match === "time-window" ? " ⚠️" : ""}</div>`
    : "";
  return `
    <div class="attribution ${cls}">
      <div class="attr-head"><span class="attr-title">主使归因</span></div>
      <div class="attr-who">${who}</div>
      <div class="attr-verify">${verifyLine}</div>
      ${autonomyLine}
      ${matchLine}
    </div>
  `;
}

function pill(value) {
  const [bg, color] = PILL_COLORS[value] || ["var(--ol-accent-soft)", "var(--ol-text-muted)"];
  return `<span class="pill" style="--pill-bg:${bg};--pill-color:${color}">${escapeHtml(value)}</span>`;
}

function setView(view) {
  state.view = view === "severity" ? "severity" : "status";
  for (const button of el.viewButtons) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
  if (state.board) renderBoardColumns(state.board);
}

function togglePolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (el.poll.checked) {
    state.pollTimer = setInterval(refreshCurrentView, 10000);
    showToast("已开启 10s 只读刷新。");
  }
}

function toggleTheme() {
  const dark = document.documentElement.classList.contains("ol-dark");
  const next = dark ? "light" : "dark";
  document.documentElement.className = `ol-${next}`;
  localStorage.setItem("ol-theme", next);
  syncThemeButton();
  // the heatmap ramp is theme-keyed — repaint it so cold/hot swap palettes.
  if (state.topview === "heatmap" && state.heatmap && state.heatmap.report) {
    renderHeatmap(state.heatmap);
  }
}

function syncThemeButton() {
  const dark = document.documentElement.classList.contains("ol-dark");
  el.theme.textContent = dark ? "亮色" : "暗色";
}

function setStatus(kind, text) {
  el.status.className = `status ${kind}`;
  el.status.textContent = text;
}

function showToast(text) {
  el.toast.textContent = text;
  el.toast.classList.add("show");
  setTimeout(() => el.toast.classList.remove("show"), 1800);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// ============================================================================
// 日志 / Activity view (feature A) — per-day plain-language change log.
// Reads /api/activity (server-side ticket aggregation, no fs/git). Clicking a
// day expands逐条 detail via /api/activity/day in the existing drawer — path /
// op / source only, NEVER file content or diff.
// ============================================================================
const OP_LABEL = { create: "新增", update: "更新", delete: "删除" };

async function loadActivity() {
  setActivityStatus("loading", "加载活动日志...");
  try {
    const window = el.activityWindow.value || "all";
    const response = await fetch(`/api/activity?window=${encodeURIComponent(window)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.activity = await response.json();
    renderActivity(state.activity);
  } catch (error) {
    setActivityStatus("error", `读取失败：${error.message || "未知错误"}。请重试。`);
  }
}

function renderActivity(data) {
  const days = data.days || [];
  if (!days.length) {
    setActivityStatus("empty", "该时间窗内暂无器官改动 —— 试试切换到「全部时间」。");
    el.activityTimeline.replaceChildren();
    return;
  }
  setActivityStatus("ready", "");
  el.activityTimeline.replaceChildren(...days.map(renderActivityDay));
}

function renderActivityDay(day) {
  const card = document.createElement("article");
  card.className = "activity-day";

  const counts = [];
  if (day.created) counts.push(`<span class="ac-pill create">+${day.created} 新增</span>`);
  if (day.updated) counts.push(`<span class="ac-pill update">~${day.updated} 更新</span>`);
  if (day.deleted) counts.push(`<span class="ac-pill delete">-${day.deleted} 删除</span>`);
  const upstream = day.upstream_events
    ? `<span class="ac-pill upstream">↓ ${day.upstream_events} 次上游更新</span>`
    : "";

  const head = document.createElement("header");
  head.className = "activity-day-head";
  head.innerHTML = `
    <div class="ac-date">
      <strong>${escapeHtml(day.date)}</strong>
      <span class="ac-weekday">${weekday(day.date)}</span>
    </div>
    <div class="ac-total">${day.total} 处改动</div>
    <div class="ac-pills">${counts.join("")}${upstream}</div>
  `;

  const summary = document.createElement("ul");
  summary.className = "activity-summary";
  summary.append(...(day.summary || []).map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));

  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "activity-expand";
  expand.textContent = "查看当天逐条改动 →";
  expand.addEventListener("click", () => openActivityDay(day.date));

  card.append(head, summary, expand);
  return card;
}

// Expand one day into逐条 detail — reuses the drawer. Shows path / op / system /
// source only (NO file content, NO diff). This is the A-posture privacy line.
async function openActivityDay(date) {
  el.drawerBody.innerHTML = `<h2>${escapeHtml(date)} · 当天改动</h2><div class="status loading">加载中...</div>`;
  openDrawerShell();
  try {
    const response = await fetch(`/api/activity/day?date=${encodeURIComponent(date)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const items = data.items || [];
    const rows = items.map((c) => `
      <div class="day-item">
        <span class="di-file">${escapeHtml(c.file)}</span>
        <span class="di-meta">${pill(c.op)}${pill(c.system)}${c.provenance && ["pull","merge","clone"].includes(c.provenance.kind) ? `<span class="pill" style="--pill-bg:rgba(102,140,179,0.14);--pill-color:var(--ol-blue)">来自 ${escapeHtml(remoteShort(c.provenance.remote_url))}</span>` : ""}</span>
        ${c.reason ? `<span class="di-reason">${escapeHtml(c.reason)}</span>` : ""}
      </div>
    `).join("");
    const day = (state.activity && state.activity.days || []).find((d) => d.date === date);
    el.drawerBody.innerHTML = `
      <h2>${escapeHtml(date)} · 当天改动</h2>
      <span class="change">${items.length} 条 · 仅显示改了什么 / 在哪 / 来自哪个上游（不含文件内容）</span>
      <div class="day-items">${rows || '<div class="empty">（无）</div>'}</div>
      ${items.length ? briefingBlock("当天") : ""}
    `;
    drawerBriefing = items.length ? buildDayBriefing(date, day ? day.summary : [], items) : "";
    const briefBtn = el.drawerBody.querySelector(".briefing-button");
    if (briefBtn) briefBtn.addEventListener("click", copyBriefing);
  } catch (error) {
    el.drawerBody.innerHTML = `<h2>${escapeHtml(date)}</h2><div class="status error">读取失败：${escapeHtml(error.message || "未知错误")}</div>`;
  }
}

function remoteShort(url) {
  if (!url) return "上游";
  const seg = String(url).replace(/\.git$/i, "").replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop();
  return seg || "上游";
}

function weekday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
}

function setActivityStatus(kind, text) {
  el.activityStatus.className = `status ${kind}`;
  el.activityStatus.textContent = text;
  el.activityStatus.hidden = kind === "ready";
}

// ============================================================================
// 热力图 / Heatmap view (feature B) — privacy treemap, COLOR = frequency.
// Reads /api/heatmap (read-only state/heatmap.json). Hand-written squarified
// treemap (NO d3). Clicking a rectangle shows ONLY a count tooltip — there is NO
// drill-down to file content / diff / detail. Redacted nodes show heat but hide
// their name. This is the head red line.
// ============================================================================
async function loadHeatmap() {
  setHeatmapStatus("loading", "加载热力图...");
  try {
    const response = await fetch("/api/heatmap");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.heatmap = await response.json();
    renderHeatmap(state.heatmap);
  } catch (error) {
    setHeatmapStatus("error", `读取失败：${error.message || "未知错误"}。请重试。`);
  }
}

// Renders the heatmap.json HeatNode tree as a vertical, collapsible FILE TREE
// (like an OS file explorer): folders first, indent = depth, a caret to expand /
// collapse, and a heat-colored row background (deeper = more changes). Clicking a
// file asks /api/reveal to locate it in the OS file manager. The board itself
// NEVER shows file content — that is the Phase-1.8 red line.
function renderHeatmap(payload) {
  if (!payload || payload.missing || !payload.report) {
    setHeatmapStatus("empty", "");
    el.heatmapMeta.textContent = "未生成";
    el.heatmapLegend.replaceChildren();
    el.heatmapCanvas.replaceChildren(Object.assign(document.createElement("div"), {
      className: "heatmap-empty",
      innerHTML: '暂无文件树快照 —— 在终端运行 <code>organledger heatmap</code> 生成 <code>state/heatmap.json</code> 后点「刷新」。',
    }));
    return;
  }
  const report = payload.report;
  setHeatmapStatus("ready", "");

  const mode = report.full_tree ? "整树" : "仅改动过";
  const trunc = report.limits && report.limits.truncated ? " · 已折叠部分节点" : "";
  el.heatmapMeta.textContent = `窗口 ${report.window} · ${mode} · ${report.limits ? report.limits.node_count : "?"} 节点${trunc}`;

  // global max heat for the log color scale (dirs aggregate — scan the whole tree)
  let maxHeat = 1;
  const scan = (n) => { if (n.change_count > maxHeat) maxHeat = n.change_count; (n.children || []).forEach(scan); };
  report.targets.forEach((t) => (t.root.children || []).forEach(scan));
  renderLegend(maxHeat);

  // seed default expansion (first 2 levels) once per loaded report
  if (!state.tree.seeded) {
    seedExpanded(report);
    state.tree.seeded = true;
  }

  const blocks = report.targets.map((t) => renderTargetTree(t, maxHeat));
  el.heatmapCanvas.replaceChildren(...blocks);
}

// expand directories within the first two visible levels (root's children are
// depth 1; expanding those reveals depth 2) — the file-explorer default.
function seedExpanded(report) {
  eachDir(report, (n) => { if (n.depth < 2) state.tree.expanded.add(n.rel_path); });
}

function eachDir(report, fn) {
  const visit = (n) => { if (n.type === "dir" && n.rel_path) fn(n); (n.children || []).forEach(visit); };
  report.targets.forEach((t) => (t.root.children || []).forEach(visit));
}

function expandAll(flag) {
  if (!state.heatmap || !state.heatmap.report) return;
  state.tree.expanded.clear();
  if (flag) eachDir(state.heatmap.report, (n) => state.tree.expanded.add(n.rel_path));
  renderHeatmap(state.heatmap);
}

function renderTargetTree(target, maxHeat) {
  const wrap = document.createElement("div");
  wrap.className = "heatmap-target";
  const title = document.createElement("div");
  title.className = "heatmap-target-title";
  title.innerHTML = `<strong>${escapeHtml(target.system)}</strong> <span class="ht-sub">${escapeHtml(target.home)} · ${target.root.change_count} 次改动</span>`;
  const treeEl = document.createElement("div");
  treeEl.className = "file-tree";
  const children = target.root.children || [];
  if (!children.length) {
    treeEl.appendChild(Object.assign(document.createElement("div"), {
      className: "heatmap-empty",
      textContent: target.exists
        ? "（此器官暂无可显示的文件）"
        : `（目录不存在：${target.home} —— 该器官可选，配置并落地后自动出现）`,
    }));
  } else {
    renderTreeLevel(treeEl, children, target.system, maxHeat);
  }
  wrap.append(title, treeEl);
  return wrap;
}

function renderTreeLevel(container, nodes, system, maxHeat) {
  const list = state.tree.changedOnly ? nodes.filter((n) => n.change_count > 0) : nodes;
  for (const node of list) container.appendChild(renderTreeNode(node, system, maxHeat));
}

function renderTreeNode(node, system, maxHeat) {
  const isDir = node.type === "dir";
  const hasChildren = isDir && !!(node.children && node.children.length);
  const folded = !!node.truncated && !hasChildren; // the "… 已折叠 N 项" aggregate row
  const expanded = hasChildren && state.tree.expanded.has(node.rel_path);
  const masked = state.tree.mask && node.redacted;

  const wrapper = document.createElement("div");
  wrapper.className = "tree-item";

  const row = document.createElement("div");
  row.className = "tree-row" + (masked ? " masked" : "") + (folded ? " folded" : "");
  row.style.paddingLeft = 6 + node.depth * 15 + "px";

  // heat background + luminance-derived ink (deeper color = more changes). The
  // ramp is theme-keyed; ink is chosen per-row so it stays readable on any shade.
  const rgb = heatColor(node.change_count, maxHeat);
  row.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  row.style.color = lum > 0.55 ? "rgba(30,22,14,0.92)" : "rgba(245,238,225,0.96)";

  const caret = document.createElement("span");
  caret.className = "tree-caret";
  caret.textContent = hasChildren ? (expanded ? "▾" : "▸") : "";
  row.appendChild(caret);

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = folded ? "⋯" : isDir ? (expanded ? "📂" : "📁") : "📄";
  row.appendChild(icon);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = masked ? "•••" : node.name;
  row.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "tree-meta";
  if (node.change_count > 0) {
    meta.textContent = `${node.change_count} 次` + (node.last_change ? ` · ${node.last_change}` : "");
  }
  row.appendChild(meta);

  // interactions: dir → expand/collapse; file → OS reveal (never content)
  if (folded) {
    row.title = node.name;
  } else if (isDir) {
    row.classList.add("is-dir");
    if (hasChildren) {
      row.title = `${node.name} · ${node.change_count} 次改动 —— 点击展开/收起`;
      row.addEventListener("click", () => {
        if (expanded) state.tree.expanded.delete(node.rel_path);
        else state.tree.expanded.add(node.rel_path);
        renderHeatmap(state.heatmap);
      });
    } else {
      row.title = `${node.name} · ${node.change_count} 次改动`;
    }
  } else {
    row.classList.add("is-file");
    if (masked || !node.rel_path) {
      row.title = masked ? "已打码，不可定位" : node.name;
      if (masked) row.addEventListener("click", () => showToast("已打码，不可定位（关闭「打码」后可点开）"));
    } else {
      row.title = `${node.name} · ${node.change_count} 次改动 —— 点击在资源管理器/访达中定位`;
      row.addEventListener("click", () => revealFile(system, node.rel_path));
    }
  }

  // right-click → jump into the OS file manager (open a folder, locate a file)
  if (!folded) {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (masked) {
        showTreeContextMenu(e.clientX, e.clientY, [{ label: "🔒 已打码，不可定位", disabled: true }]);
        return;
      }
      if (!node.rel_path) return;
      const items = isDir
        ? [
            { label: "📂 在资源管理器中打开此文件夹", action: () => revealFile(system, node.rel_path, "open") },
            { label: "📍 在上级中定位此文件夹", action: () => revealFile(system, node.rel_path, "select") },
          ]
        : [
            { label: "📍 在资源管理器中定位文件", action: () => revealFile(system, node.rel_path, "select") },
          ];
      showTreeContextMenu(e.clientX, e.clientY, items);
    });
  }

  wrapper.appendChild(row);

  // children built lazily — only when the directory is expanded
  if (expanded) {
    const kids = document.createElement("div");
    kids.className = "tree-children";
    renderTreeLevel(kids, node.children, system, maxHeat);
    wrapper.appendChild(kids);
  }
  return wrapper;
}

// POST /api/reveal → OS file manager. mode "select" locates the item (files &
// default); mode "open" opens a FOLDER's contents (the server ignores "open" for
// files, so a file is never opened/executed). Content is NEVER shown in the board;
// the operator inspects it in their own file manager. Path safety (must stay
// inside the target) is enforced server-side (reveal.ts).
async function revealFile(system, relPath, mode = "select") {
  try {
    const res = await fetch(
      `/api/reveal?system=${encodeURIComponent(system)}&path=${encodeURIComponent(relPath)}&mode=${mode}`,
      { method: "POST" },
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) showToast(mode === "open" ? `已打开文件夹：${relPath}` : `已在文件管理器中定位：${relPath}`);
    else showToast(`无法定位（${data.error || "HTTP " + res.status}）`);
  } catch (error) {
    showToast(`定位失败：${error.message || "未知错误"}`);
  }
}

// lightweight right-click menu → jump into the OS file manager. Files: locate;
// folders: open the folder, or locate it in its parent.
function showTreeContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.id = "ctxMenu";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item" + (it.disabled ? " disabled" : "");
    b.textContent = it.label;
    if (!it.disabled) {
      b.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); it.action(); });
    }
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // keep the menu inside the viewport
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + "px";
  setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  const m = document.getElementById("ctxMenu");
  if (m) m.remove();
}

// log-scaled color ramp keyed to the active theme (frequency only — never file
// size). Returns an [r,g,b] array. 0 heat = coldest end of the ramp.
//   · Light "Crème brûlée": cream (low) → deep terracotta (high)
//   · Dark  "Ukiyo":        recessive sepia (low) → glowing gold (high)
// The dark ramp deliberately starts near the page background so cold regions
// recede and hot ones glow — matching the woodblock-print aesthetic.
function heatColor(count, maxHeat) {
  const t = maxHeat > 1 ? Math.log(count + 1) / Math.log(maxHeat + 1) : 0;
  const dark = document.documentElement.classList.contains("ol-dark");
  const low = dark ? [58, 48, 41] : [243, 233, 210];    // #3a3029 / #f3e9d2
  const high = dark ? [224, 186, 134] : [166, 74, 42];  // #e0ba86 / terracotta
  return low.map((c, i) => Math.round(c + (high[i] - c) * t));
}

function renderLegend(maxHeat) {
  const steps = 6;
  const swatches = [];
  for (let s = 0; s < steps; s++) {
    const frac = s / (steps - 1);
    const count = Math.round((Math.exp(frac * Math.log(maxHeat + 1)) - 1));
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    const rgb = heatColor(count, maxHeat);
    sw.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    sw.title = `${count} 次`;
    swatches.push(sw);
  }
  el.heatmapLegend.replaceChildren(
    Object.assign(document.createElement("span"), { className: "legend-label", textContent: "改动频率 低" }),
    ...swatches,
    Object.assign(document.createElement("span"), { className: "legend-label", textContent: `高 (max ${maxHeat})` }),
  );
}

function copyHeatmapCommand() {
  const report = state.heatmap && state.heatmap.report;
  const changed = report && !report.full_tree ? " --changed-only" : "";
  const win = report && report.window && report.window !== "all" ? ` --window ${report.window}` : "";
  const cmd = `organledger heatmap${changed}${win}`;
  navigator.clipboard.writeText(cmd);
  showToast(`已复制：${cmd} —— 在终端运行以重算文件树（切窗口请加 --window）。`);
}

function setHeatmapStatus(kind, text) {
  el.heatmapStatus.className = `status ${kind}`;
  el.heatmapStatus.textContent = text;
  el.heatmapStatus.hidden = kind === "ready" || (kind === "empty" && !text);
}

// shared drawer opener (used by activity day expand + card drawer)
function openDrawerShell() {
  el.drawer.classList.add("open");
  el.drawer.setAttribute("aria-hidden", "false");
  el.overlay.hidden = false;
}
