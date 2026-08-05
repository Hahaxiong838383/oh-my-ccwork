from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def configuration_key(attributes: dict[str, str]) -> tuple[tuple[str, str], ...]:
    return tuple(sorted(attributes.items()))


class Channel(str, Enum):
    TMALL = "TMALL"
    JD = "JD"
    DEALER = "DEALER"


class DeviceState(str, Enum):
    CREATED = "CREATED"
    ASSEMBLED = "ASSEMBLED"
    FLASHED = "FLASHED"
    QC_PASSED = "QC_PASSED"
    STOCKED = "STOCKED"
    ALLOCATED = "ALLOCATED"
    SHIPPED = "SHIPPED"
    ACTIVATED = "ACTIVATED"
    RMA_OPEN = "RMA_OPEN"
    REPAIRING = "REPAIRING"
    RETURNED = "RETURNED"
    REFURBISHED = "REFURBISHED"
    SCRAPPED = "SCRAPPED"


class OrderState(str, Enum):
    CREATED = "CREATED"
    ALLOCATED = "ALLOCATED"
    SHIPPED = "SHIPPED"


class RmaType(str, Enum):
    RETURN = "RETURN"
    EXCHANGE = "EXCHANGE"
    REPAIR = "REPAIR"
    REFURBISH = "REFURBISH"


@dataclass(frozen=True)
class ProductTemplate:
    code: str
    allowed_attributes: dict[str, frozenset[str]]
    approved_combinations: frozenset[tuple[tuple[str, str], ...]]


@dataclass(frozen=True)
class SellableSku:
    code: str
    template_code: str
    attributes: dict[str, str]
    bundle_items: tuple[str, ...]
    bom_revision: str


@dataclass(frozen=True)
class BillOfMaterials:
    revision: str
    sku_code: str
    components: dict[str, float]
    required_tests: tuple[str, ...]


@dataclass(frozen=True)
class WorkOrder:
    work_order_id: str
    sku_code: str
    bom_revision: str
    quantity: int


@dataclass(frozen=True)
class TestRecord:
    test_type: str
    passed: bool
    template_version: str
    raw_data_ref: str
    tested_at: datetime = field(default_factory=utc_now)


@dataclass
class DeviceUnit:
    serial_no: str
    sku_code: str
    bom_revision: str
    work_order_id: str
    state: DeviceState = DeviceState.CREATED
    firmware_version: str | None = None
    agent_version: str | None = None
    activation_ref: str | None = None
    tests: list[TestRecord] = field(default_factory=list)
    lifecycle_events: list[dict[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class ChannelSkuMapping:
    channel: Channel
    external_sku: str
    internal_sku: str
    scope: str


@dataclass
class ChannelOrder:
    internal_order_id: str
    channel: Channel
    external_order_id: str
    external_sku: str
    internal_sku: str
    state: OrderState = OrderState.CREATED
    allocated_serial: str | None = None
    logistics_ref: str | None = None


@dataclass(frozen=True)
class RmaCase:
    rma_id: str
    serial_no: str
    case_type: RmaType
    issue_category: str
