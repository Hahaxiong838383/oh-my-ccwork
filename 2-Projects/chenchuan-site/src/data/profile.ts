import { formatCareerExperience, getCareerExperience } from '@/lib/experience'

const careerExperience = getCareerExperience()
const careerExperienceLabel = formatCareerExperience(undefined, { spaced: true, includeDays: true })

export const profile = {
  name: '陈川',
  nameEn: 'Chen Chuan',
  title: 'AI-Native Product Leader',
  tagline: 'AR HUD · Embodied Intelligence · Vibe Coder',
  bio: `${careerExperienceLabel}智能硬件与 AI 产品经验。从 SLAM 机器人到协作机械臂，从多模态 AI 系统到 AR HUD 智能座舱，跨越具身智能完整技术栈。以 Claude、GPT、Gemini、Grok 多引擎构建 AI-Native 工作流，擅长复杂硬科技产品定义、交互体验设计与商业闭环构建。`,
  bioExtended: '我相信好的产品不是技术的堆砌，而是对人类需求的深刻理解与技术可能性的精准匹配。拥有从第一性原理解构需求、到供应链量产、再到 GTM 的全链路操盘经验，多次实现跨界技术降维打击，定义具备极高壁垒的"新物种"品类。',
  profileCards: [
    {
      id: '01',
      label: 'AI-NATIVE OPS',
      text: '以多模型动态路由构建全流程 Vibe Coding 工作方式——Claude 负责规划编排，GPT / Codex 主实现，Gemini 负责长上下文与对照验证，Grok 支撑实时研究与 AI Ops。',
    },
    {
      id: '02',
      label: 'AR HUD PIONEER',
      text: '主导 AR HUD 前沿预研与产品定义，深度参与用户体验研究与交互设计，主持 4 代展车迭代路测，成功支撑斩获多家新势力旗舰车型及豪华品牌定点订单。',
    },
    {
      id: '03',
      label: 'EMBODIED AI LINEAGE',
      text: '从 SLAM 机器人 → 协作机械臂 → 多模态 AI 系统 → 智能座舱，跨越具身智能完整技术栈，感知-规划-交互三要素融合于产品定义全链路。',
    },
    {
      id: '04',
      label: '0→1 FULL-STACK BUILDER',
      text: '拥有从第一性原理解构需求、到供应链量产、再到 GTM 的全链路操盘经验，擅长跨界技术降维打击，多次实现商业规模化落地。',
    },
  ],
  stats: {
    yearsExperience: careerExperience.years,
    patents: 14,
    shippedProducts: 8,
    keyWins: 7,
  },
  aiToolchain: [
    { name: 'Claude', role: '主规划', desc: '深度推理 · 任务编排', tint: '#F4A35D' },
    { name: 'GPT / Codex', role: '主实现', desc: '编码交付 · 多模态', tint: '#5BA7FF' },
    { name: 'Gemini', role: '对照验证', desc: '长上下文 · 研究分析', tint: '#34D399' },
    { name: 'Grok', role: '实时研究', desc: '前沿检索 · AI Ops', tint: '#F472B6' },
  ],
  keyWins: [
    'AR HUD 展车获国内新势力旗舰车型定点订单',
    '获海外豪华合资品牌 AR HUD 定点',
    'UNHCR 难民营太阳能路灯出口 20,000 盏',
    '太阳能消费品年均出口 ¥400-500 万',
    '机器人原型参展 CES 2017',
    '无人冰淇淋站山东两地落地运营',
    '阿斯顿马丁太阳能赛车勒芒赛季冠军',
  ],
  coreSkills: [
    { label: '产品战略', detail: '五看三定 · PEST · NPDP · OKR/KPI' },
    { label: 'AR 光学系统', detail: '自由曲面 · HUD 光路设计 · 前装量产' },
    { label: 'AI 集成', detail: 'LLM 工程化 · 情感计算 · SLAM · 3D 视觉' },
    { label: '交互设计', detail: 'HMI · DMS · 语音/手势 · 多屏协同' },
    { label: '商业模式', detail: 'SaaS 数据闭环 · B2B2C · GTM · 供应链' },
    { label: 'Vibe Coding', detail: '四引擎动态路由 · 多模型 API 编排' },
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
    github: 'https://github.com/yourprofile',
    wechat: 'your-wechat-id',
  },
}
