export function classifyGovernedIntent(turn = {}) {
  const message = String(turn.message || '').normalize('NFKC').trim()
  const compact = message.replace(/\s+/g, '')

  const personalIdentity = (
    /(以|用)(我|本人|员工本人).{0,8}(个人身份|用户身份|飞书身份|身份)/u.test(compact)
    || /(我的飞书|我的日程|个人日程|我的邮箱|我的云文档)/u.test(compact)
  )
    && /(修改|编辑|创建|新建|删除|发送|回复|移动|授权|邀请|提交|操作)/u.test(compact)
  if (personalIdentity) return { kind: 'personal_identity_handoff', evidencePolicy: 'company-front-door-boundary' }

  const systemSubject = /(公司AI(?:Ontology|本体)|AI(?:Ontology|本体)|公司智慧中枢|智慧中枢|公司大脑)/iu.test(compact)
  const systemState = /(运行状态|当前状态|健康状态|Schema|Registry|AgentCore|DomainConnector|ReadModel|读模型)/iu.test(compact)
  if (systemSubject && systemState) return { kind: 'system_status', evidencePolicy: 'sanitized-system-status' }

  const operatingSubject = /(ERPM3|ERP|市场信号|社媒|经营决策|公司大脑|智慧中枢)/iu.test(compact)
  const operatingQuestion = /(经过哪些阶段|哪些阶段|如何形成|工作逻辑|如何运转|决策流程|形成经营决策)/u.test(compact)
  if (operatingSubject && operatingQuestion) return { kind: 'operating_model_explanation', evidencePolicy: 'versioned-operating-model' }

  return null
}
