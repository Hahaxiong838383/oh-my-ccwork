# 领域原型

本目录用 Python 标准库实现爱视可 ERP 的第一条业务闭环，不依赖 ERPNext 或第三方包。

它不是生产系统，作用是先固定业务规则并提供可执行验收标准，后续映射为 Frappe DocType、Controller 和 Workflow。

## 运行

```bash
python3 -m unittest discover -s tests -v
python3 demo_flow.py
python3 web_app.py
```

浏览器打开 `http://127.0.0.1:8765`，即可手动体验SKU配置、组装、烧录、测试、入库、渠道订单、发货、激活和售后流程。

## 当前闭环

```text
批准SKU组合
  -> SKU与BOM
  -> 工单
  -> 设备SN
  -> 组装
  -> 固件/Agent烧录
  -> 光学/传感/功能/AI/老化/OQC测试
  -> 成品入库
  -> 天猫渠道SKU映射
  -> 渠道订单
  -> 分配SN
  -> 发货
  -> 激活
  -> SN全链路查询
```
