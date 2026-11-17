---
name: aliyun-icp-filing
description: 阿里云 ICP 备案（网站/App）的材料准备、API 提交、状态跟踪与排障。覆盖 aliyun-cli-domain 插件的 icp 子命令（init/fill/status/info/ask）、工作簿字段规则、管局硬性要求、图片规格、认领主体的走不通场景、国内机房 443 对未备案域名的 SNI 拦截。触发词："ICP 备案"、"网站备案"、"备案号"、"京ICP备"、"beian"、"未备案 443 被拦"、"PreAuditUnavailable"、"aliyun domain icp"、"公安联网备案"。
---

# 阿里云 ICP 备案

**一句话**：API（`aliyun domain icp`）能做**填表 + 上传 + 状态查询**，但**「认领主体」「人脸活体」必须走阿里云 App 或 beian.aliyun.com 网页**；境内机房**未备案域名的 443/80 会被 SNI 拦截**，配得再对也不通。

## 一、先判断 443 不通是不是备案问题

```
① TCP 443 可连                    telnet IP 443
② 直连 IP + Host 头 → 200          curl -k https://IP/health -H "Host: 域名"
③ 带域名 SNI → TLS 握手被 RST       curl -v https://域名/
```

**三条都符合 = 备案拦截**，不是 nginx/证书问题。反向案例见 [claude-fleet#4072](https://github.com/verkyyi/claude-fleet/issues/4072)。

- **80 端口**同样受管（未备案常返回 403 或拦截）
- **非标端口不受限**（这是家里 Lucky 8666 能用的原因）
- **本机自访通常正常**（只拦外部），别拿 VPS 本机 curl 当验收

## 二、前置条件核对

| 项 | 怎么查 |
|---|---|
| 域名实名 | `aliyun domain detail --domain X --view raw` → `RealNameStatus: SUCCEED` |
| 域名在哪个账号 | 同上返回的 `UserId` |
| 服务器 | 必须是**境内**阿里云 ECS/轻量，且剩余时长满足管局要求（一般 ≥3 个月） |
| 已有备案 | `aliyun domain icp info` → `BaSuccessDataWithRiskList` |
| 历史订单 | `aliyun domain icp status --organizers-name <姓名>` |

## 三、装插件（父 CLI 直调会被拦）

```bash
aliyun plugin install --names aliyun-cli-domain   # 0.9.18，SHA-256 verified
aliyun domain --help                              # 确认子命令存在
```

父 CLI 直调域名 OpenAPI 会报「仅升级父 CLI 不会解除拦截」。

## 四、API 提交流程

```bash
# 1) 初始化工作簿（按 OAuth 凭证维度返回清单，不需指定域名）
cd <工作目录>
aliyun domain icp init --profile <profile> --service-type website --output-file ./icp-filing.json
# → 返回 filing_id

# 2) 填工作簿（JSON，结构见下）
#    图片放工作簿同目录或子目录，value 填**相对路径**

# 3) 预览（不加 --confirm 不会建单，但**会上传图片到 OSS**）
aliyun domain icp fill --profile <profile> --input-file ./icp-filing.json

# 4) 正式提交
aliyun domain icp fill --profile <profile> --input-file ./icp-filing.json --confirm=true

# 5) 查状态
aliyun domain icp status --profile <profile> --ba-order-id <订单号>
aliyun domain icp status --profile <profile> --domain-name <域名>
aliyun domain icp status --profile <profile> --organizers-name <姓名>

# 6) 咨询知识库（管局规则/驳回原因）
aliyun domain icp ask --profile <profile> --question "浙江省个人备案网站名称有什么要求"

# 7) 放弃流程
aliyun domain icp cancel --profile <profile>
```

## 五、工作簿结构（关键字段）

```
entity（主体）                    responsiblePersons（负责人）
├ entity_comName ★                ├ fzrName ★
├ entity_comType ★ (个人/企业)     ├ fzrIdType ★
├ entity_comIdType ★              ├ fzrIdNum ★
├ entity_comIdNum ★               ├ fzrIdAddress
├ entity_comIdAddress ★           ├ fzrMobile ★
├ entity_comMailingAddress ★      ├ fzrEmergencyMobile ★（不能与 fzrMobile 相同）
├ entity_comArea_province ★       ├ fzrEmail ★
├ entity_comArea_city ★           └ picList:
├ entity_comArea_county ★           ├ pic_fzrId_front ★
└ picList:                          ├ pic_fzrId_back ★
  ├ pic_entityId（合成图）           └ pic_facePhoto ★（人脸核验照）
  ├ pic_entityId_front ★
  └ pic_entityId_back ★          siteList（网站）
                                  ├ site_domain ★
domainCertPicList                  ├ site_siteName ★
└ pic_domainCert（非必填）          ├ site_homeUrl ★
                                   ├ site_serviseContent ★
                                   └ site_siteLanguage ★
```

**规则**：
- `type: code` 字段（省市区、主体类型、证件类型、服务内容、语言）**只填 `value`（中文名），`valueCode` 留空**，服务端按 value 自动生成
- 图片 value 填**相对工作簿目录**的路径，如 `pics/id_front.jpg`
- 个人备案：身份证正反面既要填 `entity.picList.pic_entityId_front/back`，也要填 `responsiblePersons[0].picList.pic_fzrId_front/back`（同一份）

## 六、管局硬性要求（通用）

| 项 | 规则 |
|---|---|
| **网站内容** | **个人备案只能选「其他」**。选教育/新闻/出版/医疗等要**前置审批**（教育厅/新闻出版局），流程极长，个人站不要碰 |
| **网站名称** | **≥3 个汉字**，且**与主体姓名有关联**（个人站建议含姓名，如「陈川词途」）。禁「中国/国家/教育/学校」等敏感词 |
| **首页 URL** | 要能访问。未备案 443 被拦时，用 `http://IP/` 放静态页兜底（审核员能看） |
| **图片** | JPG/JPEG/PNG/GIF，**200KB~4MB**，原件彩色拍照，四角完整无反光。**禁**复印件/黑白扫描/翻拍屏幕/电子证件截图/二次扫描 |
| **证件有效期** | 提交日起剩余 **≥3 个月** |
| **应急手机** | 不能与主手机相同；同一号码不能被不同主体复用 |
| **通过后** | **30 日内**办公安联网备案 |

## 七、走不通的场景：`PreAuditUnavailable`

**症状**：
```json
"blockers": [{"message":"备案预审失败","reason":"PreAuditUnavailable",
              "type":"PreAuditRejected","step":"Submit"}]
"derived_order_type": {"code":4,"name":"无主体新增服务"}
```

**根因**：主体**有历史备案**（系统记得），要走「新增网站」而不是「首次备案」，但主体**没被认领**：

```json
"entityCivilSubjectId": {"value": ""}   // 空
"customerEntityId":     {"value": ""}   // 空
"ztId":                 {"value": ""}   // 空
```

**API 没有认领参数**：`icp init --operation-type` 只有 `CHANGE`（变更）和 `REJECTED`（改驳回单）。

**解法**：认领 + 提交 + 人脸活体**必须在阿里云 App**（首页 → 更多 → ICP 备案）或 `https://beian.aliyun.com/pcContainer/myorder` 做。API 只留作**提交后的状态轮询**。

**判据**：`fill` 预览后 `icp status --domain-name X` 返回「未查询到符合条件的进行中备案订单」= 没建单。

## 八、图片处理常用操作

```python
# 前置自拍是镜像的（证件字反），要翻转
from PIL import Image, ImageOps
ImageOps.mirror(Image.open("selfie.jpg")).save("face.jpg", "JPEG", quality=92)

# 身份证正反面合成（pic_entityId 用）
f = Image.open("id_front.jpg"); b = Image.open("id_back.jpg")
h = 900
f = f.resize((int(f.width*h/f.height), h), Image.LANCZOS)
b = b.resize((int(b.width*h/b.height), h), Image.LANCZOS)
combo = Image.new("RGB", (f.width + b.width + 30, h), "white")
combo.paste(f, (0,0)); combo.paste(b, (f.width+30, 0))
combo.save("id_combo.jpg", "JPEG", quality=90, optimize=True)
```

## 九、状态流转与时间

```
待初审        阿里云审核 1-2 工作日（App 里会写具体承诺时间）
  ↓
待管局审核     各省管局，浙江 7-10 工作日 / 北京 10-15 工作日
  ↓
管局审核通过   → 下发备案号（京ICP备2026xxxxxx号-1）
```

**已有主体备案号时走「新增网站」只要 3-5 工作日**，比首次备案快 10 天。

## 十、临时材料分发（含身份证的敏感文件）

给用户下载证件照时**别用长期可访问的公网路径**：

```bash
TOKEN=$(openssl rand -hex 16)
# 建 /var/www/html/dl-$TOKEN/ 放文件 + index.html
# nginx 加 location，带 no-store + X-Robots-Tag noindex
# systemd-run --on-active=24h 定时清理
```

## 十一、本机真值

| 项 | 值 |
|---|---|
| 域名 | `hahaxiong.cc`（实名 SUCCEED，到期 2035-08-19，注册商阿里云） |
| 域名所属账号 | `1688373750559418`（`cc-remote` profile） |
| 服务器 | `60.205.5.246`（北京 cn-beijing-h，2C2G，Ubuntu 26.04） |
| 历史备案 | `京ICP备2023019126号-1`，域名 `futurus-test.top`，2024-09-27 取消接入（`icp info` 现为空） |
| 本次订单 | `2038883678409`，2026-11-17 23:28:28，待初审 |
| 材料目录 | `/data/home-studio/wordpath-icp/` |
| 备份 | 飞牛2 `/vol1/1000/backups/wordpath-icp/` |

**注意**：`aliyun` CLI 的 profile 与密码库的 AK **不是同一个账号**——`cc-remote` = `1688373750559418`（午夜设计师，域名+这台 ECS），`intl-jp` = `5032581483931690`（国际站 Gmail）。查资源前先 `aliyun sts GetCallerIdentity --profile X` 确认。
