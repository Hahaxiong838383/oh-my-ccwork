---
name: design-review
description: 设计审计与修复。评估 UI 的视觉质量，检测"AI 垃圾"反模式，自动修复 CSS 问题，截图前后对比验证。支持快速/完整/diff 感知三种模式。触发词："/design-review"、"设计审计"、"UI 太丑了"、"视觉检查"、"polish"、"设计打磨"。
layer: 验证层
authorization: B区（展示问题清单，等确认再修复）
output_levels: L2（问题清单 + 修复结果）
---

# design-review — 设计审计与修复

> 灵感来源：gstack-design-review（Garry Tan / YC）
> "做完功能之后，设计是让产品从 4 分变 9 分的关键。"

## 定位

**code-review** 看代码质量，**design-review** 看视觉质量。

用途：
- 功能做完了，UI 还粗糙，需要打磨
- 想知道哪里最影响视觉效果
- 检查是否有"AI 味"，让界面更自然

---

## 触发词

- `/design-review`
- "设计审计"、"UI 太丑了"、"视觉检查"
- "polish"、"设计打磨"、"界面优化"
- "帮我看看 UI 哪里不对"

---

## 三种模式

| 模式 | 适用场景 | 深度 |
|------|---------|------|
| **快速** | 改了一点，快速验证没有破坏 | 只看改动的文件 |
| **完整** | 整体设计审计，找所有问题 | 扫描全部 UI 文件 |
| **diff 感知** | PR 前检查，确保新改动没引入设计问题 | 对比 git diff |

默认：完整模式。

---

## 执行流程

### Step 1：扫描 UI 文件

找到所有需要审计的文件：

```bash
# 找 CSS/样式文件
find src -name "*.css" -o -name "*.scss" -o -name "*.module.css" | head -20

# 找组件文件（含内联样式）
find src -name "*.tsx" -o -name "*.jsx" | head -20

# 如果用 Tailwind，找 class 最多的文件
grep -r "className=" src --include="*.tsx" -l
```

### Step 2：10 维度审计

对每个维度打分（0-10），列出具体问题：

| 维度 | 检查内容 |
|------|---------|
| **颜色一致性** | 是否在用设计系统的颜色变量？有没有 hardcode 的颜色值？ |
| **字体层级** | heading/body/caption 是否区分清晰？字号是否有规律？ |
| **间距规律** | padding/margin 是否用 4px/8px 倍数？有没有随意的 13px、17px？ |
| **对齐** | 元素是否对齐？有没有 1-2px 的偏移让界面看起来不整齐？ |
| **圆角一致性** | 同类元素圆角是否统一？有没有大小不一的圆角？ |
| **阴影合理性** | 阴影是否有层级意义？有没有滥用 box-shadow？ |
| **交互状态** | hover/active/focus/disabled 状态是否完整？ |
| **响应式** | 移动端是否正常显示？断点是否合理？ |
| **可访问性** | 颜色对比度是否够（WCAG AA：4.5:1）？ |
| **AI 垃圾** | 是否有渐变滥用、过度圆角、卡片堆叠等反模式？ |

### Step 3：生成问题清单

按严重程度分级：

```
## 设计审计报告

### 严重问题（影响专业感，建议优先修）
- [ ] [文件:行号] 问题描述 → 建议修复方式

### 中等问题（影响一致性，建议修）
- [ ] [文件:行号] 问题描述 → 建议修复方式

### 轻微问题（有时间可以改）
- [ ] [文件:行号] 问题描述 → 建议修复方式

### 得分
颜色: X/10  字体: X/10  间距: X/10  对齐: X/10
圆角: X/10  阴影: X/10  状态: X/10  响应式: X/10
总分: XX/80
```

### Step 4：修复（等确认后执行）

展示问题清单后，等老板确认再修复。

修复原则：
- **原子修复**：每个问题单独修，不混在一起
- **最小改动**：只改有问题的地方，不重构无关代码
- **不改逻辑**：只改样式，不动功能代码

### Step 5：验证

修复完成后，如果项目有运行起来，用 Ghost OS 截图对比：

```
# 修复前截图 → 修复后截图
# 对比主要页面的视觉变化
```

---

## "AI 垃圾"检测清单

这些是 AI 生成 UI 的典型特征，让界面看起来"假"：

**颜色问题**
- 背景用纯白 #FFFFFF + 文字用纯黑 #000000（太刺眼）
- 随机使用多种颜色，没有系统
- 渐变背景没有意义（pure gradient as background）

**布局问题**
- 所有内容都在白色圆角卡片里（card soup）
- 大量 border 代替空间分隔
- padding 不对称，左右/上下不一致

**字体问题**
- 所有文字同一字重（没有层级）
- 标题和正文大小差距太小
- 行高太紧（line-height < 1.4）

**组件问题**
- 按钮到处都是 border-radius: 999px（胶囊按钮滥用）
- 表单元素没有 focus 状态
- 没有 loading/disabled 状态

---

## 常见 CSS 修复模式

```css
/* 修复：用设计变量替换 hardcode 颜色 */
/* 之前 */
color: #374151;
/* 之后 */
color: var(--color-text);

/* 修复：间距统一为 4px 倍数 */
/* 之前 */
padding: 13px 17px;
/* 之后 */
padding: 12px 16px;

/* 修复：适当的 line-height */
/* 之前 */
line-height: 1.2;
/* 之后 */
line-height: 1.5;

/* 修复：添加 focus 状态 */
/* 之前（缺失）*/
/* 之后 */
input:focus {
  outline: 2px solid var(--color-primary-500);
  outline-offset: 2px;
}

/* 修复：颜色对比度不足 */
/* 之前 */
color: #9CA3AF;  /* 对比度 2.5:1，不达标 */
/* 之后 */
color: #6B7280;  /* 对比度 4.6:1，达标 */
```

---

## 与其他 Skill 联动

| Skill | 联动方式 |
|-------|---------|
| `design-system` | 先用 design-system 定规范，再用 design-review 检查执行情况 |
| `frontend-design` | frontend-design 实现页面后，用 design-review 做最终检查 |
| `desktop` | 用 Ghost OS 截图，直观查看修复前后对比 |

---

*v1.0 — 改编自 gstack-design-review，2026-03-21*
