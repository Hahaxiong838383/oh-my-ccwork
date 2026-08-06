frappe.pages["aishike-quality-console"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("质量与入库工作台"),
    single_column: true,
  });
  wrapper.quality_console = new AishikeQualityConsole(page, wrapper);
};

frappe.pages["aishike-quality-console"].on_page_show = function (wrapper) {
  wrapper.quality_console.show();
};

class AishikeQualityConsole {
  constructor(page, wrapper) {
    this.page = page;
    this.wrapper = $(wrapper);
    this.state = { data: null };
    this.make();
  }

  make() {
    this.wrapper.addClass("aishike-quality-page");
    this.page.main.html(`
      <div class="quality-shell">
        <section class="quality-hero">
          <div class="quality-hero-copy">
            <p class="quality-eyebrow">M2.3 · 质量与仓储控制塔</p>
            <h1>质量放行、成品入库与设备追溯</h1>
            <p>以唯一 SN 串联生产、质量和库存凭证。每次判定与移动独立留痕，禁止覆盖历史。</p>
          </div>
          <div class="quality-hero-actions">
            <button class="btn btn-default quality-open-production">生产测试</button>
            <button class="btn btn-default quality-open-release-list">质量记录</button>
            <button class="btn btn-default quality-open-stock-list">库存记录</button>
          </div>
        </section>

        <section class="quality-scan-bar">
          <div class="quality-scan-icon">${frappe.utils.icon("scan-barcode", "md")}</div>
          <input class="quality-scan-input" autocomplete="off" placeholder="扫描设备条形码、二维码或输入 SN 后回车">
          <button class="btn btn-primary quality-lookup">识别设备</button>
          <button class="btn btn-default quality-camera">打开摄像头</button>
        </section>

        <section class="quality-empty">
          <div class="quality-empty-mark">03</div>
          <h2>等待设备扫码</h2>
          <p>支持 HID 扫码枪、设备二维码、摄像头扫码与手工输入 SN。</p>
        </section>

        <div class="quality-content" hidden>
          <section class="quality-device-header"></section>
          <section class="quality-flow"></section>
          <section class="quality-overview"></section>
          <div class="quality-action-grid">
            <section class="quality-panel quality-release-panel"></section>
            <section class="quality-panel quality-stock-panel"></section>
          </div>
          <section class="quality-panel quality-trace-panel"></section>
        </div>
      </div>
    `);
    this.bind_events();
  }

  bind_events() {
    this.wrapper.on("keydown", ".quality-scan-input", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.lookup();
      }
    });
    this.wrapper.on("click", ".quality-lookup", () => this.lookup());
    this.wrapper.on("click", ".quality-camera", () => this.open_camera());
    this.wrapper.on("click", ".quality-refresh", () => this.refresh_device());
    this.wrapper.on("click", ".quality-open-device", () => this.open_device());
    this.wrapper.on("click", ".quality-open-production", () => this.open_production());
    this.wrapper.on("click", ".quality-open-release-list", () => this.open_filtered_list("Aishike Quality Release Record"));
    this.wrapper.on("click", ".quality-open-stock-list", () => this.open_filtered_list("Aishike Device Stock Movement"));
    this.wrapper.on("click", ".quality-release-pass", () => this.open_quality_dialog("PASS"));
    this.wrapper.on("click", ".quality-release-reject", () => this.open_quality_dialog("REJECT"));
    this.wrapper.on("click", ".quality-stock-receive", () => this.open_stock_dialog("RECEIVE"));
    this.wrapper.on("click", ".quality-stock-transfer", () => this.open_stock_dialog("TRANSFER"));
  }

  async show() {
    const routeOptions = frappe.route_options;
    frappe.route_options = null;
    if (routeOptions && routeOptions.scan_value) {
      this.wrapper.find(".quality-scan-input").val(routeOptions.scan_value);
      await this.lookup(routeOptions.scan_value);
      return;
    }
    this.focus_scanner(false);
  }

  async lookup(scanValue = null) {
    const value = scanValue || this.wrapper.find(".quality-scan-input").val().trim();
    if (!value) {
      this.focus_scanner();
      return;
    }
    const response = await frappe.call({
      method: "aishike_erp.quality.get_quality_console",
      args: { scan_value: value },
      freeze: true,
      freeze_message: __("正在汇总设备全链路记录"),
    });
    this.apply_response(response.message);
  }

  async refresh_device() {
    if (this.current_serial()) {
      await this.lookup(this.current_serial());
    }
  }

  apply_response(data) {
    this.state.data = data;
    this.wrapper.find(".quality-scan-input").val(data.device.serial_no);
    this.wrapper.find(".quality-empty").attr("hidden", true);
    this.wrapper.find(".quality-content").removeAttr("hidden");
    this.render_device_header();
    this.render_flow();
    this.render_overview();
    this.render_quality_panel();
    this.render_stock_panel();
    this.render_trace_panel();
  }

  render_device_header() {
    const { device, sku } = this.state.data;
    this.wrapper.find(".quality-device-header").html(`
      <div>
        <span class="quality-state-badge">${this.escape(__(device.lifecycle_state))}</span>
        <h2>${this.escape(device.serial_no)}</h2>
        <p>${this.escape(device.sku_configuration)} · ${this.escape(sku?.color ? __(sku.color) : "-")} · ${this.escape(sku?.hardware_configuration ? __(sku.hardware_configuration) : "-")}</p>
      </div>
      <div class="quality-device-actions">
        <button class="btn btn-default quality-refresh">刷新</button>
        <button class="btn btn-default quality-open-production">生产测试</button>
        <button class="btn btn-primary quality-open-device">设备档案</button>
      </div>
    `);
  }

  render_flow() {
    const { device, test_summary: testSummary } = this.state.data;
    const rank = {
      CREATED: 0,
      ASSEMBLED: 1,
      FLASHED: 2,
      QC_PASSED: 3,
      STOCKED: 4,
      ALLOCATED: 5,
      SHIPPED: 6,
      ACTIVATED: 7,
    }[device.lifecycle_state] ?? 0;
    const steps = [
      ["01", "组装", rank >= 1, device.work_order || "生产工单待关联"],
      ["02", "烧录与测试", rank >= 2 && testSummary.complete, `${testSummary.passed}/6 项通过`],
      ["03", "质量放行", rank >= 3, device.quality_release_record || "等待质量判定"],
      ["04", "成品入库", rank >= 4, device.current_warehouse || "等待选择仓库"],
      ["05", "销售履约", rank >= 5, device.channel_order_id || "尚未分配订单"],
    ];
    this.wrapper.find(".quality-flow").html(
      steps.map(([number, label, complete, detail]) => `
        <article class="quality-flow-step ${complete ? "is-complete" : ""}">
          <span>${number}</span>
          <div><strong>${label}</strong><small>${this.escape(detail)}</small></div>
        </article>
      `).join(""),
    );
  }

  render_overview() {
    const { device, flash_records: flashRecords, test_summary: testSummary, quality_records: qualityRecords, stock_movements: stockMovements } = this.state.data;
    const items = [
      { label: "六项测试", value: String(testSummary.passed), suffix: "/6", className: testSummary.complete ? "is-good" : "" },
      { label: "烧录尝试", value: String(flashRecords.length), className: "" },
      { label: "质量判定", value: String(qualityRecords.length), className: "" },
      { label: "库存移动", value: String(stockMovements.length), className: "" },
      { label: "当前仓库", value: device.current_warehouse || "未入库", className: device.current_warehouse ? "is-good is-text" : "is-text" },
    ];
    this.wrapper.find(".quality-overview").html(
      items.map((item) => `
        <div>
          <span>${this.escape(item.label)}</span>
          <strong class="${item.className}">${this.escape(item.value)}${item.suffix ? `<small>${this.escape(item.suffix)}</small>` : ""}</strong>
        </div>
      `).join(""),
    );
  }

  render_quality_panel() {
    const { permissions, test_summary: testSummary, quality_records: qualityRecords } = this.state.data;
    const latest = qualityRecords[0];
    const latestText = latest
      ? `${latest.decision === "PASS" ? "通过" : "驳回"} · 第 ${latest.attempt_no} 次 · ${this.format_datetime(latest.released_at)}`
      : "尚无质量判定记录";
    const permissionNote = permissions.can_create_quality_record
      ? "每次判定生成独立凭证。驳回不改变设备状态，复核必须新增记录。"
      : "当前账号可查看完整追溯；质量判定操作需要“质量经理”角色。";
    this.wrapper.find(".quality-release-panel").html(`
      <div class="quality-panel-heading">
        <div><span>01</span><h3>出厂质量门</h3></div>
        <em>${testSummary.complete ? "六项最新结果已全部通过" : `仍有 ${testSummary.pending + testSummary.failed} 项未满足`}</em>
      </div>
      <div class="quality-status-block ${testSummary.complete ? "is-ready" : ""}">
        <div class="quality-status-orb">${testSummary.complete ? "✓" : "!"}</div>
        <div><strong>${testSummary.complete ? "已具备质量判定条件" : "质量门仍被测试结果锁定"}</strong><p>${this.escape(latestText)}</p></div>
      </div>
      <div class="quality-action-row">
        <button class="btn btn-primary quality-release-pass" ${permissions.can_release ? "" : "disabled"}>质量放行</button>
        <button class="btn btn-default quality-release-reject" ${permissions.can_release ? "" : "disabled"}>驳回整改</button>
      </div>
      <p class="quality-panel-note">${permissionNote}</p>
    `);
  }

  render_stock_panel() {
    const { device, permissions, stock_movements: stockMovements } = this.state.data;
    const latest = stockMovements[0];
    const latestText = latest
      ? `${__(latest.movement_type)} · ${latest.from_warehouse || "生产线"} → ${latest.to_warehouse}`
      : "尚无成品入库或仓库调拨记录";
    const permissionNote = permissions.can_create_stock_movement
      ? "目标仓库必须为末级仓库；调拨来源由系统读取当前仓库，不能手工绕过。"
      : "当前账号可查看完整追溯；入库和调拨操作需要“库存经理”角色。";
    this.wrapper.find(".quality-stock-panel").html(`
      <div class="quality-panel-heading">
        <div><span>02</span><h3>成品库存</h3></div>
        <em>${this.escape(device.current_warehouse || "未入库")}</em>
      </div>
      <div class="quality-stock-route">
        <div><span>当前位置</span><strong>${this.escape(device.current_warehouse || "生产待入库区")}</strong></div>
        <div class="quality-route-line"></div>
        <div><span>最近动作</span><strong>${this.escape(latestText)}</strong></div>
      </div>
      <div class="quality-action-row">
        <button class="btn btn-primary quality-stock-receive" ${permissions.can_receive ? "" : "disabled"}>成品入库</button>
        <button class="btn btn-default quality-stock-transfer" ${permissions.can_transfer ? "" : "disabled"}>仓库调拨</button>
      </div>
      <p class="quality-panel-note">${permissionNote}</p>
    `);
  }

  render_trace_panel() {
    const { device, generation_batch: generationBatch, flash_records: flashRecords, tests, quality_records: qualityRecords, stock_movements: stockMovements, lifecycle_events: lifecycleEvents } = this.state.data;
    const testRows = tests.map((test) => {
      const latest = test.latest;
      return this.trace_row(
        test.label,
        latest ? __(latest.result) : "待测试",
        latest ? `${this.format_datetime(latest.tested_at)} · 第 ${test.attempts} 次` : "暂无记录",
        latest?.result === "PASS" ? "good" : latest?.result === "FAIL" ? "bad" : "muted",
      );
    }).join("");
    const qualityRows = qualityRecords.length
      ? qualityRecords.map((record) => this.trace_row(
          `质量判定 #${record.attempt_no}`,
          record.decision === "PASS" ? "通过" : "驳回",
          `${this.format_datetime(record.released_at)} · ${record.checklist_version}${record.failure_reason ? ` · ${record.failure_reason}` : ""}`,
          record.decision === "PASS" ? "good" : "bad",
        )).join("")
      : this.trace_empty("暂无质量判定记录");
    const stockRows = stockMovements.length
      ? stockMovements.map((record) => this.trace_row(
          `库存移动 #${record.movement_no}`,
          __(record.movement_type),
          `${this.format_datetime(record.movement_at)} · ${record.from_warehouse || "生产线"} → ${record.to_warehouse}`,
          "blue",
        )).join("")
      : this.trace_empty("暂无库存移动记录");
    const eventRows = lifecycleEvents.length
      ? lifecycleEvents.map((event) => `
          <div class="quality-timeline-item">
            <span class="quality-timeline-dot"></span>
            <div><strong>${this.escape(__(event.event_type))}</strong><p>${this.escape(event.source_system)} · ${this.escape(event.source_record_id || "系统记录")}</p></div>
            <time>${this.format_datetime(event.occurred_at)}</time>
          </div>
        `).join("")
      : this.trace_empty("暂无生命周期事件");
    this.wrapper.find(".quality-trace-panel").html(`
      <div class="quality-panel-heading quality-trace-heading">
        <div><span>03</span><h3>设备全链路追溯</h3></div>
        <em>${lifecycleEvents.length} 条生命周期事件</em>
      </div>
      <div class="quality-master-data">
        ${this.master_item("SKU", device.sku_configuration)}
        ${this.master_item("BOM", device.bom || "未关联")}
        ${this.master_item("生产工单", device.work_order || "未关联")}
        ${this.master_item("生产批次", device.production_batch || "未填写")}
        ${this.master_item("SN 批次", generationBatch?.name || "未关联")}
        ${this.master_item("固件 / Agent", `${device.firmware_version || "-"} / ${device.agent_version || "-"}`)}
      </div>
      <div class="quality-trace-grid">
        <div class="quality-trace-column">
          <div class="quality-trace-title"><h4>制造与测试</h4><span>${flashRecords.length} 次烧录 · 6 类测试</span></div>
          ${this.trace_row("固件烧录", flashRecords[0] ? __(flashRecords[0].result) : "无记录", flashRecords[0] ? `${this.format_datetime(flashRecords[0].flashed_at)} · 共 ${flashRecords.length} 次` : "暂无记录", flashRecords[0]?.result === "PASS" ? "good" : "muted")}
          ${testRows}
        </div>
        <div class="quality-trace-column">
          <div class="quality-trace-title"><h4>质量与库存凭证</h4><span>记录不可修改</span></div>
          ${qualityRows}
          ${stockRows}
        </div>
      </div>
      <div class="quality-timeline">
        <div class="quality-trace-title"><h4>生命周期时间线</h4><span>最近事件在前</span></div>
        ${eventRows}
      </div>
    `);
  }

  open_quality_dialog(decision) {
    const { device, default_quality_checklist: defaultChecklist } = this.state.data;
    const dialog = new frappe.ui.Dialog({
      title: decision === "PASS" ? "确认质量放行" : "驳回并要求整改",
      fields: [
        { fieldname: "checklist_version", fieldtype: "Data", label: "放行清单版本", reqd: 1, default: defaultChecklist },
        { fieldname: "workstation", fieldtype: "Link", options: "Workstation", label: "质量工位" },
        { fieldname: "release_summary", fieldtype: "Small Text", label: "放行摘要", default: decision === "PASS" ? "六项测试复核通过，外观、包装与标识符合放行要求。" : "" },
        { fieldname: "failure_reason", fieldtype: "Small Text", label: "驳回原因", reqd: decision === "REJECT" },
      ],
      primary_action_label: decision === "PASS" ? "生成放行凭证" : "记录驳回",
      primary_action: async (values) => {
        const response = await frappe.call({
          method: "aishike_erp.quality.record_quality_release",
          type: "POST",
          args: { scan_value: device.serial_no, decision, ...values },
          freeze: true,
          freeze_message: __("正在保存质量判定"),
        });
        dialog.hide();
        this.apply_response(response.message);
        frappe.show_alert({ message: decision === "PASS" ? "质量放行完成，可执行成品入库" : "质量驳回已留痕", indicator: decision === "PASS" ? "green" : "orange" });
      },
    });
    dialog.show();
  }

  open_stock_dialog(movementType) {
    const { device, warehouses } = this.state.data;
    const dialog = new frappe.ui.Dialog({
      title: movementType === "RECEIVE" ? "成品入库" : "仓库调拨",
      fields: [
        { fieldname: "current_warehouse_display", fieldtype: "Data", label: "来源位置", read_only: 1, default: movementType === "TRANSFER" ? device.current_warehouse : "生产待入库区" },
        { fieldname: "to_warehouse", fieldtype: "Link", options: "Warehouse", label: "目标仓库", reqd: 1, default: movementType === "RECEIVE" && warehouses.length === 1 ? warehouses[0].name : "" },
        { fieldname: "erp_stock_entry", fieldtype: "Link", options: "Stock Entry", label: "ERP 库存凭证（可选）" },
        { fieldname: "reference_type", fieldtype: "Data", label: "外部凭证类型", default: movementType === "RECEIVE" ? "成品入库单" : "仓库调拨单" },
        { fieldname: "reference_id", fieldtype: "Data", label: "外部凭证编号" },
        { fieldname: "remarks", fieldtype: "Small Text", label: "备注" },
      ],
      primary_action_label: movementType === "RECEIVE" ? "确认入库" : "确认调拨",
      primary_action: async (values) => {
        delete values.current_warehouse_display;
        const response = await frappe.call({
          method: "aishike_erp.quality.record_stock_movement",
          type: "POST",
          args: { scan_value: device.serial_no, movement_type: movementType, ...values },
          freeze: true,
          freeze_message: __("正在保存库存移动"),
        });
        dialog.hide();
        this.apply_response(response.message);
        frappe.show_alert({ message: movementType === "RECEIVE" ? "设备已进入成品库存" : "仓库调拨完成", indicator: "green" });
      },
    });
    dialog.show();
  }

  open_camera() {
    new frappe.ui.Scanner({
      dialog: true,
      multiple: false,
      on_scan: (data) => {
        const value = data && data.result && data.result.text;
        if (value) {
          this.wrapper.find(".quality-scan-input").val(value);
          this.lookup(value);
        }
      },
    });
  }

  open_device() {
    if (this.current_serial()) {
      frappe.set_route("Form", "Aishike Device Unit", this.current_serial());
    }
  }

  open_production() {
    if (this.current_serial()) {
      frappe.route_options = { scan_value: this.current_serial() };
    }
    frappe.set_route("aishike-production-console");
  }

  open_filtered_list(doctype) {
    frappe.route_options = this.current_serial() ? { device_unit: this.current_serial() } : null;
    frappe.set_route("List", doctype);
  }

  trace_row(label, value, detail, tone) {
    return `<div class="quality-trace-row"><div><strong>${this.escape(label)}</strong><p>${this.escape(detail)}</p></div><span class="is-${tone}">${this.escape(value)}</span></div>`;
  }

  trace_empty(text) {
    return `<div class="quality-trace-empty">${this.escape(text)}</div>`;
  }

  master_item(label, value) {
    return `<div><span>${this.escape(label)}</span><strong>${this.escape(value)}</strong></div>`;
  }

  current_serial() {
    return this.state.data && this.state.data.device.serial_no;
  }

  focus_scanner(select = true) {
    const input = this.wrapper.find(".quality-scan-input");
    input.trigger("focus");
    if (select) {
      input.trigger("select");
    }
  }

  format_datetime(value) {
    return value ? frappe.datetime.str_to_user(value) : "-";
  }

  escape(value) {
    return frappe.utils.escape_html(String(value == null ? "" : value));
  }
}
