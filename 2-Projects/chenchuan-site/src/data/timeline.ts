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
    description: '主导 AI+AR HUD 与多模态交互产品线，完成 4 代展车迭代路测与量产定点。同步推动智能座舱 AI 能力平台化建设、AI-Native 工作流在组织内落地，以及健康教育 AI 智能消费品的 0→1 孵化。',
    tags: ['AR HUD', '智能座舱', 'AI-Native', 'Vibe Coding', '0→1'],
  },
  {
    period: '2017 — 2019',
    company: '古点科技（歌尔子公司）',
    role: '产品经理 · 智能机器人 & 自动化',
    description: '主导基于 SLAM 的自主导航服务机器人与 UR 协作机械臂无人冰淇淋站。从技术方案评估到商业场景落地，积累了具身智能"感知-规划-执行"闭环的完整工程化经验。',
    tags: ['具身智能', 'SLAM', 'UR 协作臂', '无人自动化'],
  },
  {
    period: '2015 — 2017',
    company: '歌尔股份',
    role: '智能机器人产品经理（高级）',
    description: '构建多模态 AI 机器人能力体系，整合 Azure AI、语音 NLU、SLAM、骨骼识别。产品覆盖儿童服务机器人、人形桌面办公助手与个人智能穿戴。机器人原型参展 CES 2017。',
    tags: ['Embodied Agent', 'Azure AI', '多模态感知', 'CES 2017'],
  },
  {
    period: '2012 — 2015',
    company: '汉能控股集团',
    role: '设计经理 / 产品经理',
    description: '主导太阳能智能消费品矩阵产品定义。阿斯顿马丁太阳能赛车获勒芒赛季冠军，UNHCR 难民营路灯出口 20,000 盏，太阳能消费品年均出口 ¥400-500 万。',
    tags: ['太阳能 IoT', '跨界创新', 'Aston Martin', 'UNHCR'],
  },
  {
    period: '2006 — 2012',
    company: '和利时集团 / 易艾斯德 / 菲特工业设计',
    role: '产品设计主管 / 产品设计师 / 工业设计师',
    description: '工业控制、医疗设备、电力监控仪表的工业设计与产品迭代。园林工具、小家电、电动工具的外贸出口产品设计与量产。积累扎实的工业设计与供应链量产基本功。',
    tags: ['工业设计', '量产', '供应链', 'VI 体系'],
  },
]
