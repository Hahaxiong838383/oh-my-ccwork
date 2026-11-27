---
name: amlogic-armbian-flash
description: Amlogic 安卓机顶盒从 root ADB/telnetd 启动 Armbian、Windows 远端安全写 U 盘、选择/修正 DTB、备份并写入 eMMC、预置静态 IP、回滚和独立启动验收的安全 SOP。用户提到“机顶盒刷 Armbian”“Amlogic 刷 Linux”“Phicomm-T1”“S912”“S905L/S905X”“aml_autoscript”“armbian-install”“eMMC 找不到”“mmc error -84”“USB 启动后失联”时使用。
---

# Amlogic Armbian 安全刷机

适用于已能通过 root ADB（或官改内置 root telnetd）控制的 Amlogic 电视盒/运营商机顶盒。目标是先证明 U 盘启动和硬件兼容，再写 eMMC；不能把“脚本运行成功”当成交付。

已验证机型参考：

- `MGV3001-ZG` / `UNT413A5` / `gxlx2_p291_2g`：先读 [`references/mgv3001-zg.md`](references/mgv3001-zg.md)
- `Phicomm-T1` / `q201` / `S912`（webpad 官改 + Windows 远端写盘 + 静态 IP 固化）：先读 [`references/phicomm-t1.md`](references/phicomm-t1.md)

## 不可跳过的安全门

1. **先只读识别**：制造商、型号、SoC、DT ID、内存、eMMC、USB 盘、启动分区和网络接口。
2. **先 U 盘启动，后写 eMMC**：未通过 USB Armbian 的 SSH、网卡、eMMC 识别测试，禁止执行 `armbian-install`。
3. **DTB 必须同时满足两件事**：系统能联网，且 `lsblk` 能看到真实 eMMC 和 `mmcblk*boot0/boot1`。能启动但看不到 eMMC 仍是不兼容。
4. **回滚策略明确**：需要保留原 Android 时执行两级备份（激活 multiboot 前备份 bootloader/env/boot/recovery；写盘前用 `armbian-ddbr` 做完整 eMMC 压缩镜像并复制到另一台机器，校验 `gzip -t`、整包 SHA-256 及解压后前 4 MiB SHA-256）。若用户明确放弃原 Android 直接全盘覆盖，也必须留存母盘镜像与校验记录。
5. **最终验收必须拔掉 U 盘**：根分区和 `/boot` 都来自 eMMC，且独立上电/重启后仍可 SSH。
6. IP、盘符、DTB 和 eMMC 编号均以实时探测为准，禁止照抄案例值。

## 阶段 1：Android 只读预检

优先复用本机已有 `adb`，不要因为 PATH 中没有就盲目安装：

```bash
ADB="${ADB:-$(command -v adb || echo "$HOME/Library/Android/sdk/platform-tools/adb")}"
"$ADB" connect <android-ip>:5555
"$ADB" -s <android-ip>:5555 shell '
  id
  getprop ro.product.manufacturer
  getprop ro.product.model
  getprop ro.product.device
  getprop ro.hardware
  cat /proc/device-tree/amlogic-dt-id 2>/dev/null | tr "\000" "\n"
  cat /proc/partitions
  mount
  ip -br addr
'
```

判读与排障：

- `uid=0(root)` 才能做分区备份或写系统配置。
- **无屏盒子 `adb shell su` 挂起**：SuperSU 弹出图形授权窗 `PromptActivity` 时，无 HDMI/触控无法点击且 `uiautomator dump` 常报 `null root node`。先查盒上监听端口（`netstat -tlpn` / `ss -tlpn`），例如 webpad 官改（如 Phicomm-T1 `1.3T47`）自带 root `busybox telnetd` 监听 `2323` 端口，直连即可取得 root。
- **Android 7.x 固化有线静态 IP**：配置位于二进制 Java `DataOutputStream` v2 文件 `/data/misc/ethernet/ipconfig.txt`。用 `cat new > /data/misc/ethernet/ipconfig.txt` 原地覆写，避免改坏 `system:system 0600` 权限与 SELinux 上下文 `u:object_r:system_data_file:s0`。
- Android 的管理 IP 可能属于 Wi‑Fi；用 `ip -br addr`、`carrier`、MAC 和路由确认，不能把“局域网 IP”自动当作有线口。
- Android 通常没有 `sshd`。22 端口拒绝但 ADB 5555 可用时，继续用 ADB，不要把它误判为设备离线。

## 阶段 1.5：Windows 宿主机远端安全写盘（无本地读卡器时）

当 U 盘插在局域网 Windows 宿主机（如 `maxtkf-server`）时：

1. **镜像归档与传输**：先在控制机数据盘（home-studio 遵循 `HOME-STUDIO-STORAGE.md`，存 `/data/home-studio/work/<device>-armbian/`）下载并解压 `.img`，记录完整 SHA-256，再 `scp` 到 Windows 临时目录。
2. **四元组锁定目标盘**：通过 `Get-Disk` 核验 `Number`、`BusType -eq 'USB'`、`SerialNumber` 和精确字节 `Size`，禁止仅凭盘符盲写。
3. **脚本传文件执行**：禁止把多行 PowerShell/C# 嵌在 `ssh '...'` 双引号里（嵌套转义极易静默丢失代码）。一律本地生成 `.ps1`，`scp` 上去后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File ...`。
4. **原始写盘与 SHA-256 校验陷阱**：
   - `diskpart clean` 后用 Win32 `CreateFileW("\\.\PhysicalDriveN", ..., FILE_FLAG_WRITE_THROUGH)` 顺序写入并 `FlushFileBuffers`。
   - **关键坑**：调用 `IOCTL_DISK_UPDATE_PROPERTIES` 会让 Windows 11 立刻自动挂载 FAT32 `BOOT` 分区并写入隐藏目录 `System Volume Information\WPSettings.dat`，导致写完后整盘回读 SHA-256 与源 `.img` 失配。
   - **正确校验法**：在调用 `IOCTL_DISK_UPDATE_PROPERTIES` **之前**完成整盘回读 SHA-256；若已刷新分区表，则分别比对 **MBR+gap** 与 **ext4 ROOTFS 分区** SHA-256，并直接检查挂载出的 `BOOT\uEnv.txt` 和目标 `.dtb` 文件。
5. 校验通过后安全弹出 U 盘，并清理 Windows 宿主机上的临时镜像目录。

## 阶段 2：激活 multiboot 前的小备份（需保留原系统时）

把关键 Android 分区备份到 U 盘 ROOTFS，同时复制到控制机临时目录：

```sh
B=<usb-rootfs>/root/android-backup-$(date +%Y%m%d)-pre-armbian
mkdir -p "$B"
for x in bootloader env boot recovery dtbo vbmeta misc logo; do
  [ -e "/dev/block/$x" ] && dd if="/dev/block/$x" of="$B/$x.img" bs=1M
done
(cd "$B" && sha256sum *.img > SHA256SUMS)
sync
```

`aml_autoscript` 通常会 `saveenv`，所以至少要在第一次 `reboot update` 前保留原始 `env` 和 bootloader。

## 阶段 3：为首次 SSH 预置公钥（如在 Linux/Android 侧可挂载 ROOTFS）

若当前可直接挂载 U 盘 ROOTFS，在其中追加控制机公钥（禁止复制私钥）：

```sh
mkdir -p <usb-rootfs>/root/.ssh
cat <temporary-public-key> >> <usb-rootfs>/root/.ssh/authorized_keys
chown -R 0:0 <usb-rootfs>/root/.ssh
chmod 700 <usb-rootfs>/root/.ssh
chmod 600 <usb-rootfs>/root/.ssh/authorized_keys
sync
```

确认 `/etc/ssh/sshd_config` 允许 root 公钥登录。使用有线网第一次启动；如果 Android 当前只有 Wi‑Fi，Armbian 启动后很可能会换 IP。

## 阶段 4：U 盘启动、免交互接管与 DTB 闭环

```bash
adb -s <android-ip>:5555 reboot update
```

不要只盯旧 Android IP（Armbian 首次 U 盘启动走 DHCP）；根据有线 MAC 查 DHCP/ARP，并扫描 SSH 22 与 Debian/Ubuntu OpenSSH banner。首次启动 SSH 可能先开放 socket、稍后才返回 banner，允许等待 1–3 分钟后重试。

### 无交互绕过 `armbian-firstlogin`（Windows 写盘未预置公钥时）

交互式 SSH 首次登录会被 `armbian-firstlogin`（等待 `NetworkManager-wait-online` + 强制改密向导）阻塞。用 Python `pty` 执行**非交互 SSH 命令**送入 Armbian 初始口令，可直接写入 `/root/.ssh/authorized_keys`（`700/600`）并执行 `rm -f /root/.not_logged_in_yet`，随后即可全程免密自动化操作（完工后提醒用户修改 root 密码）。

登录后最小验收：

```bash
uname -a
ip -br addr
lsblk -e 7 -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
systemctl --failed --no-pager
dmesg | grep -Ei 'mmc|sdhci|I/O error|EXT4-fs error'
```

### DTB 判读

- **网卡正常但没有 eMMC**：先换 DTB，禁止运行安装器。
- `mmc*: error -84 whilst initialising MMC card` 常见于 eMMC 时序/电压模式不匹配；比较候选 DTB 的 `mmc@74000` 中 `mmc-ddr-1_8v`、`mmc-hs200-1_8v`、`max-frequency`、供电和 pinctrl。
- 每次只改 `uEnv.txt` 的 `FDT=`，保留一份已知可启动配置，重启后同时复验 Ethernet 和 eMMC。
- 需要从 Android boot image 的 Amlogic `AML_` multi-DTB 包提取原厂 DTB 时，使用：

```bash
python3 scripts/extract-amlogic-multidtb.py <decompressed-multidtb.bin> <output-dir>
```

## 阶段 5：完整 eMMC 回滚镜像（需保留原系统时）

只有 eMMC 已被正确识别后才执行：

```bash
printf 'b\n' | armbian-ddbr
```

验收：

```bash
sha256sum /ddbr/BACKUP-arm-64-emmc.img.gz
gzip -t /ddbr/BACKUP-arm-64-emmc.img.gz
python3 - <<'PY'
import gzip, hashlib
p = "/ddbr/BACKUP-arm-64-emmc.img.gz"
with gzip.open(p, "rb") as f:
    data = f.read(4 * 1024 * 1024)
print(len(data), hashlib.sha256(data).hexdigest())
PY
```

再把镜像复制到控制机并复算 SHA-256。U 盘和控制机副本哈希不一致时停止。

## 阶段 6：写入 eMMC 与静态 IP 预置

从 `/etc/model_database.conf` 选择**已通过 USB 实测的 DTB/bootloader 组合**，不能只按商品名猜型号。优先 ext4；除非已验证需要，否则保留安装器默认 bootloader/ampart 策略。

```bash
# 交互式或确认 ID 与文件系统编号后无交互执行（例：Phicomm-T1 为 ID 205、ext4 为 1）
printf '<model-id>\n1\n' | armbian-install
```

完成后先不要立刻断电，检查：

```bash
lsblk -f <emmc-device>
fsck.vfat -n <emmc-boot-partition>
e2fsck -fn <emmc-root-partition>
```

挂载两个分区，确认并预置网络配置：

- eMMC `/boot/uEnv.txt` 使用已验证 DTB；
- `authorized_keys` 存在且权限为 `700/600`；
- `/etc/fstab` 指向新的 eMMC ROOTFS UUID 和 `BOOT_EMMC`；
- `/etc/ophub-release` 标记 `DISK_TYPE='emmc'`；
- **需要固定静态 IP 时**：先在 U 盘系统用 `nmcli` 新建静态连接（设 `connection.autoconnect-priority 100`），把 `/etc/NetworkManager/system-connections/<name>.nmconnection`（确保 `0600 root:root`）、`/etc/hostname` 和 `/etc/hosts` 同步写入挂载的 eMMC ROOTFS，执行 `sync && umount` 后，先在 U 盘系统跑 `nmcli con up <name>` 实测切通目标静态 IP，确认新 IP SSH 可达再 `sync && systemctl poweroff`，物理拔掉 U 盘重新上电。

## 阶段 7：最终独立启动验收

```bash
findmnt -no SOURCE,FSTYPE /
findmnt -no SOURCE,FSTYPE /boot
lsblk -e 7
ip -br addr
systemctl --failed --no-pager
dmesg | grep -Ei 'mmc.*error|I/O error|EXT4-fs error|Buffer I/O'
```

必须证明：

- `/` 和 `/boot` 均来自 eMMC；
- U 盘盘符不存在；
- 目标静态 IP（如有）与主机名生效，SSH、网关、DNS 可用；
- eMMC 小文件写入、`sync`、哈希和删除均成功；
- 再执行一次受控重启，boot ID 改变后仍从 eMMC 启动；
- failed units 和存储 I/O 错误为 0。

HDMI/GPU 报错与无头服务器用途要分开判定：网络和存储通过不代表 HDMI/硬解可用，最终汇报必须明确功能边界。

## 回滚

首选从 U 盘 Armbian 启动后运行 `armbian-ddbr` 的 restore；若 multiboot/bootloader 已损坏，再使用原厂 USB Burning/MaskROM 路径。恢复前重新校验备份 SHA-256，禁止把备份文件和目标 eMMC 盘符写反。
