# Phicomm-T1（斐讯 T1 / S912）已验证配置

> 现场验收：2026-11-27。IP、固件版本和设备路径使用前仍须实时复查。

## 硬件真值

- 厂商 / 型号：斐讯 `Phicomm-T1`（刷机前 Android `ro.product.device=q201`）
- SoC / CPU：Amlogic S912，8× ARM Cortex-A53（`cpu0-3` 最高 `1.512 GHz`，`cpu4-7` 最高 `1.0 GHz`，支持 `aes/pmull/sha1/sha2/crc32`）
- 内存：2 GB DDR3（可用 `1.8 GiB`，空载占用约 `241 MiB`，`Swap: 0B`）
- eMMC：16 GB（`/dev/mmcblk2`，约 `14.6 GiB`：`mmcblk2p1` `511M` vfat `BOOT_EMMC` + `mmcblk2p2` `13.8G` ext4 `ROOTFS_EMMC`）
- Ethernet：百兆口 `100Mb/s Full Duplex`（`eth0`，MAC `fc:7c:02:50:5f:d9`）
- Wi‑Fi / BT：Broadcom 双频 Wi‑Fi（`brcmfmac`，`wlan0` 已识别、当前关闭）+ BT（`btbcm` / `hci_uart`）
- USB / 温度：1× USB 2.0；空载约 `54°C`

## 刷机前 Android 与关键排障结论

1. **原固件已解锁 U 盘引导**：刷机前为 webpad 官改 `DB1_0000_7.1.2_1.3T47_0123_SH`（Android 7.1.2），无需降级或线刷，直接 `adb shell reboot update` 即可从 U 盘启动 Armbian。
2. **无屏环境绕过 SuperSU 弹窗**：`adb shell su` 会触发 SuperSU `PromptActivity` 图形授权窗导致挂起（`uiautomator dump` 返回 `null root node`）。webpad 官改自带 root `busybox telnetd` 监听 `2323` 端口，直连即可取得 root shell。
3. **Android 静态以太网 IP 固化**：Android 7.1.2 静态网口配置存放在二进制 Java `DataOutputStream` v2 文件 `/data/misc/ethernet/ipconfig.txt`。用 `cat new > /data/misc/ethernet/ipconfig.txt` 原地覆写，可保留 `system:system 0600` 与 SELinux 上下文 `u:object_r:system_data_file:s0`。
4. **Windows 11（`maxtkf-server`）远端 raw 写盘校验陷阱**：向 `\\.\PhysicalDriveN` 写完 `.img` 后，若先调用 `IOCTL_DISK_UPDATE_PROPERTIES` 再做整盘回读 SHA-256，Win11 会瞬间自动挂载 FAT32 `BOOT` 分区并写入 `System Volume Information\WPSettings.dat`，导致整盘哈希失配。必须在刷新分区表**之前**回读校验，或分别校验 MBR+gap 与 ext4 ROOTFS 分区哈希，再核对 `BOOT\uEnv.txt` 与 DTB。
5. **首次 U 盘 SSH 绕过 firstlogin**：首次 U 盘启动走 DHCP（原 Android 静态 IP 失效，按 MAC `fc:7c:02:50:5f:d9` 与 Debian SSH banner 定位）。交互 SSH 会被 `armbian-firstlogin` 卡住；用 Python PTY 执行非交互 SSH 命令注入公钥并 `rm -f /root/.not_logged_in_yet`，可免交互接管。
6. **`armbian-install` 实测参数**：选择 ID `205` + 文件系统 `1`（`ext4`），即 `printf '205\n1\n' | armbian-install`：
   - profile：`s912-phicomm-t1`
   - DTB：`meson-gxm-phicomm-t1.dtb`
   - U-Boot overload：`u-boot-s905x-s912.bin`
   - filesystem：`ext4`
7. **写完 eMMC 预置静态 IP**：先在 U 盘系统用 `nmcli` 创建 `eth0-static.nmconnection`（`autoconnect-priority=100`），将该配置（`0600 root:root`）与 `/etc/hostname`、`/etc/hosts` 同步写入挂载的 `/dev/mmcblk2p2` 并 `sync && umount`，随后在 U 盘系统执行 `nmcli con up eth0-static` 实测切通 `192.168.1.241` 后再 `poweroff` 拔 U 盘，确保首次 eMMC 冷启直接落盘到目标静态 IP。

## 现场镜像与最终状态

- 系统：`Armbian 26.11.0` Debian 12 (`bookworm`)，内核 `6.12.117-ophub` aarch64
- 镜像母盘（`home-studio` 数据盘归档）：
  - `/data/home-studio/work/phicomm-t1-armbian/Armbian_26.11.0_amlogic_s912-phicomm-t1_bookworm_6.12.117_server_2026.11.14.img.gz`
  - 解压 `.img` SHA-256：`17e8d18f514315bbd2d4821412ab8c9bf2409c82f43327b420714828ec83ea10`
- 最终根 / 启动分区：`/` → `/dev/mmcblk2p2`（ext4），`/boot` → `/dev/mmcblk2p1`（vfat）
- 最终静态有线 IP：`192.168.1.241/24`（GW `192.168.1.1`，DNS `192.168.1.1;223.5.5.5`，主机名 `phicomm-t1`）
- SSH：`home-studio` 公钥 `~/.ssh/id_ed25519` 已免密写入 `/root/.ssh/authorized_keys`（初始 root 密码待改）
- 验收边界：拔 U 盘冷启动、eMMC 挂载、静态 IP、SSH 免密、硬件规格全部实机通过；定位为无头服务器，未验收 HDMI / GPU 硬解与 Wi‑Fi 客户端模式。
