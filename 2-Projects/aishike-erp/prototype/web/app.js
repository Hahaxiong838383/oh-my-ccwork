const actionCopy = {
  create_sku: ["生成受控SKU", "销售属性必须命中工程批准组合。"],
  release_work_order: ["释放生产工单", "根据SKU默认BOM创建一台演示工单。"],
  create_device: ["生成设备SN", "建立设备数字身份并绑定工单和BOM。"],
  assemble: ["完成组装", "记录设备从待生产进入组装完成。"],
  flash: ["烧录固件与Agent", "写入FW-1.0.0和小可Agent 3.2。"],
  run_tests: ["执行强制测试", "可正常通过，也可注入一次光学测试失败。"],
  stock: ["质检放行并入库", "只有所有测试最新结果通过时才能入库。"],
  create_order: ["创建渠道订单", "选择天猫、京东或经销商并映射内部SKU。"],
  allocate: ["分配设备SN", "只有库存设备且SKU一致才能分配。"],
  ship: ["扫码复核并发货", "发货后SN与物流单永久关联。"],
  activate: ["家长配网激活", "未发货设备不能进入激活状态。"],
  open_rma: ["创建售后RMA", "将激活设备冻结并进入公司自营维修流程。"],
};

const testNames = {
  OPTICAL: "光学校准",
  SENSOR: "传感器",
  FUNCTION: "整机功能",
  AI: "小可AI",
  AGING: "老化稳定",
  OQC: "出厂检验",
};

const deviceStateNames = {
  CREATED: "待组装",
  ASSEMBLED: "组装完成",
  FLASHED: "待质量放行",
  QC_PASSED: "质量通过",
  STOCKED: "成品在库",
  ALLOCATED: "订单已分配",
  SHIPPED: "已发货",
  ACTIVATED: "已激活",
  RMA_OPEN: "售后处理中",
  REPAIRING: "维修中",
  RETURNED: "已返还",
  REFURBISHED: "已翻新",
  SCRAPPED: "已报废",
};

const eventNames = {
  DEVICE_CREATED: "设备SN创建",
  ASSEMBLED: "组装完成",
  FLASHED: "固件与Agent烧录",
  TEST_PASS: "测试通过",
  TEST_FAIL: "测试失败",
  QC_PASSED: "质量放行",
  STOCKED: "成品入库",
  ALLOCATED: "订单分配",
  SHIPPED: "物流发货",
  ACTIVATED: "设备激活",
  RMA_OPEN: "售后RMA创建",
};

let currentState = null;
let toastTimer = null;

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "操作失败");
  }
  return payload;
}

async function loadState() {
  currentState = await request("/api/state");
  render(currentState);
}

async function perform(action, payload = {}) {
  try {
    currentState = await request(`/api/actions/${action}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    render(currentState);
    showToast(action === "reset" ? "演示数据已重置。" : "操作已完成，业务状态已更新。", false);
  } catch (error) {
    showToast(error.message, true);
    await loadState();
  }
}

function render(state) {
  renderMetrics(state.summary);
  renderPipeline(state.pipeline);
  renderActionConsole(state.actions);
  renderSku(state.product);
  renderDossier(state.trace);
  renderTests(state.trace);
  renderEvents(state.trace);
}

function renderMetrics(summary) {
  const metrics = [
    ["SKU", summary.sku_count],
    ["工单", summary.work_order_count],
    ["设备", summary.device_count],
    ["通过测试", summary.passed_test_count],
    ["渠道订单", summary.order_count],
    ["售后RMA", summary.rma_count],
  ];
  document.querySelector("#metrics").innerHTML = metrics
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderPipeline(pipeline) {
  const complete = pipeline.filter((step) => step.complete).length;
  document.querySelector("#progress-label").textContent = `${complete} / ${pipeline.length}`;
  document.querySelector("#status-progress-bar").style.width = `${(complete / pipeline.length) * 100}%`;
  const activeIndex = pipeline.findIndex((step) => !step.complete);
  document.querySelector("#pipeline").innerHTML = pipeline
    .map(
      (step, index) => `
        <div class="pipeline-step ${step.complete ? "complete" : index === activeIndex ? "active" : ""}" data-index="${String(index + 1).padStart(2, "0")}">
          <span>${step.name}</span>
        </div>`,
    )
    .join("");
}

function renderActionConsole(actions) {
  const title = document.querySelector("#next-action-title");
  const help = document.querySelector("#next-action-help");
  const buttons = document.querySelector("#action-buttons");
  buttons.innerHTML = "";
  if (!actions.length) {
    title.textContent = "本轮闭环完成";
    help.textContent = "可以查看完整履历，或重置后体验异常路径。";
    return;
  }
  const action = actions[0];
  const copy = actionCopy[action];
  title.textContent = copy[0];
  help.textContent = copy[1];

  if (action === "create_sku") {
    buttons.innerHTML = `<span class="console-label">使用上方配置表单</span>`;
    return;
  }
  if (action === "run_tests") {
    buttons.append(
      actionButton("全部测试通过", "button-primary", () => perform("run_tests")),
      actionButton("注入光学失败", "button-warning", () =>
        perform("run_tests", { fail_optical: true }),
      ),
    );
    return;
  }
  if (action === "create_order") {
    ["TMALL", "JD", "DEALER"].forEach((channel) => {
      buttons.append(
        actionButton(channelLabel(channel), "button-primary", () =>
          perform("create_order", { channel }),
        ),
      );
    });
    return;
  }
  buttons.append(actionButton(copy[0], "button-primary", () => perform(action)));
}

function actionButton(label, className, handler) {
  const button = document.createElement("button");
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderSku(product) {
  const result = document.querySelector("#sku-result strong");
  result.textContent = product.sku || "尚未创建";
  document.querySelectorAll("#sku-form select, #sku-form button").forEach((element) => {
    element.disabled = Boolean(product.sku);
  });
}

function renderDossier(trace) {
  const device = trace?.device;
  const order = trace?.orders?.[0];
  const stateLabel = device ? deviceStateNames[device.state] || device.state : "等待创建";
  document.querySelector("#hero-device-state").textContent = stateLabel;
  document.querySelector("#hero-serial").textContent = device?.serial_no || "SN 尚未生成";
  document.querySelector("#dossier-serial").textContent = device?.serial_no || "—";
  document.querySelector("#dossier-state").textContent = stateLabel;

  const details = [
    ["SKU", device?.sku_code || "—"],
    ["BOM", device?.bom_revision || "—"],
    ["工单", device?.work_order_id || "—"],
    ["固件", device?.firmware_version || "—"],
    ["Agent", device?.agent_version || "—"],
    ["渠道", order ? channelLabel(order.channel) : "—"],
  ];
  document.querySelector("#dossier-details").innerHTML = details
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join("");
}

function renderTests(trace) {
  const latest = {};
  (trace?.device?.tests || []).forEach((test) => {
    latest[test.test_type] = test.passed;
  });
  const passedCount = Object.values(latest).filter((result) => result === true).length;
  document.querySelector("#quality-count").textContent = `${passedCount} / ${Object.keys(testNames).length}`;
  document.querySelector("#test-list").innerHTML = Object.entries(testNames)
    .map(([code, name]) => {
      const result = latest[code];
      const statusClass = result === true ? "pass" : result === false ? "fail" : "";
      const statusText = result === true ? "PASS" : result === false ? "FAIL" : "WAIT";
      return `<div class="test-item ${statusClass}"><i class="test-dot"></i><span>${name}</span><strong>${statusText}</strong></div>`;
    })
    .join("");
}

function renderEvents(trace) {
  const events = [...(trace?.device?.lifecycle_events || [])].reverse();
  document.querySelector("#event-count").textContent = `${events.length} 条`;
  document.querySelector("#event-ledger").innerHTML = events.length
    ? events
        .map(
          (event) => `
          <div class="event-row">
            <strong>${eventNames[event.event_type] || event.event_type}</strong>
            <span>${event.source_system} / ${event.source_record_id}</span>
            <time>${formatTime(event.occurred_at)}</time>
          </div>`,
        )
        .join("")
    : `<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h14V5H5Zm3 3h8v2H8V8Zm0 4h8v2H8v-2Z" /></svg><strong>尚无设备事件</strong><span>生成设备SN后，完整事件记录将在这里展示。</span></div>`;
}

function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function channelLabel(channel) {
  return { TMALL: "天猫", JD: "京东", DEALER: "线下经销" }[channel] || channel;
}

function showToast(message, isError) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

document.querySelector("#sku-form").addEventListener("submit", (event) => {
  event.preventDefault();
  perform("create_sku", {
    color: document.querySelector("#color-select").value,
    hardware: document.querySelector("#hardware-select").value,
    region: document.querySelector("#region-select").value,
  });
});

document.querySelector("#reset-button").addEventListener("click", () => perform("reset"));

loadState().catch((error) => showToast(error.message, true));
