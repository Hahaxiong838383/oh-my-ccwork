frappe.pages["aishike-sn-console"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("SN 工作台"),
    single_column: true,
  });
  wrapper.sn_console = new AishikeSnConsole(page, wrapper);
};

frappe.pages["aishike-sn-console"].on_page_show = function (wrapper) {
  wrapper.sn_console.refresh();
};

class AishikeSnConsole {
  constructor(page, wrapper) {
    this.page = page;
    this.wrapper = $(wrapper);
    this.state = { rules: [], skus: [], batches: [], selectedDevice: null, codeAssets: null };
    this.make();
  }

  make() {
    this.wrapper.addClass("aishike-sn-page");
    this.page.main.html(`
      <div class="sn-shell">
        <section class="sn-hero">
          <div>
            <p class="sn-eyebrow">M2 · 设备生产身份中心</p>
            <h1>设备 SN 生成与扫码</h1>
            <p class="sn-subtitle">统一生成设备身份、打印标签，并在组装工位通过扫码快速定位设备。</p>
          </div>
          <div class="sn-hero-actions">
            <button class="btn btn-default sn-manage-rules">管理规则</button>
            <button class="btn btn-primary sn-focus-scanner">进入扫码模式</button>
          </div>
        </section>

        <section class="sn-metrics">
          <div class="sn-metric"><span>可用规则</span><strong data-metric="rules">0</strong></div>
          <div class="sn-metric"><span>已批准 SKU</span><strong data-metric="skus">0</strong></div>
          <div class="sn-metric"><span>最近生成</span><strong data-metric="generated">0</strong></div>
        </section>

        <div class="sn-grid">
          <section class="sn-panel sn-generator-panel">
            <div class="sn-panel-heading">
              <div><span class="sn-step">01</span><h2>批量生成</h2></div>
              <span class="sn-panel-note">单次最多 200 台</span>
            </div>
            <div class="sn-form-grid">
              <label><span>SN 规则</span><select class="form-control sn-rule"></select></label>
              <label><span>SKU 配置</span><select class="form-control sn-sku"></select></label>
              <label><span>生产批次</span><input class="form-control sn-production-batch" placeholder="例如 LOT-20260805-A"></label>
              <label><span>生产日期</span><input class="form-control sn-generation-date" type="date"></label>
              <label><span>生成数量</span><input class="form-control sn-quantity" type="number" min="1" max="200" value="10"></label>
            </div>
            <div class="sn-preview-block">
              <div class="sn-preview-heading"><span>编号预览</span><button class="btn btn-xs btn-default sn-preview">刷新预览</button></div>
              <div class="sn-preview-list"><span class="sn-empty-inline">选择规则与 SKU 后显示</span></div>
            </div>
            <button class="btn btn-primary btn-lg sn-generate">生成设备 SN</button>
          </section>

          <section class="sn-panel sn-scanner-panel">
            <div class="sn-panel-heading">
              <div><span class="sn-step">02</span><h2>扫码识别</h2></div>
              <span class="sn-live-indicator"><i></i> 等待扫码</span>
            </div>
            <div class="sn-scan-box">
              ${frappe.utils.icon("scan-barcode", "lg")}
              <input class="sn-scan-input" autocomplete="off" placeholder="扫描条形码、二维码或输入 SN 后回车">
              <div class="sn-scan-actions">
                <button class="btn btn-primary sn-lookup">识别设备</button>
                <button class="btn btn-default sn-camera">打开摄像头</button>
              </div>
            </div>
            <div class="sn-device-result">
              <div class="sn-empty-state">
                ${frappe.utils.icon("package", "lg")}
                <strong>尚未识别设备</strong>
                <span>USB 或蓝牙扫码枪使用键盘模式即可直接录入。</span>
              </div>
            </div>
          </section>
        </div>

        <section class="sn-panel sn-history-panel">
          <div class="sn-panel-heading">
            <div><span class="sn-step">03</span><h2>最近生成批次</h2></div>
            <button class="btn btn-xs btn-default sn-open-batches">查看全部</button>
          </div>
          <div class="sn-history"></div>
        </section>
      </div>
    `);
    this.bind_events();
  }

  bind_events() {
    this.wrapper.on("click", ".sn-manage-rules", () =>
      frappe.set_route("List", "Aishike Serial Number Rule"),
    );
    this.wrapper.on("click", ".sn-open-batches", () =>
      frappe.set_route("List", "Aishike Serial Number Batch"),
    );
    this.wrapper.on("click", ".sn-focus-scanner", () => this.focus_scanner());
    this.wrapper.on("click", ".sn-preview", () => this.preview());
    this.wrapper.on("click", ".sn-generate", () => this.generate());
    this.wrapper.on("click", ".sn-lookup", () => this.lookup());
    this.wrapper.on("click", ".sn-camera", () => this.open_camera());
    this.wrapper.on("click", ".sn-open-device", () => this.open_device());
    this.wrapper.on("click", ".sn-print-label", () => this.print_label());
    this.wrapper.on("click", ".sn-mark-assembled", () => this.mark_assembled());
    this.wrapper.on("change", ".sn-rule, .sn-sku, .sn-production-batch, .sn-generation-date", () => this.preview());
    this.wrapper.on("keydown", ".sn-scan-input", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.lookup();
      }
    });
  }

  async refresh() {
    const response = await frappe.call({ method: "aishike_erp.sn.get_console_bootstrap" });
    this.state.rules = response.message.rules || [];
    this.state.skus = response.message.skus || [];
    this.state.batches = response.message.batches || [];
    this.render_controls();
    this.render_metrics();
    this.render_history();
    await this.preview();
    this.focus_scanner();
  }

  render_controls() {
    const currentRule = this.wrapper.find(".sn-rule").val();
    const currentSku = this.wrapper.find(".sn-sku").val();
    const ruleOptions = this.state.rules
      .map((rule) => `<option value="${this.escape(rule.name)}">${this.escape(rule.rule_name)} · ${this.escape(rule.name)}</option>`)
      .join("");
    const skuOptions = this.state.skus
      .map((sku) => `<option value="${this.escape(sku.name)}">${this.escape(sku.name)}</option>`)
      .join("");
    this.wrapper.find(".sn-rule").html(ruleOptions);
    this.wrapper.find(".sn-sku").html(skuOptions);
    if (currentRule && this.state.rules.some((rule) => rule.name === currentRule)) {
      this.wrapper.find(".sn-rule").val(currentRule);
    }
    if (currentSku && this.state.skus.some((sku) => sku.name === currentSku)) {
      this.wrapper.find(".sn-sku").val(currentSku);
    }
  }

  render_metrics() {
    const generated = this.state.batches.reduce(
      (total, batch) => total + Number(batch.generated_count || 0),
      0,
    );
    this.wrapper.find('[data-metric="rules"]').text(this.state.rules.length);
    this.wrapper.find('[data-metric="skus"]').text(this.state.skus.length);
    this.wrapper.find('[data-metric="generated"]').text(generated);
  }

  render_history() {
    if (!this.state.batches.length) {
      this.wrapper.find(".sn-history").html('<div class="sn-empty-row">暂无生成批次</div>');
      return;
    }
    const rows = this.state.batches
      .map(
        (batch) => `
          <div class="sn-history-row">
            <div><strong>${this.escape(batch.name)}</strong><span>${this.escape(batch.production_batch || "未填写生产批次")}</span></div>
            <div><span>SKU</span><strong>${this.escape(batch.sku_configuration)}</strong></div>
            <div><span>数量</span><strong>${Number(batch.generated_count || 0)}</strong></div>
            <div><span>生产日期</span><strong>${this.escape(batch.generation_date || "未填写")}</strong></div>
          </div>`,
      )
      .join("");
    this.wrapper.find(".sn-history").html(rows);
  }

  async preview() {
    const values = this.get_generation_values();
    if (!values.serial_rule || !values.sku_configuration || !values.generation_date) {
      this.wrapper.find(".sn-preview-list").html('<span class="sn-empty-inline">请选择生产日期后预览</span>');
      return;
    }
    try {
      const response = await frappe.call({
        method: "aishike_erp.sn.preview_serials",
        args: { ...values, quantity: Math.min(values.quantity, 3) },
      });
      this.wrapper
        .find(".sn-preview-list")
        .html(response.message.serials.map((serial) => `<code>${this.escape(serial)}</code>`).join(""));
    } catch (error) {
      this.wrapper.find(".sn-preview-list").html('<span class="sn-empty-inline">当前参数无法生成预览</span>');
    }
  }

  async generate() {
    const values = this.get_generation_values();
    const response = await frappe.call({
      method: "aishike_erp.sn.generate_serials",
      type: "POST",
      args: values,
      freeze: true,
      freeze_message: __("正在生成设备 SN"),
    });
    frappe.show_alert({
      message: __("已生成 {0} 个设备 SN", [response.message.generated_count]),
      indicator: "green",
    });
    this.wrapper.find(".sn-scan-input").val(response.message.serials[0]);
    await this.refresh();
    await this.lookup(response.message.serials[0]);
  }

  async lookup(scanValue = null) {
    const value = scanValue || this.wrapper.find(".sn-scan-input").val();
    if (!value) {
      this.focus_scanner();
      return;
    }
    const response = await frappe.call({ method: "aishike_erp.sn.lookup_device", args: { scan_value: value } });
    this.state.selectedDevice = response.message;
    this.wrapper.find(".sn-scan-input").val(response.message.serial_no);
    await this.load_code_assets(response.message.serial_no);
    this.render_device();
    this.focus_scanner();
  }

  async load_code_assets(serialNo) {
    const response = await frappe.call({ method: "aishike_erp.sn.get_code_assets", args: { scan_value: serialNo } });
    this.state.codeAssets = response.message;
    await frappe.require("/assets/frappe/node_modules/jsbarcode/dist/JsBarcode.all.min.js");
  }

  render_device() {
    const device = this.state.selectedDevice;
    const assets = this.state.codeAssets;
    if (!device || !assets) {
      return;
    }
    const canAssemble = device.lifecycle_state === "CREATED";
    this.wrapper.find(".sn-device-result").html(`
      <div class="sn-device-card">
        <div class="sn-device-head">
          <div><span class="sn-status">${this.escape(__(device.lifecycle_state))}</span><h3>${this.escape(device.serial_no)}</h3></div>
          <button class="btn btn-default btn-xs sn-open-device">打开设备档案</button>
        </div>
        <div class="sn-code-grid">
          <div class="sn-barcode-card"><svg class="sn-barcode-svg"></svg><span>${this.escape(device.serial_no)}</span></div>
          <div class="sn-qr-card">${assets.qr_svg}<span>${this.escape(assets.qr_payload)}</span></div>
        </div>
        <dl class="sn-device-meta">
          <div><dt>SKU 配置</dt><dd>${this.escape(device.sku_configuration)}</dd></div>
          <div><dt>生产批次</dt><dd>${this.escape(device.production_batch || "未填写")}</dd></div>
          <div><dt>生成批次</dt><dd>${this.escape(device.sn_generation_batch || "手工创建")}</dd></div>
          <div><dt>生产日期</dt><dd>${this.escape(device.generation_date || "未填写")}</dd></div>
        </dl>
        <div class="sn-device-actions">
          <button class="btn btn-default sn-print-label">打印设备标签</button>
          ${canAssemble ? '<button class="btn btn-primary sn-mark-assembled">登记组装完成</button>' : ""}
        </div>
      </div>
    `);
    window.JsBarcode(this.wrapper.find(".sn-barcode-svg")[0], device.serial_no, {
      format: assets.barcode_format || "CODE128",
      displayValue: false,
      height: 56,
      margin: 0,
      width: 2,
    });
  }

  open_camera() {
    new frappe.ui.Scanner({
      dialog: true,
      multiple: false,
      on_scan: (data) => {
        const value = data && data.result && data.result.text;
        if (value) {
          this.wrapper.find(".sn-scan-input").val(value);
          this.lookup(value);
        }
      },
    });
  }

  async mark_assembled() {
    const serialNo = this.state.selectedDevice && this.state.selectedDevice.serial_no;
    if (!serialNo) {
      return;
    }
    const response = await frappe.call({
      method: "aishike_erp.sn.mark_assembled",
      type: "POST",
      args: { scan_value: serialNo },
      freeze: true,
      freeze_message: __("正在登记组装结果"),
    });
    this.state.selectedDevice = response.message;
    this.render_device();
    frappe.show_alert({ message: __("设备已登记为组装完成"), indicator: "green" });
  }

  open_device() {
    if (this.state.selectedDevice) {
      frappe.set_route("Form", "Aishike Device Unit", this.state.selectedDevice.serial_no);
    }
  }

  print_label() {
    const device = this.state.selectedDevice;
    const assets = this.state.codeAssets;
    if (!device || !assets) {
      return;
    }
    const barcode = this.wrapper.find(".sn-barcode-svg")[0].outerHTML;
    const printWindow = window.open("", "_blank", "width=760,height=560");
    printWindow.document.write(`
      <!doctype html><html><head><meta charset="utf-8"><title>${this.escape(device.serial_no)}</title>
      <style>@page{size:60mm 30mm;margin:0}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.label{box-sizing:border-box;width:60mm;height:30mm;padding:3mm;display:grid;grid-template-columns:1fr 20mm;gap:2mm;color:#111}.name{font-size:8pt;font-weight:700}.serial{font:7pt ui-monospace,monospace;margin-top:1mm}.barcode{margin-top:1.5mm}.barcode svg{width:35mm;height:10mm}.qr svg{width:18mm;height:18mm}.qr{text-align:center}.brand{font-size:6pt;color:#555;margin-top:1mm}</style>
      </head><body><div class="label"><div><div class="name">爱视可读写台设备标签</div><div class="serial">${this.escape(device.serial_no)}</div><div class="barcode">${barcode}</div><div class="brand">FUTURUS · ${this.escape(device.sku_configuration)}</div></div><div class="qr">${assets.qr_svg}</div></div><script>window.onload=()=>window.print()</script></body></html>
    `);
    printWindow.document.close();
  }

  get_generation_values() {
    return {
      serial_rule: this.wrapper.find(".sn-rule").val(),
      sku_configuration: this.wrapper.find(".sn-sku").val(),
      production_batch: this.wrapper.find(".sn-production-batch").val().trim(),
      generation_date: this.wrapper.find(".sn-generation-date").val(),
      quantity: Number(this.wrapper.find(".sn-quantity").val() || 1),
    };
  }

  focus_scanner(select = true) {
    const input = this.wrapper.find(".sn-scan-input");
    input.trigger("focus");
    if (select) {
      input.trigger("select");
    }
  }

  escape(value) {
    return frappe.utils.escape_html(String(value == null ? "" : value));
  }
}
