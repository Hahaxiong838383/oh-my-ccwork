frappe.ui.form.on("Aishike SKU Configuration", {
  refresh(frm) {
    const editable = frm.doc.status === "Draft";
    frm.toggle_enable(
      [
        "item_template",
        "item_code",
        "color",
        "hardware_configuration",
        "sales_region",
        "bom",
        "product_bundle",
      ],
      editable,
    );

    if (!frm.is_new() && frm.doc.status === "Draft") {
      frm.add_custom_button(__("批准 SKU"), async () => {
        await frm.set_value("status", "Approved");
        await frm.save();
      }, __("状态"));
    }

    if (!frm.is_new() && frm.doc.status === "Approved") {
      frm.add_custom_button(__("停用 SKU"), () => {
        frappe.prompt(
          [{ fieldname: "reason", fieldtype: "Small Text", label: __("停用原因"), reqd: 1 }],
          async ({ reason }) => {
            await frm.set_value("disabled_reason", reason);
            await frm.set_value("status", "Disabled");
            await frm.save();
          },
          __("停用 SKU"),
          __("确认"),
        );
      }, __("状态"));
    }
  },
});
