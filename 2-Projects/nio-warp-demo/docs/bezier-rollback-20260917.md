# 贝塞尔曲面功能开发前回滚点

创建时间：2026-09-17。此次在 `codex/nio-bezier-warp-20260917` 独立分支开发。

## 源码

- 基线提交：`51513d4dbf533ad7955f65b0c4aca4a6a1c4c5a6`。
- Git 标签：`nio-warp-before-bezier-20260917`。
- 本机只读归档：`.rollback/20260917-before-bezier/source.tar`。
- SHA256：`c050deadaa906b2350d20c3840f2108bebe320e694ac8523914394e23c12439b`。
- 在仓库根运行 `git archive nio-warp-before-bezier-20260917:2-Projects/nio-warp-demo` 可重新导出基线。
- 回退时先保存当前工作，再在隔离目录解包或新建基线 worktree。不要对 mycc 整仓使用 reset --hard，也不要覆盖其他项目未提交改动。

只读演练：在项目根目录执行 `sh native/scripts/verify-bezier-rollback.sh`，验证标签、归档哈希和 tar 可读性；不切换分支、不导入 defaults、不替换 App。如已取回开发机备份，可将其目录作为第一个参数，同时验证 App/偏好哈希及 plist 格式。

## 开发机的实际安装版和参数

机器：nio-war-mac；该机现有 App 是0.9.10(25)，不同于源码0.9.2基线。当前开发不覆盖该安装版。

远端目录 `/Users/futurus/.local/state/nio-war-mac/rollback/20260917-before-bezier/`：

| 文件 | SHA256 |
|---|---|
| NIOWarpApp-v0.9.10-25.zip | cc6741e20afe01cb587b491b1fa7a208b029e182c4f367d48a375887f24cf688 |
| warp-defaults.plist | c504dfbdff33e3c0121b28f2a5ce7484fffe729e52e7ff11a211eb26d7e56cad |

两文件权限0600。安装包与偏好不提交Git。

恢复前退出Warp，核对哈希，将当前安装版另行备份，再用ditto解包到原安装路径；只有确需回滚标定时才执行 `defaults import com.mycc.nio-warp-demo <备份plist>`。恢复后核对版本0.9.10(25)和签名，再启动并核实外屏。用户运行中的参数不因源码回退自动导入。

## Air 验收边界

当前仅在Air的 `/tmp` 隔离目录运行Swift测试；不安装App、不修改正式源码和用户偏好。用户明确要求后才安装体验版；安装前重新备份Air当时的App与配置，不用开发机配置替代Air标定。

新配置schema增加字段，旧版本不能读取新schema；回退App时必须配对对应旧偏好备份。
