import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";

var isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= 768);

// --- State ---
var sessions = {}; // id → { term, fit, search, ws, el, userScrolledUp }
var activeId = null;
var currentFontSize = parseInt(localStorage.getItem("ccr-font-size")) || (isMobile ? 12 : 14);
var MIN_FONT = 10;
var MAX_FONT = 24;

// --- DOM refs ---
var scrollBtn = document.getElementById("scroll-bottom-btn");
var searchBar = document.getElementById("search-bar");
var searchInput = document.getElementById("search-input");
var searchStatusEl = document.getElementById("search-status");

// --- API helper ---
async function api(path, opts) {
  var r = await fetch("/api" + path, opts);
  return r.json();
}

// --- Init ---
async function init() {
  var [engines, list, device] = await Promise.all([
    api("/engines"), api("/sessions"), api("/device"),
  ]);

  var di = document.getElementById("device-info");
  if (di && device.hostname) {
    di.textContent = device.hostname.split(".")[0] + " | " + device.arch + " | " + device.memory;
  }

  renderEngineBar(engines);
  list.forEach(function (s) { addSessionTab(s.id, s.engine); });

  if (list.length > 0) switchSession(list[0].id);
  else document.getElementById("empty").style.display = "flex";

  setupQuickKeys();
  setupMobileInput();
  setupDesktopFeatures();
}

// ============================
// Engine bar
// ============================
var availableEngines = [];

function renderEngineBar(engs) {
  availableEngines = engs.filter(function (e) { return e.available; });
  var bar = document.getElementById("engine-bar");

  availableEngines.forEach(function (e) {
    var btn = document.createElement("button");
    btn.className = "engine-btn";
    btn.textContent = e.name;
    btn.onclick = function () { launchEngine(e.id, btn); };
    bar.appendChild(btn);
  });

  // "+" button
  var addBtn = document.createElement("button");
  addBtn.className = "add-btn";
  addBtn.textContent = "+";
  addBtn.title = "新建终端";

  var dropdown = document.createElement("div");
  dropdown.className = "engine-dropdown";
  dropdown.style.display = "none";
  availableEngines.forEach(function (e) {
    var item = document.createElement("div");
    item.className = "engine-item";
    item.textContent = e.name;
    item.onclick = function (ev) {
      ev.stopPropagation(); dropdown.style.display = "none"; launchEngine(e.id, null);
    };
    dropdown.appendChild(item);
  });

  addBtn.onclick = function (ev) {
    ev.stopPropagation();
    if (dropdown.style.display === "none") {
      var rect = addBtn.getBoundingClientRect();
      dropdown.style.top = (rect.bottom + 4) + "px";
      dropdown.style.left = rect.left + "px";
      dropdown.style.display = "flex";
    } else {
      dropdown.style.display = "none";
    }
  };
  document.addEventListener("click", function () {
    dropdown.style.display = "none";
    document.querySelectorAll(".session-dropdown").forEach(function (d) { d.style.display = "none"; });
  });

  bar.appendChild(addBtn);
  document.body.appendChild(dropdown);
}

async function launchEngine(engineId, btn) {
  if (btn) { btn.disabled = true; var orig = btn.textContent; btn.textContent = "..."; }
  var s = await api("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine: engineId }),
  });
  if (btn) { btn.disabled = false; btn.textContent = orig; }
  if (s.id) { addSessionTab(s.id, s.engine); switchSession(s.id); }
}

// ============================
// Session selector
// ============================
var sessionList = [];

function addSessionTab(id, engine) {
  sessionList.push({ id: id, engine: engine });
  renderSessionSelector();
}

function removeSessionFromList(id) {
  sessionList = sessionList.filter(function (s) { return s.id !== id; });
  renderSessionSelector();
}

function renderSessionSelector() {
  var container = document.getElementById("session-tabs");
  container.innerHTML = "";
  if (sessionList.length === 0) return;

  var btn = document.createElement("button");
  btn.className = "session-btn";
  var active = sessionList.find(function (s) { return s.id === activeId; });
  btn.textContent = active ? active.engine + " \u25BE" : "Sessions \u25BE";

  var dd = document.createElement("div");
  dd.className = "session-dropdown";
  dd.style.display = "none";

  sessionList.forEach(function (s) {
    var row = document.createElement("div");
    row.className = "session-row" + (s.id === activeId ? " active" : "");
    row.innerHTML =
      '<span class="session-label">' + s.engine + '</span>' +
      '<span class="session-id">' + s.id.split("-").pop() + '</span>' +
      '<span class="session-del">\u00d7</span>';
    row.querySelector(".session-label").onclick = function (ev) {
      ev.stopPropagation(); dd.style.display = "none"; switchSession(s.id);
    };
    row.querySelector(".session-id").onclick = function (ev) {
      ev.stopPropagation(); dd.style.display = "none"; switchSession(s.id);
    };
    row.querySelector(".session-del").onclick = async function (ev) {
      ev.stopPropagation();
      if (!confirm("终止 " + s.id + "?")) return;
      await api("/sessions/" + s.id, { method: "DELETE" });
      destroySession(s.id);
      removeSessionFromList(s.id);
      dd.style.display = "none";
      if (activeId === s.id) {
        if (sessionList.length) switchSession(sessionList[0].id);
        else {
          activeId = null;
          document.getElementById("empty").style.display = "flex";
        }
      }
    };
    dd.appendChild(row);
  });

  btn.onclick = function (ev) {
    ev.stopPropagation();
    if (dd.style.display === "none") {
      var rect = btn.getBoundingClientRect();
      dd.style.top = (rect.bottom + 4) + "px";
      dd.style.right = (window.innerWidth - rect.right) + "px";
      dd.style.left = "auto";
      dd.style.display = "flex";
    } else {
      dd.style.display = "none";
    }
  };
  dd.onclick = function (ev) { ev.stopPropagation(); };

  container.appendChild(btn);
  document.body.appendChild(dd);

  // Cleanup stale dropdowns
  document.querySelectorAll(".session-dropdown").forEach(function (old) {
    if (old !== dd) old.remove();
  });
}

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

  renderSessionSelector();
  document.getElementById("empty").style.display = "none";
  closeSearch();
  updateScrollBtn();

  setTimeout(function () {
    doFit(id); sendResize(id);
    if (!isMobile) sessions[id].term.focus();
  }, 50);
}

// ============================
// Terminal creation (with all addons)
// ============================
var TERM_THEME = {
  background: "#1a1a2e", foreground: "#e4e4e4", cursor: "#e94560",
  cursorAccent: "#1a1a2e",
  selectionBackground: "rgba(233,69,96,0.30)", selectionForeground: "#fff",
  black: "#1a1a2e", red: "#e94560", green: "#4ade80", yellow: "#fbbf24",
  blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e0e0e0",
  brightBlack: "#5a5a7a", brightRed: "#ff6b81", brightGreen: "#6aff96",
  brightYellow: "#ffe066", brightBlue: "#82bdff", brightMagenta: "#d8a8ff",
  brightCyan: "#5aeaea", brightWhite: "#ffffff",
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
    fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono','Menlo','Consolas',monospace",
    lineHeight: isMobile ? 1.1 : 1.15,
    scrollback: 50000,
    theme: TERM_THEME,
    allowProposedApi: true,
    convertEol: true,
  });

  var fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // Search addon (per terminal)
  var search = new SearchAddon();
  term.loadAddon(search);

  // Unicode11 for CJK
  var unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  term.open(el);

  // WebGL renderer — disabled on mobile to use DOM rendering (touch scroll support)
  if (!isMobile) {
    try {
      var webgl = new WebglAddon();
      webgl.onContextLoss(function () { webgl.dispose(); });
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL not available, using DOM renderer");
    }
  }

  sessions[id] = { term: term, fit: fit, search: search, ws: null, el: el, userScrolledUp: false };

  // Desktop keyboard → terminal
  if (!isMobile) {
    term.onData(function (data) { wsSend(id, { type: "input", data: data }); });
  }

  // Scroll-to-bottom detection
  term.onScroll(function () {
    var buf = term.buffer.active;
    var atBottom = buf.viewportY >= buf.baseY;
    var s = sessions[id];
    if (!s) return;
    s.userScrolledUp = !atBottom;
    if (id === activeId) updateScrollBtn();
  });

  // Auto-scroll on new content (unless user scrolled up)
  term.onWriteParsed(function () {
    var s = sessions[id];
    if (s && !s.userScrolledUp) term.scrollToBottom();
  });

  // Search result updates (only update UI for active session)
  search.onDidChangeResults(function (e) {
    if (id !== activeId) return;
    if (!e || e.resultCount === 0) {
      searchStatusEl.textContent = searchInput.value ? "无结果" : "";
    } else {
      searchStatusEl.textContent = (e.resultIndex + 1) + "/" + e.resultCount;
    }
  });

  // Mobile passive touch (let xterm handle natively)
  if (isMobile) {
    term.element.addEventListener("touchstart", function () {}, { passive: true });
  }

  // Fit
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
// Scroll-to-bottom button
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
// WebSocket (per session)
// ============================
function connectWs(id) {
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var ws = new WebSocket(proto + "//" + location.host + "/ws?sessionId=" + id);
  var s = sessions[id]; if (!s) return;
  s.ws = ws;

  ws.onopen = function () {
    updateStatus(true);
    doFit(id); sendResize(id);
  };

  ws.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === "output") s.term.write(msg.data);
      else if (msg.type === "exit") s.term.write("\r\n\x1b[31m[Session ended]\x1b[0m\r\n");
    } catch (err) {}
  };

  ws.onclose = function () {
    updateStatus(false);
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
  dot.className = "dot" + (on ? " on" : "");
  txt.className = "status-text" + (on ? " on" : "");
  txt.textContent = on ? "Connected" : "Reconnecting...";
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
  // Clear decorations on active terminal
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
      matchOverviewRuler: "#fbbf24", activeMatchColorOverviewRuler: "#e94560",
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
  // Apply to all terminals
  Object.keys(sessions).forEach(function (id) {
    sessions[id].term.options.fontSize = currentFontSize;
    doFit(id);
  });
}

document.getElementById("font-inc").addEventListener("click", function (e) { e.preventDefault(); changeFontSize(1); });
document.getElementById("font-dec").addEventListener("click", function (e) { e.preventDefault(); changeFontSize(-1); });

// ============================
// Stop button (Ctrl+C to active session)
// ============================
document.getElementById("stop-btn").addEventListener("click", function (e) {
  e.preventDefault();
  if (activeId) wsSend(activeId, { type: "input", data: "\x03" });
});

// ============================
// Upload: toast + shared logic
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

    fetch("/api/upload", { method: "POST", body: form })
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

// File input change
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

  // Attach button
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

  // Header upload button
  document.getElementById("header-upload-btn").addEventListener("click", function (e) {
    e.preventDefault(); fileInput.click();
  });

  // Click anywhere → focus terminal
  document.addEventListener("click", function (e) {
    if (!e.target.closest("button,textarea,input,.search-bar,.session-btn,.session-row") && activeId && sessions[activeId]) {
      sessions[activeId].term.focus();
    }
  });

  // Drag & drop upload
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
// Mobile: touch scroll via overlay layer on top of xterm
// ============================
if (isMobile) {
  var touchLayer = document.getElementById("touch-scroll-layer");
  var dbg = document.getElementById("touch-debug");
  var tLastY = 0;
  var tVel = 0;
  var tMid = null;
  var tAccum = 0; // accumulate sub-line movements

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

    var stepPx = 12; // 1 scroll event per 12px
    var lines = Math.trunc(tAccum / stepPx);
    if (lines !== 0) {
      // Send mouse wheel escape sequences to tmux (SGR extended mode)
      // Direction reversed: finger up (dy>0) = wheel down (see newer), finger down = wheel up (see older)
      var code = lines > 0 ? 65 : 64;
      // Cap to 1 event per touchmove — smooth single-line scrolling
      var seq = "\x1b[<" + code + ";1;1M";
      wsSend(activeId, { type: "input", data: seq });
      tAccum -= (lines > 0 ? 1 : -1) * stepPx;
    }
    dbg.textContent = "dy=" + dy.toFixed(0) + " L=" + lines + " code=" + (lines > 0 ? "UP" : lines < 0 ? "DN" : "-");
    e.preventDefault();
  }, { passive: false });

  touchLayer.addEventListener("touchend", function () {
    // Momentum scroll
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
