# AirPlayer.app 图标 prompt（GPT Image 2）

> 用法：完整复制下方 JSON 作为 prompt；建议参数 size=1024x1024, quality=high, background=transparent。
> 生成后把 PNG 给 cc，由 cc 转 .icns 并重打包替换。

```json
{
  "type": "拟物 3D macOS 应用图标",
  "goal": "为一款「隔空手势控制的视频播放器」生成图标，一眼传达『不用触碰、挥手即控制播放』",
  "subject": {
    "metaphor_core": "一只简洁的 3D 手掌心朝前微微抬起，掌心上方悬浮一个立体的圆角播放按钮（三角形 play 徽标）；手掌与播放按钮之间有 2-3 圈细腻的同心光环涟漪，表达『隔空感应』",
    "motion_hint": "播放按钮右侧拖出一条短促流畅的暖橙色光弧轨迹，暗示挥手划过的动势",
    "element_count": "手 + 悬浮播放按钮 + 光环涟漪，主次分明",
    "detail_level": "克制圆润，无真实皮肤纹理，接近 Apple 官方图标的抽象度"
  },
  "style": {
    "rendering": "拟物 3D + 软质哑光材质 + 播放按钮带轻微玻璃光泽 + 柔和棚光 + 厚而软的投影，Apple Big Sur / macOS 现代图标风",
    "color_palette": "午夜蓝黑渐变底（影院氛围）+ 暖橙色播放按钮与光弧 + 手部浅暖灰白，总色相 ≤ 3",
    "lighting": "播放按钮自体微微发光，成为画面视觉中心；手掌被其暖光轻微照亮"
  },
  "background": {
    "type": "macOS 圆角方形（squircle）图标本体自带午夜蓝黑渐变底；squircle 之外为透明背景",
    "inside_squircle": "极淡的暖色光晕从播放按钮向外衰减"
  },
  "format": {
    "shape": "macOS squircle 圆角方形，居中",
    "aspect_ratio": "1:1",
    "composition_safety": "主体在 squircle 内留约 12% 内边距；squircle 占画布约 82%，四周透明"
  },
  "constraints": {
    "must_keep": [
      "五米外仍可辨认『手 + 播放三角』两个核心符号",
      "播放按钮悬浮在掌心上方、二者不接触，突出『隔空/非接触』",
      "像一个真实可点击的 macOS 应用图标",
      "缩小到 32px 时播放三角依然清晰"
    ],
    "avoid": [
      "任何可读文字、字母、logo",
      "写实人手（要图形化的手，不要恐怖谷）",
      "元素过多（不要屏幕、遥控器、摄像头、胶片等杂物）",
      "光弧喧宾夺主盖过播放按钮",
      "手指遮挡播放三角"
    ]
  }
}
```
