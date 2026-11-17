---
name: wechat-mp-ops
description: 微信小程序在本机的开发、真机调试与自建后端运维。覆盖 docker 远程桌面里的微信开发者工具（Xvfb+selkies）、appid 选择（小程序 vs 小游戏）、编译/预览码自动化、家里 Piper TTS 与 RapidOCR 服务、Lucky 反代到公网、真机 urlCheck 限制。触发词："小程序"、"微信开发者工具"、"秒懂预览码"、"拍课本识别"、"小程序发音"、"小程序 OCR"、"WechatSI"、"同声传译插件"、"urlCheck"、"downloadFile 合法域名"、"VisionKit"。
---

# 微信小程序开发与自建后端（本机真值）

**一句话**：微信给的两条原生能力（TTS 插件、VisionKit OCR）都不可用，**发音和 OCR 全部自建在家里
（Piper / RapidOCR）经 Lucky 反代暴露**；开发环境是 docker 里的 Xvfb + selkies 远程桌面跑官方
开发者工具，用 xdotool + CDP 自动化。

## 关键事实

| 项 | 值 |
|---|---|
| 项目 | `~/MyAgent/2-Projects/P02-英语学习App/miniprogram/` |
| 容器 | `wxdt-ide`（Ubuntu 24.04 + Xvfb 2048×1536 + openbox + selkies），GPU `/dev/dri` 映射 |
| 远程桌面 | `https://10.10.10.23:3002/` |
| 容器内工程路径 | `/config/projects/wordpath`（`/config` 是挂载卷，重建不丢） |
| 启动/截图 | `~/mycc/2-Projects/wechat-mp-env/bin/wxdt-ide ide` / `wxdt-ide shot /tmp/x.png` |
| **可用 appid** | `wx55e19a8ad4ffc774`（HUD计算助手，**已认证已备案**，推荐）／`wx0cd11032ce83b77b`（新注册未认证） |
| **不可用 appid** | `wxdc44a36b9eb7bae6`（小游戏，要 `game.json`）、`wx0102ed7a38028e17`（测试号，无插件无域名） |
| TTS 服务 | home-studio `:8790`，`scripts/tts-server.py`，`wordpath-tts.service` |
| OCR 服务 | home-studio `:8791`，`scripts/ocr-server.py`，`wordpath-ocr.service` |
| 公网反代 | Lucky（`192.168.1.115:16601/Max121211`）→ `tts/ocr.hahaxiong.cc:8666` |
| 公网 IPv4 | `120.244.92.4`（家宽，8666 已映射；80/443 未映射） |

## 一、appid 选择（先做这步，选错白干）

1. 后台 `https://mp.weixin.qq.com/` 登录 → 看左侧是否只有「小程序」而**没有**「游戏」字样
2. 「开发管理 → 开发设置」能正常显示 AppID + 服务器域名 + API 安全 → 是**小程序**
3. 类目**绝不能**带「游戏」：会连锁触发 IDE 的 `Error: game.json: 未找到 game.json 文件`
4. 改 `project.config.json` 的 `appid`，重新编译验证 `⊗ 0 ⚠ 0`

## 二、编译与预览码自动化

```bash
# 编译
docker exec -u abc -e DISPLAY=:1 wxdt-ide sh -c \
  'ID=$(xdotool search --name "wordpath"|head -1); xdotool windowactivate $ID; sleep 2; xdotool key --clearmodifiers ctrl+b; sleep 20'

# 预览码：工具菜单(254,18) → 预览(262,88) → 「有文件未保存」确定(1136,160)
docker exec -u abc -e DISPLAY=:1 wxdt-ide sh -c \
  'xdotool key --clearmodifiers ctrl+s; sleep 1; \
   xdotool mousemove 254 18 click 1; sleep 2; \
   xdotool mousemove 262 88 click 1; sleep 10; \
   xdotool mousemove 1136 160 click 1; sleep 18'
# 二维码区域：截图上 (1442,168)-(1612,338)，放大 4 倍落盘
```

**坑**：
- 点预览前先 `ctrl+s`，否则弹「有文件未保存」挡住流程
- 若出现 `未能保存 "settings.json"：文件的内容较新` → 点「覆盖」(1500,148)
- 二维码有效期约 25 分钟，过期要重出

## 三、发音：家里 Piper（不要用插件）

**官方「同声传译」插件已下架**（搜不到 `wx069ba97219f66d99`），第三方插件不可控。

```
wx.downloadFile(BASE + '/tts?w=<word>&v=<voice>')
  → https://tts.hahaxiong.cc:8666 → Lucky → 192.168.1.133:8790 → Piper
  → wav 22050Hz mono 38-55KB → InnerAudioContext
```

- 音色：`hfc`（默认，与 Android 端一致）/ `amy` / `joe` / `lessac` / `ryan`
- 模型：`~/local/piper/en_US-*-medium.onnx`（已有，`bin/piper`）
- 缓存：`/data/home-studio/wordpath-tts-cache/<voice>/<sha1>.wav`
- 实测：首次 496 ms、缓存 5 ms

**`utils/tts.js` 铁律**：**必须 `wx.downloadFile` 落 tempFilePath 再播**。直接把
`audio.src` 设成 http URL 时，模拟器既不下载也不报错（服务端零日志），极易误判成网络问题。

## 四、OCR：家里 RapidOCR（VisionKit 真机不返回）

`wx.createVKSession` + `runOCR` 在真机上**回调永不触发**，页面卡死「识别中」且无错误。

```
wx.uploadFile(POST https://ocr.hahaxiong.cc:8666/ocr, 图片)
  → Lucky → 192.168.1.133:8791 → RapidOCR（PP-OCRv4 ONNX）
  → {"ok":true,"count":N,"lines":[{"text","confidence"}],"text":"..."}
```

- 依赖：`pip install --break-system-packages rapidocr_onnxruntime`
- 实测：429 ms，900×700 课本样张 6 个英文词 conf 0.97~1.00 全对；**音标符号识别乱**但不影响词匹配
- **服务端必须解析 multipart**：`wx.uploadFile` 发的是 `multipart/form-data`，
  整个 body 喂 PIL 会报 `cannot identify image file <_io.BytesIO ...>`。
  按 boundary 切段取 `filename=` 的 payload，同时保留原始字节透传

**产品逻辑铁律**：OCR 要**保留词库外的词**。只返回词库命中会让拍课外读物直接
「没识别到单词」。做法：`matcher.match()` 取命中 + `matcher.extractAll(text, dict)`
取全部英文 token，合并去重；词库外的标 `external:true`、打橙色「词库外」标签、照样能听写
（发音走 Piper，任意词都能合成）。短词（≤2）只在词库命中时保留，用来挡音标碎片。

## 五、Lucky 反代（新增域名）

走 `lucky-reverse-proxy` skill，注意两条：

1. **PUT 只能传 `rule` 那一层对象**，传整个 `{"ret":0,"rule":{...}}` 会 200 但静默不生效
2. 改完 `GET rules` 复核条目数 + 目标地址

```
RuleKey  AdMqS1jnVHj8YLVt（外网回家NAS，8666/TLS，Let's Encrypt *.hahaxiong.cc）
  tts.hahaxiong.cc  → http://192.168.1.133:8790
  ocr.hahaxiong.cc  → http://192.168.1.133:8791（HttpClientTimeout=60，OCR 慢）
  wordpath.hahaxiong.cc → http://192.168.1.133:8899（APK 更新）
```

**DNS 是反代的前提**：阿里云 A 记录必须指向家宽当前公网 IPv4（`120.244.92.4`）。
A 记录过期（指着旧 IP）表现为「Lucky 配得全对但外面进不来」。删 DNS ≠ 更安全，等于反代失效。

## 六、真机调试（必读）

| 环境 | 域名校验 |
|---|---|
| 开发者工具模拟器 | `setting.urlCheck=false` 生效，可跑 http/非标端口 |
| **真机预览/体验版** | **强制校验合法域名**，只认 443/80，不能带端口 |

当前用 `:8666`，真机必须在 **手机微信 → `···` → 开发调试 → 打开「不校验合法域名、
web-view（业务域名）、TLS 版本以及 HTTPS 证书」** 才能连。

**上线前必做**：把服务挪到 443 + 小程序后台「开发管理 → 服务器域名」配 `downloadFile`
合法域名。443 在飞牛2（Lucky 那台）被飞牛 nginx 占用且用自签证书（`CN=fnOS`，微信不认），
要么给 nginx 单独签 `tts.hahaxiong.cc` 证书，要么另找机器。

## 七、微信后台自动化结论：不要做

后台 token **按页面维度**分：同一浏览器里 `开发管理` 一直有效、`设置(basicprofile)`
几分钟就报登录超时；无人值守容器环境活不过几分钟；`bizlogin?action=validate` 是强制
二次验证，脚本过不去。

**结论**：后台配置（加插件、配域名、填基础信息、改类目）**让川哥在自己浏览器做**，
agent 只做代码侧 + 编译 + 出预览码 + 服务端运维。保活机制 `wxdt-mp-keepalive`
（profile 持久化 + 20 分钟 CDP 心跳 + 有密码时尝试重登）只能延缓，不能解决。

## 八、日志与排障

```bash
journalctl --user -u wordpath-tts.service --since '-5min' --no-pager
journalctl --user -u wordpath-ocr.service --since '-5min' --no-pager
# 看真机请求来源：192.168.1.115 = 经 Lucky 反代；172.17.0.4 = 容器内模拟器
```

**判断链路通不通，看服务端 access log，不要只看前端提示。**

## 已验证清单（2026-11-17）

- ✅ appid `wx55e19a8ad4ffc774` 编译 0 error 0 warning，代码包 284 KB
- ✅ TTS 公网 HTTPS → wav → 真机出声（开调试开关后）
- ✅ OCR 公网 HTTPS → 11 行文本，印刷体单词全对
- ✅ Lucky 反代 `tts` / `ocr` 两条，Let's Encrypt 证书免 `-k`
- ✅ 预览码自动化产出（有效期 25 分钟）
- ⏳ 443 + 后台合法域名白名单（上线前）
- ⏳ 手写体 OCR 识别率（RapidOCR 弱项，可能需要 TrOCR）
