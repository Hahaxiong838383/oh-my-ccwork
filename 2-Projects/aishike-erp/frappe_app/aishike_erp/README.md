# Aishike ERP Frappe App

爱视可智能硬件 ERP 的 Frappe v16 自定义应用。

## 第一阶段能力

- SKU草稿、批准、停用状态管理；
- 草稿可编辑，批准后关键属性锁定；
- 设备SN、BOM、工单、固件和Agent版本关联；
- 设备生命周期状态机；
- 六类出厂测试及复测历史；
- 自定义 SN 生成规则、批量生成和序号重置策略；
- Code 128 条形码、二维码、键盘扫码枪和摄像头扫码；
- SN 工作台扫码定位设备并登记组装完成；
- 质量门未满足时禁止质量放行；
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

安装后访问 `/app/aishike-erp`。
