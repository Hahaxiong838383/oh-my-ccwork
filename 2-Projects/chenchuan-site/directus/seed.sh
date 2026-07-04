#!/bin/bash
# Directus Schema Setup & Seed Script
#
# 使用方法：
# 1. 先启动 docker compose（Directus 需要先跑起来）
# 2. 运行此脚本：bash directus/seed.sh
#
# 前提：Directus 运行在 localhost:8055

set -e

DIRECTUS_URL="${DIRECTUS_URL:-http://localhost:8055}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

echo "=== Directus Schema & Seed ==="
echo "URL: $DIRECTUS_URL"

# 1. Login
echo "→ 登录..."
TOKEN=$(curl -s -X POST "$DIRECTUS_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")

if [ -z "$TOKEN" ]; then
  echo "✗ 登录失败，请检查 Directus 是否已启动"
  exit 1
fi
echo "✓ 登录成功"

AUTH="Authorization: Bearer $TOKEN"

# Helper function
create_collection() {
  local name=$1
  local singleton=$2
  shift 2

  echo "→ 创建 collection: $name"
  local payload="{\"collection\":\"$name\",\"meta\":{\"singleton\":$singleton,\"icon\":\"folder\"},\"schema\":{}}"
  curl -s -o /dev/null -w "%{http_code}" -X POST "$DIRECTUS_URL/collections" \
    -H "$AUTH" -H "Content-Type: application/json" -d "$payload"
  echo ""
}

create_field() {
  local collection=$1
  local field=$2
  local type=$3
  local interface=$4

  local payload="{\"field\":\"$field\",\"type\":\"$type\",\"meta\":{\"interface\":\"$interface\"},\"schema\":{}}"
  curl -s -o /dev/null -X POST "$DIRECTUS_URL/fields/$collection" \
    -H "$AUTH" -H "Content-Type: application/json" -d "$payload"
}

# 2. Create Collections

# -- profile (singleton) --
create_collection "profile" "true"
create_field "profile" "name" "string" "input"
create_field "profile" "name_en" "string" "input"
create_field "profile" "title" "string" "input"
create_field "profile" "tagline" "string" "input"
create_field "profile" "bio" "text" "input-multiline"
create_field "profile" "bio_extended" "text" "input-multiline"
create_field "profile" "phone" "string" "input"
create_field "profile" "email" "string" "input"
create_field "profile" "location" "string" "input"
create_field "profile" "linkedin" "string" "input"
create_field "profile" "github" "string" "input"
create_field "profile" "wechat" "string" "input"
echo "✓ profile"

# -- projects --
create_collection "projects" "false"
create_field "projects" "status" "string" "select-dropdown"
create_field "projects" "sort" "integer" "input"
create_field "projects" "slug" "string" "input"
create_field "projects" "title" "string" "input"
create_field "projects" "subtitle" "string" "input"
create_field "projects" "description" "text" "input-multiline"
create_field "projects" "full_description" "text" "input-multiline"
create_field "projects" "tags" "json" "tags"
create_field "projects" "year" "string" "input"
create_field "projects" "company" "string" "input"
create_field "projects" "role" "string" "input"
create_field "projects" "highlights" "json" "tags"
create_field "projects" "wins" "json" "tags"
create_field "projects" "color" "string" "input"
create_field "projects" "featured" "boolean" "boolean"
echo "✓ projects"

# -- patents --
create_collection "patents" "false"
create_field "patents" "sort" "integer" "input"
create_field "patents" "title" "string" "input"
create_field "patents" "number" "string" "input"
create_field "patents" "status" "string" "select-dropdown"
create_field "patents" "status_label" "string" "input"
echo "✓ patents"

# -- timeline --
create_collection "timeline" "false"
create_field "timeline" "sort" "integer" "input"
create_field "timeline" "period" "string" "input"
create_field "timeline" "company" "string" "input"
create_field "timeline" "role" "string" "input"
create_field "timeline" "description" "text" "input-multiline"
create_field "timeline" "tags" "json" "tags"
echo "✓ timeline"

# -- articles --
create_collection "articles" "false"
create_field "articles" "status" "string" "select-dropdown"
create_field "articles" "slug" "string" "input"
create_field "articles" "title" "string" "input"
create_field "articles" "excerpt" "text" "input-multiline"
create_field "articles" "date" "string" "input"
create_field "articles" "tags" "json" "tags"
create_field "articles" "content" "text" "input-rich-text-md"
echo "✓ articles"

# -- videos --
create_collection "videos" "false"
create_field "videos" "sort" "integer" "input"
create_field "videos" "title" "string" "input"
create_field "videos" "description" "text" "input-multiline"
create_field "videos" "url" "string" "input"
create_field "videos" "thumbnail" "string" "input"
create_field "videos" "duration" "string" "input"
create_field "videos" "tags" "json" "tags"
echo "✓ videos"

# 3. Set public read permissions (Directus v11 uses policies)
echo "→ 设置公开读取权限..."
PUBLIC_POLICY=$(curl -s "$DIRECTUS_URL/policies" -H "$AUTH" \
  | python3 -c "import sys,json; ps=json.load(sys.stdin)['data']; print(next((p['id'] for p in ps if 'public' in p['name'].lower()), ''))" 2>/dev/null)

if [ -z "$PUBLIC_POLICY" ]; then
  echo "→ 未找到 Public policy，尝试 null role 方式..."
  for col in profile projects patents timeline articles videos; do
    curl -s -o /dev/null -X POST "$DIRECTUS_URL/permissions" \
      -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"role\":null,\"collection\":\"$col\",\"action\":\"read\",\"fields\":[\"*\"]}"
  done
else
  echo "→ Public Policy: $PUBLIC_POLICY"
  for col in profile projects patents timeline articles videos; do
    curl -s -o /dev/null -X POST "$DIRECTUS_URL/permissions" \
      -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"policy\":\"$PUBLIC_POLICY\",\"collection\":\"$col\",\"action\":\"read\",\"fields\":[\"*\"]}"
  done
fi
echo "✓ 公开读取权限已设置"

# 4. Seed profile
echo "→ 导入 profile 数据..."
curl -s -o /dev/null -X PATCH "$DIRECTUS_URL/items/profile" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "name": "陈川",
    "name_en": "Chen Chuan",
    "title": "AI-Native Product Leader",
    "tagline": "AR HUD · Embodied Intelligence · Vibe Coder",
    "bio": "19.5 年智能硬件与 AI 产品经验。从 SLAM 机器人到协作机械臂，从多模态 AI 系统到 AR HUD 智能座舱，跨越具身智能完整技术栈。以 Claude Code 为主力构建 AI-Native 工作流，擅长复杂硬科技产品定义、交互体验设计与商业闭环构建。",
    "bio_extended": "我相信好的产品不是技术的堆砌，而是对人类需求的深刻理解与技术可能性的精准匹配。拥有从第一性原理解构需求、到供应链量产、再到 GTM 的全链路操盘经验，多次实现跨界技术降维打击，定义具备极高壁垒的新物种品类。",
    "phone": "13911184569",
    "email": "13911184569@163.com",
    "location": "北京",
    "linkedin": "https://linkedin.com/in/yourprofile",
    "github": "https://github.com/yourprofile",
    "wechat": "your-wechat-id"
  }'
echo "✓ profile"

# 5. Seed projects (first 3 as example)
echo "→ 导入项目数据..."
curl -s -o /dev/null -X POST "$DIRECTUS_URL/items/projects" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '[
    {"status":"published","sort":1,"slug":"ar-hud-smart-cockpit","title":"AI+AR HUD 智能座舱","subtitle":"前沿预研 · 4 代展车迭代 · 量产定点","description":"主导 AI+AR HUD 与多模态交互产品线的中长期规划，完成从光学原理设计、展车路测到量产落地的全流程。","full_description":"运用五看三定与 PEST 框架，牵头 AI+AR HUD+多模态交互产品线的中长期规划。主导产品从光学原理设计、实验台架搭建到展车路测及量产落地全流程，完成 4 代展车功能迭代。","tags":["AR HUD","自由曲面光学","HMI","DMS","多模态交互"],"year":"2019 — 至今","company":"未来黑科技 · FUTURUS","role":"产品市场部负责人 & 产品总监","highlights":["主导 4 代展车功能迭代","获得国内新势力及海外豪华品牌多项定点"],"wins":["国内新势力旗舰车型定点","海外豪华品牌定点"],"color":"#3B82F6","featured":true},
    {"status":"published","sort":2,"slug":"health-education-ai","title":"健康教育 AI 智能消费品","subtitle":"0→1 品类创新 · 技术降维 · B2B2C 闭环","description":"基于车规级 AR-HUD 光学技术跨界移植，从 0 到 1 定义健康教育 AI 智能消费品蓝海品类。","full_description":"运用 NPDP 科学产品开发流程与第一性原理，从 0 到 1 组建独立 To C 产品团队。将车规级 AR-HUD 自由曲面光学技术跨界移植。","tags":["B2B2C SaaS","LLM 情感计算","游戏化留存"],"year":"2023 — 2024","company":"未来黑科技（第二增长曲线）","role":"产品负责人","highlights":["将车规级光学技术跨界降维至消费品领域","构建端-管-云一体化 B2B2C 架构"],"wins":[],"color":"#10B981","featured":true},
    {"status":"published","sort":3,"slug":"slam-service-robot","title":"基于 SLAM 的自主服务机器人","subtitle":"激光雷达 + 深度视觉 · 商业场景落地","description":"主导基于激光雷达 SLAM 及深度视觉的室内自主导航服务机器人。","full_description":"基于激光雷达 SLAM 及深度视觉技术，定义室内自主导航服务机器人。成功完成第一代机器人原型并应用于咖啡厅服务。","tags":["SLAM","自主导航","具身智能"],"year":"2016 — 2018","company":"歌尔股份 / 古点科技","role":"高级产品经理","highlights":["基于激光雷达 SLAM + 深度视觉实现室内自主导航","成功交付咖啡厅送餐服务机器人"],"wins":[],"color":"#8B5CF6","featured":true}
  ]'
echo "✓ projects (3条)"

# 6. Seed patents (first 5)
echo "→ 导入专利数据..."
curl -s -o /dev/null -X POST "$DIRECTUS_URL/items/patents" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '[
    {"sort":1,"title":"显示装置及显示方法、交通工具、存储介质和电子设备","number":"202011454971.5","status":"发明","status_label":"发明专利"},
    {"sort":2,"title":"双层成像抬头显示装置、抬头显示系统及交通设备","number":"202010851791.4","status":"发明","status_label":"发明专利"},
    {"sort":3,"title":"一种智能婴儿车的控制方法、智能婴儿车及控制系统","number":"201610565712.7","status":"发明授权","status_label":"发明授权"},
    {"sort":4,"title":"一种智能轮椅及其控制方法","number":"201710510126.7","status":"发明","status_label":"发明专利"},
    {"sort":5,"title":"移动式机器人高度自适应底盘及自适应方法","number":"201710693807.1","status":"发明","status_label":"发明专利"}
  ]'
echo "✓ patents (5条)"

# 7. Seed timeline (first 3)
echo "→ 导入经历数据..."
curl -s -o /dev/null -X POST "$DIRECTUS_URL/items/timeline" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '[
    {"sort":1,"period":"2019 — 至今","company":"未来黑科技 · FUTURUS","role":"产品市场部负责人 & 产品总监","description":"主导 AI+AR HUD 与多模态交互产品线，完成 4 代展车迭代路测与量产定点。","tags":["AR HUD","智能座舱","AI-Native"]},
    {"sort":2,"period":"2017 — 2019","company":"古点科技（歌尔子公司）","role":"产品经理 · 智能机器人 & 自动化","description":"主导基于 SLAM 的自主导航服务机器人与 UR 协作机械臂无人冰淇淋站。","tags":["具身智能","SLAM","UR 协作臂"]},
    {"sort":3,"period":"2015 — 2017","company":"歌尔股份","role":"智能机器人产品经理（高级）","description":"构建多模态 AI 机器人能力体系，产品覆盖儿童服务机器人、人形桌面办公助手。机器人原型参展 CES 2017。","tags":["Embodied Agent","Azure AI","CES 2017"]}
  ]'
echo "✓ timeline (3条)"

echo ""
echo "=== 完成！==="
echo ""
echo "后台地址: $DIRECTUS_URL"
echo "账号: $ADMIN_EMAIL"
echo "密码: $ADMIN_PASSWORD"
echo ""
echo "可在 Directus 后台继续补充完整数据。"
echo "前台站点会每 60 秒自动从 CMS 拉取最新内容。"
