from __future__ import annotations

import json
from enum import Enum

from aishike_erp import AishikeErpService, BillOfMaterials, Channel, ProductTemplate
from aishike_erp.domain import configuration_key


def json_default(value: object) -> str:
    if isinstance(value, Enum):
        return value.value
    return str(value)


service = AishikeErpService()
attributes = {"color": "STAR_WHITE", "hardware": "STANDARD", "region": "CN"}

service.register_template(
    ProductTemplate(
        code="K1",
        allowed_attributes={
            "color": frozenset({"STAR_WHITE", "DEEP_GRAY"}),
            "hardware": frozenset({"STANDARD", "PRO"}),
            "region": frozenset({"CN"}),
        },
        approved_combinations=frozenset({configuration_key(attributes)}),
    )
)

service.configure_sku(
    template_code="K1",
    sku_code="K1-WHITE-STD-CN",
    attributes=attributes,
    bom_revision="K1-BOM-R1",
    bundle_items=("POWER-ADAPTER", "BASIC-ACCESSORY-KIT"),
)

service.register_bom(
    BillOfMaterials(
        revision="K1-BOM-R1",
        sku_code="K1-WHITE-STD-CN",
        components={
            "MAINBOARD": 1,
            "OPTICAL-MODULE": 1,
            "CAMERA-MODULE": 1,
            "SENSOR-KIT": 1,
            "ENCLOSURE-WHITE": 1,
        },
        required_tests=("OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC"),
    )
)

service.release_work_order("WO-20260805-001", "K1-WHITE-STD-CN", 1)
service.create_device("K1-20260805-000001", "WO-20260805-001")
service.mark_assembled("K1-20260805-000001")
service.flash_device("K1-20260805-000001", "FW-1.0.0", "XIAOKE-3.2")

for test_type in ("OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC"):
    service.record_test(
        "K1-20260805-000001",
        test_type,
        True,
        "TEST-TEMPLATE-1.0",
        f"qms://K1-20260805-000001/{test_type.lower()}",
    )

service.release_to_stock("K1-20260805-000001")
service.map_channel_sku(Channel.TMALL, "TM-K1-001", "K1-WHITE-STD-CN", "TMALL-FLAGSHIP")
service.create_channel_order(
    "SO-20260805-001",
    Channel.TMALL,
    "TM-ORDER-001",
    "TM-K1-001",
    "TMALL-FLAGSHIP",
)
service.allocate_device("SO-20260805-001", "K1-20260805-000001")
service.ship_order("SO-20260805-001", "SF-TEST-001")
service.activate_device("K1-20260805-000001", "family://anonymous-001")

print(
    json.dumps(
        service.get_device_trace("K1-20260805-000001"),
        ensure_ascii=False,
        indent=2,
        default=json_default,
    )
)
