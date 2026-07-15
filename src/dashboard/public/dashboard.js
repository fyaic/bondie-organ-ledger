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
  for (const control of [el.date, el.system, el.severity, el.provenance]) {
    control.addEventListener("change", loadBoard);
  }
  el.q.addEventListener("input", debounce(loadBoard, 180));
  el.activityWindow.addEventListener("change", loadActivity);
  el.heatmapRedactToggle.addEventListener("change", () => { if (state.heatmap) renderHeatmap(state.heatmap); });
  el.heatmapCmdButton.addEventListener("click", copyHeatmapCommand);
  el.refresh.addEventListener("click", refreshCurrentView);
  el.poll.addEventListener("change", togglePolling);
  el.theme.addEventListener("click", toggleTheme);
  el.drawerClose.addEventListener("click", closeDrawer);
  el.overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
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
  if (isHeatmap && !state.heatmap) loadHeatmap();
}

function refreshCurrentView() {
  if (state.topview === "activity") loadActivity();
  else if (state.topview === "heatmap") loadHeatmap();
  else { loadBoard(); loadSources(); }
}

async function loadBoard() {
  setStatus("loading", "加载审计数据...");
  try {
    const params = new URLSearchParams({
      date: el.date.value,
      system: el.system.value,
      severity: el.severity.value,
      provenance: el.provenance.value,
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
  table.append(...allSources.map(renderSourceRow));
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
    </span>
    <span class="time">${formatDate(card.created_at)}</span>
  `;
  button.addEventListener("click", () => openDrawer(card));
  return button;
}

function openDrawer(card) {
  const command = `organledger approve ${card.change_id}`;
  el.drawerBody.innerHTML = `
    <h2>${escapeHtml(card.file)}</h2>
    <span class="change">${escapeHtml(card.change_id)}</span>
    <div class="detail-grid">
      ${detail("状态", card.status)}
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
    ${provenanceBlock(card.provenance)}
    ${card.status === "held" ? `<button class="command-button" type="button" data-command="${escapeAttr(command)}">复制 ${escapeHtml(command)}</button>` : ""}
  `;

  const commandButton = el.drawerBody.querySelector(".command-button");
  if (commandButton) {
    commandButton.addEventListener("click", () => copyCommand(commandButton.dataset.command));
  }
  el.drawer.classList.add("open");
  el.drawer.setAttribute("aria-hidden", "false");
  el.overlay.hidden = false;
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
        ${isUpstream ? `<span class="badge upstream-badge">上游更新</span>` : `<span class="badge agent-badge">Agent 自改</span>`}
      </div>
      <div class="prov-src">来自 <code>${escapeHtml(p.remote_url || "（无 remote）")}</code> <span class="prov-branch">@${escapeHtml(p.branch || "detached")}</span></div>
      ${move}
      <div class="prov-verify">✅ 来源已验证（内容寻址）· ⚠️ 身份未验证（谁改的仍不可证）</div>
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
    el.drawerBody.innerHTML = `
      <h2>${escapeHtml(date)} · 当天改动</h2>
      <span class="change">${items.length} 条 · 仅显示改了什么 / 在哪 / 来自哪个上游（不含文件内容）</span>
      <div class="day-items">${rows || '<div class="empty">（无）</div>'}</div>
    `;
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

function renderHeatmap(payload) {
  if (!payload || payload.missing || !payload.report) {
    setHeatmapStatus("empty", "");
    el.heatmapMeta.textContent = "未生成";
    el.heatmapLegend.replaceChildren();
    el.heatmapCanvas.replaceChildren(Object.assign(document.createElement("div"), {
      className: "heatmap-empty",
      innerHTML: '暂无热力图快照 —— 在终端运行 <code>organledger heatmap --full-tree</code> 生成 <code>state/heatmap.json</code> 后点「刷新」。',
    }));
    return;
  }
  const report = payload.report;
  setHeatmapStatus("ready", "");

  const mode = report.full_tree ? "整树" : "仅改动过";
  const trunc = report.limits && report.limits.truncated ? " · 已折叠部分节点" : "";
  el.heatmapMeta.textContent = `窗口 ${report.window} · ${mode} · ${report.limits ? report.limits.node_count : "?"} 节点${trunc}`;

  // global max heat for the log color scale
  let maxHeat = 1;
  const scan = (n) => { if (n.change_count > maxHeat) maxHeat = n.change_count; (n.children || []).forEach(scan); };
  report.targets.forEach((t) => (t.root.children || []).forEach(scan));

  renderLegend(maxHeat);

  // one treemap block per target
  const blocks = report.targets.map((t) => {
    const wrap = document.createElement("div");
    wrap.className = "heatmap-target";
    const title = document.createElement("div");
    title.className = "heatmap-target-title";
    title.innerHTML = `<strong>${escapeHtml(t.system)}</strong> <span class="ht-sub">${escapeHtml(t.home)} · ${t.root.change_count} 次改动</span>`;
    const canvas = document.createElement("div");
    canvas.className = "treemap";
    wrap.append(title, canvas);
    // defer layout until in DOM (needs measured width)
    requestAnimationFrame(() => layoutTreemap(canvas, t.root, maxHeat));
    return wrap;
  });
  el.heatmapCanvas.replaceChildren(...blocks);
}

// squarified treemap of the children of `root`, nested to a bounded depth so the
// DOM stays light. Area ∝ (change_count + 1) so zero-heat nodes still show as a
// thin slice; color = log-scaled change_count. NO file bytes are ever used.
const TREEMAP_MAX_RENDER_DEPTH = 3;

function layoutTreemap(container, root, maxHeat) {
  const width = container.clientWidth || 800;
  const height = 420;
  container.style.height = height + "px";
  const frag = document.createDocumentFragment();
  renderTreemapLevel(frag, root.children || [], 0, 0, width, height, maxHeat, 0);
  container.replaceChildren(frag);
}

function renderTreemapLevel(parent, nodes, x, y, w, h, maxHeat, depth) {
  if (w <= 1 || h <= 1 || !nodes.length) return;
  const items = nodes
    .map((n) => ({ node: n, value: n.change_count + 1 }))
    .sort((a, b) => b.value - a.value);
  const rects = squarify(items, x, y, w, h);
  for (const r of rects) {
    const cell = buildTreemapCell(r, maxHeat, depth);
    parent.appendChild(cell.el);
    // nest one level deeper for dirs, if the rect is big enough and within depth
    const kids = r.node.children || [];
    if (kids.length && depth + 1 < TREEMAP_MAX_RENDER_DEPTH && r.w > 34 && r.h > 34) {
      const pad = 14; // leave room for the label header
      renderTreemapLevel(cell.el, kids, r.x + 2, r.y + pad, r.w - 4, r.h - pad - 2, maxHeat, depth + 1);
    }
  }
}

function buildTreemapCell(r, maxHeat, depth) {
  const node = r.node;
  const cell = document.createElement("div");
  cell.className = "tm-cell" + (node.redacted ? " redacted" : "") + (node.truncated ? " truncated" : "");
  cell.style.left = r.x + "px";
  cell.style.top = r.y + "px";
  cell.style.width = r.w + "px";
  cell.style.height = r.h + "px";
  cell.style.background = heatColor(node.change_count, maxHeat);
  const name = node.name;
  const showRedactMark = node.redacted && el.heatmapRedactToggle.checked;
  // label only when there's room
  if (r.w > 42 && r.h > 20) {
    const label = document.createElement("span");
    label.className = "tm-label";
    label.textContent = (showRedactMark ? "🔒 " : "") + name;
    cell.appendChild(label);
  }
  // click / hover → tooltip with COUNT ONLY. No content, no drill-down.
  const tip = `${node.redacted ? "🔒 " : ""}${name} · ${node.change_count} 次改动${node.last_change ? " · 最近 " + node.last_change : ""}${node.truncated ? " · (已折叠)" : ""}`;
  cell.title = tip;
  cell.addEventListener("click", (e) => { e.stopPropagation(); showToast(tip); });
  return { el: cell };
}

// ---- squarified treemap layout (Bruls, Huizing, van Wijk) — hand-written -----
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, it) => s + it.value, 0) || 1;
  // scale values so their sum equals the rect area
  const area = w * h;
  const scaled = items.map((it) => ({ node: it.node, area: (it.value / total) * area }));
  let rect = { x, y, w, h };
  let row = [];
  let i = 0;
  const worst = (row, len) => {
    if (!row.length) return Infinity;
    const s = row.reduce((a, b) => a + b.area, 0);
    const max = Math.max(...row.map((b) => b.area));
    const min = Math.min(...row.map((b) => b.area));
    const len2 = len * len;
    const s2 = s * s;
    return Math.max((len2 * max) / s2, s2 / (len2 * min));
  };
  while (i < scaled.length) {
    const item = scaled[i];
    const shortest = Math.min(rect.w, rect.h);
    const withItem = [...row, item];
    if (row.length === 0 || worst(withItem, shortest) <= worst(row, shortest)) {
      row = withItem;
      i++;
    } else {
      layoutRow(row, rect, out);
      rect = shrink(rect, row);
      row = [];
    }
  }
  if (row.length) layoutRow(row, rect, out);
  return out;
}

function layoutRow(row, rect, out) {
  const sum = row.reduce((a, b) => a + b.area, 0);
  const horizontal = rect.w >= rect.h;
  if (horizontal) {
    const rowW = sum / rect.h;
    let cy = rect.y;
    for (const it of row) {
      const cellH = it.area / rowW;
      out.push({ node: it.node, x: rect.x, y: cy, w: Math.max(0, rowW - 1), h: Math.max(0, cellH - 1) });
      cy += cellH;
    }
  } else {
    const rowH = sum / rect.w;
    let cx = rect.x;
    for (const it of row) {
      const cellW = it.area / rowH;
      out.push({ node: it.node, x: cx, y: rect.y, w: Math.max(0, cellW - 1), h: Math.max(0, rowH - 1) });
      cx += cellW;
    }
  }
}

function shrink(rect, row) {
  const sum = row.reduce((a, b) => a + b.area, 0);
  if (rect.w >= rect.h) {
    const rowW = sum / rect.h;
    return { x: rect.x + rowW, y: rect.y, w: rect.w - rowW, h: rect.h };
  }
  const rowH = sum / rect.w;
  return { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
}

// log-scaled color ramp: light cream (low) → deep terracotta (high). Frequency
// only — never file size. 0 heat = palest.
function heatColor(count, maxHeat) {
  const t = maxHeat > 1 ? Math.log(count + 1) / Math.log(maxHeat + 1) : 0;
  const cream = [243, 233, 210];   // #f3e9d2
  const terra = [166, 74, 42];     // deep terracotta
  const mix = cream.map((c, i) => Math.round(c + (terra[i] - c) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function renderLegend(maxHeat) {
  const steps = 6;
  const swatches = [];
  for (let s = 0; s < steps; s++) {
    const frac = s / (steps - 1);
    const count = Math.round((Math.exp(frac * Math.log(maxHeat + 1)) - 1));
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = heatColor(count, maxHeat);
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
  const full = report && report.full_tree ? " --full-tree" : "";
  const win = report && report.window && report.window !== "all" ? ` --window ${report.window}` : "";
  const cmd = `organledger heatmap${full}${win}`;
  navigator.clipboard.writeText(cmd);
  showToast(`已复制：${cmd} —— 在终端运行以重算（切窗口/整树请改参数）。`);
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
