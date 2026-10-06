const EMPTY = '尚待进一步澄清'

function asText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).join('、')
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function useful(value) {
  const text = asText(value)
  if (!text || text.length < 2) return false
  if (/^(暂无|未知|未填写|没有|无|1111+|哈哈+|呵呵+|嗯+|好+|test|n\/a)$/i.test(text)) return false
  if (/^(.)\1{2,}$/.test(text)) return false
  return /[\u4e00-\u9fffA-Za-z]/.test(text)
}

function unique(values, limit = 5) {
  return [...new Set(values.map(asText).filter(useful))].slice(0, limit)
}

function contains(text, pattern) {
  return pattern.test(asText(text))
}

function dateValue(value) {
  const match = asText(value).match(/\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : ''
}

function sortRecent(items, key) {
  return [...items].sort((a, b) => dateValue(b[key]).localeCompare(dateValue(a[key])))
}

export function buildCustomerAiContext(database, customerId, now = new Date().toISOString()) {
  const customer = database.customers.find((item) => item.id === customerId)
  if (!customer) throw new Error(`客户不存在: ${customerId}`)
  const profile = customer.profileFields || {}
  const currentCase = sortRecent(database.appointments.filter((item) => item.customerId === customerId), 'createdAt')[0] || null
  const recentSessions = sortRecent(database.sessions.filter((item) => item.customerId === customerId), 'date').slice(0, 3)
  const recentChanges = sortRecent(database.profileChanges.filter((item) => item.customerId === customerId), 'updatedAt').slice(0, 3)
  const enrollments = database.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED').map((item) => ({
    ...item,
    productName: database.products.find((product) => product.id === item.productId)?.name || item.productId,
  }))
  return {
    now,
    customer: {
      id: customer.id,
      name: customer.name,
      createdAt: customer.createdAt,
      source: customer.source || '',
      grade: customer.grade,
      need: customer.need || '',
      helpExpectation: customer.helpExpectation || '',
      goal: customer.goal || '',
      intendedCourse: customer.intendedCourse || '',
      notes: customer.notes || '',
      paid: Boolean(customer.paid),
      profile,
    },
    currentCase: currentCase ? {
      id: currentCase.id,
      status: currentCase.status,
      topic: currentCase.topic,
      description: currentCase.description,
      expectation: currentCase.expectation,
      createdAt: currentCase.createdAt,
      source: currentCase.source,
    } : null,
    recentSessions: recentSessions.map((item) => ({
      date: item.date,
      topic: item.topic,
      note: item.note,
      result: item.result,
      nextStep: item.nextStep,
      aiSummary: item.aiSummary || '',
    })),
    recentChanges: recentChanges.map((item) => ({ field: item.field, oldValue: item.oldValue, newValue: item.newValue, updatedAt: item.updatedAt, source: item.source })),
    enrollments,
  }
}

function contextText(context) {
  const customer = context.customer || {}
  const profile = customer.profile || {}
  const sessions = (context.recentSessions || []).flatMap((item) => [item.topic, item.note, item.result, item.nextStep, item.aiSummary])
  return [customer.need, customer.helpExpectation, customer.goal, customer.notes, ...Object.values(profile), ...sessions].map(asText).join(' ')
}

function issueLabels(context) {
  const customer = context.customer || {}
  const profile = customer.profile || {}
  const source = [customer.need, profile.current_core_issue, profile.secondary_issues, profile.current_stressors, profile.career_problem, profile.relationship_conflicts]
  const issues = []
  for (const value of source) {
    const text = asText(value)
    if (!useful(text)) continue
    if (contains(text, /离婚|离异|婚姻变化/)) issues.push('关系变化后的生活重建')
    else if (contains(text, /职业|工作|转型|换行业|副业|创业/)) issues.push('职业方向与现实选择')
    else if (contains(text, /睡眠|失眠|情绪|焦虑|惊恐|内耗/)) issues.push('情绪与生活节奏恢复')
    else if (contains(text, /孩子|育儿|亲子|父母/)) issues.push('家庭关系与照顾压力')
    else issues.push(text)
  }
  return unique(issues, 3)
}

function riskFor(context) {
  const text = contextText(context)
  if (contains(text, /自杀|自伤|伤害自己|不想活|无法保证安全|暴力威胁|急诊/)) return { level: 'HIGH', reason: '资料中出现需要真人立即核实的安全信号，暂停普通服务推进。' }
  if (contains(text, /失眠严重|持续失眠|惊恐发作|情绪失控|无法工作|明显绝望/)) return { level: 'MEDIUM', reason: '近期状态可能已影响日常功能，需由真人进一步确认持续时间和支持情况。' }
  const meaningfulCount = [context.customer?.need, context.customer?.helpExpectation, context.customer?.goal, context.customer?.notes, ...(Object.values(context.customer?.profile || {}))].filter(useful).length
  if (meaningfulCount < 2) return { level: 'UNASSESSED', reason: '当前有效信息不足，尚未完成安全风险评估。' }
  return { level: 'LOW', reason: '现有资料中暂未发现明确即时安全风险，仍需在真实沟通中确认。' }
}

export function generateCoreSummary(context) {
  const customer = context.customer || {}
  const profile = customer.profile || {}
  const issues = issueLabels(context)
  const sparse = !useful(customer.need) && !useful(customer.helpExpectation) && !useful(customer.goal) && !issues.length
  if (sparse) {
    return {
      overview: '当前有效信息较少，暂时只能确认客户提交过一个困扰主题，尚不足以形成稳定的人物判断。',
      core_issues: ['尚待澄清'],
      priority_topics: ['建立基本理解'],
      current_goals: ['待确认'],
      resources: ['尚待确认'],
      service_focus: '先建立安全、基本的理解，再确认客户当前最想处理的一件事。',
      risk: riskFor(context),
      confidence: 'LOW',
      missing_key_information: ['最近最困扰的具体场景', '希望获得的帮助', '近期日常状态与支持系统'],
    }
  }

  const relationshipChange = contains(contextText(context), /离婚|离异|婚姻变化|分手|关系结束/)
  const careerChange = contains([customer.need, customer.goal, profile.career_problem, profile.career_goal, profile.recent_major_changes].map(asText).join(' '), /职业方向|职业选择|换工作|离开.*工作|转型|换行业|副业|创业/)
  const sleepIssue = useful(profile.sleep) || contains(contextText(context), /睡眠|失眠/)
  const majorChange = useful(profile.recent_major_changes) ? asText(profile.recent_major_changes) : ''
  let overview = ''
  if (relationshipChange && careerChange) overview = `客户近期处于${majorChange || '关系与生活结构变化'}后的重建阶段，关系变化带来的稳定感下降，也让职业方向问题变得更突出；两者叠加，当前更像是在寻找可控感，而不是马上做出重大决定。`
  else if (relationshipChange) overview = `客户正在经历关系变化后的生活重建期，眼下的困扰不只在关系本身，也涉及日常节奏、情绪承受和对未来的把握感。`
  else if (careerChange) overview = `客户正处于工作或职业选择的重新评估期，已有一定方向意识，但仍需要把抽象的纠结落到具体场景、现实条件和可验证的下一步。`
  else if (sleepIssue) overview = `客户当前的困扰已经和睡眠或日常节奏发生联系，服务上宜先恢复稳定感，再逐步厘清背后的问题与目标。`
  else overview = `客户已经表达了${asText(customer.need) || '一个当前困扰'}，并希望${asText(customer.helpExpectation) || '获得进一步支持'}；目前可先从具体经历和最急迫的一块开始理解。`

  const currentGoals = unique([customer.goal, profile.current_goal], 2)
  const resources = unique([profile.current_resources, profile.support_system, profile.strengths, profile.hobbies], 3)
  const priority = []
  if (relationshipChange || sleepIssue) priority.push('恢复近期生活稳定感')
  if (sleepIssue) priority.push('确认睡眠与日常功能影响')
  if (careerChange) priority.push('把职业困惑落到现实选择')
  if (!priority.length) priority.push(issues[0] || '确认当前最需要支持的一件事')
  if (currentGoals.length === 0) currentGoals.push('尚待进一步澄清')
  if (resources.length === 0) resources.push('尚待确认现有支持与可用资源')
  const informationCount = [customer.need, customer.helpExpectation, customer.goal, ...Object.values(profile), ...(context.recentSessions || []).map((item) => item.note)].filter(useful).length
  return {
    overview,
    core_issues: issues.length ? issues : ['尚待澄清'],
    priority_topics: unique(priority, 3),
    current_goals: currentGoals,
    resources,
    service_focus: relationshipChange || sleepIssue ? '先帮助客户恢复稳定和被理解的感觉，再进入职业、关系或长期行动的探索。' : '先围绕客户明确表达的困扰聚焦一个具体场景，再共同确认可行动的一步。',
    risk: riskFor(context),
    confidence: informationCount >= 10 ? 'HIGH' : informationCount >= 5 ? 'MEDIUM' : 'LOW',
    missing_key_information: missingInformation(context, { relationshipChange, careerChange, sleepIssue }),
  }
}

function missingInformation(context, flags) {
  const customer = context.customer || {}
  const profile = customer.profile || {}
  const result = []
  if (flags.relationshipChange && !useful(profile.sleep)) result.push('近期睡眠和日常生活状态')
  if (flags.careerChange && !useful(profile.job_status)) result.push('当前工作或离职状态与现实经济压力')
  if (!useful(profile.support_system) && !useful(profile.current_resources)) result.push('目前主要支持系统')
  if (!useful(customer.goal) && !useful(profile.current_goal)) result.push('客户希望本次先变清楚什么')
  return unique(result.length ? result : ['最近一次变化后的真实感受'], 4)
}

export function generateBrief(context, summary = generateCoreSummary(context)) {
  const customer = context.customer || {}
  const profile = customer.profile || {}
  const lowInfo = summary.confidence === 'LOW' && summary.core_issues[0] === '尚待澄清'
  const relationshipChange = contains(contextText(context), /离婚|离异|婚姻变化|分手|关系结束/)
  const careerChange = contains([customer.need, customer.goal, profile.career_problem, profile.career_goal, profile.recent_major_changes].map(asText).join(' '), /职业方向|职业选择|换工作|离开.*工作|转型|换行业|副业|创业/)
  const sleepIssue = useful(profile.sleep) || contains(contextText(context), /睡眠|失眠/)
  const childIssue = contains([customer.need, profile.children_detail, profile.current_stressors].map(asText).join(' '), /孩子.*(?:生病|发烧|住院|复诊)|(?:生病|发烧|住院|复诊|照顾|照护).*孩子/)
  const latestSession = context.recentSessions?.[0]
  const confirmed = lowInfo
    ? ['当前只确认客户提交过一个困扰主题，内容仍不足以形成稳定判断。']
    : unique([
      relationshipChange ? '近期经历了关系或婚姻层面的重要变化。' : '',
      careerChange ? '当前同时在面对工作或职业方向的重新选择。' : '',
      customer.need,
      customer.goal ? `客户明确希望：${customer.goal}` : '',
      latestSession?.aiSummary || latestSession?.note || '',
      profile.support_system ? `目前已有支持：${asText(profile.support_system)}。` : '',
      context.enrollments?.length ? `已有服务关系：${context.enrollments.map((item) => item.productName).join('、')}。` : '',
    ], 5)
  const toConfirm = lowInfo
    ? ['最近最希望解决的具体事情', '当前困扰主要发生在哪个生活场景', '近期日常状态与是否需要即时支持']
    : unique([
      ...summary.missing_key_information,
      relationshipChange && !useful(profile.sleep) ? '最近生活有没有慢慢安顿下来，睡眠是否受影响' : '',
      careerChange && !useful(profile.job_status) ? '当前是否已经正式离职，现实压力主要在哪里' : '',
    ], 4)
  const careCues = unique([
    sleepIssue ? '可以先自然问问最近有没有睡得稍微好一点。' : '',
    childIssue ? '可以先关心孩子最近的情况，再进入客户自己的困扰。' : '',
    relationshipChange ? '可以先关心最近生活有没有慢慢安顿下来，不急着追问关系细节。' : '',
    useful(profile.recent_major_changes) && !relationshipChange ? `可以记得问一句：${asText(profile.recent_major_changes)}最近还好吗？` : '',
  ], 2)
  const entryPoints = lowInfo
    ? ['先建立基本理解，让客户自己决定从哪里展开，不急于分析或给建议。', '先听客户描述一个最近发生的具体场景，再确认这次最希望获得什么。']
    : [
      relationshipChange ? '先从最近生活有没有慢慢稳定下来聊起，让客户自己决定是否展开关系细节。' : careerChange ? '先从最近一个具体的工作或选择场景开始，把抽象纠结落到现实。' : '先接住最近最消耗客户的具体场景，再决定是否进入更深层的分析。',
      sleepIssue ? '如果客户状态偏疲惫，先回应感受和生活影响，不急着布置方法或推动决定。' : summary.service_focus,
      careCues[0] || '保持先听后问，前一两个问题已经足够时就收住，不追求问完清单。',
    ].filter(Boolean).slice(0, 3)
  const questions = lowInfo
    ? ['你愿意的话，可以先和我说说最近最让你困扰的一件事。', '这件事最近主要在哪个场景里变得明显？', '如果今天聊完能让一件事清楚一点，你最希望是哪件？']
    : unique([
      relationshipChange ? '这段时间里，最近哪一部分生活最让你觉得难熬或不稳？' : '',
      careerChange ? '如果先不急着决定要不要换方向，最近哪个具体工作选择最让你卡住？' : '',
      sleepIssue ? '最近睡眠和白天做事的状态，大概受到了怎样的影响？' : '',
      customer.goal ? `如果先围绕“${customer.goal}”往前走一步，你觉得最现实的一小步是什么？` : '',
      latestSession?.nextStep ? `上次提到的“${latestSession.nextStep}”，这段时间有什么变化？` : '',
      '如果今天只先聊一件事，你最想从哪里开始？',
    ], 4)
  const highRisk = summary.risk.level === 'HIGH'
  return {
    confirmed,
    to_confirm: toConfirm.slice(0, 4),
    entry_points: highRisk ? ['先暂停普通课程或成交话题，确认客户当下是否安全以及是否有可联系的真人支持。'] : entryPoints,
    suggested_questions: highRisk ? ['你现在此刻是否安全？有没有想伤害自己或他人的念头？', '此刻身边有没有可以陪着你的人？'] : questions.slice(0, 4),
    interaction_guidance: {
      tone: highRisk ? '稳定、直接、以安全为先' : lowInfo ? '温和、开放、少做判断' : sleepIssue || relationshipChange ? '温柔、慢一点，先回应感受' : '具体、清晰，先听后问',
      pace: highRisk ? '先安全核实，再决定是否继续普通服务' : lowInfo ? '少分析，多听和确认' : contains(profile.communication_style, /简短|少表达|谨慎/) ? '从具体场景开始，先听后问' : '先听后问，围绕一个重点推进',
      avoid: highRisk ? ['课程推荐和成交推进', '把安全信号解释成性格问题'] : [relationshipChange ? '一开始追问关系责任或细节' : '', careerChange ? '过早替客户做职业决定' : '', '连续追问多个问题', '把 AI 推断当成事实'].filter(Boolean).slice(0, 4),
      care_cues: careCues,
    },
    lede: lowInfo ? '当前资料还不足以形成完整判断，本次 Brief 以建立基本理解和澄清需求为主。' : childIssue ? '先关心孩子近况和客户自己的消耗，再一起看照顾与工作之间怎样分配。' : summary.service_focus,
  }
}

export function briefText(brief) {
  return [
    brief.lede,
    `建议先从：${(brief.entry_points || []).join('；')}`,
    `备选提问：${(brief.suggested_questions || []).join('；')}`,
  ].filter(Boolean).join('\n')
}
