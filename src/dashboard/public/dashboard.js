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
};

const el = {
  board: document.querySelector("#board"),
  status: document.querySelector("#status"),
  viewButtons: [...document.querySelectorAll("[data-view]")],
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
  for (const button of el.viewButtons) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  for (const control of [el.date, el.system, el.severity, el.provenance]) {
    control.addEventListener("change", loadBoard);
  }
  el.q.addEventListener("input", debounce(loadBoard, 180));
  el.refresh.addEventListener("click", () => { loadBoard(); loadSources(); });
  el.poll.addEventListener("change", togglePolling);
  el.theme.addEventListener("click", toggleTheme);
  el.drawerClose.addEventListener("click", closeDrawer);
  el.overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
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
    state.pollTimer = setInterval(loadBoard, 10000);
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
