# 爱视可智能 ERP

面向爱视可读写台产品线的智能硬件 ERP 项目，覆盖产品配置、采购、自有组装测试、全渠道销售、设备 SN 生命周期和公司自营售后。

## 当前状态

- 阶段：M2.1、M2.2、M2.3、M3 已通过人工验收；M4 等待川哥明确指令
- 核心底座：ERPNext/Frappe
- 第一优先级：SKU/BOM、采购、组装测试、库存、渠道订单、SN追溯、售后RMA
- 暂缓：AI会员订阅计费、复杂经销商返利、自动化AI审批
- 测试环境：公司 Ubuntu 虚拟机仅绑定 `127.0.0.1:18080`，本机通过 `http://aishike.localhost:18081` 访问
- M1 验收：中文登录、工作台、SKU 列表、草稿编辑、批准锁定和浏览器控制台均已通过
- M2.1 验收入口：`http://aishike.localhost:18081/desk/aishike-sn-console`
- M2.1 已覆盖：自定义 SN 规则、批量生成、Code 128/Code 39、二维码、HID 扫码枪、摄像头扫码和组装登记
- M2.2 验收入口：`http://aishike.localhost:18081/desk/aishike-production-console`
- M2.2 已覆盖：烧录失败/重试、版本追溯、不可覆盖记录、六项测试和复测历史
- M2.3 验收入口：`http://aishike.localhost:18081/desk/aishike-quality-console`
- M2.3 已覆盖：质量驳回/放行、成品入库、仓库调拨、岗位最小权限和 SN 全链路追溯
- M2.3 人工验收样机：`ASK-000015`，已完成烧录与六项测试，等待质量判定
- M3 验收入口：`http://aishike.localhost:18081/desk/aishike-fulfillment-console`
- M3 已覆盖：天猫/京东/线下经销 SKU 映射、订单幂等、扫码分配、物流发货、脱敏激活、岗位最小权限和不可覆盖履约凭证
- M3 人工验收订单：`ASK-ORD-00015`；样机：`ASK-000020`，已完成分配、发货和激活闭环

## 已确认业务边界

- 公司自有组装和测试环节
- 销售渠道为天猫、京东、线下经销
- SKU 少于 100，颜色、套餐和配件作为受控销售属性
- 当前没有完整 ERP、OMS、WMS、客服和设备生命周期系统
- AI会员前期随硬件赠送，不作为第一阶段核心需求
- 售后由公司自营
- 视光原始数据保留在独立敏感数据域
- 儿童档案最小化保存，原始语音不长期保存，运营数据脱敏

## 文件索引

- `docs/architecture-v0.1.md`：系统边界、业务主链和阶段规划
- `docs/data-model-v0.1.md`：ERPNext标准对象与爱视可自定义对象映射
- `docs/m1-retrospective.md`：M1 中文化、部署和真实浏览器验收复盘
- `docs/m2-sn-plan-v0.1.md`：M2 设备 SN、条码、二维码与扫码枪方案
- `docs/m2-2-retrospective.md`：M2.2 烧录、六项测试和阶段闸门复盘
- `docs/m3-channel-fulfillment-plan-v0.1.md`：M3 渠道订单、设备分配、发货与激活边界
- `docs/m3-manual-acceptance-guide.md`：M3 人工验收步骤和通过标准
- `docs/m3-retrospective.md`：M2.3/M3 质量库存、渠道履约、部署与验收复盘
- `prototype/`：不依赖第三方库的可执行领域原型与人工验收界面
- `frappe_app/`：Frappe v16 自定义应用源码，包含真实DocType与控制器
- `deploy/`：公司虚拟机的隔离测试环境、主机准备、部署和运行检查脚本

## 当前原型覆盖

原型已定义并验证以下业务规则：

1. 销售只能选择工程批准的SKU属性组合；
2. 每个实体SKU必须绑定有效BOM版本；
3. 设备必须完成组装、烧录和全部强制测试才能入库；
4. 渠道订单必须先映射内部SKU；
5. 只有库存中的设备才能分配订单；
6. 设备发货后才能激活；
7. 任意SN可以追溯SKU、BOM、工单、测试、渠道订单和生命周期事件。

## 本地验证

```bash
cd prototype
python3 -m unittest discover -s tests -v
python3 demo_flow.py
python3 web_app.py
```

启动后访问 `http://127.0.0.1:8765` 进行人工体验验收。

## SKU编辑规则

- 当前轻量演示数据是已批准状态，因此界面只读符合预期；
- 真实ERPNext中，`Draft` SKU可以编辑颜色、硬件配置、区域、BOM和套餐；
- `Approved` 后关键属性锁定，只允许停用或复制为新SKU；
- `Disabled` 保留历史追溯，不允许删除或恢复草稿。

## 下一步

1. M2.1：已通过人工验收；
2. M2.2：已通过人工验收；
3. M2.3：已通过人工验收；
4. M3：已完成部署、多轮自动验收、重启复验、浏览器闭环和川哥人工验收；
5. M4：未授权，等待川哥明确指令后再规划或启动售后 RMA、退换货和设备解绑；
6. 每个阶段先提供真实界面人工验收，通过后再进入下一阶段。
