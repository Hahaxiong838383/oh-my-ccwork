export interface TimelineItem {
  period: string
  company: string
  role: string
  description: string
  tags: string[]
}

export const timeline: TimelineItem[] = [
  {
    period: '2019 — 至今',
    company: '未来黑科技 · FUTURUS',
    role: '产品市场部负责人 & 产品总监',
    description: '负责 AR HUD 与座舱交互产品，参与展车迭代、路测和量产定点。近年推进儿童读写台、AI 语音伙伴和团队 AI 工作助手，负责产品定义、技术取舍与软件验证；硬件和量产由跨职能团队共同推进。',
    tags: ['AR HUD', '智能座舱', '儿童 AI', 'AI Native'],
  },
  {
    period: '2017 — 2019',
    company: '古点科技（歌尔子公司）',
    role: '产品经理 · 智能机器人 & 自动化',
    description: '负责自主导航服务机器人与 UR 协作机械臂冰淇淋站，评估 SLAM（同时定位与建图）、机械控制和实际运营条件，推进原型与应用场景验证。',
    tags: ['具身智能', 'SLAM', 'UR 协作臂', '无人自动化'],
  },
  {
    period: '2015 — 2017',
    company: '歌尔股份',
    role: '智能机器人产品经理（高级）',
    description: '参与儿童服务机器人、桌面办公助手和智能穿戴的产品开发，整合 Azure AI、语音理解、SLAM 定位与骨骼识别。机器人原型参展 CES 2017。',
    tags: ['Embodied Agent', 'Azure AI', '多模态感知', 'CES 2017'],
  },
  {
    period: '2012 — 2015',
    company: '汉能控股集团',
    role: '设计经理 / 产品经理',
    description: '负责太阳能智能消费品的设计与产品定义，参与阿斯顿马丁赛车、UNHCR 难民营路灯等应用项目，并推进太阳能消费品的出口交付。',
    tags: ['太阳能 IoT', '跨界创新', 'Aston Martin', 'UNHCR'],
  },
  {
    period: '2006 — 2012',
    company: '和利时集团 / 易艾斯德 / 菲特工业设计',
    role: '产品设计主管 / 产品设计师 / 工业设计师',
    description: '从事工业控制、医疗设备和电力监控仪表的设计与迭代，也负责园林工具、小家电和电动工具的出口产品设计，跟进结构、供应链与量产。',
    tags: ['工业设计', '量产', '供应链', 'VI 体系'],
  },
]
