import { formatCareerExperience, getCareerExperience } from '@/lib/experience'
import { patents } from '@/data/patents'

const careerExperience = getCareerExperience()
const careerExperienceLabel = formatCareerExperience(undefined, { spaced: true, includeDays: true })

export const profile = {
  name: '陈川',
  nameEn: 'Chen Chuan',
  title: 'AI Native 产品经理',
  tagline: '儿童 AI · 团队 AI 助手 · AR HUD',
  intro: '我做过机器人、智能硬件和 AR HUD，现在也在做儿童 AI 伙伴和团队 AI 助手。除了产品定义，我会参与技术选型、原型开发和验收，用 AI 把想法做成可试用的产品。',
  bio: `我做产品已有${careerExperienceLabel}，经历过机器人、智能硬件和 AR HUD 的研发与商业落地。现在主要在做儿童 AI 伙伴、团队 AI 助手，也继续探索全车窗 AR HUD。`,
  bioExtended: '我负责产品定义和技术取舍，也借助 AI 写代码、做测试，自己试用和验收。独立软件项目由我一个人 vibe coding 完成，没有团队，AI 是我的手脚；公司产品的硬件、供应链和量产由跨职能团队共同推进。',
  profileCards: [
    {
      id: '01',
      label: '用 AI 做产品',
      text: '从 2025 年底开始，我把 AI 用进日常开发。产品需求由我判断，代码和测试借助 AI 完成，能不能用由实际试用来检验。',
    },
    {
      id: '02',
      label: '汽车显示与交互',
      text: '我负责过 AR HUD 的产品定义、展车迭代和路测，和团队一起推动客户定点。现在的 Warp 预研关注曲面投影变形，以及可显示区域怎么用得更充分。',
    },
    {
      id: '03',
      label: '把不同技术用在一起',
      text: '做机器人时接触导航、视觉和机械控制，做座舱时研究光学与交互。这些经验也用在小可上：硬件采集、语音对话和成长玩法要配合好，孩子才能顺畅地使用。',
    },
    {
      id: '04',
      label: '把原型带到使用现场',
      text: '除了功能，我也关心成本、供应链、交付和后续使用。原型跑通后，要在真实设备和实际工作里继续验证，才能知道哪些地方需要改。',
    },
  ],
  stats: {
    yearsExperience: careerExperience.years,
    patents: patents.length,
    shippedProducts: 8,
    keyWins: 7,
  },
  aiToolchain: [
    { name: 'Claude', role: '主规划', desc: '深度推理 · 任务编排', tint: '#F4A35D' },
    { name: 'GPT / Codex', role: '主实现', desc: '编码交付 · 多模态', tint: '#5BA7FF' },
    { name: 'Grok', role: '实时研究', desc: '前沿检索 · AI Ops', tint: '#F472B6' },
  ],
  keyWins: [
    'AR HUD 展车获国内新势力旗舰车型定点订单',
    '获海外豪华合资品牌 AR HUD 定点',
    '太阳能路灯交付 UNHCR 难民营项目',
    '太阳能消费品实现海外销售',
    '机器人原型参展 CES 2017',
    '无人冰淇淋站山东两地落地运营',
    '阿斯顿马丁太阳能赛车勒芒赛季冠军',
  ],
  coreSkills: [
    { label: '产品定义', detail: '用户需求、使用场景、成本与验收标准' },
    { label: '汽车显示', detail: 'AR HUD 光学与交互 · Swift / Metal 预畸变原型' },
    { label: '实时语音', detail: 'Rust / Tokio · LiveKit / WebRTC · 流式 ASR—LLM—TTS' },
    { label: '儿童 AI 硬件', detail: 'Android / Kotlin · Godot 场景 · Rust 游戏运行时' },
    { label: 'Agent 应用', detail: 'Node.js · SQLite · 记忆检索 · Harness 运行框架' },
    { label: '产品交付', detail: '原型测试、供应链协作、量产与上线验收' },
  ],
  education: [
    { school: '南京航空航天大学', degree: '硕士 · 项目管理', tag: '211/双一流', year: '2011–2014' },
    { school: '南京航空航天大学', degree: '本科 · 工业设计', tag: '211/双一流', year: '2002–2006' },
  ],
  certifications: [
    'NPDP 产品经理国际认证 (PDMA)',
    '英语 Business Proficient',
  ],
  contact: {
    phone: '13911184569',
    email: '13911184569@163.com',
    location: '北京',
    linkedin: 'https://linkedin.com/in/yourprofile',
    github: 'https://github.com/Hahaxiong838383',
    wechat: 'your-wechat-id',
  },
}
