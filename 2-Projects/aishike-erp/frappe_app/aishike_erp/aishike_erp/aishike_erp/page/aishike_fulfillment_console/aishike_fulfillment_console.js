frappe.pages["aishike-fulfillment-console"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("销售履约工作台"),
    single_column: true,
  });
  wrapper.fulfillment_console = new AishikeFulfillmentConsole(page, wrapper);
};

frappe.pages["aishike-fulfillment-console"].on_page_show = function (wrapper) {
  wrapper.fulfillment_console.show();
};

class AishikeFulfillmentConsole {
  constructor(page, wrapper) {
    this.page = page;
    this.wrapper = $(wrapper);
    this.state = { setup: null, data: null };
    this.make();
  }

  make() {
    this.wrapper.addClass("aishike-fulfillment-page");
    this.page.main.html(`
      <div class="fulfillment-shell">
        <section class="fulfillment-hero">
          <div>
            <p class="fulfillment-eyebrow">M3 · OMNICHANNEL FULFILLMENT</p>
            <h1>全渠道订单与设备履约</h1>
            <p>统一天猫、京东与经销订单，以唯一 SN 完成库存分配、物流发货和脱敏激活。</p>
          </div>
          <div class="fulfillment-hero-actions">
            <button class="btn btn-default fulfillment-new-mapping">新建 SKU 映射</button>
            <button class="btn btn-primary fulfillment-new-order">录入渠道订单</button>
          </div>
        </section>

        <section class="fulfillment-command-bar">
          <div class="fulfillment-command-icon">${frappe.utils.icon("search", "md")}</div>
          <input class="fulfillment-search-input" autocomplete="off" placeholder="输入内部订单号、渠道订单号或扫描设备 SN">
          <button class="btn btn-primary fulfillment-search">查询履约</button>
          <button class="btn btn-default fulfillment-open-order-list">订单列表</button>
          <button class="btn btn-default fulfillment-open-record-list">履约凭证</button>
        </section>

        <section class="fulfillment-empty">
          <div class="fulfillment-empty-mark">M3</div>
          <h2>等待订单或设备查询</h2>
          <p>先建立渠道 SKU 映射并录入订单，再扫描在库设备完成履约。</p>
        </section>

        <div class="fulfillment-content" hidden>
          <section class="fulfillment-order-header"></section>
          <section class="fulfillment-flow"></section>
          <section class="fulfillment-metrics"></section>
          <div class="fulfillment-grid">
            <section class="fulfillment-panel fulfillment-allocation-panel"></section>
            <section class="fulfillment-panel fulfillment-device-panel"></section>
          </div>
          <section class="fulfillment-panel fulfillment-trace-panel"></section>
        </div>
      </div>
    `);
    this.bind_events();
  }

  bind_events() {
    this.wrapper.on("keydown", ".fulfillment-search-input", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.lookup();
      }
    });
    this.wrapper.on("click", ".fulfillment-search", () => this.lookup());
    this.wrapper.on("click", ".fulfillment-refresh", () => this.refresh());
    this.wrapper.on("click", ".fulfillment-new-mapping", () => this.open_mapping_dialog());
    this.wrapper.on("click", ".fulfillment-new-order", () => this.open_order_dialog());
    this.wrapper.on("click", ".fulfillment-open-order", () => this.open_order());
    this.wrapper.on("click", ".fulfillment-open-order-list", () => this.open_list("Aishike Channel Order"));
    this.wrapper.on("click", ".fulfillment-open-record-list", () => this.open_list("Aishike Device Fulfillment Record"));
    this.wrapper.on("click", ".fulfillment-open-mapping-list", () => this.open_list("Aishike Channel SKU Mapping"));
    this.wrapper.on("click", ".fulfillment-use-device", (event) => {
      this.wrapper.find(".fulfillment-device-scan").val($(event.currentTarget).data("serial"));
      this.wrapper.find(".fulfillment-device-scan").trigger("focus");
    });
    this.wrapper.on("click", ".fulfillment-allocate", () => this.allocate_scanned_device());
    this.wrapper.on("keydown", ".fulfillment-device-scan", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.allocate_scanned_device();
      }
    });
    this.wrapper.on("click", ".fulfillment-ship", (event) => this.open_action_dialog("SHIP", $(event.currentTarget).data("serial")));
    this.wrapper.on("click", ".fulfillment-activate", (event) => this.open_action_dialog("ACTIVATE", $(event.currentTarget).data("serial")));
    this.wrapper.on("click", ".fulfillment-open-device", (event) => frappe.set_route("Form", "Aishike Device Unit", $(event.currentTarget).data("serial")));
  }

  async show() {
    await this.load_setup();
    const routeOptions = frappe.route_options;
    frappe.route_options = null;
    if (routeOptions && routeOptions.search_value) {
      this.wrapper.find(".fulfillment-search-input").val(routeOptions.search_value);
      await this.lookup(routeOptions.search_value);
      return;
    }
    this.wrapper.find(".fulfillment-search-input").trigger("focus");
  }

  async load_setup() {
    const response = await frappe.call({ method: "aishike_erp.fulfillment.get_fulfillment_setup" });
    this.state.setup = response.message;
    this.apply_permissions();
  }

  apply_permissions() {
    const permissions = this.state.setup?.permissions || {};
    this.wrapper.find(".fulfillment-new-mapping").toggle(Boolean(permissions.can_create_mapping));
    this.wrapper.find(".fulfillment-new-order").toggle(Boolean(permissions.can_create_order));
  }

  async lookup(searchValue = null) {
    const value = searchValue || this.wrapper.find(".fulfillment-search-input").val().trim();
    if (!value) {
      this.wrapper.find(".fulfillment-search-input").trigger("focus");
      return;
    }
    const response = await frappe.call({
      method: "aishike_erp.fulfillment.get_fulfillment_console",
      args: { search_value: value },
      freeze: true,
      freeze_message: __("正在汇总订单与设备履约记录"),
    });
    this.apply_response(response.message);
  }

  async refresh() {
    if (this.state.data?.order?.name) {
      await this.lookup(this.state.data.order.name);
    }
  }

  apply_response(data) {
    this.state.data = data;
    this.state.setup = data.setup;
    this.wrapper.find(".fulfillment-search-input").val(data.order.name);
    this.wrapper.find(".fulfillment-empty").attr("hidden", true);
    this.wrapper.find(".fulfillment-content").removeAttr("hidden");
    this.apply_permissions();
    this.render_header();
    this.render_flow();
    this.render_metrics();
    this.render_allocation();
    this.render_devices();
    this.render_trace();
  }

  render_header() {
    const { order, mapping } = this.state.data;
    this.wrapper.find(".fulfillment-order-header").html(`
      <div>
        <span class="fulfillment-status">${this.escape(__(order.order_status))}</span>
        <h2>${this.escape(order.name)}</h2>
        <p>${this.escape(__(order.channel))} · ${this.escape(order.channel_scope)} · 外部订单 ${this.escape(order.external_order_id)}</p>
      </div>
      <div class="fulfillment-header-actions">
        <button class="btn btn-default fulfillment-refresh">刷新</button>
        <button class="btn btn-default fulfillment-open-mapping-list">SKU 映射</button>
        <button class="btn btn-primary fulfillment-open-order">订单档案</button>
      </div>
      <div class="fulfillment-mapping-strip">
        <span>渠道 SKU</span><strong>${this.escape(mapping.external_sku)}</strong>
        <span>内部 SKU</span><strong>${this.escape(order.sku_configuration)}</strong>
        <span>脱敏对象</span><strong>${this.escape(order.recipient_ref || "未填写")}</strong>
      </div>
    `);
  }

  render_flow() {
    const { order } = this.state.data;
    const steps = [
      ["01", "订单录入", true, `${order.order_quantity} 台`],
      ["02", "设备分配", order.allocated_count === order.order_quantity, `${order.allocated_count}/${order.order_quantity}`],
      ["03", "物流发货", order.shipped_count === order.order_quantity, `${order.shipped_count}/${order.order_quantity}`],
      ["04", "设备激活", order.activated_count === order.order_quantity, `${order.activated_count}/${order.order_quantity}`],
      ["05", "售后服务", false, "M4 后续阶段"],
    ];
    this.wrapper.find(".fulfillment-flow").html(steps.map(([number, label, complete, detail]) => `
      <article class="fulfillment-flow-step ${complete ? "is-complete" : ""}">
        <span>${number}</span><div><strong>${label}</strong><small>${this.escape(detail)}</small></div>
      </article>
    `).join(""));
  }

  render_metrics() {
    const { order, available_devices: availableDevices } = this.state.data;
    const metrics = [
      ["订单数量", order.order_quantity, "台"],
      ["已分配", order.allocated_count, "台"],
      ["已发货", order.shipped_count, "台"],
      ["已激活", order.activated_count, "台"],
      ["匹配可用库存", availableDevices.length, "台"],
    ];
    this.wrapper.find(".fulfillment-metrics").html(metrics.map(([label, value, unit]) => `
      <div><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>
    `).join(""));
  }

  render_allocation() {
    const { order, available_devices: availableDevices, setup } = this.state.data;
    const capacity = order.allocated_count < order.order_quantity;
    const canFulfill = Boolean(setup.permissions.can_allocate_ship);
    const rows = availableDevices.length
      ? availableDevices.map((device) => `
          <button class="fulfillment-stock-row fulfillment-use-device" data-serial="${this.escape(device.name)}">
            <span><strong>${this.escape(device.name)}</strong><small>${this.escape(device.production_batch || "无生产批次")}</small></span>
            <em>${this.escape(device.current_warehouse || "仓库未知")}</em>
          </button>
        `).join("")
      : '<div class="fulfillment-empty-row">暂无匹配的在库设备</div>';
    this.wrapper.find(".fulfillment-allocation-panel").html(`
      <div class="fulfillment-panel-heading"><div><span>01</span><h3>库存设备分配</h3></div><em>${capacity ? "等待扫码" : "订单分配已满"}</em></div>
      <div class="fulfillment-scan-card">
        <input class="fulfillment-device-scan" autocomplete="off" placeholder="扫描或输入在库设备 SN" ${!capacity || !canFulfill ? "disabled" : ""}>
        <button class="btn btn-primary fulfillment-allocate" ${!capacity || !canFulfill ? "disabled" : ""}>分配设备</button>
      </div>
      <p class="fulfillment-help">只允许分配 SKU 匹配、状态为“已入成品库”的设备；扫码枪使用 HID 键盘模式即可。</p>
      <div class="fulfillment-stock-list">${rows}</div>
    `);
  }

  render_devices() {
    const { devices, setup } = this.state.data;
    const canAllocateShip = Boolean(setup.permissions.can_allocate_ship);
    const canActivate = Boolean(setup.permissions.can_activate);
    const rows = devices.length
      ? devices.map((device) => {
          let action = '<span class="fulfillment-done">等待后续动作</span>';
          if (device.lifecycle_state === "ALLOCATED") {
            action = `<button class="btn btn-primary fulfillment-ship" data-serial="${this.escape(device.name)}" ${canAllocateShip ? "" : "disabled"}>登记发货</button>`;
          } else if (device.lifecycle_state === "SHIPPED") {
            action = `<button class="btn btn-primary fulfillment-activate" data-serial="${this.escape(device.name)}" ${canActivate ? "" : "disabled"}>登记激活</button>`;
          } else if (device.lifecycle_state === "ACTIVATED") {
            action = '<span class="fulfillment-done is-complete">履约完成</span>';
          }
          return `
            <article class="fulfillment-device-card">
              <div class="fulfillment-device-title">
                <button class="fulfillment-open-device" data-serial="${this.escape(device.name)}">${this.escape(device.name)}</button>
                <span>${this.escape(__(device.lifecycle_state))}</span>
              </div>
              <dl>
                <div><dt>当前仓库</dt><dd>${this.escape(device.current_warehouse || "已出库")}</dd></div>
                <div><dt>物流</dt><dd>${this.escape(device.tracking_no ? `${device.logistics_carrier} · ${device.tracking_no}` : "未发货")}</dd></div>
                <div><dt>激活引用</dt><dd>${this.escape(device.activation_ref || "未激活")}</dd></div>
              </dl>
              <div class="fulfillment-device-action">${action}</div>
            </article>
          `;
        }).join("")
      : '<div class="fulfillment-empty-row is-large">该订单尚未分配设备</div>';
    this.wrapper.find(".fulfillment-device-panel").html(`
      <div class="fulfillment-panel-heading"><div><span>02</span><h3>订单设备履约</h3></div><em>${devices.length} 台设备</em></div>
      <div class="fulfillment-device-list">${rows}</div>
    `);
  }

  render_trace() {
    const { records } = this.state.data;
    const rows = records.length
      ? records.map((record) => `
          <div class="fulfillment-trace-row">
            <div><strong>${this.escape(__(record.action))} · ${this.escape(record.device_unit)}</strong><p>${this.escape(this.record_detail(record))}</p></div>
            <time>${this.escape(this.format_datetime(record.action_at))}</time>
          </div>
        `).join("")
      : '<div class="fulfillment-empty-row is-large">暂无履约凭证</div>';
    this.wrapper.find(".fulfillment-trace-panel").html(`
      <div class="fulfillment-panel-heading"><div><span>03</span><h3>不可覆盖履约时间线</h3></div><em>${records.length} 条凭证</em></div>
      <div class="fulfillment-trace-list">${rows}</div>
    `);
  }

  async allocate_scanned_device() {
    const serial = this.wrapper.find(".fulfillment-device-scan").val().trim();
    if (!serial) {
      this.wrapper.find(".fulfillment-device-scan").trigger("focus");
      return;
    }
    await this.submit_action("ALLOCATE", serial, {});
  }

  open_mapping_dialog() {
    const dialog = new frappe.ui.Dialog({
      title: "新建渠道 SKU 映射",
      fields: [
        { fieldname: "channel", fieldtype: "Select", options: "TMALL\nJD\nDEALER", label: "销售渠道", reqd: 1 },
        { fieldname: "channel_scope", fieldtype: "Data", label: "渠道范围", description: "例如旗舰店、京东自营或经销商编码", reqd: 1 },
        { fieldname: "external_sku", fieldtype: "Data", label: "渠道 SKU", reqd: 1 },
        { fieldname: "sku_configuration", fieldtype: "Link", options: "Aishike SKU Configuration", label: "内部批准 SKU", reqd: 1, get_query: () => ({ filters: { status: "Approved" } }) },
      ],
      primary_action_label: "创建映射",
      primary_action: async (values) => {
        await frappe.call({ method: "aishike_erp.fulfillment.create_channel_mapping", type: "POST", args: values, freeze: true, freeze_message: __("正在创建渠道 SKU 映射") });
        dialog.hide();
        await this.load_setup();
        frappe.show_alert({ message: "渠道 SKU 映射已创建", indicator: "green" });
      },
    });
    dialog.show();
  }

  open_order_dialog() {
    if (!this.state.setup?.mappings?.length) {
      frappe.msgprint("请先创建至少一条启用中的渠道 SKU 映射");
      return;
    }
    const dialog = new frappe.ui.Dialog({
      title: "录入统一渠道订单",
      fields: [
        { fieldname: "channel_sku_mapping", fieldtype: "Link", options: "Aishike Channel SKU Mapping", label: "渠道 SKU 映射", reqd: 1, get_query: () => ({ filters: { status: "ACTIVE" } }), onchange: () => {
          const mapping = this.state.setup.mappings.find((row) => row.name === dialog.get_value("channel_sku_mapping"));
          if (mapping) {
            dialog.set_value("channel", mapping.channel);
            dialog.set_value("channel_scope", mapping.channel_scope);
          }
        } },
        { fieldname: "channel", fieldtype: "Select", options: "TMALL\nJD\nDEALER", label: "销售渠道", read_only: 1, reqd: 1 },
        { fieldname: "channel_scope", fieldtype: "Data", label: "渠道范围", read_only: 1, reqd: 1 },
        { fieldname: "external_order_id", fieldtype: "Data", label: "渠道订单号", reqd: 1 },
        { fieldname: "order_quantity", fieldtype: "Int", label: "订单数量", default: 1, reqd: 1 },
        { fieldname: "recipient_ref", fieldtype: "Data", label: "脱敏收货对象引用", description: "禁止填写姓名、手机号或邮箱" },
        { fieldname: "raw_payload_ref", fieldtype: "Data", label: "脱敏原始报文引用" },
      ],
      primary_action_label: "创建订单",
      primary_action: async (values) => {
        const response = await frappe.call({ method: "aishike_erp.fulfillment.create_channel_order", type: "POST", args: values, freeze: true, freeze_message: __("正在创建统一渠道订单") });
        dialog.hide();
        this.apply_response(response.message);
        frappe.show_alert({ message: response.message.reused ? "重复请求已返回原订单" : "渠道订单已创建", indicator: "green" });
      },
    });
    dialog.show();
  }

  open_action_dialog(action, serial) {
    const isShip = action === "SHIP";
    const dialog = new frappe.ui.Dialog({
      title: isShip ? `登记发货 · ${serial}` : `登记设备激活 · ${serial}`,
      fields: isShip ? [
        { fieldname: "logistics_carrier", fieldtype: "Data", label: "物流承运商", reqd: 1 },
        { fieldname: "tracking_no", fieldtype: "Data", label: "物流单号", reqd: 1 },
        { fieldname: "source_record_id", fieldtype: "Data", label: "出库单号（可选）" },
        { fieldname: "remarks", fieldtype: "Small Text", label: "备注" },
      ] : [
        { fieldname: "activation_ref", fieldtype: "Data", label: "脱敏激活引用", description: "例如设备云激活记录 ID，禁止手机号或邮箱", reqd: 1 },
        { fieldname: "customer_ref", fieldtype: "Data", label: "脱敏客户引用" },
        { fieldname: "source_record_id", fieldtype: "Data", label: "设备云记录编号（可选）" },
        { fieldname: "remarks", fieldtype: "Small Text", label: "备注" },
      ],
      primary_action_label: isShip ? "确认发货" : "确认激活",
      primary_action: async (values) => {
        await this.submit_action(action, serial, values);
        dialog.hide();
      },
    });
    dialog.show();
  }

  async submit_action(action, serial, values) {
    const response = await frappe.call({
      method: "aishike_erp.fulfillment.record_fulfillment_action",
      type: "POST",
      args: { channel_order: this.state.data.order.name, scan_value: serial, action, ...values },
      freeze: true,
      freeze_message: __({ ALLOCATE: "正在分配设备", SHIP: "正在登记发货", ACTIVATE: "正在登记激活" }[action]),
    });
    this.apply_response(response.message);
    frappe.show_alert({ message: __({ ALLOCATE: "设备已分配给订单", SHIP: "设备发货完成", ACTIVATE: "设备激活完成" }[action]), indicator: "green" });
  }

  open_order() {
    if (this.state.data?.order?.name) {
      frappe.set_route("Form", "Aishike Channel Order", this.state.data.order.name);
    }
  }

  open_list(doctype) {
    frappe.route_options = doctype === "Aishike Device Fulfillment Record" && this.state.data?.order?.name
      ? { channel_order: this.state.data.order.name }
      : null;
    frappe.set_route("List", doctype);
  }

  record_detail(record) {
    if (record.action === "SHIP") {
      return `${record.operation_warehouse || "仓库未知"} · ${record.logistics_carrier || "-"} · ${record.tracking_no || "-"}`;
    }
    if (record.action === "ACTIVATE") {
      return `${record.activation_ref || "-"} · ${record.customer_ref || "无客户引用"}`;
    }
    return `${record.operation_warehouse || "仓库未知"} · ${record.source_system}`;
  }

  format_datetime(value) {
    return value ? frappe.datetime.str_to_user(value) : "-";
  }

  escape(value) {
    return frappe.utils.escape_html(String(value == null ? "" : value));
  }
}
