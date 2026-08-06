---
name: aishike-erp
description: 爱视可智能 ERP 项目开发、部署与验收入口。用户提到爱视可 ERP、读写台产品线、公司虚拟机上的 ERPNext、SKU、SN、扫码枪、烧录、六项测试、质量门、成品入库、渠道订单、发货、激活、设备追溯或 M1/M2/M2.1/M2.2/M2.3/M3 时使用。
layer: 项目层
authorization: B区（部署与阶段推进必须遵守用户验收闸门）
output_levels: L2
---

# 爱视可智能 ERP

## 先读真源

1. 项目状态：`~/mycc/2-Projects/aishike-erp/README.md`
2. 架构边界：`docs/architecture-v0.1.md`
3. 数据模型：`docs/data-model-v0.1.md`
4. M1 复盘：`docs/m1-retrospective.md`
5. M2 SN 方案：`docs/m2-sn-plan-v0.1.md`
6. M2.2 复盘：`docs/m2-2-retrospective.md`
7. M3 复盘：`docs/m3-retrospective.md`
8. SKU 命名规则：`docs/sku-naming-rule-v1.md`
9. Sheet1 SKU 导入复盘：`docs/sku-sheet1-retrospective.md`
10. 公司虚拟机运行状态：`ssh company-vm 'cd /home/futurus/aishike-erp && ./deploy/doctor.sh'`

历史文档只能作为基线；涉及容器、页面、数据或端口时必须重新实测。

## 固定拓扑

- 本地项目：`~/mycc/2-Projects/aishike-erp`
- 服务器项目：`/home/futurus/aishike-erp`
- SSH：`ssh company-vm`
- 服务端 Web：仅监听 `127.0.0.1:18080`
- 本机隧道：`ssh -N -L 18081:127.0.0.1:18080 company-vm`
- 浏览器：`http://aishike.localhost:18081`
- SN 工作台：`/desk/aishike-sn-console`
- 生产测试工作台：`/desk/aishike-production-console`
- 质量与入库工作台：`/desk/aishike-quality-console`
- 销售履约工作台：`/desk/aishike-fulfillment-console`
- 运行版本基线：Frappe `16.30.0`、ERPNext `16.31.0`、`aishike_erp 0.1.0`

密码、Token、私钥、部署 `.env`、`deploy/secrets/`、备份和原始设备日志不得进入 Git、skill、记忆、截图或命令输出。

## 阶段闸门

| 阶段 | 状态 | 边界 |
|---|---|---|
| M1 | 已验收 | 中文化、SKU 主数据、批准锁定 |
| M2.1 | 已验收 | SN 规则、批量生成、条形码/二维码、扫码枪、组装登记 |
| M2.2 | 已验收 | 烧录历史、失败重试、六项测试、复测历史 |
| M2.3 | 已验收 | 质量门、成品入库、仓库调拨、完整设备追溯 |
| M3 | 已验收 | 渠道订单、设备分配、发货与激活 |
| M4 | 未授权 | 售后 RMA、退换货、设备解绑与逆向物流 |

**硬规则**：M3 已通过人工验收；川哥未发出新的明确 M4 指令前，不规划或启动 M4，不创建 RMA、退换货、设备解绑或逆向物流对象。

每次继续开发前同时核对用户最后一条阶段指令、项目 README、Git 工作区和服务器实际页面；任一处超出已授权阶段都必须停止，不能把“代码已写”或“自动化已通过”当成阶段授权。

## 业务规则

### SKU 与设备身份

- 销售只能选择工程批准的 SKU 属性组合；
- 已批准 SKU 的身份字段锁定，变更通过复制新版本完成；
- P003 SKU 统一使用 `EC-{ProductLine}-{Model}-{Screen}-{Bundle}-{Version}`，产品线为 `T/S/T&S`，屏幕为 `N/A/V`，套装为 `N/S1/S2`；
- 内部 SKU 编码和 ERP 料号必须分离；不完整的 `FQT` 前缀只能标记为 `PENDING`，不能作为唯一主键；
- 飞书 Sheet1 外部主数据默认导入为 `Draft`，正式 ERP 料号、BOM 和审批责任未齐全前不得自动批准；
- Sheet1 当前验收基线为第 4–14 行 11 条唯一 SKU，其中 7 条 `CONFIRMED`、4 条 `PENDING`；
- SN 全局唯一且不可修改，生产日期必须显式选择，不能依赖服务器时钟；
- SN 批量分配在数据库事务中锁定规则记录，保持全成功或全失败；
- 条形码和二维码由 SN 即时派生，不保存图片真值；
- USB/蓝牙扫码枪优先支持 HID 键盘模式，配置扫描后发送 Enter/CR。

### 烧录与测试

- 状态必须由真实业务记录驱动，不允许只改设备状态；
- 烧录通过记录存在后才能完成 `ASSEMBLED → FLASHED`；
- 烧录和测试记录不可修改，失败后新增记录重试；
- 烧录失败和测试失败必须填写原因；
- 六项测试为 `OPTICAL/SENSOR/FUNCTION/AI/AGING/OQC`；
- 当前测试状态取每项最新记录，完整历史永久保留；
- ERP 只保存日志引用、脱敏摘要和必要结构化测量值。

### 渠道订单与履约

- 支持 `TMALL`、`JD`、`DEALER`，渠道 SKU 只能映射到已批准内部 SKU；
- `渠道 + 渠道范围 + 外部订单号` 是订单幂等键，重复内容冲突时拒绝覆盖；
- 新订单必须使用启用映射，映射停用后历史订单仍可继续履约和刷新投影；
- 只有 `STOCKED`、SKU 匹配且存在当前仓库的设备可以分配；
- 发货必须先分配并保存承运商、物流单号和实际出库仓库；
- 激活必须发生在发货后，收货对象、原始报文、激活和客户脱敏引用均禁止出现手机号和邮箱；
- 分配、发货和激活记录不可修改、不可删除，设备和订单状态只能由凭证派生；
- Sales Manager 维护映射和订单，Stock Manager 分配与发货，System Manager 或设备云受控入口激活。

### M3 经验规则

- 权限 JSON 和按钮显隐只证明“配置看起来正确”；必须用临时真实用户执行销售建单、仓库分配/发货、系统激活，并在事务回滚后验证用户、订单、映射和凭证残留为 0；
- 设备与订单状态必须由不可修改凭证投影，验收同时核对订单计数、设备状态、最近凭证、仓库清空、物流/激活投影和生命周期事件，不能只看一个状态字段；
- 新订单要求启用映射，但映射停用不能阻断历史订单的投影刷新与后续履约；新建约束和历史可追溯性要分开处理；
- 所有标为“脱敏引用”的字段都要执行同一隐私校验，不能只保护收货对象和激活字段而漏掉原始报文引用；
- 浏览器自动化工具可能在操作日志中回显填充值；敏感值一旦被工具回显，立即轮换服务端凭据，后续只通过受限文件到剪贴板传递；
- 部署前同时备份源码和数据库，`rsync` 排除 `.env`、`secrets/`、`backups/`、`output/` 和浏览器产物；部署后做连续自动验收、容器重启复验、全新浏览器闭环和源码零漂移检查；
- 公网目标必须先核对设备真值；爱视可 ERP 只部署 `company-vm`，Studio 仅可做连通性验证，不得因用户口误把业务系统部署到错误主机；
- 阶段完成不等于下一阶段获批；M3 已验收，但 M4 仍保持 `WAIT_EXPLICIT_USER_COMMAND`。

### SKU 外部主数据经验规则

- 表格元数据行数不能作为业务数量；先读取目标 Sheet 的有效业务列，过滤空白模板行，并保留来源表、Sheet 和行号；
- 命名规则如果分散在生成器或配置 Sheet，应先核对生成公式，再以用户指定的业务 Sheet 作为导入内容真源；
- 导入器必须以结构化 SKU 编码幂等，重复运行应只返回复用记录，不能生成重复 Item 或 SKU；
- 新结构化模型与历史颜色/硬件模型并存时，唯一性校验按模型分支执行，并在新 SKU 表单隐藏无关兼容字段；
- 数据库计数、迁移成功和 HTTP 200 不足以验收；必须在真实列表与详情页确认数量、字段、状态、来源追踪和控制台 0 错误；
- Playwright CLI 填写敏感字段可能回显内容；剪贴板粘贴在无头浏览器中也可能不可用。必须从服务器受限文件读入临时 shell 变量，执行填充时重定向标准输出与错误输出，使用后立即 `unset`，禁止把真实值写入命令文本、截图、日志或记忆。

### Frappe 实现约束

- Workspace 内部 `name/label/title` 保持稳定英文标识，中文使用翻译资源展示；
- 新增必填字段时同步更新静态 JSON、迁移钩子和静态校验器；
- 生命周期字段对用户只读，状态推进走控制器或业务 API；
- 生命周期事件追加写，并同步设备 `last_event_at`；
- 回退到较早阶段时，先清理 Workspace/Sidebar 中指向待删除 Page 或 DocType 的入口；Frappe 会先删除孤立对象再执行 `after_migrate`，残留链接会让迁移在保存导航时失败；
- 目标阶段的迁移钩子必须主动剔除后续阶段导航目标，不能只依赖人工清理或 Frappe 的孤立对象删除；M2.2 当前需清除 `aishike-quality-console`、质量放行和库存移动入口；
- Frappe 删除 DocType/字段元数据后可能继续保留物理表、隐藏列和已投影的设备状态；M2.2 回退必须清理 M2.3 夹具与越界事件、由组装/烧录凭证重新派生状态，并确认孤立表与隐藏列为 0；
- 正常浏览器路径必须做到控制台 0 错误，负向业务校验另行保留证据。

## 开发验证

```bash
cd ~/mycc/2-Projects/aishike-erp/frappe_app/aishike_erp
python3 -m unittest discover -s tests -v
python3 scripts/validate_app.py
python3 -m compileall -q aishike_erp

cd ~/mycc/2-Projects/aishike-erp/prototype
python3 -m unittest discover -s tests -v

cd ~/mycc/2-Projects/aishike-erp
node --check frappe_app/aishike_erp/aishike_erp/aishike_erp/page/aishike_sn_console/aishike_sn_console.js
node --check frappe_app/aishike_erp/aishike_erp/aishike_erp/page/aishike_production_console/aishike_production_console.js
node --check frappe_app/aishike_erp/aishike_erp/aishike_erp/page/aishike_quality_console/aishike_quality_console.js
node --check frappe_app/aishike_erp/aishike_erp/aishike_erp/page/aishike_fulfillment_console/aishike_fulfillment_console.js
bash -n deploy/bootstrap.sh deploy/doctor.sh
```

失败时先判断是业务缺陷、验证器缺陷还是执行目录错误，禁止把命令使用错误误报成产品失败。

## 部署流程

1. 先在服务器 `deploy/backups/` 创建不含 `.env` 和 `secrets/` 的源码备份；
2. `rsync` 时排除 `deploy/.env`、`deploy/secrets/`、`deploy/backups/`、`output/` 和 `.playwright-cli/`；
3. 服务器运行 `./deploy/bootstrap.sh`，执行镜像构建、容器更新、站点迁移和翻译构建；
4. 运行 `./deploy/doctor.sh`，确认容器、应用、DocType、Page、阶段内设备状态/事件、夹具、孤立表、隐藏列和 ping；该脚本必须调用 fail-closed 的 `assert_runtime_check`；
5. 使用全新浏览器会话完成实际用户流程和控制台检查；如果复用登录态，必须清空 localStorage 和 sessionStorage，避免已删除页面被旧缓存伪装成仍可访问；
6. 项目源码提交前运行差异检查、密钥模式扫描并只暂存 `2-Projects/aishike-erp` 和本 skill。

阶段回退必须先备份源码与数据库，再同步目标提交、由目标阶段迁移钩子清理导航、测试夹具、越界事件、状态投影、孤立表和隐藏列，重跑迁移；最后用 fail-closed 运行检查和清空浏览器存储的独立上下文证明所有越界对象为 0、正常设备状态由凭证派生、越界路由返回“页面未找到”。

## 验收证据要求

- 不能用容器 active 或 HTTP 200 替代业务验收；
- M2.1 必须证明连续生成不重复、扫码定位和组装登记；
- M2.2 必须证明失败烧录不推进、成功重烧推进、未烧录禁止测试、失败后复测恢复、记录不可修改、六项通过后仍停在 `FLASHED`；
- M2.3 必须证明质量驳回不推进、再次放行进入 `QC_PASSED`、成品入库进入 `STOCKED`、仓库调拨保留完整历史、岗位权限最小化和 M3 状态防越界；
- M3 必须证明订单幂等、SKU/库存/数量门禁、缺物流不可发货、未发货不可激活、隐私字段阻断、凭证不可篡改、五岗位真实动作链及事务回滚、桌面/手机无横向溢出和控制台 0 错误；
- 截图保存在项目 `output/playwright/`，该目录不进入 Git；
- 提交和推送后核对本地与远端 SHA 一致；
- 主仓或共享记忆仓存在其他任务脏文件时，只做路径或索引级选择性暂存。

## 当前验收样本

- `ASK-000002`：M2.3 自动闭环样机，已完成驳回、放行、入库和调拨；
- `ASK-000003`：已组装、未烧录，作为后续人工体验样本；
- `ASK-000015`：M2.3 人工验收样机，六项测试通过，停在 `FLASHED`；
- `ASK-000016`：M2.3 浏览器端完整闭环样机，已调拨至 `Stores - ASK`；
- `ASK-000017` / `ASK-ORD-00009`：M3 自动闭环样机与订单，已激活；
- `ASK-000019` / `ASK-ORD-00013`：M3 浏览器完整闭环样机与订单，已激活；
- `ASK-000020` / `ASK-ORD-00015`：M3 人工验收样机与订单，已完成分配、发货和激活；
- 飞书 Sheet1 SKU：11 条已导入并通过人工界面验收，正式料号 7 条、待补料号 4 条，全部保持草稿；
- M3：`ACCEPTED`；M4：`WAIT_EXPLICIT_USER_COMMAND`。
