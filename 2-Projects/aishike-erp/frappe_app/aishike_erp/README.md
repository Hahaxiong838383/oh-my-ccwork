# Aishike ERP Frappe App

爱视可智能硬件 ERP 的 Frappe v16 自定义应用。

## 当前阶段

- M2.3 已通过川哥人工验收；
- M3 已完成自动、重启、浏览器和川哥人工验收；
- M4 未授权，必须等待川哥明确指令，不允许提前进入售后 RMA、退换货或设备解绑阶段。

## 第一阶段能力

- SKU草稿、批准、停用状态管理；
- 草稿可编辑，批准后关键属性锁定；
- 设备SN、BOM、工单、固件和Agent版本关联；
- 设备生命周期状态机；
- 六类出厂测试及复测历史；
- 自定义 SN 生成规则、批量生成和序号重置策略；
- Code 128 条形码、二维码、键盘扫码枪和摄像头扫码；
- SN 工作台扫码定位设备并登记组装完成；
- 不可覆盖的固件烧录尝试记录，烧录通过后自动推进设备状态；
- 生产测试工作台和六项出厂测试，失败后可复测但保留完整历史；
- 质量门未满足时禁止质量放行；
- 不可覆盖的质量驳回与放行记录，质量通过后自动推进设备状态；
- 成品入库和仓库调拨凭证，当前仓库由最新库存移动派生；
- 质量与入库工作台集中展示生产、测试、质量、库存和生命周期追溯；
- 天猫、京东和线下经销 SKU 映射与统一渠道订单；
- 渠道订单按渠道范围和外部订单号幂等导入；
- 只有在库且 SKU 匹配的设备可以扫码分配；
- 发货必须保存出库仓库、承运商和物流单号；
- 激活只保存脱敏激活引用和脱敏客户引用；
- 分配、发货和激活凭证不可修改或删除；
- 销售履约工作台集中展示订单、设备、物流、激活和时间线；
- 生命周期事件追加记录；
- 爱视可 ERP Workspace入口。

## 本地静态验证

```bash
python3 -m unittest discover -s tests -v
python3 scripts/validate_app.py
python3 -m compileall -q aishike_erp
```

## 安装到已有Bench

```bash
cd /path/to/frappe-bench
cp -R /path/to/aishike_erp apps/aishike_erp
./env/bin/pip install -e apps/aishike_erp
bench --site erp.localhost install-app aishike_erp
bench --site erp.localhost migrate
```

安装后访问 `/desk/aishike-erp`，质量与入库工作台为 `/desk/aishike-quality-console`，销售履约工作台为 `/desk/aishike-fulfillment-console`。
