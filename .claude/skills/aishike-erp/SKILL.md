---
name: aishike-erp
description: 爱视可智能 ERP 项目开发、部署与验收入口。用户提到爱视可 ERP、读写台产品线、公司虚拟机上的 ERPNext、SKU、SN、扫码枪、烧录、六项测试、质量门、成品入库、设备追溯或 M1/M2/M2.1/M2.2/M2.3 时使用。
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
7. 公司虚拟机运行状态：`ssh company-vm 'cd /home/futurus/aishike-erp && ./deploy/doctor.sh'`

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
- 运行版本基线：Frappe `16.30.0`、ERPNext `16.31.0`、`aishike_erp 0.1.0`

密码、Token、私钥、部署 `.env`、`deploy/secrets/`、备份和原始设备日志不得进入 Git、skill、记忆、截图或命令输出。

## 阶段闸门

| 阶段 | 状态 | 边界 |
|---|---|---|
| M1 | 已验收 | 中文化、SKU 主数据、批准锁定 |
| M2.1 | 已验收 | SN 规则、批量生成、条形码/二维码、扫码枪、组装登记 |
| M2.2 | 已验收 | 烧录历史、失败重试、六项测试、复测历史 |
| M2.3 | 等待指令 | 质量门、成品入库、完整设备追溯 |

**硬规则**：用户未明确说启动 M2.3 前，不写 M2.3 代码、不部署质量放行/入库入口，也不把设备推进到 `QC_PASSED` 或 `STOCKED`。

每次继续开发前同时核对用户最后一条阶段指令、项目 README、Git 工作区和服务器实际页面；任一处超出已授权阶段都必须停止，不能把“代码已写”或“自动化已通过”当成阶段授权。

## 业务规则

### SKU 与设备身份

- 销售只能选择工程批准的 SKU 属性组合；
- 已批准 SKU 的身份字段锁定，变更通过复制新版本完成；
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

### Frappe 实现约束

- Workspace 内部 `name/label/title` 保持稳定英文标识，中文使用翻译资源展示；
- 新增必填字段时同步更新静态 JSON、迁移钩子和静态校验器；
- 生命周期字段对用户只读，状态推进走控制器或业务 API；
- 生命周期事件追加写，并同步设备 `last_event_at`；
- 回退到较早阶段时，先清理 Workspace/Sidebar 中指向待删除 Page 或 DocType 的入口；Frappe 会先删除孤立对象再执行 `after_migrate`，残留链接会让迁移在保存导航时失败；
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
bash -n deploy/bootstrap.sh deploy/doctor.sh
```

失败时先判断是业务缺陷、验证器缺陷还是执行目录错误，禁止把命令使用错误误报成产品失败。

## 部署流程

1. 先在服务器 `deploy/backups/` 创建不含 `.env` 和 `secrets/` 的源码备份；
2. `rsync` 时排除 `deploy/.env`、`deploy/secrets/`、`deploy/backups/`、`output/` 和 `.playwright-cli/`；
3. 服务器运行 `./deploy/bootstrap.sh`，执行镜像构建、容器更新、站点迁移和翻译构建；
4. 运行 `./deploy/doctor.sh`，确认容器、应用、DocType、Page 和 ping；
5. 使用全新浏览器会话完成实际用户流程和控制台检查；
6. 项目源码提交前运行差异检查、密钥模式扫描并只暂存 `2-Projects/aishike-erp` 和本 skill。

阶段回退必须先备份源码与数据库，再同步目标提交、清理孤立导航、重跑迁移；最后同时证明目标阶段 DocType/Page 存在、越界阶段 DocType/Page 不存在、用户入口不可见。

## 验收证据要求

- 不能用容器 active 或 HTTP 200 替代业务验收；
- M2.1 必须证明连续生成不重复、扫码定位和组装登记；
- M2.2 必须证明失败烧录不推进、成功重烧推进、未烧录禁止测试、失败后复测恢复、记录不可修改、六项通过后仍停在 `FLASHED`；
- 截图保存在项目 `output/playwright/`，该目录不进入 Git；
- 提交和推送后核对本地与远端 SHA 一致；
- 主仓或共享记忆仓存在其他任务脏文件时，只做路径或索引级选择性暂存。

## 当前验收样本

- `ASK-000002`：两次烧录，第一次失败、第二次通过；光学第一次失败、第二次通过；六项最新结果全部通过，状态仍为 `FLASHED`；
- `ASK-000003`：已组装、未烧录，作为后续人工体验样本；
- M2.3：`WAIT_EXPLICIT_USER_COMMAND`。
