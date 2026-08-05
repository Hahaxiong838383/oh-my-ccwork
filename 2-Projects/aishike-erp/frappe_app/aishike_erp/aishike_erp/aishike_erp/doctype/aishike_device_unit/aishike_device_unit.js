const nextStateActions = {
  CREATED: ["标记组装完成", "ASSEMBLED"],
  ASSEMBLED: ["完成固件烧录", "FLASHED"],
  FLASHED: ["通过质量门", "QC_PASSED"],
  QC_PASSED: ["转入成品库存", "STOCKED"],
  STOCKED: ["分配销售订单", "ALLOCATED"],
  ALLOCATED: ["确认发货", "SHIPPED"],
  SHIPPED: ["确认设备激活", "ACTIVATED"],
  ACTIVATED: ["发起售后工单", "RMA_OPEN"],
  RMA_OPEN: ["开始维修", "REPAIRING"],
};

frappe.ui.form.on("Aishike Device Unit", {
  async refresh(frm) {
    frm.toggle_enable(
      ["serial_no", "sku_configuration", "work_order"],
      frm.doc.lifecycle_state === "CREATED",
    );

    const action = nextStateActions[frm.doc.lifecycle_state];
    if (!frm.is_new() && action) {
      frm.add_custom_button(__(action[0]), async () => {
        await frm.set_value("lifecycle_state", action[1]);
        await frm.save();
      }, __("生命周期"));
    }

    if (!frm.is_new()) {
      frm.add_custom_button(__("打开 SN 工作台"), () => {
        frappe.set_route("aishike-sn-console");
      }, __("设备标识"));
      await render_device_identity_codes(frm);
    }
  },
});

async function render_device_identity_codes(frm) {
  const wrapper = frm.get_field("identity_codes").$wrapper;
  wrapper.html('<div class="text-muted small">正在生成设备标识码…</div>');
  const response = await frappe.call({
    method: "aishike_erp.sn.get_code_assets",
    args: { scan_value: frm.doc.name },
  });
  const assets = response.message;
  await frappe.require("/assets/frappe/node_modules/jsbarcode/dist/JsBarcode.all.min.js");
  wrapper.html(`
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 140px;gap:16px;align-items:center;padding:16px;border:1px solid var(--border-color);border-radius:10px;background:var(--fg-color)">
      <div style="min-width:0"><svg class="aishike-device-barcode"></svg><div class="text-muted small" style="margin-top:8px;font-family:ui-monospace,monospace">${frappe.utils.escape_html(frm.doc.name)}</div></div>
      <div style="text-align:center">${assets.qr_svg}<div class="text-muted" style="margin-top:6px;font-size:10px;font-family:ui-monospace,monospace">${frappe.utils.escape_html(assets.qr_payload)}</div></div>
    </div>
  `);
  window.JsBarcode(wrapper.find(".aishike-device-barcode")[0], frm.doc.name, {
    format: assets.barcode_format || "CODE128",
    displayValue: false,
    height: 62,
    margin: 0,
    width: 2,
  });
}
