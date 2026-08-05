from __future__ import annotations

import json
import mimetypes
import threading
from dataclasses import asdict
from datetime import date, datetime
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from aishike_erp import (
    AishikeErpService,
    BillOfMaterials,
    Channel,
    DeviceState,
    DomainError,
    ProductTemplate,
    RmaType,
)
from aishike_erp.domain import OrderState, configuration_key


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"


def json_ready(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_ready(item) for item in value]
    return value


class DemoController:
    required_tests = ("OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC")

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.reset()

    def reset(self) -> None:
        with getattr(self, "lock", threading.Lock()):
            self.service = AishikeErpService()
            approved = (
                {"color": "STAR_WHITE", "hardware": "STANDARD", "region": "CN"},
                {"color": "DEEP_GRAY", "hardware": "STANDARD", "region": "CN"},
                {"color": "STAR_WHITE", "hardware": "PRO", "region": "CN"},
            )
            self.service.register_template(
                ProductTemplate(
                    code="K1",
                    allowed_attributes={
                        "color": frozenset({"STAR_WHITE", "DEEP_GRAY"}),
                        "hardware": frozenset({"STANDARD", "PRO"}),
                        "region": frozenset({"CN"}),
                    },
                    approved_combinations=frozenset(
                        configuration_key(attributes) for attributes in approved
                    ),
                )
            )
            self.sku_code: str | None = None
            self.work_order_id: str | None = None
            self.serial_no: str | None = None
            self.internal_order_id: str | None = None
            self.rma_id: str | None = None
            self.approved_combinations = approved

    def execute(self, action: str, payload: dict[str, object]) -> dict[str, object]:
        with self.lock:
            handlers = {
                "create_sku": self._create_sku,
                "release_work_order": self._release_work_order,
                "create_device": self._create_device,
                "assemble": self._assemble,
                "flash": self._flash,
                "run_tests": self._run_tests,
                "stock": self._stock,
                "create_order": self._create_order,
                "allocate": self._allocate,
                "ship": self._ship,
                "activate": self._activate,
                "open_rma": self._open_rma,
            }
            if action == "reset":
                self.reset()
                return self.snapshot()
            handler = handlers.get(action)
            if handler is None:
                raise DomainError(f"未知操作: {action}")
            handler(payload)
            return self.snapshot()

    def snapshot(self) -> dict[str, object]:
        device = self.service.devices.get(self.serial_no) if self.serial_no else None
        order = (
            self.service.orders.get(self.internal_order_id)
            if self.internal_order_id
            else None
        )
        latest_tests: dict[str, bool] = {}
        if device:
            for record in device.tests:
                latest_tests[record.test_type] = record.passed
        pipeline = [
            ("SKU", self.sku_code is not None),
            ("工单", self.work_order_id is not None),
            ("SN", self.serial_no is not None),
            ("组装", bool(device and device.state != DeviceState.CREATED)),
            (
                "烧录",
                bool(
                    device
                    and device.state
                    not in {DeviceState.CREATED, DeviceState.ASSEMBLED}
                ),
            ),
            (
                "测试",
                bool(
                    device
                    and all(latest_tests.get(test) is True for test in self.required_tests)
                ),
            ),
            (
                "入库",
                bool(
                    device
                    and device.state
                    in {
                        DeviceState.STOCKED,
                        DeviceState.ALLOCATED,
                        DeviceState.SHIPPED,
                        DeviceState.ACTIVATED,
                        DeviceState.RMA_OPEN,
                    }
                ),
            ),
            ("订单", order is not None),
            (
                "发货",
                bool(order and order.state == OrderState.SHIPPED),
            ),
            (
                "激活",
                bool(
                    device
                    and device.state in {DeviceState.ACTIVATED, DeviceState.RMA_OPEN}
                ),
            ),
            ("售后", self.rma_id is not None),
        ]
        trace = self.service.get_device_trace(self.serial_no) if self.serial_no else None
        return json_ready(
            {
                "product": {
                    "template": "K1",
                    "sku": self.sku_code,
                    "approved_combinations": self.approved_combinations,
                    "attribute_options": {
                        "color": ["STAR_WHITE", "DEEP_GRAY"],
                        "hardware": ["STANDARD", "PRO"],
                        "region": ["CN"],
                    },
                },
                "summary": {
                    "sku_count": len(self.service.skus),
                    "work_order_count": len(self.service.work_orders),
                    "device_count": len(self.service.devices),
                    "passed_test_count": sum(
                        1 for passed in latest_tests.values() if passed
                    ),
                    "order_count": len(self.service.orders),
                    "rma_count": len(self.service.rma_cases),
                },
                "pipeline": [
                    {"name": name, "complete": complete} for name, complete in pipeline
                ],
                "actions": self._available_actions(device, order, latest_tests),
                "trace": trace,
            }
        )

    def _available_actions(
        self,
        device,
        order,
        latest_tests: dict[str, bool],
    ) -> list[str]:
        if not self.sku_code:
            return ["create_sku"]
        if not self.work_order_id:
            return ["release_work_order"]
        if not self.serial_no:
            return ["create_device"]
        if device.state == DeviceState.CREATED:
            return ["assemble"]
        if device.state == DeviceState.ASSEMBLED:
            return ["flash"]
        if device.state == DeviceState.FLASHED:
            tests_passed = all(
                latest_tests.get(test) is True for test in self.required_tests
            )
            return ["stock"] if tests_passed else ["run_tests"]
        if device.state == DeviceState.STOCKED and not order:
            return ["create_order"]
        if device.state == DeviceState.STOCKED and order.state == OrderState.CREATED:
            return ["allocate"]
        if device.state == DeviceState.ALLOCATED:
            return ["ship"]
        if device.state == DeviceState.SHIPPED:
            return ["activate"]
        if device.state == DeviceState.ACTIVATED:
            return ["open_rma"]
        return []

    def _create_sku(self, payload: dict[str, object]) -> None:
        attributes = {
            "color": str(payload.get("color", "")),
            "hardware": str(payload.get("hardware", "")),
            "region": str(payload.get("region", "CN")),
        }
        color_code = {"STAR_WHITE": "WHITE", "DEEP_GRAY": "GRAY"}.get(
            attributes["color"], attributes["color"]
        )
        hardware_code = {"STANDARD": "STD", "PRO": "PRO"}.get(
            attributes["hardware"], attributes["hardware"]
        )
        sku_code = f"K1-{color_code}-{hardware_code}-{attributes['region']}"
        bom_revision = f"{sku_code}-BOM-R1"
        self.service.configure_sku(
            "K1",
            sku_code,
            attributes,
            bom_revision,
            bundle_items=("POWER-ADAPTER", "BASIC-ACCESSORY-KIT"),
        )
        components = {
            "MAINBOARD-PRO" if attributes["hardware"] == "PRO" else "MAINBOARD-STD": 1,
            "OPTICAL-MODULE": 1,
            "CAMERA-MODULE": 1,
            "SENSOR-KIT": 1,
            f"ENCLOSURE-{color_code}": 1,
        }
        self.service.register_bom(
            BillOfMaterials(
                revision=bom_revision,
                sku_code=sku_code,
                components=components,
                required_tests=self.required_tests,
            )
        )
        self.sku_code = sku_code

    def _release_work_order(self, payload: dict[str, object]) -> None:
        self._require(self.sku_code, "请先创建SKU")
        self.work_order_id = "WO-DEMO-001"
        self.service.release_work_order(self.work_order_id, self.sku_code, 1)

    def _create_device(self, payload: dict[str, object]) -> None:
        self._require(self.work_order_id, "请先释放工单")
        self.serial_no = "K1-DEMO-000001"
        self.service.create_device(self.serial_no, self.work_order_id)

    def _assemble(self, payload: dict[str, object]) -> None:
        self.service.mark_assembled(self._serial())

    def _flash(self, payload: dict[str, object]) -> None:
        self.service.flash_device(self._serial(), "FW-1.0.0", "XIAOKE-3.2")

    def _run_tests(self, payload: dict[str, object]) -> None:
        fail_optical = bool(payload.get("fail_optical", False))
        for test_type in self.required_tests:
            self.service.record_test(
                self._serial(),
                test_type,
                not (fail_optical and test_type == "OPTICAL"),
                "TEST-TEMPLATE-1.0",
                f"qms://{self._serial()}/{test_type.lower()}",
            )

    def _stock(self, payload: dict[str, object]) -> None:
        self.service.release_to_stock(self._serial())

    def _create_order(self, payload: dict[str, object]) -> None:
        channel = Channel(str(payload.get("channel", Channel.TMALL.value)))
        external_sku = {
            Channel.TMALL: "TM-K1-DEMO",
            Channel.JD: "JD-K1-DEMO",
            Channel.DEALER: "DL-K1-DEMO",
        }[channel]
        scope = {
            Channel.TMALL: "TMALL-FLAGSHIP",
            Channel.JD: "JD-FLAGSHIP",
            Channel.DEALER: "DEALER-DEMO",
        }[channel]
        self.service.map_channel_sku(channel, external_sku, self.sku_code, scope)
        self.internal_order_id = "SO-DEMO-001"
        self.service.create_channel_order(
            self.internal_order_id,
            channel,
            f"{channel.value}-ORDER-DEMO-001",
            external_sku,
            scope,
        )

    def _allocate(self, payload: dict[str, object]) -> None:
        self.service.allocate_device(self._order(), self._serial())

    def _ship(self, payload: dict[str, object]) -> None:
        self.service.ship_order(self._order(), "SF-DEMO-001")

    def _activate(self, payload: dict[str, object]) -> None:
        self.service.activate_device(self._serial(), "family://masked-demo-001")

    def _open_rma(self, payload: dict[str, object]) -> None:
        self.rma_id = "RMA-DEMO-001"
        self.service.open_rma(
            self.rma_id,
            self._serial(),
            RmaType.REPAIR,
            "OPTICAL_CALIBRATION",
        )

    def _serial(self) -> str:
        return str(self._require(self.serial_no, "设备SN尚未创建"))

    def _order(self) -> str:
        return str(self._require(self.internal_order_id, "渠道订单尚未创建"))

    @staticmethod
    def _require(value: object, message: str) -> object:
        if not value:
            raise DomainError(message)
        return value


CONTROLLER = DemoController()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "AishikeERPPrototype/0.1"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            self._json_response(200, CONTROLLER.snapshot())
            return
        self._serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not path.startswith("/api/actions/"):
            self._json_response(404, {"error": "接口不存在"})
            return
        action = path.rsplit("/", 1)[-1]
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json_response(400, {"error": "请求JSON格式无效"})
            return
        try:
            state = CONTROLLER.execute(action, payload)
        except (DomainError, ValueError) as error:
            self._json_response(400, {"error": str(error), "state": CONTROLLER.snapshot()})
            return
        self._json_response(200, state)

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        target = (WEB_ROOT / relative).resolve()
        if WEB_ROOT not in target.parents and target != WEB_ROOT:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _json_response(self, status: int, payload: object) -> None:
        content = json.dumps(json_ready(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: object) -> None:
        return


def run(host: str = "127.0.0.1", port: int = 8765) -> None:
    server = ThreadingHTTPServer((host, port), RequestHandler)
    print(f"Aishike ERP prototype: http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
