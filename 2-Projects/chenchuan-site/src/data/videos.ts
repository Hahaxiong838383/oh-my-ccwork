export interface Video {
  title: string
  description: string
  url: string
  thumbnail: string
  duration: string
  tags: string[]
  projectSlug?: string // 关联项目 slug（来自 admin 视频管理）
  projectTitle?: string // 关联项目名称（运行时按 slug 填充，用于卡片展示）
}

export const videos: Video[] = [
  {
    title: '眼动+手势 多模态交互演示 1',
    description: '使用 FaceMesh 与手势识别，演示注视预选和捏合抓取。',
    url: '/media-optimized/eye-gesture-interaction/20260319-090647.mp4',
    thumbnail: '/media-posters/eye-gesture-interaction/20260319-090647.jpg',
    duration: '0:27',
    tags: ['眼动追踪', '手势交互', '多模态'],
  },
  {
    title: '眼动+手势 多模态交互演示 2',
    description: '展示注视高亮、气泡反馈与捏合抓取的配合。',
    url: '/media-optimized/eye-gesture-interaction/20260319-090658.mp4',
    thumbnail: '/media-posters/eye-gesture-interaction/20260319-090658.jpg',
    duration: '0:33',
    tags: ['眼动追踪', '手势交互', '空间计算'],
  },
  {
    title: '眼动+手势 多模态交互演示 3',
    description: '展示校准后的注视点、气泡锁定与手势操作效果。',
    url: '/media-optimized/eye-gesture-interaction/20260319-090714.mp4',
    thumbnail: '/media-posters/eye-gesture-interaction/20260319-090714.jpg',
    duration: '0:29',
    tags: ['气泡交互', '校准优化', '人机交互'],
  },
  {
    title: '眼动+手势 多模态交互完整流程',
    description: '记录眼动校准、注视预选、手势确认与拖拽操作的连续流程。',
    url: '/media-optimized/eye-gesture-interaction/20260319-090720.mp4',
    thumbnail: '/media-posters/eye-gesture-interaction/20260319-090720.jpg',
    duration: '1:13',
    tags: ['多模态交互', '完整流程', 'Embodied AI'],
  },
  {
    title: 'AR HUD 展车路测实录',
    description: '智能座舱 AR HUD 在真实道路场景下的功能演示，包括导航叠加、车道偏离预警、前车碰撞预警等。',
    url: '/media-optimized/ar-hud-demo/driver-view-loop.mp4',
    thumbnail: '/media-posters/ar-hud-demo/driver-view-loop.jpg',
    duration: '3:42',
    tags: ['AR HUD', '路测'],
  },
  {
    title: 'SLAM 机器人自主导航演示',
    description: '基于视觉 SLAM 的服务机器人在商业环境中的自主导航、避障与人机交互演示。',
    url: '#',
    thumbnail: '',
    duration: '2:15',
    tags: ['SLAM', '机器人'],
  },
  {
    title: '机械臂无人冰激凌站全流程',
    description: '六轴协作机械臂自动完成冰激凌制作的全流程演示，从下单到出餐。',
    url: '#',
    thumbnail: '',
    duration: '1:58',
    tags: ['机械臂', '无人零售'],
  },
  {
    title: 'Vibecoding 工作流演示',
    description: '使用 Claude Code 进行日常开发的真实工作流演示，展示 AI 如何参与产品全流程。',
    url: '#',
    thumbnail: '',
    duration: '5:20',
    tags: ['Vibecoding', 'Claude Code'],
  },
]
