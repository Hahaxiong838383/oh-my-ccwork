from __future__ import annotations

from dataclasses import asdict

from .domain import (
    BillOfMaterials,
    Channel,
    ChannelOrder,
    ChannelSkuMapping,
    DeviceState,
    DeviceUnit,
    OrderState,
    ProductTemplate,
    RmaCase,
    RmaType,
    SellableSku,
    TestRecord,
    WorkOrder,
    configuration_key,
    utc_now,
)


class DomainError(ValueError):
    pass


class AishikeErpService:
    def __init__(self) -> None:
        self.templates: dict[str, ProductTemplate] = {}
        self.skus: dict[str, SellableSku] = {}
        self.boms: dict[str, BillOfMaterials] = {}
        self.work_orders: dict[str, WorkOrder] = {}
        self.devices: dict[str, DeviceUnit] = {}
        self.channel_mappings: dict[tuple[Channel, str, str], ChannelSkuMapping] = {}
        self.orders: dict[str, ChannelOrder] = {}
        self.external_orders: dict[tuple[Channel, str], str] = {}
        self.rma_cases: dict[str, RmaCase] = {}

    def register_template(self, template: ProductTemplate) -> None:
        if template.code in self.templates:
            raise DomainError(f"产品模板已存在: {template.code}")
        self.templates[template.code] = template

    def configure_sku(
        self,
        template_code: str,
        sku_code: str,
        attributes: dict[str, str],
        bom_revision: str,
        bundle_items: tuple[str, ...] = (),
    ) -> SellableSku:
        template = self._get(self.templates, template_code, "产品模板")
        if set(attributes) != set(template.allowed_attributes):
            raise DomainError("SKU属性必须完整且不能包含未定义属性")
        for name, value in attributes.items():
            if value not in template.allowed_attributes[name]:
                raise DomainError(f"属性值未批准: {name}={value}")
        if configuration_key(attributes) not in template.approved_combinations:
            raise DomainError("该SKU属性组合未经过工程批准")
        if sku_code in self.skus:
            raise DomainError(f"SKU已存在: {sku_code}")
        sku = SellableSku(
            code=sku_code,
            template_code=template_code,
            attributes=dict(attributes),
            bundle_items=bundle_items,
            bom_revision=bom_revision,
        )
        self.skus[sku_code] = sku
        return sku

    def register_bom(self, bom: BillOfMaterials) -> None:
        sku = self._get(self.skus, bom.sku_code, "SKU")
        if sku.bom_revision != bom.revision:
            raise DomainError("SKU默认BOM版本与注册BOM不一致")
        if bom.revision in self.boms:
            raise DomainError(f"BOM版本已存在: {bom.revision}")
        if not bom.required_tests:
            raise DomainError("实体SKU必须配置强制测试")
        self.boms[bom.revision] = bom

    def release_work_order(
        self,
        work_order_id: str,
        sku_code: str,
        quantity: int,
    ) -> WorkOrder:
        if quantity <= 0:
            raise DomainError("工单数量必须大于0")
        sku = self._get(self.skus, sku_code, "SKU")
        self._get(self.boms, sku.bom_revision, "BOM")
        if work_order_id in self.work_orders:
            raise DomainError(f"工单已存在: {work_order_id}")
        work_order = WorkOrder(work_order_id, sku_code, sku.bom_revision, quantity)
        self.work_orders[work_order_id] = work_order
        return work_order

    def create_device(self, serial_no: str, work_order_id: str) -> DeviceUnit:
        if serial_no in self.devices:
            raise DomainError(f"SN已存在: {serial_no}")
        work_order = self._get(self.work_orders, work_order_id, "工单")
        device = DeviceUnit(
            serial_no=serial_no,
            sku_code=work_order.sku_code,
            bom_revision=work_order.bom_revision,
            work_order_id=work_order_id,
        )
        self.devices[serial_no] = device
        self._event(device, "DEVICE_CREATED", "MES", work_order_id)
        return device

    def mark_assembled(self, serial_no: str) -> None:
        device = self._device_in_state(serial_no, DeviceState.CREATED)
        device.state = DeviceState.ASSEMBLED
        self._event(device, "ASSEMBLED", "MES", device.work_order_id)

    def flash_device(
        self,
        serial_no: str,
        firmware_version: str,
        agent_version: str,
    ) -> None:
        device = self._device_in_state(serial_no, DeviceState.ASSEMBLED)
        if not firmware_version or not agent_version:
            raise DomainError("固件版本和Agent版本不能为空")
        device.firmware_version = firmware_version
        device.agent_version = agent_version
        device.state = DeviceState.FLASHED
        self._event(device, "FLASHED", "MES", firmware_version)

    def record_test(
        self,
        serial_no: str,
        test_type: str,
        passed: bool,
        template_version: str,
        raw_data_ref: str,
    ) -> TestRecord:
        device = self._get(self.devices, serial_no, "设备")
        if device.state not in {DeviceState.FLASHED, DeviceState.QC_PASSED}:
            raise DomainError("设备必须完成烧录后才能记录出厂测试")
        bom = self._get(self.boms, device.bom_revision, "BOM")
        if test_type not in bom.required_tests:
            raise DomainError(f"测试类型不在BOM强制测试清单中: {test_type}")
        record = TestRecord(
            test_type=test_type,
            passed=passed,
            template_version=template_version,
            raw_data_ref=raw_data_ref,
        )
        device.tests.append(record)
        self._event(device, f"TEST_{'PASS' if passed else 'FAIL'}", "QMS", test_type)
        return record

    def release_to_stock(self, serial_no: str) -> None:
        device = self._get(self.devices, serial_no, "设备")
        if device.state != DeviceState.FLASHED:
            raise DomainError("只有完成烧录且未入库的设备可以执行入库放行")
        bom = self._get(self.boms, device.bom_revision, "BOM")
        latest_results: dict[str, bool] = {}
        for record in device.tests:
            latest_results[record.test_type] = record.passed
        missing_or_failed = [
            test_type
            for test_type in bom.required_tests
            if latest_results.get(test_type) is not True
        ]
        if missing_or_failed:
            raise DomainError(f"强制测试未通过: {', '.join(missing_or_failed)}")
        device.state = DeviceState.QC_PASSED
        self._event(device, "QC_PASSED", "QMS", serial_no)
        device.state = DeviceState.STOCKED
        self._event(device, "STOCKED", "WMS", serial_no)

    def map_channel_sku(
        self,
        channel: Channel,
        external_sku: str,
        internal_sku: str,
        scope: str,
    ) -> ChannelSkuMapping:
        self._get(self.skus, internal_sku, "SKU")
        key = (channel, external_sku, scope)
        if key in self.channel_mappings:
            raise DomainError("渠道SKU映射已存在")
        mapping = ChannelSkuMapping(channel, external_sku, internal_sku, scope)
        self.channel_mappings[key] = mapping
        return mapping

    def create_channel_order(
        self,
        internal_order_id: str,
        channel: Channel,
        external_order_id: str,
        external_sku: str,
        scope: str,
    ) -> ChannelOrder:
        external_key = (channel, external_order_id)
        if external_key in self.external_orders:
            return self.orders[self.external_orders[external_key]]
        mapping = self._get(
            self.channel_mappings,
            (channel, external_sku, scope),
            "渠道SKU映射",
        )
        if internal_order_id in self.orders:
            raise DomainError(f"内部订单已存在: {internal_order_id}")
        order = ChannelOrder(
            internal_order_id=internal_order_id,
            channel=channel,
            external_order_id=external_order_id,
            external_sku=external_sku,
            internal_sku=mapping.internal_sku,
        )
        self.orders[internal_order_id] = order
        self.external_orders[external_key] = internal_order_id
        return order

    def allocate_device(self, internal_order_id: str, serial_no: str) -> None:
        order = self._get(self.orders, internal_order_id, "订单")
        device = self._device_in_state(serial_no, DeviceState.STOCKED)
        if order.state != OrderState.CREATED:
            raise DomainError("只有新建订单可以分配设备")
        if order.internal_sku != device.sku_code:
            raise DomainError("订单SKU与设备SKU不一致")
        order.allocated_serial = serial_no
        order.state = OrderState.ALLOCATED
        device.state = DeviceState.ALLOCATED
        self._event(device, "ALLOCATED", "OMS", internal_order_id)

    def ship_order(self, internal_order_id: str, logistics_ref: str) -> None:
        order = self._get(self.orders, internal_order_id, "订单")
        if order.state != OrderState.ALLOCATED or not order.allocated_serial:
            raise DomainError("订单必须先分配设备SN")
        device = self._device_in_state(order.allocated_serial, DeviceState.ALLOCATED)
        order.logistics_ref = logistics_ref
        order.state = OrderState.SHIPPED
        device.state = DeviceState.SHIPPED
        self._event(device, "SHIPPED", "WMS", logistics_ref)

    def activate_device(self, serial_no: str, activation_ref: str) -> None:
        device = self._device_in_state(serial_no, DeviceState.SHIPPED)
        if not activation_ref:
            raise DomainError("激活引用不能为空")
        device.activation_ref = activation_ref
        device.state = DeviceState.ACTIVATED
        self._event(device, "ACTIVATED", "IOT", activation_ref)

    def open_rma(
        self,
        rma_id: str,
        serial_no: str,
        case_type: RmaType,
        issue_category: str,
    ) -> RmaCase:
        device = self._get(self.devices, serial_no, "设备")
        if device.state not in {DeviceState.SHIPPED, DeviceState.ACTIVATED}:
            raise DomainError("只有已发货或已激活设备可以进入售后RMA")
        if rma_id in self.rma_cases:
            raise DomainError(f"RMA已存在: {rma_id}")
        case = RmaCase(rma_id, serial_no, case_type, issue_category)
        self.rma_cases[rma_id] = case
        device.state = DeviceState.RMA_OPEN
        self._event(device, "RMA_OPEN", "CRM", rma_id)
        return case

    def get_device_trace(self, serial_no: str) -> dict[str, object]:
        device = self._get(self.devices, serial_no, "设备")
        linked_orders = [
            asdict(order)
            for order in self.orders.values()
            if order.allocated_serial == serial_no
        ]
        linked_rma = [
            asdict(case)
            for case in self.rma_cases.values()
            if case.serial_no == serial_no
        ]
        return {
            "device": asdict(device),
            "work_order": asdict(self.work_orders[device.work_order_id]),
            "bom": asdict(self.boms[device.bom_revision]),
            "orders": linked_orders,
            "rma_cases": linked_rma,
        }

    def _device_in_state(self, serial_no: str, expected: DeviceState) -> DeviceUnit:
        device = self._get(self.devices, serial_no, "设备")
        if device.state != expected:
            raise DomainError(
                f"设备状态不允许该操作: 当前={device.state.value}, 需要={expected.value}"
            )
        return device

    @staticmethod
    def _get(store: dict, key: object, label: str):
        try:
            return store[key]
        except KeyError as error:
            raise DomainError(f"{label}不存在: {key}") from error

    @staticmethod
    def _event(
        device: DeviceUnit,
        event_type: str,
        source_system: str,
        source_record_id: str,
    ) -> None:
        device.lifecycle_events.append(
            {
                "event_type": event_type,
                "source_system": source_system,
                "source_record_id": source_record_id,
                "occurred_at": utc_now().isoformat(),
            }
        )
