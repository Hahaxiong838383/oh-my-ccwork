---
name: design-system
description: 从零构建完整设计系统。六阶段流程：产品上下文理解 → 竞品研究 → 美学方向确定 → 完整设计规范 → 深度打磨 → 输出 DESIGN.md。触发词："/design-system"、"建设计系统"、"定义设计规范"、"UI 风格统一"、"设计语言"。
layer: 规划层
authorization: B区（展示方案，等确认再写文件）
output_levels: L2（规范文档 + 代码示例）
---

# design-system — 设计系统构建

> 灵感来源：gstack-design-consultation（Garry Tan / YC）
> 补充 frontend-design（单页面实现）的上游：先有系统，再有页面。

## 定位

`frontend-design` 负责**实现**单个页面/组件。
`design-system` 负责**定义**整个产品的视觉语言，让所有页面保持一致。

**适用场景**：
- 新产品从零开始，需要确定 UI 方向
- 老产品"看起来乱"，需要统一风格
- 多人协作，需要共同遵守的设计规范

---

## 触发词

- `/design-system`
- "建设计系统"、"定义设计规范"
- "UI 风格统一"、"设计语言"、"视觉规范"
- "颜色/字体/间距怎么定"

---

## 六阶段流程

### Phase 1：预检查（读现有代码）

先看看现在有什么，避免推倒重来：

```bash
# 找现有 CSS/设计变量
grep -r "color\|font\|spacing\|--" src/ --include="*.css" --include="*.scss" | head -30
# 找现有组件
ls src/components/ 2>/dev/null
```

问老板：
- 这个产品现在用什么技术栈？（Tailwind / CSS modules / styled-components？）
- 有没有已经在用的颜色/字体？
- 要不要兼容现有代码，还是全部重来？

### Phase 2：产品上下文

理解这是什么产品，才能定对的设计方向：

| 维度 | 问题 |
|------|------|
| 用户画像 | 主要用户是谁？他们的技术水平？使用场景？ |
| 产品调性 | 专业工具 / 消费品 / 内容平台 / 数据仪表盘？ |
| 情绪目标 | 用户用完希望感受到什么？（专业感/温暖/活力/可靠）|
| 对标产品 | 你觉得哪个产品的设计风格接近你想要的？ |

### Phase 3：竞品研究

找 3-5 个同类产品，分析他们的设计选择：
- 主色调策略（单色系 / 双色系 / 中性色为主）
- 字体选择（几何体 / 人文体 / 等宽）
- 圆角风格（无圆角 / 小圆角 / 大圆角）
- 间距密度（紧凑 / 适中 / 宽松）
- 整体感觉（冷峻 / 温暖 / 活泼 / 严肃）

### Phase 4：完整设计规范

根据上下文，生成以下规范：

#### 颜色系统

```css
/* 主色 */
--color-primary-50: ;   /* 最浅 */
--color-primary-500: ;  /* 标准 */
--color-primary-900: ;  /* 最深 */

/* 中性色 */
--color-neutral-50: ;
--color-neutral-500: ;
--color-neutral-900: ;

/* 功能色 */
--color-success: ;
--color-warning: ;
--color-error: ;
--color-info: ;

/* 语义色 */
--color-bg: ;           /* 页面背景 */
--color-surface: ;      /* 卡片/面板背景 */
--color-border: ;       /* 边框 */
--color-text: ;         /* 主文字 */
--color-text-muted: ;   /* 辅助文字 */
```

#### 字体系统

```css
/* 字体族 */
--font-sans: ;          /* 正文字体 */
--font-mono: ;          /* 代码字体 */

/* 字号阶梯（推荐 4px 基准）*/
--text-xs: 12px;
--text-sm: 14px;
--text-base: 16px;
--text-lg: 18px;
--text-xl: 20px;
--text-2xl: 24px;
--text-3xl: 30px;
--text-4xl: 36px;

/* 字重 */
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;

/* 行高 */
--leading-tight: 1.25;
--leading-normal: 1.5;
--leading-relaxed: 1.75;
```

#### 间距系统

```css
/* 4px 基准间距 */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
--space-16: 64px;
```

#### 圆角与阴影

```css
/* 圆角 */
--radius-sm: 4px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;
--radius-full: 9999px;

/* 阴影 */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--shadow-md: 0 4px 6px rgba(0,0,0,0.07);
--shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
```

#### 动效规范

```css
/* 过渡时长 */
--duration-fast: 100ms;
--duration-normal: 200ms;
--duration-slow: 300ms;

/* 缓动函数 */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
--ease-enter: cubic-bezier(0, 0, 0.2, 1);
--ease-exit: cubic-bezier(0.4, 0, 1, 1);
```

### Phase 5：深度打磨（组件级规范）

核心组件的设计规范：

**Button**：尺寸（sm/md/lg）× 变体（primary/secondary/ghost/danger）× 状态（normal/hover/active/disabled/loading）

**Input**：尺寸 × 状态（normal/focus/error/disabled）× 类型（text/search/password）

**Card**：padding 规则、阴影层级、边框 vs 阴影的选择

**Typography**：heading 1-4、body/small、caption、code 的完整规格

**Badge/Tag**：颜色语义（成功/警告/错误/信息/中性）

### Phase 6：输出 DESIGN.md

将以上规范整理成一份 `DESIGN.md`，存放在项目根目录或 `docs/` 下。

这份文档是：
- `frontend-design` 工作时的参考
- 多人协作的共同语言
- 未来 AI 辅助开发的上下文

---

## "AI 垃圾"反模式（要主动避开）

gstack 定义的 AI 生成 UI 常见问题，设计时要避免：

| 反模式 | 具体表现 | 修正方向 |
|--------|---------|---------|
| 过度圆角 | 所有东西都是大圆角，看起来像玩具 | 只在合适的地方用圆角 |
| 渐变滥用 | 随处可见 gradient，没有意义 | 渐变只用于特定强调 |
| 卡片堆叠 | 所有内容都放在白色卡片里 | 用留白和层级代替卡片 |
| 颜色混乱 | 用了 10+ 种颜色，没有系统 | 严格遵守颜色系统 |
| 间距不一致 | 随意的 padding，没有基准 | 所有间距用 4px/8px 倍数 |
| 图标过多 | 每个菜单项都有图标，视觉噪音 | 图标只用于增加语义理解 |
| 假深度 | 大量 box-shadow 制造层次感 | 层次感来自颜色和间距 |

---

## 与其他 Skill 联动

| Skill | 联动方式 |
|-------|---------|
| `frontend-design` | design-system 先定规范，frontend-design 按规范实现页面 |
| `design-review` | design-system 定好后，用 design-review 检查实现是否符合规范 |
| `theme-factory` | 规范确定后，用 theme-factory 快速给 artifact 套主题 |

---

*v1.0 — 改编自 gstack-design-consultation，2026-03-21*
