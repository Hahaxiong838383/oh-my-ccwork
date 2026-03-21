import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";

var isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= 768);

// --- State ---
var sessions = {}; // id → { term, fit, search, ws, el, userScrolledUp, pingTimer }
var activeId = null;
var currentFontSize = parseInt(localStorage.getItem("ccr-font-size")) || (isMobile ? 12 : 14);
var MIN_FONT = 10;
var MAX_FONT = 24;
var sessionList = []; // { id, engine, engineName, name, cwd, alive, createdAt }
var availableEngines = [];
var defaultCwd = "~/mycc";
var currentLatency = -1;
var editingSessionId = null;

// --- DOM refs ---
var scrollBtn = document.getElementById("scroll-bottom-btn");
var searchBar = document.getElementById("search-bar");
var searchInput = document.getElementById("search-input");
var searchStatusEl = document.getElementById("search-status");
var latencyBadge = document.getElementById("latency-badge");
var sessionDropdown = document.getElementById("session-dropdown");
var sessionMgrBtn = document.getElementById("session-mgr-btn");
var sessionMgrLabel = document.getElementById("session-mgr-label");
var ddSessionList = document.getElementById("dd-session-list");
var ddEngineList = document.getElementById("dd-engine-list");
var ddCwdInput = document.getElementById("dd-cwd-input");
var connLatencyEl = document.getElementById("conn-latency");

// --- API helper ---
// 获取 API 基路径（兼容 Relay 代理：/api/{token}/ 前缀）
var basePath = location.pathname.replace(/\/$/, "");
async function api(path, opts) {
  var r = await fetch(basePath + "/api" + path, opts);
  return r.json();
}

// --- Init ---
async function init() {
  var [engines, list, device] = await Promise.all([
    api("/engines"), api("/sessions"), api("/device"),
  ]);

  // Device info
  var di = document.getElementById("device-info");
  if (di && device.hostname) {
    di.textContent = device.hostname.split(".")[0] + " · " + device.arch + " · " + device.memory;
  }

  // Default CWD from server
  if (device.defaultCwd) {
    defaultCwd = device.defaultCwd;
    ddCwdInput.placeholder = defaultCwd;
  }

  // Engines
  availableEngines = engines.filter(function (e) { return e.available; });
  renderEngineOptions();

  // Sessions
  sessionList = list;
  renderSessionDropdown();

  if (list.length > 0) switchSession(list[0].id);
  else document.getElementById("empty").style.display = "flex";

  setupSessionMgr();
  setupEditModal();
  setupQuickKeys();
  setupMobileInput();
  setupDesktopFeatures();
  startLatencyPing();
}

// ============================
// Session management dropdown
// ============================
function setupSessionMgr() {
  sessionMgrBtn.onclick = function (ev) {
    ev.stopPropagation();
    if (sessionDropdown.classList.contains("hidden")) {
      openSessionDropdown();
    } else {
      closeSessionDropdown();
    }
  };

  // Close on click outside
  document.addEventListener("click", function (ev) {
    if (!sessionDropdown.contains(ev.target) && ev.target !== sessionMgrBtn && !sessionMgrBtn.contains(ev.target)) {
      closeSessionDropdown();
    }
  });

  // Prevent dropdown from closing when clicking inside
  sessionDropdown.addEventListener("click", function (ev) {
    ev.stopPropagation();
  });
}

function openSessionDropdown() {
  var rect = sessionMgrBtn.getBoundingClientRect();
  sessionDropdown.style.top = (rect.bottom + 4) + "px";
  sessionDropdown.style.left = rect.left + "px";
  sessionDropdown.classList.remove("hidden");
  renderSessionDropdown();
}

function closeSessionDropdown() {
  sessionDropdown.classList.add("hidden");
}

function renderSessionDropdown() {
  // Update button label
  var active = sessionList.find(function (s) { return s.id === activeId; });
  if (active) {
    var label = active.name || active.engineName || active.engine;
    var shortId = active.id.split("-").pop();
    sessionMgrLabel.textContent = label + " · " + shortId;
  } else {
    sessionMgrLabel.textContent = "Sessions";
  }

  // Render session list
  ddSessionList.innerHTML = "";
  if (sessionList.length === 0) {
    ddSessionList.innerHTML = '<div class="dd-empty-hint">暂无会话</div>';
  } else {
    sessionList.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "dd-session-row" + (s.id === activeId ? " active" : "");

      var displayName = s.name || s.engineName || s.engine;
      var shortId = s.id.split("-").pop();
      var isAlive = s.alive !== false;

      row.innerHTML =
        '<span class="dd-dot ' + (isAlive ? "alive" : "dead") + '"></span>' +
        '<div class="dd-session-info">' +
          '<div class="dd-session-name">' + displayName + '</div>' +
          '<div class="dd-session-meta">' + s.engine + ' · ' + shortId + (s.cwd ? ' · ' + s.cwd : '') + '</div>' +
        '</div>' +
        '<div class="dd-session-actions">' +
          '<button class="dd-action-btn dd-edit-btn" title="编辑">✎</button>' +
          '<button class="dd-action-btn danger dd-del-btn" title="删除">✕</button>' +
        '</div>';

      // Click row → switch session
      row.querySelector(".dd-session-info").onclick = function () {
        closeSessionDropdown();
        switchSession(s.id);
      };

      // Edit button
      row.querySelector(".dd-edit-btn").onclick = function (ev) {
        ev.stopPropagation();
        closeSessionDropdown();
        openEditModal(s.id);
      };

      // Delete button
      row.querySelector(".dd-del-btn").onclick = async function (ev) {
        ev.stopPropagation();
        if (!confirm("终止会话 " + displayName + " (" + shortId + ")?")) return;
        await api("/sessions/" + s.id, { method: "DELETE" });
        destroySession(s.id);
        sessionList = sessionList.filter(function (x) { return x.id !== s.id; });
        renderSessionDropdown();
        if (activeId === s.id) {
          if (sessionList.length) switchSession(sessionList[0].id);
          else {
            activeId = null;
            document.getElementById("empty").style.display = "flex";
          }
        }
      };

      ddSessionList.appendChild(row);
    });
  }
}

function renderEngineOptions() {
  ddEngineList.innerHTML = "";
  availableEngines.forEach(function (e) {
    var item = document.createElement("div");
    item.className = "dd-engine-item";
    item.textContent = e.name;
    item.onclick = function () {
      launchEngine(e.id);
    };
    ddEngineList.appendChild(item);
  });

  if (availableEngines.length === 0) {
    ddEngineList.innerHTML = '<div class="dd-empty-hint">无可用引擎</div>';
  }
}

async function launchEngine(engineId) {
  var cwd = ddCwdInput.value.trim() || undefined;
  closeSessionDropdown();

  var s = await api("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine: engineId, cwd: cwd }),
  });

  if (s.id) {
    sessionList.push(s);
    renderSessionDropdown();
    switchSession(s.id);
  }
}

// ============================
// Edit session modal
// ============================
function setupEditModal() {
  document.getElementById("edit-cancel").onclick = closeEditModal;
  document.getElementById("edit-save").onclick = saveEdit;

  // Close on overlay click
  document.getElementById("edit-modal").onclick = function (ev) {
    if (ev.target === this) closeEditModal();
  };
}

function openEditModal(id) {
  var s = sessionList.find(function (x) { return x.id === id; });
  if (!s) return;

  editingSessionId = id;
  document.getElementById("edit-name").value = s.name || "";
  document.getElementById("edit-engine").textContent = s.engineName || s.engine;
  document.getElementById("edit-cwd").textContent = s.cwd || defaultCwd;
  document.getElementById("edit-time").textContent = s.createdAt ? new Date(s.createdAt).toLocaleString("zh-CN") : "--";
  document.getElementById("edit-modal").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
  editingSessionId = null;
}

async function saveEdit() {
  if (!editingSessionId) return;
  var name = document.getElementById("edit-name").value.trim();

  var result = await api("/sessions/" + editingSessionId, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || null }),
  });

  if (result && !result.error) {
    // Update local state
    var idx = sessionList.findIndex(function (s) { return s.id === editingSessionId; });
    if (idx >= 0) {
      sessionList[idx].name = result.name;
    }
    renderSessionDropdown();
  }

  closeEditModal();
}

// ============================
// Session switching
// ============================
function switchSession(id) {
  if (!sessions[id]) createTerminal(id);

  // Hide all, show target
  Object.keys(sessions).forEach(function (k) {
    sessions[k].el.style.visibility = "hidden";
    sessions[k].el.style.pointerEvents = "none";
    sessions[k].el.style.zIndex = "0";
  });
  sessions[id].el.style.visibility = "visible";
  sessions[id].el.style.pointerEvents = "auto";
  sessions[id].el.style.zIndex = "1";
  activeId = id;

  renderSessionDropdown();
  document.getElementById("empty").style.display = "none";
  closeSearch();
  updateScrollBtn();
  updateLatencyBadge();

  setTimeout(function () {
    doFit(id); sendResize(id);
    if (!isMobile) sessions[id].term.focus();
  }, 50);
}

// ============================
// Terminal creation
// ============================
var TERM_THEME = {
  background: "#1e1e1e", foreground: "#e5e5e5", cursor: "#0a84ff",
  cursorAccent: "#1e1e1e",
  selectionBackground: "rgba(10,132,255,0.30)", selectionForeground: "#fff",
  black: "#1e1e1e", red: "#ff453a", green: "#30d158", yellow: "#ffd60a",
  blue: "#0a84ff", magenta: "#bf5af2", cyan: "#64d2ff", white: "#e5e5e5",
  brightBlack: "#636366", brightRed: "#ff6961", brightGreen: "#4cd964",
  brightYellow: "#ffe066", brightBlue: "#409cff", brightMagenta: "#da8fff",
  brightCyan: "#70d7ff", brightWhite: "#ffffff",
};

function createTerminal(id) {
  var wrap = document.getElementById("terminal-wrap");
  var el = document.createElement("div");
  el.className = "term-el";
  el.style.visibility = "hidden";
  wrap.appendChild(el);

  var term = new Terminal({
    cursorBlink: true,
    fontSize: currentFontSize,
    fontFamily: "'SF Mono',SFMono-Regular,ui-monospace,'Cascadia Code','Fira Code','JetBrains Mono','Menlo','Consolas','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',monospace",
    lineHeight: isMobile ? 1.1 : 1.15,
    scrollback: 50000,
    theme: TERM_THEME,
    allowProposedApi: true,
  });

  var fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  var search = new SearchAddon();
  term.loadAddon(search);

  var unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  term.open(el);

  // 使用 DOM 渲染器（默认），WebGL 在 Relay 代理场景下渲染不稳定

  // 选中文本自动复制到剪贴板（解决终端内链接无法复制的问题）
  term.onSelectionChange(function () {
    var sel = term.getSelection();
    if (sel && navigator.clipboard) {
      navigator.clipboard.writeText(sel).catch(function () {});
    }
  });

  sessions[id] = { term: term, fit: fit, search: search, ws: null, el: el, userScrolledUp: false, pingTimer: null };

  // Desktop keyboard → terminal
  if (!isMobile) {
    term.onData(function (data) { wsSend(id, { type: "input", data: data }); });
  }

  // Scroll detection
  term.onScroll(function () {
    var buf = term.buffer.active;
    var atBottom = buf.viewportY >= buf.baseY;
    var s = sessions[id];
    if (!s) return;
    s.userScrolledUp = !atBottom;
    if (id === activeId) updateScrollBtn();
  });

  term.onWriteParsed(function () {
    var s = sessions[id];
    if (s && !s.userScrolledUp) term.scrollToBottom();
  });

  search.onDidChangeResults(function (e) {
    if (id !== activeId) return;
    if (!e || e.resultCount === 0) {
      searchStatusEl.textContent = searchInput.value ? "无结果" : "";
    } else {
      searchStatusEl.textContent = (e.resultIndex + 1) + "/" + e.resultCount;
    }
  });

  if (isMobile) {
    term.element.addEventListener("touchstart", function () {}, { passive: true });
  }

  doFit(id);
  requestAnimationFrame(function () { doFit(id); });
  setTimeout(function () { doFit(id); }, 200);
  setTimeout(function () { doFit(id); }, 800);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { doFit(id); });
  }

  connectWs(id);
}

function destroySession(id) {
  var s = sessions[id]; if (!s) return;
  if (s.pingTimer) clearInterval(s.pingTimer);
  if (s.ws) s.ws.close();
  s.term.dispose();
  s.el.remove();
  delete sessions[id];
}

function doFit(id) {
  var s = sessions[id]; if (s) try { s.fit.fit(); } catch (e) {}
}

function sendResize(id) {
  var s = sessions[id];
  if (s && s.ws && s.ws.readyState === 1) {
    s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
  }
}

// ============================
// Scroll-to-bottom
// ============================
function updateScrollBtn() {
  var s = activeId && sessions[activeId];
  if (s && s.userScrolledUp) {
    scrollBtn.classList.remove("hidden");
  } else {
    scrollBtn.classList.add("hidden");
  }
}

scrollBtn.addEventListener("click", function (e) {
  e.preventDefault();
  var s = activeId && sessions[activeId];
  if (s) {
    s.userScrolledUp = false;
    s.term.scrollToBottom();
    scrollBtn.classList.add("hidden");
  }
});

// ============================
// WebSocket (per session) + WS ping for latency
// ============================
function connectWs(id) {
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var wsUrl = proto + "//" + location.host + basePath + "/ws?sessionId=" + id;

  // Add token if stored
  var token = new URLSearchParams(location.search).get("token");
  if (token) wsUrl += "&token=" + token;

  var ws = new WebSocket(wsUrl);
  var s = sessions[id]; if (!s) return;
  s.ws = ws;

  ws.onopen = function () {
    updateStatus(true);
    doFit(id); sendResize(id);

    // Start WS ping for latency
    if (s.pingTimer) clearInterval(s.pingTimer);
    s.pingTimer = setInterval(function () {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    }, 15000);

    // Initial ping
    ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  };

  ws.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === "output") {
        s.term.write(msg.data);
      } else if (msg.type === "exit") {
        s.term.write("\r\n\x1b[31m[Session ended]\x1b[0m\r\n");
      } else if (msg.type === "pong" && msg.ts) {
        var latency = Date.now() - msg.ts;
        currentLatency = latency;
        if (id === activeId) updateLatencyBadge();
        updateConnLatency(latency);
      }
    } catch (err) {}
  };

  ws.onclose = function () {
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
    updateStatus(false);
    currentLatency = -1;
    updateLatencyBadge();
    updateConnLatency(-1);
    setTimeout(function () { if (sessions[id]) connectWs(id); }, 3000);
  };
}

function wsSend(id, msg) {
  var s = sessions[id];
  if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
}

function updateStatus(on) {
  var dot = document.getElementById("status-dot");
  var txt = document.getElementById("status-text");
  dot.className = "dot" + (on ? " on" : " err");
  txt.className = on ? "on" : "";
  txt.textContent = on ? "Connected" : "Reconnecting...";
}

// ============================
// Latency display
// ============================
function updateLatencyBadge() {
  if (currentLatency < 0) {
    latencyBadge.classList.add("hidden");
    return;
  }
  latencyBadge.classList.remove("hidden");
  var text = currentLatency < 1000 ? currentLatency + "ms" : (currentLatency / 1000).toFixed(1) + "s";
  latencyBadge.textContent = text;
  latencyBadge.className = "latency-badge " + (currentLatency < 200 ? "good" : currentLatency < 1000 ? "mid" : "slow");
}

function updateConnLatency(ms) {
  if (ms < 0) {
    connLatencyEl.textContent = "";
    connLatencyEl.className = "conn-latency";
    return;
  }
  var text = ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  connLatencyEl.textContent = "· " + text;
  connLatencyEl.className = "conn-latency " + (ms < 200 ? "good" : ms < 1000 ? "mid" : "slow");
}

function startLatencyPing() {
  // Also do HTTP ping every 30s as backup
  setInterval(async function () {
    try {
      var t0 = Date.now();
      await fetch(basePath + "/api/ping");
      var lat = Date.now() - t0;
      // Only use HTTP latency if WS latency is unavailable
      if (currentLatency < 0) {
        currentLatency = lat;
        updateLatencyBadge();
        updateConnLatency(lat);
      }
    } catch {}
  }, 30000);
}

// ============================
// Search UI
// ============================
function openSearch() {
  searchBar.classList.remove("hidden");
  searchInput.focus();
  setTimeout(function () { if (activeId) doFit(activeId); }, 200);
}

function closeSearch() {
  searchBar.classList.add("hidden");
  searchInput.value = "";
  searchStatusEl.textContent = "";
  var s = activeId && sessions[activeId];
  if (s) s.search.clearDecorations();
  setTimeout(function () { if (activeId) doFit(activeId); }, 200);
}

function doSearchNext() {
  var s = activeId && sessions[activeId];
  if (!s || !searchInput.value) return;
  s.search.findNext(searchInput.value, {
    incremental: true,
    decorations: {
      matchBackground: "#665500", activeMatchBackground: "#886600",
      matchOverviewRuler: "#ffd60a", activeMatchColorOverviewRuler: "#0a84ff",
    },
  });
}

searchInput.addEventListener("input", doSearchNext);
searchInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    var s = activeId && sessions[activeId];
    if (s) s.search.findPrevious(searchInput.value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    doSearchNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});

document.getElementById("search-next").addEventListener("click", doSearchNext);
document.getElementById("search-prev").addEventListener("click", function () {
  var s = activeId && sessions[activeId];
  if (s) s.search.findPrevious(searchInput.value);
});
document.getElementById("search-close").addEventListener("click", closeSearch);
document.getElementById("search-toggle").addEventListener("click", function (e) {
  e.preventDefault();
  if (searchBar.classList.contains("hidden")) openSearch(); else closeSearch();
});

// ============================
// Font size controls
// ============================
function changeFontSize(delta) {
  currentFontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, currentFontSize + delta));
  localStorage.setItem("ccr-font-size", currentFontSize);
  Object.keys(sessions).forEach(function (id) {
    sessions[id].term.options.fontSize = currentFontSize;
    doFit(id);
  });
}

document.getElementById("font-inc").addEventListener("click", function (e) { e.preventDefault(); changeFontSize(1); });
document.getElementById("font-dec").addEventListener("click", function (e) { e.preventDefault(); changeFontSize(-1); });

// ============================
// Stop button
// ============================
document.getElementById("stop-btn").addEventListener("click", function (e) {
  e.preventDefault();
  if (activeId) wsSend(activeId, { type: "input", data: "\x03" });
});

// ============================
// Upload
// ============================
var fileInput = document.getElementById("file-input");
var toast = document.createElement("div");
toast.className = "upload-toast hidden";
document.body.appendChild(toast);

function showToast(msg) { toast.textContent = msg; toast.classList.remove("hidden"); }
function hideToast() { toast.classList.add("hidden"); }

function uploadFiles(files, onComplete) {
  var list = Array.from(files);
  if (!list.length) return;
  var paths = [];
  var total = list.length;
  var done = 0;
  var failed = 0;

  showToast("上传中... 0/" + total);

  list.forEach(function (file) {
    var form = new FormData();
    form.append("file", file);
    if (activeId) form.append("sessionId", activeId);

    fetch(basePath + "/api/upload", { method: "POST", body: form })
      .then(function (r) { if (!r.ok) throw new Error("fail"); return r.json(); })
      .then(function (data) {
        if (data.path) paths.push(data.path);
        done++;
        showToast("上传中... " + done + "/" + total);
        if (done === total) finishUpload(paths, failed, onComplete);
      })
      .catch(function () {
        done++; failed++;
        if (done === total) finishUpload(paths, failed, onComplete);
      });
  });
}

function finishUpload(paths, failed, onComplete) {
  if (paths.length > 0) {
    if (failed > 0) {
      showToast(failed + " 个文件上传失败");
      setTimeout(function () { hideToast(); onComplete(paths); }, 1500);
    } else {
      hideToast();
      onComplete(paths);
    }
  } else {
    showToast("上传失败");
    setTimeout(hideToast, 2000);
  }
}

fileInput.addEventListener("change", function () {
  var files = fileInput.files;
  if (!files.length) return;

  if (isMobile) {
    var input = document.getElementById("mobile-input");
    uploadFiles(files, function (paths) {
      var insert = paths.join(" ");
      input.value = input.value ? input.value + " " + insert : insert;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
      input.focus();
    });
  } else {
    uploadFiles(files, function (paths) {
      if (activeId) wsSend(activeId, { type: "input", data: paths.join(" ") });
    });
  }
  fileInput.value = "";
});

// ============================
// Mobile input + quick keys
// ============================
function setupMobileInput() {
  if (!isMobile) return;
  var input = document.getElementById("mobile-input");
  var sendBtn = document.getElementById("send-btn");

  function sendInput() {
    var text = input.value;
    if (!text || !activeId) return;
    wsSend(activeId, { type: "input", data: text + "\r" });
    input.value = "";
    autoResize();
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  sendBtn.addEventListener("click", function (e) { e.preventDefault(); sendInput(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendInput(); }
  });
  input.addEventListener("input", autoResize);

  document.getElementById("attach-btn").addEventListener("click", function (e) {
    e.preventDefault(); fileInput.click();
  });
}

function setupQuickKeys() {
  var qk = document.getElementById("quick-keys"); if (!qk) return;
  var keys = [
    { label: "Stop", data: "\x03", cls: "qk-danger" },
    "sep",
    { label: "Enter", data: "\r" },
    { label: "Tab", data: "\t" },
    { label: "Esc", data: "\x1b" },
    "sep",
    { label: "\u2191", data: "\x1b[A" },
    { label: "\u2193", data: "\x1b[B" },
    "sep",
    { label: "y", data: "y" },
    { label: "n", data: "n" },
    "sep",
    { label: "Ctrl+Z", data: "\x1a" },
    { label: "Ctrl+D", data: "\x04" },
    { label: "Ctrl+L", data: "\x0c" },
    "sep",
    { label: "/exit", data: "/exit\r" },
  ];

  keys.forEach(function (k) {
    if (k === "sep") {
      var s = document.createElement("div"); s.className = "qk-sep"; qk.appendChild(s);
      return;
    }
    var b = document.createElement("button");
    b.className = "qk" + (k.cls ? " " + k.cls : "");
    b.textContent = k.label;
    b.addEventListener("click", function (e) {
      e.preventDefault();
      if (activeId) wsSend(activeId, { type: "input", data: k.data });
    }, { passive: false });
    qk.appendChild(b);
  });
}

// ============================
// Desktop-only features
// ============================
function setupDesktopFeatures() {
  if (isMobile) return;

  document.getElementById("header-upload-btn").addEventListener("click", function (e) {
    e.preventDefault(); fileInput.click();
  });

  // Click anywhere → focus terminal
  document.addEventListener("click", function (e) {
    if (!e.target.closest("button,textarea,input,.search-bar,.session-mgr-btn,.session-dropdown,.dd-session-row,.modal,.modal-overlay") && activeId && sessions[activeId]) {
      sessions[activeId].term.focus();
    }
  });

  // Drag & drop
  var termWrap = document.getElementById("terminal-wrap");
  var dropOverlay = document.getElementById("drop-overlay");
  var dragCounter = 0;

  termWrap.addEventListener("dragenter", function (e) {
    e.preventDefault(); dragCounter++; dropOverlay.classList.add("show");
  });
  termWrap.addEventListener("dragleave", function (e) {
    e.preventDefault(); dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove("show"); }
  });
  termWrap.addEventListener("dragover", function (e) { e.preventDefault(); });
  termWrap.addEventListener("drop", function (e) {
    e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove("show");
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      uploadFiles(files, function (paths) {
        if (activeId) wsSend(activeId, { type: "input", data: paths.join(" ") });
      });
    }
  });

  // Clipboard paste images
  document.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var imageFiles = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image/") === 0) {
        var blob = items[i].getAsFile();
        if (blob) {
          var ext = items[i].type.split("/")[1] || "png";
          imageFiles.push(new File([blob], "paste-" + Date.now() + "." + ext, { type: items[i].type }));
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      uploadFiles(imageFiles, function (paths) {
        if (activeId) wsSend(activeId, { type: "input", data: paths.join(" ") });
      });
    }
  });

  // Keyboard shortcuts
  var shortcutsOverlay = document.getElementById("shortcuts-overlay");

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault(); openSearch(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault(); changeFontSize(1); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") {
      e.preventDefault(); changeFontSize(-1); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      e.preventDefault();
      currentFontSize = 14;
      localStorage.setItem("ccr-font-size", currentFontSize);
      Object.keys(sessions).forEach(function (id) {
        sessions[id].term.options.fontSize = currentFontSize;
        doFit(id);
      });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault(); shortcutsOverlay.classList.toggle("hidden"); return;
    }
    if (!shortcutsOverlay.classList.contains("hidden")) {
      shortcutsOverlay.classList.add("hidden");
    }
  });

  shortcutsOverlay.addEventListener("click", function () {
    shortcutsOverlay.classList.add("hidden");
  });
}

// ============================
// Mobile: touch scroll
// ============================
if (isMobile) {
  var touchLayer = document.getElementById("touch-scroll-layer");
  var dbg = document.getElementById("touch-debug");
  var tLastY = 0;
  var tVel = 0;
  var tMid = null;
  var tAccum = 0;

  touchLayer.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    tLastY = e.touches[0].clientY;
    tVel = 0;
    tAccum = 0;
    if (tMid) { cancelAnimationFrame(tMid); tMid = null; }
  }, { passive: true });

  touchLayer.addEventListener("touchmove", function (e) {
    if (e.touches.length !== 1 || !activeId) return;
    var s = sessions[activeId];
    if (!s || !s.term) return;

    var y = e.touches[0].clientY;
    var dy = tLastY - y;
    tVel = dy;
    tLastY = y;
    tAccum += dy;

    var stepPx = 12;
    var lines = Math.trunc(tAccum / stepPx);
    if (lines !== 0) {
      var code = lines > 0 ? 65 : 64;
      var seq = "\x1b[<" + code + ";1;1M";
      wsSend(activeId, { type: "input", data: seq });
      tAccum -= (lines > 0 ? 1 : -1) * stepPx;
    }
    dbg.textContent = "dy=" + dy.toFixed(0) + " L=" + lines + " code=" + (lines > 0 ? "UP" : lines < 0 ? "DN" : "-");
    e.preventDefault();
  }, { passive: false });

  touchLayer.addEventListener("touchend", function () {
    if (Math.abs(tVel) > 4 && activeId) {
      (function momentum() {
        var s = activeId && sessions[activeId];
        if (!s || !s.term || Math.abs(tVel) < 1) { tVel = 0; return; }
        var lineH = (s.term.options.fontSize || 14) * (s.term.options.lineHeight || 1.15);
        var lines = Math.round(tVel / lineH);
        if (lines !== 0) s.term.scrollLines(lines);
        tVel *= 0.92;
        tMid = requestAnimationFrame(momentum);
      })();
    }
  }, { passive: true });
}

// ============================
// Resize
// ============================
var resizeTimer;
window.addEventListener("resize", function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    if (activeId) { doFit(activeId); sendResize(activeId); }
  }, 150);
});

if (isMobile && window.visualViewport) {
  var appEl = document.getElementById("app");

  window.visualViewport.addEventListener("resize", function () {
    appEl.style.height = window.visualViewport.height + "px";
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (activeId) { doFit(activeId); sendResize(activeId); }
    }, 100);
  });

  window.visualViewport.addEventListener("scroll", function () {
    window.scrollTo(0, 0);
  });
}

// --- Go ---
init();
