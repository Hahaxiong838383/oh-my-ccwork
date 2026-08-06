frappe.pages["aishike-production-console"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("生产测试工作台"),
    single_column: true,
  });
  wrapper.production_console = new AishikeProductionConsole(page, wrapper);
};

frappe.pages["aishike-production-console"].on_page_show = function (wrapper) {
  wrapper.production_console.show();
};

class AishikeProductionConsole {
  constructor(page, wrapper) {
    this.page = page;
    this.wrapper = $(wrapper);
    this.state = { data: null };
    this.make();
  }

  make() {
    this.wrapper.addClass("aishike-production-page");
    this.page.main.html(`
      <div class="production-shell">
        <section class="production-hero">
          <div>
            <p class="production-eyebrow">M2.2 · 制造执行中心</p>
            <h1>烧录与出厂测试</h1>
            <p>以设备 SN 为主线，记录每次烧录、失败重试和六项测试，历史结果永久保留。</p>
          </div>
          <div class="production-hero-actions">
            <button class="btn btn-default production-open-flash-list">烧录历史</button>
            <button class="btn btn-default production-open-test-list">测试记录</button>
          </div>
        </section>

        <section class="production-scan-bar">
          <div class="production-scan-icon">${frappe.utils.icon("scan-barcode", "md")}</div>
          <input class="production-scan-input" autocomplete="off" placeholder="扫描设备条形码、二维码或输入 SN 后回车">
          <button class="btn btn-primary production-lookup">识别设备</button>
          <button class="btn btn-default production-camera">打开摄像头</button>
        </section>

        <section class="production-empty">
          <div class="production-empty-mark">02</div>
          <h2>等待设备扫码</h2>
          <p>USB 或蓝牙扫码枪使用 HID 键盘模式，并配置扫描后自动回车。</p>
        </section>

        <div class="production-content" hidden>
          <section class="production-device-header"></section>
          <section class="production-flow"></section>
          <section class="production-metrics"></section>

          <div class="production-grid">
            <section class="production-panel production-flash-panel"></section>
            <section class="production-panel production-test-panel"></section>
          </div>
        </div>
      </div>
    `);
    this.bind_events();
  }

  bind_events() {
    this.wrapper.on("keydown", ".production-scan-input", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.lookup();
      }
    });
    this.wrapper.on("click", ".production-lookup", () => this.lookup());
    this.wrapper.on("click", ".production-camera", () => this.open_camera());
    this.wrapper.on("click", ".production-open-device", () => this.open_device());
    this.wrapper.on("click", ".production-open-sn", () => frappe.set_route("aishike-sn-console"));
    this.wrapper.on("click", ".production-refresh", () => this.refresh_device());
    this.wrapper.on("click", ".production-flash-pass", () => this.open_flash_dialog("PASS"));
    this.wrapper.on("click", ".production-flash-fail", () => this.open_flash_dialog("FAIL"));
    this.wrapper.on("click", ".production-test-action", (event) => {
      const button = $(event.currentTarget);
      this.open_test_dialog(button.data("test"), button.data("result"));
    });
    this.wrapper.on("click", ".production-open-flash-list", () => {
      frappe.route_options = this.current_serial() ? { device_unit: this.current_serial() } : null;
      frappe.set_route("List", "Aishike Firmware Flash Record");
    });
    this.wrapper.on("click", ".production-open-test-list", () => {
      frappe.route_options = this.current_serial() ? { device_unit: this.current_serial() } : null;
      frappe.set_route("List", "Aishike Device Test Record");
    });
  }

  async show() {
    const routeOptions = frappe.route_options;
    frappe.route_options = null;
    if (routeOptions && routeOptions.scan_value) {
      this.wrapper.find(".production-scan-input").val(routeOptions.scan_value);
      await this.lookup(routeOptions.scan_value);
      return;
    }
    this.focus_scanner(false);
  }

  async lookup(scanValue = null) {
    const value = scanValue || this.wrapper.find(".production-scan-input").val().trim();
    if (!value) {
      this.focus_scanner();
      return;
    }
    const response = await frappe.call({
      method: "aishike_erp.production.get_production_console",
      args: { scan_value: value },
      freeze: true,
      freeze_message: __("正在读取生产记录"),
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
    this.wrapper.find(".production-scan-input").val(data.device.serial_no);
    this.wrapper.find(".production-empty").attr("hidden", true);
    this.wrapper.find(".production-content").removeAttr("hidden");
    this.render_device_header();
    this.render_flow();
    this.render_metrics();
    this.render_flash_panel();
    this.render_test_panel();
    this.focus_scanner();
  }

  render_device_header() {
    const { device } = this.state.data;
    this.wrapper.find(".production-device-header").html(`
      <div>
        <span class="production-state-badge">${this.escape(__(device.lifecycle_state))}</span>
        <h2>${this.escape(device.serial_no)}</h2>
        <p>${this.escape(device.sku_configuration)} · ${this.escape(device.production_batch || "未填写生产批次")}</p>
      </div>
      <div class="production-device-actions">
        <button class="btn btn-default production-refresh">刷新</button>
        <button class="btn btn-default production-open-device">打开设备档案</button>
      </div>
    `);
  }

  render_flow() {
    const { device, summary } = this.state.data;
    const assembled = device.lifecycle_state !== "CREATED";
    const flashed = ["FLASHED", "QC_PASSED", "STOCKED", "ALLOCATED", "SHIPPED", "ACTIVATED"].includes(
      device.lifecycle_state,
    );
    const steps = [
      ["01", "组装", assembled, "设备结构与部件装配"],
      ["02", "烧录", flashed, "固件与 AI Agent 写入"],
      ["03", "六项测试", summary.complete, `${summary.passed}/6 项通过`],
      ["04", "质量门", false, "M2.3 解锁"],
    ];
    this.wrapper
      .find(".production-flow")
      .html(
        steps
          .map(
            ([number, title, complete, note], index) => `
              <div class="production-flow-step ${complete ? "is-complete" : ""} ${index === 3 ? "is-locked" : ""}">
                <span>${number}</span><div><strong>${title}</strong><small>${note}</small></div>
              </div>`,
          )
          .join(""),
      );
  }

  render_metrics() {
    const { summary, flash_count: flashCount } = this.state.data;
    this.wrapper.find(".production-metrics").html(`
      <div><span>烧录次数</span><strong>${flashCount}</strong></div>
      <div><span>测试通过</span><strong>${summary.passed}<small>/6</small></strong></div>
      <div><span>待测项目</span><strong>${summary.pending}</strong></div>
      <div><span>当前失败</span><strong class="${summary.failed ? "is-danger" : ""}">${summary.failed}</strong></div>
    `);
  }

  render_flash_panel() {
    const { device, latest_flash: latestFlash, flash_records: flashRecords } = this.state.data;
    const canFlash = ["ASSEMBLED", "FLASHED"].includes(device.lifecycle_state);
    const history = flashRecords.length
      ? flashRecords
          .slice(0, 4)
          .map(
            (record) => `
              <div class="production-history-row">
                <span class="production-result-dot ${record.result === "PASS" ? "is-pass" : "is-fail"}"></span>
                <div><strong>第 ${record.attempt_no} 次 · ${this.escape(__(record.result))}</strong><small>${this.escape(record.firmware_version)} / ${this.escape(record.agent_version)}</small></div>
                <time>${this.escape(record.flashed_at)}</time>
              </div>`,
          )
          .join("")
      : '<div class="production-panel-empty">尚无烧录记录</div>';
    this.wrapper.find(".production-flash-panel").html(`
      <div class="production-panel-heading">
        <div><span>01</span><h3>固件烧录</h3></div>
        <em>${latestFlash ? `最新：${this.escape(__(latestFlash.result))}` : "等待首次烧录"}</em>
      </div>
      <div class="production-version-block">
        <div><span>当前固件</span><strong>${this.escape(device.firmware_version || "未写入")}</strong></div>
        <div><span>AI Agent</span><strong>${this.escape(device.agent_version || "未写入")}</strong></div>
      </div>
      <div class="production-flash-actions">
        ${
          canFlash
            ? '<button class="btn btn-primary production-flash-pass">记录烧录通过</button><button class="btn btn-default production-flash-fail">记录烧录失败</button>'
            : '<button class="btn btn-default production-open-sn">请先完成组装登记</button>'
        }
      </div>
      <div class="production-history"><h4>最近烧录</h4>${history}</div>
    `);
  }

  render_test_panel() {
    const { device, tests, summary } = this.state.data;
    const canTest = device.lifecycle_state === "FLASHED";
    const cards = tests
      .map((test) => {
        const latest = test.latest;
        const status = latest ? latest.result : "PENDING";
        const statusLabel = latest ? __(latest.result) : "待测试";
        return `
          <article class="production-test-card status-${status.toLowerCase()}">
            <div class="production-test-card-head">
              <span>${this.escape(test.test_type)}</span>
              <em>${this.escape(statusLabel)}</em>
            </div>
            <h4>${this.escape(test.label)}</h4>
            <p>${latest ? `第 ${test.attempts} 次 · ${this.escape(latest.test_template_version)}` : "尚未记录测试结果"}</p>
            <div class="production-test-buttons">
              <button class="btn btn-xs btn-primary production-test-action" data-test="${test.test_type}" data-result="PASS" ${canTest ? "" : "disabled"}>通过</button>
              <button class="btn btn-xs btn-default production-test-action" data-test="${test.test_type}" data-result="FAIL" ${canTest ? "" : "disabled"}>不通过</button>
            </div>
          </article>`;
      })
      .join("");
    this.wrapper.find(".production-test-panel").html(`
      <div class="production-panel-heading">
        <div><span>02</span><h3>六项出厂测试</h3></div>
        <em>${summary.complete ? "六项已通过，等待 M2.3" : `${summary.passed}/6 已通过`}</em>
      </div>
      <div class="production-test-grid">${cards}</div>
      ${canTest ? "" : '<div class="production-test-lock">设备烧录通过后自动解锁测试操作。</div>'}
    `);
  }

  open_flash_dialog(result) {
    const { device, latest_flash: latestFlash } = this.state.data;
    const dialog = new frappe.ui.Dialog({
      title: result === "PASS" ? "记录烧录通过" : "记录烧录失败",
      fields: [
        { fieldname: "firmware_version", fieldtype: "Data", label: "固件版本", reqd: 1, default: device.firmware_version || latestFlash?.firmware_version || "FW-1.0.0" },
        { fieldname: "agent_version", fieldtype: "Data", label: "AI Agent 版本", reqd: 1, default: device.agent_version || latestFlash?.agent_version || "AGENT-1.0.0" },
        { fieldname: "package_checksum", fieldtype: "Data", label: "固件包校验值" },
        { fieldname: "flash_tool_version", fieldtype: "Data", label: "烧录工具版本", default: "FLASHER-1.0" },
        { fieldname: "workstation", fieldtype: "Link", options: "Workstation", label: "烧录工位" },
        { fieldname: "raw_log_ref", fieldtype: "Data", label: "烧录日志引用" },
        { fieldname: "failure_reason", fieldtype: "Small Text", label: "失败原因", reqd: result === "FAIL" },
      ],
      primary_action_label: result === "PASS" ? "确认通过" : "确认失败",
      primary_action: async (values) => {
        dialog.hide();
        const response = await frappe.call({
          method: "aishike_erp.production.record_flash",
          type: "POST",
          args: { scan_value: device.serial_no, result, ...values },
          freeze: true,
          freeze_message: __("正在保存烧录记录"),
        });
        this.apply_response(response.message);
        frappe.show_alert({ message: result === "PASS" ? "烧录通过，测试已解锁" : "烧录失败已留痕", indicator: result === "PASS" ? "green" : "orange" });
      },
    });
    dialog.show();
  }

  open_test_dialog(testType, result) {
    const { device, default_test_template: defaultTemplate } = this.state.data;
    const dialog = new frappe.ui.Dialog({
      title: `${__(testType)} · ${__(result)}`,
      fields: [
        { fieldname: "test_template_version", fieldtype: "Data", label: "测试模板版本", reqd: 1, default: defaultTemplate },
        { fieldname: "workstation", fieldtype: "Link", options: "Workstation", label: "测试工位" },
        { fieldname: "result_summary", fieldtype: "Small Text", label: "结果摘要" },
        { fieldname: "raw_data_ref", fieldtype: "Data", label: "原始数据引用" },
        { fieldname: "measurement_json", fieldtype: "Code", options: "JSON", label: "测量数据（JSON）", default: "{}" },
        { fieldname: "failure_reason", fieldtype: "Small Text", label: "失败原因", reqd: result === "FAIL" },
      ],
      primary_action_label: result === "PASS" ? "记录通过" : "记录不通过",
      primary_action: async (values) => {
        dialog.hide();
        const response = await frappe.call({
          method: "aishike_erp.production.record_test",
          type: "POST",
          args: { scan_value: device.serial_no, test_type: testType, result, ...values },
          freeze: true,
          freeze_message: __("正在保存测试结果"),
        });
        this.apply_response(response.message);
        frappe.show_alert({ message: `${__(testType)}已记录为${__(result)}`, indicator: result === "PASS" ? "green" : "orange" });
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
          this.wrapper.find(".production-scan-input").val(value);
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

  current_serial() {
    return this.state.data && this.state.data.device.serial_no;
  }

  focus_scanner(select = true) {
    const input = this.wrapper.find(".production-scan-input");
    input.trigger("focus");
    if (select) {
      input.trigger("select");
    }
  }

  escape(value) {
    return frappe.utils.escape_html(String(value == null ? "" : value));
  }
}
