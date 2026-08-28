# MGV3001-ZG / UNT413A5_GD2 已验证配置

> 现场验收：2026-08-29。IP、DHCP 租约和软件版本会漂移，使用前实时复查。

## 硬件真值

- 厂商/型号：九联 `MGV3001-ZG`，Android 硬件 ID `UNT413A5_GD2`
- Android product/device：`p291_iptv`
- Amlogic DT ID：`gxlx2_p291_2g`
- CPU：4× Cortex-A53；Android 为 32 位用户态，Armbian 为 aarch64
- 内存：约 2 GiB
- eMMC：Biwin 约 7 GiB；正确 DTB 下为 `/dev/mmcblk2`
- Ethernet MAC：`00:69:2d:9b:be:f8`，100 Mbps Full Duplex
- Wi‑Fi MAC：`50:a1:32:9f:eb:e0`

## 关键排障结论

1. Android 的 `192.168.1.158` 来自 Wi‑Fi；插网线后 Android `eth0` 获得过 `192.168.1.226`。因此第一次 Armbian 启动后旧 IP 消失，不等于启动失败。
2. 镜像原配置 `meson-gxl-s905l3b-m302a.dtb` 能启动、有线网络可用，但 eMMC 初始化报 `mmc2: error -84`，`lsblk` 看不到 eMMC，禁止用它安装。
3. `meson-gxl-s905l3b-e900v22e.dtb` 可同时驱动 Ethernet、RTL8822CS SDIO Wi‑Fi设备和 Biwin eMMC；eMMC 以 HS200 模式识别。
4. `armbian-install` 选择 ID `126`：
   - profile：`s905l3b-e900v22e`
   - DTB：`meson-gxl-s905l3b-e900v22e.dtb`
   - U-Boot overload：`u-boot-s905x-s912.bin`
   - filesystem：ext4
5. DTB 导致 `/proc/device-tree/model` 显示 `Skyworth E900V22E`，这是兼容 profile 名，不代表物理设备型号改变。

## 现场镜像与最终状态

- U盘系统：Armbian 24.11.0 / Ubuntu 24.04 / kernel `6.1.114-ophub`
- eMMC 分区：`BOOT_EMMC` 511 MiB + `ROOTFS_EMMC` 约 6.3 GiB
- 最终根：`/dev/mmcblk2p2`
- 最终 `/boot`：`/dev/mmcblk2p1`
- 最终有线 DHCP：`192.168.1.226`（仅为当时租约，不写死）
- SSH root 公钥已通过 U盘 ROOTFS 预置
- 拔 U盘后两次独立 eMMC 启动通过；boot ID 改变、failed units=0、storage errors=0
- HDMI/GPU 有非阻塞驱动报错；无头服务器路径通过，不得宣称 HDMI/GPU 已验收

## 回滚锚

完整 Android eMMC 备份：

- U盘：`/ddbr/BACKUP-arm-64-emmc.img.gz`
- 当次 Air 临时副本：`/tmp/MGV3001-ZG-emmc-backup-20260829.img.gz`（`/tmp` 非长期存储）
- SHA-256：`2071af26493ceec8c3838b41d902af1ed0ae12931fc00e5cd458a0f76d475cb2`
- 解压后前 4 MiB SHA-256：`b76908195f1ca1ae3c623f26ba4c8cf7e4df488e42b8abab2c422392fb6acb3e`

U盘恢复副本未另行确认前不要格式化。
