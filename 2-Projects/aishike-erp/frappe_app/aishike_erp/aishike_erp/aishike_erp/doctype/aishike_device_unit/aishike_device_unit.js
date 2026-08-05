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
  refresh(frm) {
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
  },
});
