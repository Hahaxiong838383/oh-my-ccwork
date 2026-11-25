/* Interactive State Engine for the 3-Style Personal Voice Assistant Showcase */

const STYLE_META = {
  paper: {
    name: "风格 A · 暖纸静听（Warm Editorial / Tactile Paper）",
    desc: "以私密手账与桌面声学仪器为意象。暖白纸面 + 陶土红/鼠尾草绿语义色 + 衬线标题，极低视觉疲劳，突出「阅读文字稿、核对记忆、温和编辑人格成长」的长期陪伴感。",
    swatches: [
      { label: "纸面 #F4F1EA", color: "#F4F1EA" },
      { label: "墨黑 #1C1B18", color: "#1C1B18" },
      { label: "陶土红 #B54724", color: "#B54724" },
      { label: "鼠尾草 #2F5D4B", color: "#2F5D4B" },
      { label: "赭黄 #8F5B00", color: "#8F5B00" },
      { label: "朱砂 #A62626", color: "#A62626" }
    ]
  },
  console: {
    name: "风格 B · 飞牛声学台（Precision Studio Console）",
    desc: "深色暗房工程面板与专业音频调音台结合，与飞牛 fnOS 私有后台天然同频。等宽状态码、高对比度青/翠/琥珀/朱红信号灯，3–5 台设备签票与语音流水线排障零歧义。",
    swatches: [
      { label: "暗岩 #0B0E12", color: "#0B0E12" },
      { label: "面板 #131820", color: "#131820" },
      { label: "电光青 #38BDF8", color: "#38BDF8" },
      { label: "信号翠 #34D399", color: "#34D399" },
      { label: "工业琥珀 #FBBF24", color: "#FBBF24" },
      { label: "警示红 #F87171", color: "#F87171" }
    ]
  },
  glass: {
    name: "风格 C · 柔雾伴生（Ambient Spatial Glass）",
    desc: "轻盈半透明磨砂层级与边缘氛围光场（严禁复用任何品牌灯环）。对话时保持视觉低噪，仅在后台搜索返回、工具批准或记忆核对时以通透浮层展开；管理台采用现代 Bento 卡片流。",
    swatches: [
      { label: "冷雾 #EAF0F7", color: "#EAF0F7" },
      { label: "靛墨 #141B2D", color: "#141B2D" },
      { label: "鸢尾紫 #4F46E5", color: "#4F46E5" },
      { label: "松石青 #0F766E", color: "#0F766E" },
      { label: "琥珀金 #B45309", color: "#B45309" },
      { label: "珊瑚红 #C83E2B", color: "#C83E2B" }
    ]
  }
};

const state = {
  theme: "glass",
  view: "overview",       // overview | mobile | web | admin | matrix
  mobileMode: "duplex",   // duplex | listening | muted | hold | approval | collision | restricted | hardware | ended
  mobileInterrupted: false,
  mobileYielded: false,
  mobileApproved: null,   // null | 'approved' | 'rejected' | 'undone'
  webMode: "live_cards",  // live_cards | approval | sources | temp_chat | fallback
  webApproval: "pending", // pending | approved | rejected | timeout
  webCardArrived: true,
  webSources: [
    { id: "s1", type: "已保存记忆", text: "飞牛 NAS 每周三凌晨 03:00 执行冷备同步，非必要勿重启", status: "active" },
    { id: "s2", type: "旧对话 #1042", text: "11月19日讨论过客厅空调夜间设定 24℃ 且静风", status: "active" },
    { id: "s3", type: "自定义指令", text: "汇报结论先讲数字再讲原因，不要寒暄和玩笑", status: "active" }
  ],
  adminTab: "runs",       // runs | memory | persona | devices
  debugRecording: false,
  selectedRunId: "r1",
  runsFilter: "all",      // all | empty_device
  dryRunResult: null,
  realRunResult: null,
  memRefSaved: true,
  memRefHistory: true,
  personaEditingId: null,
  personaItems: [
    {
      id: "p1",
      summary: "汇报天气与任务时先给结论与关键数值，省略寒暄和俏皮话",
      status: "active",
      sources: ["通话 #1048 · 11-24 21:14 (iPhone)", "通话 #1031 · 11-21 08:05 (MacBook)"]
    },
    {
      id: "p2",
      summary: "晚 22:30 后默认压低语速，不主动追问延展话题",
      status: "active",
      sources: ["通话 #1042 · 11-23 22:48 (床头平板)"]
    },
    {
      id: "p3",
      summary: "涉及日程修改或智能插座开关时，先报出目标时间/设备名再等屏幕确认",
      status: "corrected",
      sources: ["通话 #1039 · 11-22 14:32 (Web) · 曾人工改正"]
    },
    {
      id: "p4",
      summary: "提及「飞牛」默认指家里内网 fnOS 主机，而非外部云盘",
      status: "active",
      sources: ["通话 #1015 · 11-18 19:20 (书房台机)"]
    }
  ]
};

const RECENT_RUNS = [
  {
    id: "r1",
    device: "iPhone 16 Pro",
    ticket: "TK-01",
    time: "10:42:18",
    heard: "帮我查今晚杭州会下雨吗，顺便把明天十点的例会改到十一点",
    intent: "weather.query(杭州) + calendar.reschedule(需屏幕批准)",
    result: "已口播天气；日程改期等待屏幕点击同意",
    tag: "badge-warn",
    tagText: "待批准",
    trace: {
      audioDiag: "录音清晰（SNR 26dB）· 调试录音已关闭",
      asrNote: "转写准确 · 双工未中断",
      toolNote: "weather.query 420ms 成功；calendar.reschedule 阻塞于屏幕确认（语音确认已禁用）",
      memoryNote: "刚写入：无（待批准动作不预写记忆）"
    }
  },
  {
    id: "r2",
    device: "客厅桌面音箱",
    ticket: "TK-03",
    time: "09:15:04",
    heard: "打开书房的加湿器",
    intent: "iot.switch(study_humidifier, on)",
    result: "工具失败：设备离线（错误已明确口播原因）",
    tag: "badge-danger",
    tagText: "转写对·工具失败",
    trace: {
      audioDiag: "录音清晰 · 仅本机响应",
      asrNote: "转写准确：「打开书房的加湿器」",
      toolNote: "iot.switch 返回 E_DEVICE_OFFLINE（已按指南直报具体原因，未重复客套）",
      memoryNote: "未写入记忆"
    }
  },
  {
    id: "r3",
    device: "MacBook Pro",
    ticket: "TK-02",
    time: "08:30:41",
    heard: "把非牛相册的备份日志发我看看",
    intent: "asr.misheard(「非牛」→未命中「飞牛」)",
    result: "录音清楚但转写错 → 定位为 ASR 词库问题",
    tag: "badge-info",
    tagText: "转写错·录音清",
    trace: {
      audioDiag: "调试回放清晰（可清楚听见「飞牛」），问题在转写层，不在麦克风",
      asrNote: "转写误识为「非牛」，建议补充热词表",
      toolNote: "未触发工具（且语音端无权读管理后台日志）",
      memoryNote: "已标注记忆「飞牛=fnOS」本次未触发"
    }
  },
  {
    id: "r4",
    device: "床头 iPad",
    ticket: "TK-04",
    time: "昨日 23:18",
    heard: "（转写为空）",
    intent: "asr.empty(环境噪声过强/距离过远)",
    result: "录音本身听不清，未误触发任何动作",
    tag: "badge-neutral",
    tagText: "转写为空·音糊",
    trace: {
      audioDiag: "调试回放仅见被褥摩擦与空调底噪，录音本身听不清",
      asrNote: "空转写（已过滤，不扣对话额度）",
      toolNote: "无工具调用",
      memoryNote: "无写入"
    }
  },
  {
    id: "r5",
    device: "Web 浏览器",
    ticket: "TK-05",
    time: "昨日 20:05",
    heard: "记住我下周二出差深圳，早班机七点半",
    intent: "memory.save(explicit_trip)",
    result: "已写入第1层已保存记忆，并同步摘要",
    tag: "badge-listen",
    tagText: "记忆刚写入",
    trace: {
      audioDiag: "Web 语音+文字混排会话（同线程续聊）",
      asrNote: "转写准确",
      toolNote: "memory.save 成功 · 写入第1层（可随时单独改正或删除）",
      memoryNote: "记忆刚写入：下周二 07:30 深圳出差（来源：对话 #1049）"
    }
  }
];

/* --------------------------------------------------------------------------
   Render Functions
   -------------------------------------------------------------------------- */
function renderHeaderAndBanner() {
  document.documentElement.setAttribute("data-theme", state.theme);

  document.querySelectorAll("[data-theme-btn]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeBtn === state.theme);
  });

  document.querySelectorAll("[data-view-btn]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.viewBtn === state.view);
  });

  const meta = STYLE_META[state.theme];
  document.getElementById("style-title").textContent = meta.name;
  document.getElementById("style-desc").textContent = meta.desc;
  document.getElementById("style-swatches").innerHTML = meta.swatches
    .map(s => `<span class="swatch"><span class="swatch-dot" style="background:${s.color}"></span>${s.label}</span>`)
    .join("");

  // Toggle visible sections according to selected view
  const overviewTop = document.getElementById("overview-top-grid");
  const secMobile = document.getElementById("section-mobile");
  const secWeb = document.getElementById("section-web");
  const secAdmin = document.getElementById("section-admin");
  const secMatrix = document.getElementById("section-matrix");

  if (state.view === "overview") {
    overviewTop.className = "overview-top-grid";
    secMobile.classList.remove("hidden");
    secWeb.classList.remove("hidden");
    secAdmin.classList.remove("hidden");
    secMatrix.classList.remove("hidden");
  } else {
    overviewTop.className = state.view === "mobile" ? "single-focus-wrap" : "";
    secMobile.classList.toggle("hidden", state.view !== "mobile");
    secWeb.classList.toggle("hidden", state.view !== "web");
    secAdmin.classList.toggle("hidden", state.view !== "admin");
    secMatrix.classList.toggle("hidden", state.view !== "matrix");
  }
}

function renderMobile() {
  document.querySelectorAll("[data-mobile-mode]").forEach(b => {
    b.classList.toggle("active", b.dataset.mobileMode === state.mobileMode);
  });

  const screen = document.getElementById("mobile-screen-mount");
  const m = state.mobileMode;

  // Device arbitration bar (3-5 devices, single active vs collision)
  const isCollision = m === "collision" && !state.mobileYielded;
  const devices = [
    { name: "iPhone", active: !["hardware", "ended"].includes(m) && !state.mobileYielded, collision: isCollision },
    { name: "客厅音箱", active: false, collision: isCollision },
    { name: "Mac", active: false, collision: false },
    { name: "iPad", active: false, collision: false }
  ];

  const arbBar = `
    <div class="device-arb-bar">
      <div class="device-dots" title="单主人 4 台已签票设备仲裁状态">
        ${devices.map(d => `
          <span class="dev-chip ${d.collision ? "collision" : d.active ? "active" : ""}">
            <span class="dot"></span>${d.name}
          </span>
        `).join("")}
      </div>
      <button class="yield-btn" id="btn-mobile-yield" title="当场让本机退出应答，无需进设置">
        ${state.mobileYielded ? "恢复本机" : "本机退让"}
      </button>
    </div>
  `;

  if (m === "ended") {
    screen.innerHTML = `
      <div class="phone-status mono"><span>10:45</span><span>TK-01 · 单线程文字稿</span></div>
      ${arbBar}
      <div class="phone-body">
        <div class="phone-alert info">
          <div class="phone-alert-title"><span>语音已结束 · 落回同一条文字稿</span><span class="badge badge-info">原线程</span></div>
          <div>未新建聊天。可继续打字，或点底部「续聊语音」在同一条对话里接着说。</div>
        </div>
        <div class="transcript-list">
          <div class="t-msg user"><strong>我（语音 10:42）：</strong>今晚杭州会下雨吗？顺便把明天十点的例会改到十一点。</div>
          <div class="t-msg"><strong>助手：</strong>今晚 20 点后转小雨，降水量约 4 毫米，气温 11 到 15 度。明天例会改期需要你在屏幕上点确认。</div>
          <div class="t-msg">
            <span class="badge badge-listen">已批准并执行</span> 明天「项目周会」已改至 11:00–12:00。
            <div style="margin-top:6px"><button class="btn btn-sm">撤销修改</button> <span class="helper-note">（后台不可撤销）</span></div>
          </div>
        </div>
      </div>
      <div class="phone-dock" style="grid-template-columns: 1fr auto;">
        <input class="composer-input" placeholder="在同一条对话里继续打字…" readonly />
        <button class="btn btn-primary" id="btn-resume-live">🎙 续聊语音</button>
      </div>
    `;
    bindMobileHandlers();
    return;
  }

  // Dynamic alerts & stage content per state
  let alertHtml = "";
  let asyncStripHtml = "";
  let badgeHtml = `<span class="badge badge-primary">助手在说 · 可直接打断</span>`;
  let screenText = "今晚 20 点后杭州转小雨，11–15℃，建议带伞。";
  let spokenNote = "耳机/锁屏独立口播稿：「今晚八点后杭州转小雨，气温十一度到十五度，出门记得带伞。」（不依赖看屏）";
  let meterClass = "";
  let heights = [14, 28, 38, 22, 34, 18, 30, 16];

  if (state.mobileYielded) {
    badgeHtml = `<span class="badge badge-neutral">本机已退让 · 未应答</span>`;
    screenText = "本机已当场退出监听（等效手机面朝下/合盖），其他设备保持正常。";
    spokenNote = "无口播输出。随时点右上角「恢复本机」重新参与仲裁。";
    meterClass = "paused";
  } else if (m === "duplex") {
    if (state.mobileInterrupted) {
      badgeHtml = `<span class="badge badge-listen">已打断 → 正在听你说</span>`;
      screenText = "「等等，不用改明天的会了，改后天…」";
      spokenNote = "口播立即停声，全双工切回在听，无需重唤。";
      heights = [20, 34, 26, 38, 30, 24, 32, 18];
    }
    asyncStripHtml = `
      <div class="async-tool-pill">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="pulse-dot"></span>
          <span><strong>后台还在查：</strong>检索飞牛日历冲突（前台可继续说话，不冻屏）</span>
        </div>
        <span class="mono" style="font-size:11px;color:var(--text-muted)">1.2s</span>
      </div>
    `;
  } else if (m === "listening") {
    badgeHtml = `<span class="badge badge-listen">在听 · 停顿中仍算没说完</span>`;
    screenText = "「帮我查一下下周二去深圳的航班，嗯……最好是上午……」";
    spokenNote = "语义停顿保护：检测到用户思考停顿，不抢答、不提前截断；轻点屏幕可主动催答。";
    heights = [12, 18, 14, 22, 16, 12, 18, 10];
  } else if (m === "muted") {
    badgeHtml = `<span class="badge badge-warn">助手在说 · 你已静音</span>`;
    screenText = "已为你找到 3 班深圳早班机，最早一班 07:30 萧山起飞…";
    spokenNote = "Mute 仅关掉你的麦克风，助手继续说完、上下文不断；如需中断仍可点屏幕打断。";
    heights = [18, 32, 26, 36, 22, 30, 18, 24];
  } else if (m === "hold") {
    badgeHtml = `<span class="badge badge-neutral">已暂停（Hold）</span>`;
    screenText = "麦克风与助手语音均已暂停，上下文原地保留。";
    spokenNote = "若锁屏继续开关未开启，锁屏时自动进入此暂停态；点「恢复」继续原会话。";
    meterClass = "paused";
  } else if (m === "approval") {
    badgeHtml = `<span class="badge badge-warn">等待屏幕批准 · 口头同意无效</span>`;
    screenText = "要把明天 10:00「项目周会」改到 11:00 吗？";
    spokenNote = "口播稿：「已定位明天十点的项目周会，改期会改动日历，请在屏幕上点同意或拒绝，开口说同意不算。」";
    if (state.mobileApproved === "approved") {
      alertHtml = `
        <div class="phone-alert info">
          <div class="phone-alert-title"><span>已执行日程修改</span><button class="btn btn-sm" id="btn-mobile-undo">撤销 Undo</button></div>
          <div>明天「项目周会」已改至 11:00。（仅前台支持撤销；切后台后不可撤销）</div>
        </div>
      `;
    } else if (state.mobileApproved === "rejected") {
      alertHtml = `
        <div class="phone-alert info">
          <div class="phone-alert-title"><span>已拒绝该操作</span><span class="badge badge-neutral">对话继续</span></div>
          <div>日历未改动。你可以继续说话说明新时间。</div>
        </div>
      `;
    } else if (state.mobileApproved === "undone") {
      alertHtml = `
        <div class="phone-alert info">
          <div class="phone-alert-title"><span>已撤销</span><span class="badge badge-listen">已恢复 10:00</span></div>
          <div>「项目周会」已恢复为原定 10:00。</div>
        </div>
      `;
    } else {
      alertHtml = `
        <div class="phone-alert warn">
          <div class="phone-alert-title"><span>⚠️ 外部写入需屏幕点击确认</span><span class="mono">日历 API</span></div>
          <div>将「项目周会」从 <strong>11-26 10:00</strong> 改至 <strong>11-26 11:00</strong>。口说「同意」不生效。</div>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <button class="btn btn-sm btn-listen" id="btn-mob-approve">点按同意</button>
            <button class="btn btn-sm" id="btn-mob-reject">拒绝</button>
          </div>
        </div>
      `;
    }
  } else if (m === "collision") {
    badgeHtml = `<span class="badge badge-danger">多设备冲突 · 两台同时应答</span>`;
    alertHtml = `
      <div class="phone-alert danger">
        <div class="phone-alert-title"><span>⚠️ 检测到 2 台设备同时在答</span><span class="mono">蓝牙仲裁失败</span></div>
        <div><strong>iPhone</strong> 与 <strong>客厅音箱</strong> 同时响应。请点右上角「本机退让」立即静默本机，保留客厅音箱继续说。</div>
      </div>
    `;
    screenText = "两台设备可能同时播报，建议立即退让一台。";
    spokenNote = "设计提示：单主人多设备不做家庭声纹墙，但必须明确暴露冲突态并给当场退让开关。";
  } else if (m === "restricted") {
    badgeHtml = `<span class="badge badge-warn">系统边界态合集</span>`;
    meterClass = "paused";
    screenText = "锁屏 / 切后台 / 额度边界保护说明";
    spokenNote = "口播会直报具体原因（如「本次语音时长已到上限，已切回文字继续」），不带多余寒暄。";
    alertHtml = `
      <div class="phone-alert warn">
        <div class="phone-alert-title"><span>🔒 锁屏不能新开语音</span><span class="badge badge-neutral">安全边界</span></div>
        <div>解锁后才能新开；进行中的通话若关闭「锁屏继续」将自动转为 Hold。</div>
      </div>
      <div class="phone-alert info">
        <div class="phone-alert-title"><span>📷 切后台已停止共享</span><span class="badge badge-neutral">不自动恢复</span></div>
        <div>摄像头/屏幕共享在 Hold、离开应用或锁屏时停止，返回后需手动重新开启。</div>
      </div>
      <div class="phone-alert danger">
        <div class="phone-alert-title"><span>⏱ 本次语音用量已到顶</span><button class="btn btn-sm" id="btn-go-text">切回同线程文字</button></div>
        <div>上下文完整保留，可在同一条聊天里继续打字。</div>
      </div>
    `;
  } else if (m === "hardware") {
    badgeHtml = `<span class="badge badge-danger">麦克风不可用 / 未唤醒</span>`;
    meterClass = "paused";
    screenText = "当前无法收音（可切换查看 3 种前置态）";
    spokenNote = "未唤醒时静默待命；麦克风硬件关闭或系统权限被拒时，明确告知原因并给直达入口。";
    alertHtml = `
      <div class="phone-alert danger">
        <div class="phone-alert-title"><span>🔇 麦克风权限被拒</span><button class="btn btn-sm">去系统设置开启</button></div>
        <div>未获得麦克风授权，仅支持打字输入。</div>
      </div>
      <div class="phone-alert warn">
        <div class="phone-alert-title"><span>⏻ 硬件麦克风开关已拨关</span><span class="mono">HW_MUTE</span></div>
        <div>检测到外设/机身硬件禁麦，软件无法代开，请拨开物理开关。</div>
      </div>
    `;
  }

  screen.innerHTML = `
    <div class="phone-status mono">
      <span>10:42</span>
      <span>TK-01 · ${m === "hold" ? "HOLD" : m === "muted" ? "MUTED" : "LIVE DUPLEX"}</span>
    </div>
    ${arbBar}
    <div class="phone-body">
      ${alertHtml}
      ${asyncStripHtml}
      <div class="voice-stage" id="mobile-tap-stage" role="button" tabindex="0" aria-label="轻点屏幕立即打断并改听">
        <div class="voice-stage-top">
          ${badgeHtml}
          <span class="mono" style="font-size:11px;color:var(--text-muted)">字幕：常开</span>
        </div>
        <div class="caption-block">
          <p class="caption-screen">${screenText}</p>
          <div class="caption-spoken-note">${spokenNote}</div>
        </div>
        <div>
          <div class="voice-meter ${meterClass}">
            ${heights.map(h => `<span class="meter-bar" style="height:${h}px"></span>`).join("")}
          </div>
          <div class="tap-hint">点按此处随时打断并改听（即使关掉「说话打断」也可用）</div>
        </div>
      </div>
    </div>
    <div class="phone-dock">
      <button class="dock-btn ${m === "hold" ? "is-active" : ""}" id="dock-hold">
        <span class="icon">⏸</span><span>${m === "hold" ? "继续" : "暂停"}</span>
      </button>
      <button class="dock-btn ${m === "muted" ? "is-active" : ""}" id="dock-mute">
        <span class="icon">🎙</span><span>${m === "muted" ? "已静音" : "静音自己"}</span>
      </button>
      <button class="dock-btn is-interrupt" id="dock-interrupt">
        <span class="icon">✋</span><span>点按打断</span>
      </button>
      <button class="dock-btn is-end" id="dock-end">
        <span class="icon">✕</span><span>结束回稿</span>
      </button>
    </div>
  `;

  bindMobileHandlers();
}

function bindMobileHandlers() {
  const yieldBtn = document.getElementById("btn-mobile-yield");
  if (yieldBtn) yieldBtn.onclick = () => { state.mobileYielded = !state.mobileYielded; renderMobile(); };

  const stage = document.getElementById("mobile-tap-stage");
  if (stage) stage.onclick = () => {
    if (state.mobileMode !== "duplex") state.mobileMode = "duplex";
    state.mobileYielded = false;
    state.mobileInterrupted = !state.mobileInterrupted;
    renderMobile();
  };

  const holdBtn = document.getElementById("dock-hold");
  if (holdBtn) holdBtn.onclick = () => {
    state.mobileYielded = false;
    state.mobileMode = state.mobileMode === "hold" ? "duplex" : "hold";
    renderMobile();
  };

  const muteBtn = document.getElementById("dock-mute");
  if (muteBtn) muteBtn.onclick = () => {
    state.mobileYielded = false;
    state.mobileMode = state.mobileMode === "muted" ? "duplex" : "muted";
    renderMobile();
  };

  const intBtn = document.getElementById("dock-interrupt");
  if (intBtn) intBtn.onclick = () => {
    state.mobileYielded = false;
    state.mobileMode = "duplex";
    state.mobileInterrupted = true;
    renderMobile();
  };

  const endBtn = document.getElementById("dock-end");
  if (endBtn) endBtn.onclick = () => {
    state.mobileMode = "ended";
    renderMobile();
  };

  const resumeBtn = document.getElementById("btn-resume-live");
  if (resumeBtn) resumeBtn.onclick = () => {
    state.mobileMode = "duplex";
    state.mobileInterrupted = false;
    renderMobile();
  };

  const goText = document.getElementById("btn-go-text");
  if (goText) goText.onclick = () => { state.mobileMode = "ended"; renderMobile(); };

  const appBtn = document.getElementById("btn-mob-approve");
  if (appBtn) appBtn.onclick = () => { state.mobileApproved = "approved"; renderMobile(); };
  const rejBtn = document.getElementById("btn-mob-reject");
  if (rejBtn) rejBtn.onclick = () => { state.mobileApproved = "rejected"; renderMobile(); };
  const undoBtn = document.getElementById("btn-mobile-undo");
  if (undoBtn) undoBtn.onclick = () => { state.mobileApproved = "undone"; renderMobile(); };
}

/* --------------------------------------------------------------------------
   Render Surface 2: Web Conversation
   -------------------------------------------------------------------------- */
function renderWeb() {
  document.querySelectorAll("[data-web-mode]").forEach(b => {
    b.classList.toggle("active", b.dataset.webMode === state.webMode);
  });

  const mount = document.getElementById("web-frame-mount");
  const w = state.webMode;
  const isTemp = w === "temp_chat";

  // Sticky Approval Strip (always in visible area when active)
  let stickyApprovalHtml = "";
  if (w === "approval" || w === "live_cards") {
    if (state.webApproval === "pending") {
      stickyApprovalHtml = `
        <div class="approval-sticky">
          <div>
            <strong>⚠️ 等待批准（固定可见，无需滚动）：</strong>
            修改日历「项目周会」至 <code>11-26 11:00</code>
            <span class="helper-note">· 仅点按生效，口头说同意不算</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-listen" id="web-act-approve">同意执行</button>
            <button class="btn btn-sm" id="web-act-reject">拒绝（保留对话）</button>
            <button class="btn btn-sm btn-ghost" id="web-act-timeout">模拟超时</button>
          </div>
        </div>
      `;
    } else if (state.webApproval === "approved") {
      stickyApprovalHtml = `
        <div class="approval-sticky approved">
          <div><strong>✓ 已批准并完成：</strong>「项目周会」已改至 11-26 11:00。</div>
          <button class="btn btn-sm" id="web-act-reset">重置批准条</button>
        </div>
      `;
    } else if (state.webApproval === "rejected") {
      stickyApprovalHtml = `
        <div class="approval-sticky rejected">
          <div><strong>已拒绝此步骤：</strong>日历未被改动，当前语音与文字对话继续保持。</div>
          <button class="btn btn-sm" id="web-act-reset">重置批准条</button>
        </div>
      `;
    } else if (state.webApproval === "timeout") {
      stickyApprovalHtml = `
        <div class="approval-sticky rejected">
          <div><strong>⏱ 批准已超时（60s 未点按）：</strong>动作已安全取消，对话未被中断，可重新发起。</div>
          <button class="btn btn-sm" id="web-act-reset">重新发起</button>
        </div>
      `;
    }
  }

  // Timeline messages
  let streamHtml = "";

  if (w === "fallback") {
    streamHtml = `
      <div class="phone-alert danger">
        <div class="phone-alert-title"><span>🚫 浏览器已拒绝麦克风权限</span><button class="btn btn-sm">查看地址栏解锁指引</button></div>
        <div>无法启动网页语音输入，请在浏览器站点设置允许麦克风后重试；你仍可直接使用下方文字输入。</div>
      </div>
      <div class="phone-alert warn">
        <div class="phone-alert-title"><span>⏱ 今日实时语音用量已到顶</span><span class="badge badge-neutral">已自动降级为纯文字</span></div>
        <div>当前对话与上下文不受影响，已无缝切回同一条文字时间线继续。</div>
      </div>
      <div class="chat-row user">
        <div class="chat-meta"><span>我 · 文字续聊</span><span class="mono">10:48</span></div>
        <div class="chat-bubble">那你直接用文字把明天杭州降温后的穿衣和飞牛备份时间发我吧。</div>
      </div>
      <div class="chat-row">
        <div class="chat-meta"><span>助手 · 纯文字模式</span><span class="mono">10:48</span></div>
        <div class="chat-bubble">好的：明天最高 13℃ 伴有北风建议加防风外套；飞牛冷备固定在周三凌晨 03:00，今晚可正常使用。</div>
      </div>
    `;
  } else {
    streamHtml = `
      ${isTemp ? `
        <div class="phone-alert info">
          <div class="phone-alert-title">
            <span>🕶 临时聊天 · 开始前已锁定为「不使用记忆 / 指令 / 插件」</span>
            <button class="btn btn-sm">存为普通聊天</button>
          </div>
          <div>对话已开始，记忆开关已锁定不可修改；本轮不会写入记忆。点击「存为普通聊天」后，才会按账户设置参与后续个性化。</div>
        </div>
      ` : ""}

      <div class="chat-row user">
        <div class="chat-meta"><span>我 · 语音转写 + 同通内附带文字与图片</span><span class="mono">10:42</span></div>
        <div class="chat-bubble">
          帮我看下今晚杭州天气，再核对这张飞牛磁盘告警截图是不是今晚要维护。
          <div style="margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:var(--radius-sm);background:var(--bg-surface);border:1px solid var(--border-color);font-size:11.5px;">
            🖼 fnos-smart-warn.png <span class="helper-note">（通话中插入，回复仍走语音）</span>
          </div>
        </div>
      </div>

      <div class="chat-row">
        <div class="chat-meta">
          <span>助手 · 边说边出字</span>
          <span class="badge badge-listen">语音流式输出中</span>
          <span class="mono">10:42</span>
        </div>
        <div class="chat-bubble">
          今晚 20 点后杭州转小雨，气温 11 到 15 度。截图显示的是 SMART 温度提醒，不是冷备任务；你的冷备固定在周三凌晨三点，今晚不用关机。
        </div>

        <!-- Async Card arriving after first spoken sentence -->
        ${state.webCardArrived ? `
          <div class="async-card">
            <div>
              <div style="font-weight:700;font-size:13.5px;">🌧 杭州 · 今晚 20:00 转小雨（晚于第一句到达的卡片）</div>
              <div class="helper-note">11°C – 15°C · 降水概率 80% · 东北风 3 级 · 卡片异步插入不打断口播</div>
            </div>
            <button class="btn btn-sm" id="btn-toggle-card">模拟尚未返回</button>
          </div>
        ` : `
          <div class="async-card pending">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pulse-dot"></span>
              <span><strong>后台搜索尚未返回：</strong>正在拉取杭州逐小时降水卡片（语音照常继续…）</span>
            </div>
            <button class="btn btn-sm btn-primary" id="btn-toggle-card">让卡片到达</button>
          </div>
        `}

        ${!isTemp ? `
          <!-- Memory Sources Verification (not decoration) -->
          <div class="sources-box">
            <div class="sources-head">
              <strong>本轮用到的记忆与来源（核对区）</strong>
              <span class="badge badge-warn">提示：来源可能未列全 · 分享链接不含来源</span>
            </div>
            ${state.webSources.map(s => `
              <div class="source-item ${s.status}">
                <div>
                  <span class="badge ${s.status === "irrelevant" ? "badge-neutral" : "badge-info"}">${s.type}</span>
                  <span style="margin-left:6px;">${s.text}</span>
                  ${s.status === "irrelevant" ? `<span class="badge badge-warn" style="margin-left:6px;">已标不相关（未删除原条目）</span>` : ""}
                  ${s.status === "deleted" ? `<span class="badge badge-danger" style="margin-left:6px;">已删此记忆</span>` : ""}
                </div>
                <div class="source-actions">
                  <button class="btn btn-sm" data-src-open="${s.id}">打开</button>
                  <button class="btn btn-sm" data-src-irr="${s.id}">${s.status === "irrelevant" ? "撤销不相关" : "标成不相关"}</button>
                  <button class="btn btn-sm" data-src-del="${s.id}">${s.status === "deleted" ? "恢复" : "删这条记忆"}</button>
                </div>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  mount.innerHTML = `
    <div class="web-topbar">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>统一对话时间线</strong>
        <span class="badge ${isTemp ? "badge-info" : "badge-listen"}">${isTemp ? "临时聊天（锁定无记忆）" : "主会话 · Web 与手机共享"}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span class="badge badge-neutral mono">TK-05 · Chrome</span>
        <button class="btn btn-sm">分享（自动剥离来源）</button>
      </div>
    </div>
    ${stickyApprovalHtml}
    <div class="web-body">
      <div class="web-timeline-col">
        <div class="web-stream">${streamHtml}</div>
        <div class="web-composer">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-secondary);">
            <span>${w === "fallback" ? "纯文字降级模式" : "🎙 语音通话中（可同时打字或传图，回复继续走语音；无网页摄像头/Hold）"}</span>
            <span class="mono">${w === "fallback" ? "TEXT_ONLY" : "LISTENING / DUPLEX"}</span>
          </div>
          <div class="composer-row">
            <button class="btn btn-sm" title="通话中附加图片">📎 图</button>
            <input class="composer-input" placeholder="边聊边打字，或补充参数（不另开新聊天）…" />
            ${w === "fallback" ? `
              <button class="btn btn-primary">发送文字</button>
            ` : `
              <button class="btn btn-sm">静音</button>
              <button class="btn btn-sm btn-danger">退出语音</button>
            `}
          </div>
        </div>
      </div>

      <aside class="web-inspector">
        <div class="inspector-card">
          <h4>本轮运行态 <span class="badge badge-primary">实时</span></h4>
          <div class="helper-note">前台口播与后台搜索并行；卡片与批准条均挂在同一时间线，不另开独立语音页。</div>
        </div>
        <div class="inspector-card">
          <h4>记忆 vs 自定义指令</h4>
          <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
            <div><strong>自定义指令：</strong>人写的固定要求（独立设置）</div>
            <div><strong>跨对话记忆：</strong>从过往攒出的上下文（${isTemp ? "本轮已锁定禁用" : "已启用"}）</div>
          </div>
        </div>
        <div class="inspector-card">
          <h4>边界提醒</h4>
          <ul style="margin:0;padding-left:16px;color:var(--text-secondary);font-size:12px;display:flex;flex-direction:column;gap:4px;">
            <li>标「不相关」≠ 删除该记忆</li>
            <li>Web Live 不自动扫资料库文件</li>
            <li>不搬手机端 Hold / 摄像头 / 锁屏通知</li>
          </ul>
        </div>
      </aside>
    </div>
  `;

  // Bind web handlers
  const bApp = document.getElementById("web-act-approve");
  if (bApp) bApp.onclick = () => { state.webApproval = "approved"; renderWeb(); };
  const bRej = document.getElementById("web-act-reject");
  if (bRej) bRej.onclick = () => { state.webApproval = "rejected"; renderWeb(); };
  const bTo = document.getElementById("web-act-timeout");
  if (bTo) bTo.onclick = () => { state.webApproval = "timeout"; renderWeb(); };
  const bRes = document.getElementById("web-act-reset");
  if (bRes) bRes.onclick = () => { state.webApproval = "pending"; renderWeb(); };

  const bCard = document.getElementById("btn-toggle-card");
  if (bCard) bCard.onclick = () => { state.webCardArrived = !state.webCardArrived; renderWeb(); };

  document.querySelectorAll("[data-src-irr]").forEach(btn => {
    btn.onclick = () => {
      const item = state.webSources.find(x => x.id === btn.dataset.srcIrr);
      if (item) item.status = item.status === "irrelevant" ? "active" : "irrelevant";
      renderWeb();
    };
  });
  document.querySelectorAll("[data-src-del]").forEach(btn => {
    btn.onclick = () => {
      const item = state.webSources.find(x => x.id === btn.dataset.srcDel);
      if (item) item.status = item.status === "deleted" ? "active" : "deleted";
      renderWeb();
    };
  });
  document.querySelectorAll("[data-src-open]").forEach(btn => {
    btn.onclick = () => {
      alert("已定位到原始来源条目（可在私人后台「三层记忆」中查看与追溯）。");
    };
  });
}

/* --------------------------------------------------------------------------
   Render Surface 3: Private Web Admin (fnOS Internal Admin)
   -------------------------------------------------------------------------- */
function renderAdmin() {
  const banner = document.getElementById("admin-recording-banner");
  banner.classList.toggle("hidden", !state.debugRecording);

  document.querySelectorAll("[data-admin-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.adminTab === state.adminTab);
  });

  const main = document.getElementById("admin-main-mount");

  if (state.adminTab === "runs") {
    const selectedRun = RECENT_RUNS.find(r => r.id === state.selectedRunId) || RECENT_RUNS[0];
    main.innerHTML = `
      <div class="admin-top-bar">
        <div>
          <h4 style="margin:0;font-size:16px;font-family:var(--font-display);">最近几次对话（日常维护首页）</h4>
          <span class="helper-note">固定 5 列直出；点任意一行展开音频/转写/工具/记忆写入排障</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button class="btn btn-sm ${state.runsFilter === "all" ? "btn-primary" : ""}" id="btn-runs-all">全部通话 (5)</button>
          <button class="btn btn-sm ${state.runsFilter === "empty_device" ? "btn-warn" : ""}" id="btn-runs-empty">模拟「No runs / 绑错助手」</button>
          <button class="btn btn-sm ${state.debugRecording ? "btn-danger" : ""}" id="btn-toggle-rec">
            ${state.debugRecording ? "● 调试录音留存中" : "○ 开启调试录音（默认关）"}
          </button>
        </div>
      </div>

      ${state.runsFilter === "empty_device" ? `
        <div class="empty-diag-box">
          <strong style="font-size:15px;">这台设备（厨房小屏 · TK-06）没有打到这个助手</strong>
          <p class="helper-note" style="margin:6px auto 12px;max-width:540px;">
            请勿误判为「听懂了但没反应」。常见原因：设备绑定了另一个测试助手、独立签票已失效，或设备硬件麦克风被拨关。
          </p>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-primary" id="btn-jump-devices">去核对设备绑定与签票</button>
            <button class="btn btn-sm" id="btn-runs-back">返回最近通话列表</button>
          </div>
        </div>
      ` : `
        <div class="runs-table-wrap">
          <table class="runs-table">
            <thead>
              <tr>
                <th>1. 哪一台</th>
                <th>2. 何时</th>
                <th>3. 听到什么</th>
                <th>4. 理解成什么</th>
                <th>5. 做了什么或说了什么</th>
              </tr>
            </thead>
            <tbody>
              ${RECENT_RUNS.map(r => `
                <tr data-run-id="${r.id}" class="${r.id === selectedRun.id ? "selected" : ""}">
                  <td>
                    <strong>${r.device}</strong>
                    <div class="mono helper-note">${r.ticket}</div>
                  </td>
                  <td class="mono" style="white-space:nowrap;">${r.time}</td>
                  <td>${r.heard}</td>
                  <td class="mono" style="font-size:12px;">${r.intent}</td>
                  <td>
                    <div>${r.result}</div>
                    <div style="margin-top:4px;"><span class="badge ${r.tag}">${r.tagText}</span></div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>

        <div class="trace-panel">
          <div class="panel-card">
            <h4>通话排障详情 · ${selectedRun.device} (${selectedRun.time}) <span class="badge ${selectedRun.tag}">${selectedRun.tagText}</span></h4>
            <div class="pipeline-steps">
              <div class="pipe-step"><strong>① 音频与设备：</strong>${selectedRun.trace.audioDiag}</div>
              <div class="pipe-step"><strong>② 语音转写（ASR）：</strong>${selectedRun.trace.asrNote}</div>
              <div class="pipe-step"><strong>③ 工具与动作：</strong>${selectedRun.trace.toolNote}</div>
              <div class="pipe-step"><strong>④ 记忆写入：</strong>${selectedRun.trace.memoryNote}</div>
            </div>
          </div>

          <div class="panel-card">
            <h4>试一句 vs 真跑一句 <span class="badge badge-warn">外观强区分</span></h4>
            <div class="dry-vs-real-box">
              <input class="composer-input" id="admin-test-input" value="打开书房台灯并调到 40%" />
              <div class="mode-box dry">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <div>
                    <strong>试一句（仅解析 · 不执行）</strong>
                    <div class="helper-note">只看内置解析器命中什么意图，真实设备不会动。</div>
                  </div>
                  <button class="btn btn-sm btn-listen" id="btn-dry-run">试跑解析</button>
                </div>
                ${state.dryRunResult ? `<div class="mono" style="margin-top:8px;font-size:11.5px;">✓ 试跑成功（无副作用）：${state.dryRunResult}</div>` : ""}
              </div>

              <div class="mode-box real">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <div>
                    <strong>⚠️ 真跑一句（会真实执行）</strong>
                    <div class="helper-note">走完整管道并真的开关设备或调用外部工具。</div>
                  </div>
                  <button class="btn btn-sm btn-warn" id="btn-real-run">真跑执行</button>
                </div>
                ${state.realRunResult ? `<div class="mono" style="margin-top:8px;font-size:11.5px;">⚡ 真跑已改动设备：${state.realRunResult}</div>` : ""}
              </div>
            </div>
          </div>
        </div>
      `}
    `;

    document.querySelectorAll("[data-run-id]").forEach(tr => {
      tr.onclick = () => { state.selectedRunId = tr.dataset.runId; renderAdmin(); };
    });
    const bAll = document.getElementById("btn-runs-all");
    if (bAll) bAll.onclick = () => { state.runsFilter = "all"; renderAdmin(); };
    const bEmpty = document.getElementById("btn-runs-empty");
    if (bEmpty) bEmpty.onclick = () => { state.runsFilter = "empty_device"; renderAdmin(); };
    const bBack = document.getElementById("btn-runs-back");
    if (bBack) bBack.onclick = () => { state.runsFilter = "all"; renderAdmin(); };
    const bJump = document.getElementById("btn-jump-devices");
    if (bJump) bJump.onclick = () => { state.adminTab = "devices"; renderAdmin(); };
    const bRec = document.getElementById("btn-toggle-rec");
    if (bRec) bRec.onclick = () => { state.debugRecording = !state.debugRecording; renderAdmin(); };
    const bDry = document.getElementById("btn-dry-run");
    if (bDry) bDry.onclick = () => {
      const val = document.getElementById("admin-test-input").value;
      state.dryRunResult = `intent=light.set(target=study_lamp, brightness=40%) · 输入「${val}」· 设备未动作`;
      renderAdmin();
    };
    const bReal = document.getElementById("btn-real-run");
    if (bReal) bReal.onclick = () => {
      state.realRunResult = `light.set 已发送至书房台灯（亮度 0% → 40%），已记入最近通话。`;
      renderAdmin();
    };
  } else if (state.adminTab === "memory") {
    main.innerHTML = `
      <div class="admin-top-bar">
        <div>
          <h4 style="margin:0;font-size:16px;font-family:var(--font-display);">三层记忆管理（严禁合并成一张表）</h4>
          <span class="helper-note">每层独立存储、按层明示删除后果；关闭个性化不抹除安全记录。</span>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
          <label class="toggle-label">
            <input type="checkbox" id="chk-ref-saved" ${state.memRefSaved ? "checked" : ""} />
            <span>引用已保存记忆</span>
          </label>
          <label class="toggle-label">
            <input type="checkbox" id="chk-ref-hist" ${state.memRefHistory ? "checked" : ""} ${!state.memRefSaved ? "disabled" : ""} />
            <span>引用历史对话推断</span>
          </label>
        </div>
      </div>

      ${!state.memRefSaved ? `
        <div class="phone-alert warn" style="margin-bottom:14px;">
          <div class="phone-alert-title"><span>只关了引用，已保存条目与历史聊天仍在</span><span class="badge badge-warn">级联联动</span></div>
          <div>关闭「引用已保存记忆」已连带关闭「引用历史」；下方已保存条目并未被删除。若日后重新打开，仍可恢复引用。少数高风险安全记录不受个性化开关控制。</div>
        </div>
      ` : !state.memRefHistory ? `
        <div class="phone-alert info" style="margin-bottom:14px;">
          <div class="phone-alert-title"><span>已关闭引用历史（已保存记忆不受影响）</span><span class="badge badge-info">30天清理排期</span></div>
          <div>由历史对话派生的推断记忆将在 30 天内排期删除；原始聊天仍在，第 1 层已保存条目仍继续生效。</div>
        </div>
      ` : ""}

      <div class="memory-layers">
        <div class="mem-layer">
          <div class="mem-layer-head">
            <span class="badge badge-listen">第 1 层 · 人可直改</span>
            <h4 style="margin:6px 0 2px;">明确记住与可编辑摘要</h4>
            <div class="helper-note">主动要求记住的条目与高层摘要</div>
          </div>
          <div class="mem-item">
            <div><strong>飞牛 NAS 每周三 03:00 冷备</strong> <span class="badge badge-listen">已生效</span></div>
            <div class="helper-note">来源：对话 #1015 · 2026-11-18</div>
            <div style="display:flex;gap:6px;"><button class="btn btn-sm">改正</button><button class="btn btn-sm">删此条记忆</button></div>
          </div>
          <div class="mem-item">
            <div><strong>下周二 07:30 深圳出差</strong> <span class="badge badge-primary">记忆刚写入</span></div>
            <div class="helper-note">来源：对话 #1049 · 昨日 20:05</div>
            <div style="display:flex;gap:6px;"><button class="btn btn-sm">改正</button><button class="btn btn-sm">删此条记忆</button></div>
          </div>
          <div class="mem-item" style="border-color:var(--accent-warn);">
            <div><strong>客厅空调夜间 24℃ 静风</strong> <span class="badge badge-warn">记忆与源已不一致</span></div>
            <div class="helper-note">原对话 #1042 已被删除，但本条单独保存的记忆仍存在。</div>
            <div style="display:flex;gap:6px;"><button class="btn btn-sm">核对保留</button><button class="btn btn-sm btn-danger">确认删除</button></div>
          </div>
          <div class="mem-consequence">
            <strong>删除后果：</strong>删除第 1 层仅删摘要/已保存条目，<strong>不删第 3 层历史聊天</strong>；已删日志最长留存 30 天。
          </div>
        </div>

        <div class="mem-layer">
          <div class="mem-layer-head">
            <span class="badge badge-info">第 2 层 · 动态推断</span>
            <h4 style="margin:6px 0 2px;">从历史推断（会随时间变化）</h4>
            <div class="helper-note">系统跨对话综合出的隐式上下文</div>
          </div>
          <div class="mem-item">
            <div>近期关注杭州周边周末自驾路线</div>
            <div class="helper-note">置信度高 · 关联 3 次对话</div>
            <div style="display:flex;gap:6px;"><button class="btn btn-sm">标「别再提」</button></div>
          </div>
          <div class="mem-item">
            <div>习惯早晨 08:00–08:30 听简短新闻与天气</div>
            <div class="helper-note">关联 6 次晨间通话</div>
            <div style="display:flex;gap:6px;"><button class="btn btn-sm">标「别再提」</button></div>
          </div>
          <div class="mem-consequence">
            <strong>操作边界：</strong>「别再提」只减少以后再使用，<strong>不删原始来源</strong>；关闭「引用历史」后 30 天内排期清除派生层。
          </div>
        </div>

        <div class="mem-layer">
          <div class="mem-layer-head">
            <span class="badge badge-neutral">第 3 层 · 原始源</span>
            <h4 style="margin:6px 0 2px;">原始聊天、归档、文件与连接应用</h4>
            <div class="helper-note">彻底抹除一项需按存放位置逐层清理</div>
          </div>
          <div class="mem-item">
            <div><strong>普通与归档聊天（142 条）</strong></div>
            <div class="helper-note">归档不等于删除；录音剪辑随文字稿保留 30 天</div>
            <div><button class="btn btn-sm">删除聊天（已单独保存记忆仍在）</button></div>
          </div>
          <div class="mem-item">
            <div><strong>上传文件与已连接日历/邮箱</strong></div>
            <div class="helper-note">独立数据源，不受「清空摘要」影响</div>
            <div><button class="btn btn-sm">管理连接权限</button></div>
          </div>
          <div class="mem-consequence">
            <strong>重要提示：</strong>删除聊天旁必须明示「已单独保存的记忆仍在」；彻底移除需在 1、2、3 层分别处理。
          </div>
        </div>
      </div>
    `;

    document.getElementById("chk-ref-saved").onchange = (e) => {
      state.memRefSaved = e.target.checked;
      if (!state.memRefSaved) state.memRefHistory = false;
      renderAdmin();
    };
    document.getElementById("chk-ref-hist").onchange = (e) => {
      state.memRefHistory = e.target.checked;
      renderAdmin();
    };
  } else if (state.adminTab === "persona") {
    main.innerHTML = `
      <div class="admin-top-bar">
        <div>
          <h4 style="margin:0;font-size:16px;font-family:var(--font-display);">人格成长账本（可改正摘要 + 对话溯源）</h4>
          <span class="helper-note">不做不透明的「性格数值条」，也与静态自定义指令分离；每条成长都可人工改正并追到哪次对话。</span>
        </div>
        <span class="badge badge-info">非预设人格 · 可逐条回滚</span>
      </div>

      <div class="persona-grid">
        ${state.personaItems.map(p => `
          <div class="persona-card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span class="badge ${p.status === "muted" ? "badge-neutral" : p.status === "corrected" ? "badge-warn" : "badge-listen"}">
                ${p.status === "muted" ? "已暂停影响" : p.status === "corrected" ? "人工已改正" : "生效中"}
              </span>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm" data-p-edit="${p.id}">${state.personaEditingId === p.id ? "完成" : "改正"}</button>
                <button class="btn btn-sm" data-p-mute="${p.id}">${p.status === "muted" ? "恢复" : "停用"}</button>
              </div>
            </div>
            ${state.personaEditingId === p.id ? `
              <input class="composer-input" id="p-input-${p.id}" value="${p.summary}" />
            ` : `
              <div style="font-size:14px;font-weight:600;${p.status === "muted" ? "opacity:0.55;text-decoration:line-through;" : ""}">${p.summary}</div>
            `}
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${p.sources.map(src => `<span class="provenance-chip">🔗 ${src}</span>`).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    `;

    document.querySelectorAll("[data-p-edit]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.pEdit;
        if (state.personaEditingId === id) {
          const inp = document.getElementById(`p-input-${id}`);
          const item = state.personaItems.find(x => x.id === id);
          if (item && inp) {
            item.summary = inp.value;
            item.status = "corrected";
          }
          state.personaEditingId = null;
        } else {
          state.personaEditingId = id;
        }
        renderAdmin();
      };
    });

    document.querySelectorAll("[data-p-mute]").forEach(btn => {
      btn.onclick = () => {
        const item = state.personaItems.find(x => x.id === btn.dataset.pMute);
        if (item) item.status = item.status === "muted" ? "active" : "muted";
        renderAdmin();
      };
    });
  } else if (state.adminTab === "devices") {
    main.innerHTML = `
      <div class="admin-top-bar">
        <div>
          <h4 style="margin:0;font-size:16px;font-family:var(--font-display);">单主人设备签票与权限边界（3–5 台）</h4>
          <span class="helper-note">每台均为同一主人的独立签票端（非匿名卫星，无家庭声纹墙）；语音设备与管理台严格分权。</span>
        </div>
        <span class="badge badge-danger">严禁把「读日志/改配置」放进语音工具集</span>
      </div>

      <div class="device-grid">
        <div class="device-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>iPhone 16 Pro</strong><span class="badge badge-listen">在线 · 主力</span>
          </div>
          <div class="mono helper-note">签票 TK-01 · 绑定：主助手 · 今日 4 次</div>
          <div class="helper-note">权限：日常工具（天气/日历[需批准]/搜索）</div>
          <div style="display:flex;gap:6px;"><button class="btn btn-sm">轮换签票</button><button class="btn btn-sm">吊销</button></div>
        </div>

        <div class="device-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>MacBook Pro</strong><span class="badge badge-info">在线 · 今日零次通话</span>
          </div>
          <div class="mono helper-note">签票 TK-02 · 绑定：主助手 · 今日 0 次</div>
          <div class="helper-note">心跳正常，尚未被唤醒（与「未打到助手」明确区分）</div>
          <div style="display:flex;gap:6px;"><button class="btn btn-sm">轮换签票</button></div>
        </div>

        <div class="device-card" style="border-color:var(--accent-danger);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>客厅桌面音箱</strong><span class="badge badge-danger">硬件麦克风关闭</span>
          </div>
          <div class="mono helper-note">签票 TK-03 · 绑定：主助手 · HW_MUTE</div>
          <div class="helper-note">物理禁麦开关已拨关，设备在线但无法收音。</div>
          <div style="display:flex;gap:6px;"><button class="btn btn-sm">查看今日通话</button></div>
        </div>

        <div class="device-card" style="border-color:var(--accent-warn);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>床头 iPad</strong><span class="badge badge-warn">助手绑错设备</span>
          </div>
          <div class="mono helper-note">签票 TK-04 · 错绑：旧测试助手</div>
          <div class="helper-note">因此主助手显示 No runs，请一键重绑至主助手。</div>
          <div style="display:flex;gap:6px;"><button class="btn btn-sm btn-primary">一键重绑主助手</button></div>
        </div>
      </div>

      <div class="panel-card" style="margin-top:14px;">
        <h4>权限分层对照（防管理员工具拖垮语音端）</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;font-size:12.5px;">
          <div class="pipe-step">
            <span class="badge badge-listen">语音端点（3–5 台）</span>
            <p style="margin:6px 0 0;">仅持有日常只读与需批准工具：实时搜索、日历读写（需屏批）、家居控制、个人记忆引用。<strong>不含管理 API。</strong></p>
          </div>
          <div class="pipe-step">
            <span class="badge badge-warn">飞牛内部管理台（独占）</span>
            <p style="margin:6px 0 0;">独占高敏能力：原始通话排障、调试录音开关与销毁、三层记忆增删、人格成长修订、设备签票吊销、试跑/真跑。</p>
          </div>
        </div>
      </div>
    `;
  }
}

/* --------------------------------------------------------------------------
   Global Event Wiring
   -------------------------------------------------------------------------- */
function init() {
  document.querySelectorAll("[data-theme-btn]").forEach(btn => {
    btn.onclick = () => { state.theme = btn.dataset.themeBtn; renderHeaderAndBanner(); };
  });

  document.querySelectorAll("[data-view-btn]").forEach(btn => {
    btn.onclick = () => { state.view = btn.dataset.viewBtn; renderHeaderAndBanner(); };
  });

  document.querySelectorAll("[data-mobile-mode]").forEach(btn => {
    btn.onclick = () => {
      state.mobileMode = btn.dataset.mobileMode;
      state.mobileInterrupted = false;
      state.mobileYielded = false;
      state.mobileApproved = null;
      renderMobile();
    };
  });

  document.querySelectorAll("[data-web-mode]").forEach(btn => {
    btn.onclick = () => {
      state.webMode = btn.dataset.webMode;
      if (state.webMode === "approval") state.webApproval = "pending";
      renderWeb();
    };
  });

  document.querySelectorAll("[data-admin-tab]").forEach(btn => {
    btn.onclick = () => {
      state.adminTab = btn.dataset.adminTab;
      renderAdmin();
    };
  });

  document.getElementById("btn-kill-recording").onclick = () => {
    state.debugRecording = false;
    alert("已关闭调试录音并彻底删除本地留存的调试音频文件。");
    renderAdmin();
  };

  renderHeaderAndBanner();
  renderMobile();
  renderWeb();
  renderAdmin();
}

document.addEventListener("DOMContentLoaded", init);
