# GestureDemo.app 图标 prompt（GPT Image 2）

> 用法：完整复制下方 JSON 作为 prompt；建议参数 size=1024x1024, quality=high, background=transparent。
> 生成后把 PNG 给 cc，由 cc 转 .icns 并重打包替换。

```json
{
  "type": "拟物 3D macOS 应用图标",
  "goal": "为一款「眼球注视预选 + 手势捏取拖拽」的交互实验应用生成图标，一眼传达『看向哪里、捏住什么』",
  "subject": {
    "metaphor_core": "一只风格化的 3D 眼睛悬在上方，虹膜为琥珀金色、投出一束细窄的柔和金色视线光锥；光锥落点处，一只简洁的 3D 手以拇指食指对捏的姿势，正捏住一张微微倾斜悬浮的圆角卡片",
    "element_count": "眼睛 + 捏取手 + 卡片，共 3 个元素，构图上下呼应成一条视线-动作轴线",
    "detail_level": "克制，形体圆润简洁，无皮肤纹理与真实感毛孔，接近 Apple 官方图标的抽象度"
  },
  "style": {
    "rendering": "拟物 3D + 软质塑胶与磨砂玻璃质感 + 柔和棚光 + 厚而软的接触阴影，Apple Big Sur / macOS 现代图标风",
    "color_palette": "深邃藏蓝到暗紫的渐变底 + 琥珀金高光（视线与虹膜）+ 卡片奶白色，总色相 ≤ 3",
    "lighting": "左上柔光主光源 + 卡片边缘微弱金色 rim light 呼应视线"
  },
  "background": {
    "type": "macOS 圆角方形（squircle）图标本体自带深蓝渐变底；squircle 之外为透明背景",
    "inside_squircle": "极淡的径向光晕聚焦在手与卡片交点"
  },
  "format": {
    "shape": "macOS squircle 圆角方形，居中",
    "aspect_ratio": "1:1",
    "composition_safety": "图标主体在 squircle 内留约 12% 内边距；squircle 占画布约 82%，四周透明"
  },
  "constraints": {
    "must_keep": [
      "五米外仍可辨认『眼睛 + 捏取的手』两个核心符号",
      "视线光锥必须明确指向被捏住的卡片，表达『注视选中 → 捏住拖走』",
      "像一个真实可点击的 macOS 应用图标",
      "扁平缩小到 32px 时轮廓依然清晰"
    ],
    "avoid": [
      "任何可读文字、字母、logo",
      "写实人眼（要图形化的眼睛，不要恐怖谷）",
      "元素过多（不要键盘、屏幕、摄像头等杂物）",
      "刺眼的高饱和霓虹色",
      "手部遮挡眼睛或卡片主体"
    ]
  }
}
```
