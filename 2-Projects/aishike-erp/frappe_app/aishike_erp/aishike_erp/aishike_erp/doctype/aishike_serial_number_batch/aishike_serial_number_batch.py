from __future__ import annotations

import frappe
from frappe.model.document import Document


class AishikeSerialNumberBatch(Document):
    def validate(self) -> None:
        if int(self.requested_quantity or 0) < 1:
            frappe.throw("请求数量必须大于 0")
        if int(self.generated_count or 0) != int(self.requested_quantity or 0):
            frappe.throw("生成数量必须与请求数量一致")
        if int(self.sequence_end or 0) < int(self.sequence_start or 0):
            frappe.throw("结束流水号不能小于起始流水号")
