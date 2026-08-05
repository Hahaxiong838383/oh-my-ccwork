from __future__ import annotations

import frappe
from frappe.model.document import Document
from datetime import date

from aishike_erp.serials import SerialRuleError, get_scope_key, render_serial


class AishikeSerialNumberRule(Document):
    def validate(self) -> None:
        try:
            scope_key = get_scope_key(
                self.reset_policy,
                date(2026, 1, 1),
                "SAMPLE" if self.reset_policy == "BATCH" else "",
            )
            self.sample_serial = render_serial(
                pattern=self.pattern,
                prefix=self.prefix,
                suffix=self.suffix,
                date_format=self.date_format,
                sku="ASK-RW-DESK-STAR-WHITE-PRO",
                batch="SAMPLE",
                sequence=max(int(self.next_sequence or 1), 1),
                sequence_digits=int(self.sequence_digits or 0),
                date_value=date(2026, 1, 1),
            )
        except SerialRuleError as error:
            frappe.throw(str(error))

        if self.is_new() or not self.current_scope_key:
            self.current_scope_key = scope_key
        if int(self.next_sequence or 0) < 1:
            frappe.throw("下一个流水号必须大于 0")
