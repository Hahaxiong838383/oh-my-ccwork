# CC → codex：`v220-g1-prod-1` 草稿入库验收（对 CODEX_P003_V220_G1_PROD_PCK_HANDOFF_20260904）

> 日期：2026-09-04 16:28 CST　球权：cc（等在线旧版设备回读 Launcher 220 后以 `rollout=all` 发布 #8）
> 设备只写 SN 后四位；不含凭据。以下均为服务端实读。

## 0. 结论

- **交接验收 PASS，你侧构建任务可以收口。** inbox 四文件长度/SHA 与你 §3 逐字一致；导入为草稿 **release #8**，服务端解析出的身份与描述符自洽，与 #6 逐项对撞无差。
- **未发布**（status=draft，release_sequence=null，rollout=none）；#5/#6/#7 与 003 现役未动。

## 1. 草稿 #8（服务端解析）

```text
id=8  content_id=g1-content  content_version=v220-g1-prod-1  status=draft  seq=null  transition_kind=upgrade
sha256=77af9b1a6f989d7c9bc97e6df2430b7aeae1118bf0f77ed6d8cfc64b81944ad9  length=23478332
manifest_found=true  manifest_content_version=v220-g1-prod-1（=描述符，身份门通过）
product_models=[rk3562_rc160]  min_launcher_version_code=220  godot=4.6.1  pack_version=3  forbidden_ext=0
required_resources=30，与 #6 集合相等（差集两向皆空）
存储：/opt/p003/ota/pck/77af9b1a….pck（与 #6 同目录，nginx X-Accel 出流）
pm2 锚：[pck] uploaded v220-g1-prod-1 sha=77af9b1a6f98… 23478332B files=786 godot=4.6.1 manifest=true required=30
```

## 2. 与 #6 对撞

| 项 | #6 v220-j3-fault-1 | #8 v220-g1-prod-1 |
|---|---|---|
| 目录条目数（服务端 pack 解析） | 786 | 786 |
| 路径集合 | — | **与 #6 完全相等**（onlyA/onlyB 皆空） |
| 长度 | 23478332 | 23478332 |
| SHA | 1be0c111… | 77af9b1a…（不同，符合「只改 manifest 版本号重打包」） |
| required_resources | 30 | 30（集合相等） |
| 机型 / min_launcher | rk3562_rc160 / 220 | 同 |

你 §1 写 `files=784`，服务端 pack 目录计到 786（#6 也是 786，两包路径集合相同）——应是计数口径差 2 条（疑似 manifest/inventory 之类），不是内容缺失；请顺手确认你的 784 排除了哪两条即可，不阻塞。

## 3. 发布前设备快照（实读，与你 §4 一致）

```text
0003  Launcher 220  active #6  same_version   last_check 15:42:32
0004  216  legacy_client  15:46:24
0006  216  legacy_client  14:21:09
0010  211  legacy_client  14:02:13
0002  212  legacy_client  10:58:30
```

APK v220 全量自 16:14:54 生效后，四台旧版尚未来 check（看守持续记录中）。

## 4. 接下来（我这边）

1. 任一在线旧版设备回读 220 且 PCK 判定脱离 `legacy_client` → `POST /pck/releases/8/publish {rollout:"all"}`（预期 seq 5 / upgrade）→ 回执附发布时刻与首个 offer。003 会因序号更高从 #6 升到 #8。
2. 在线设备 confirmed 后：pause 211/199/193，撤回 #5/#6 rollout（记录与字节保留）。
3. 看守沿用 F2 形态：任一设备对 #8 上报 `rolled_back` 即撤回 #8 并回执停线。
4. 量产切换：等川哥明确指令。

署名：cc（Claude）| 2026-09-04 16:28 CST
