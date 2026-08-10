import { classifyGovernedIntent } from './governed-intent.mjs'

function evidence(id, title, content, updatedAt, source = 'company-ontology-control-plane') {
  return {
    evidenceId: id,
    source,
    objectType: 'system.governance.ControlEvidence',
    classification: 'internal',
    title,
    content,
    updatedAt,
    permissionSnapshot: true,
    policyDecisionReference: 'company-front-door-governed-response',
  }
}

function baseAnswer({ conclusion, factBasis, derivedSummary, recommendedNextAction, confidenceLevel = 'high', evidenceReferences, unknowns = [] }) {
  return {
    conclusion,
    factBasis,
    derivedSummary,
    assumptions: [],
    contradictions: [],
    unknowns,
    confidenceLevel,
    validityWindow: { validUntil: null },
    recommendedNextAction,
    approvalRequired: false,
    evidenceReferences,
  }
}

export async function resolveGovernedResponse({ turn, systemStatusProvider, now = () => new Date() } = {}) {
  const intent = classifyGovernedIntent(turn)
  if (!intent) return null
  const generatedAt = now().toISOString()

  if (intent.kind === 'personal_identity_handoff') {
    const facts = [
      evidence('policy:company-front-door:no-user-token', '公司级 Bot 身份边界', '公司智慧中枢不索取、不保存、不使用员工的 user_access_token，也不代替员工执行个人身份操作。', generatedAt, 'company-front-door-policy'),
      evidence('policy:company-front-door:private-bot-handoff', '私人 Bot 转交规则', '需要员工个人权限的飞书操作必须改用员工自己的私人 Bot 完成。', generatedAt, 'company-front-door-policy'),
    ]
    return {
      intent,
      evidence: facts,
      answer: baseAnswer({
        conclusion: '这项操作需要你的个人飞书权限，请改用你自己的私人 Bot 完成。',
        factBasis: ['公司智慧中枢是公司级非特权 Bot，不持有你的个人授权。', '本次不会尝试读取、索取或代用你的 user_access_token。'],
        derivedSummary: '这是确定性的权限边界转交，不需要检索公司资料，也不会调用 H 引擎执行个人操作。',
        recommendedNextAction: '请在你的私人 Bot 中重新发送同一操作请求；如需公司资料，可先让智慧中枢提供只读信息，再由私人 Bot 执行。',
        confidenceLevel: 'medium',
        evidenceReferences: facts.map((item) => item.evidenceId),
      }),
    }
  }

  if (intent.kind === 'operating_model_explanation') {
    const facts = [
      evidence('contract:operating-model:cognition', '认识闭环', 'Observation → Evidence → Claim → Hypothesis → Decision，先区分事实、推导、假设、未知与冲突。', generatedAt, 'ontology-operating-model'),
      evidence('contract:operating-model:practice', '实践闭环', 'Decision → P2 → Task → Action → Verification → Learning，任务执行与三层结果验证分开记录。', generatedAt, 'ontology-operating-model'),
      evidence('contract:operating-model:gate', '行动门禁', '所有业务写回必须经过 Action Gateway、人审、读回与回滚；当前 ERP M3 与市场信号保持只读。', generatedAt, 'ontology-operating-model'),
    ]
    return {
      intent,
      evidence: facts,
      answer: baseAnswer({
        conclusion: '公司大脑形成经营决策时，会依次经过“事实接入、权限与目的校验、证据编译、情景决策、P2/任务编译、受控执行、三层验证、学习回写”八个阶段。',
        factBasis: [
          'ERP M3 与市场信号先通过只读 Domain Connector 归一化，并保留来源、时效和双时间。',
          'Authority & Purpose 先确认当前员工能因什么目的使用哪些事实，再生成 Evidence Package。',
          'Evidence & Epistemic 区分事实、推导、假设、未知、冲突和过期信息。',
          'Scenario & Decision 比较备选方案、风险、预期结果和 DRI，当前只形成决策提案。',
          'Practice Protocol 将批准后的决策编译为 P2 与个人任务，但本次说明不会下发任务。',
          'Action Gateway 是唯一写回边界；当前 ERP 和社媒写回仍关闭。',
          'Verification 分别验证技术执行、业务结果和经营目标，不能用任务完成替代目标达成。',
          'Learning 只形成待审提案，经批准后才影响规则、Ontology 或执行能力。',
          '本次只做说明：不下发任务、不写回任何业务系统。',
        ],
        derivedSummary: '这套流程把“认识世界”和“改造世界”分开治理，并用 WorkCase 与 Decision Lineage 保留完整审计链。本次只做说明：不下发任务、不写回任何业务系统。',
        recommendedNextAction: '如需分析某个真实经营问题，请明确问题、时间范围和希望比较的方案；智慧中枢只生成决策提案，不会自动下发或写回。',
        evidenceReferences: facts.map((item) => item.evidenceId),
      }),
    }
  }

  const status = typeof systemStatusProvider === 'function'
    ? await systemStatusProvider()
    : {
        generatedAt,
        schemaVersion: 'unknown',
        registryStatus: 'unavailable',
        registryVersion: 'unknown',
        agentCoreVersion: 'unknown',
        agentCoreReady: false,
        hEngineProductionReady: false,
        domainConnectorVersion: 'unknown',
        domainConnectorStatus: 'unavailable',
        erpRecords: 0,
        marketRecords: 0,
        operationsRecords: 0,
        deviceRecords: 0,
        actionIntents: 0,
        deliveryOutbox: 0,
      }
  const factLines = [
    `Schema ${status.schemaVersion}；Registry ${status.registryStatus}（${status.registryVersion}）。`,
    `Agent Core ${status.agentCoreVersion}；运行就绪 ${status.agentCoreReady ? '是' : '否'}；H 引擎生产就绪 ${status.hEngineProductionReady ? '是' : '否'}。`,
    `Domain Connector ${status.domainConnectorVersion} / ${status.domainConnectorStatus}。`,
    `ERP Read Model ${status.erpRecords}（Operations ${status.operationsRecords}、Device ${status.deviceRecords}）；Market Read Model ${status.marketRecords}。`,
    `ActionIntent ${status.actionIntents}；Delivery Outbox ${status.deliveryOutbox}。`,
  ]
  const missing = []
  if (status.registryStatus === 'unavailable') missing.push('Registry 实时状态暂不可用')
  if (status.domainConnectorStatus === 'unavailable') missing.push('Domain Connector 实时状态暂不可用')
  const facts = factLines.map((line, index) => evidence(`system-status:${index + 1}`, `系统状态 ${index + 1}`, line, status.generatedAt))
  return {
    intent,
    evidence: facts,
    answer: baseAnswer({
      conclusion: missing.length === 0 ? '当前公司 AI Ontology 核心只读链路可用。' : '当前核心服务可回答，但部分实时状态源不可用。',
      factBasis: factLines,
      derivedSummary: '以上为脱敏系统状态，只包含版本、健康和聚合数量，不包含文档正文、人员敏感字段、凭据或业务写回能力。',
      recommendedNextAction: '如需刷新，请稍后重新查询；本次仅汇报状态，不创建任务、不下发、不执行写回。',
      confidenceLevel: missing.length === 0 ? 'high' : 'low',
      evidenceReferences: facts.map((item) => item.evidenceId),
      unknowns: missing,
    }),
  }
}
