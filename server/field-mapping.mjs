// Internal field keys stay stable in code. These names are the visible labels
// used by Feishu Base operators. All Repository reads and writes go through
// this map so a display-label change cannot silently break the data layer.
import { serializeDateForFeishu } from './date-contract.mjs'

export const FIELD_MAPPING = {
  appointments: {
    appointment_id: '预约ID',
    customer_id: '客户ID',
    current_issue_description: '当前困扰',
    created_at: '创建时间',
    completed_at: '完成时间',
    contact_method: '联系方式',
    status: '预约状态',
    mentor_name: '当前导师',
    submitted_at: '预约时间',
    followup_info_completed: '跟进信息已完成',
    followup_handled: '跟进已处理',
    assigned_mentor_id: '当前导师ID',
    display_status: '处理状态',
    expectation: '希望获得什么帮助',
    source: '客户来源',
    case_source: '客户来源',
    reception_summary: '接待结果、最近跟进时间、备注',
    nickname: '客户昵称',
  },
  customers: {
    customer_id: '客户ID',
    nickname: '客户昵称',
    phone: '手机号',
    wechat: '微信号',
    created_at: '创建时间',
    source: '客户来源',
    referrer_name: '介绍人',
    brief: 'AI接待前Brief',
    intended_course: '意向课程',
    is_paid: '是否付费',
    paid: '付款状态',
    grade: '客户等级',
    sabc: 'SABC等级',
    current_issue: '当前困扰',
    help_expectation: '希望获得帮助',
    current_goal: '当前目标',
    notes: '备注',
    mentor_id: '当前导师ID',
    profile_updated_at: '档案更新时间',
    profile_field_meta_json: '档案字段元数据',
    profile_schema_version: '档案版本',
    gender: '性别', age: '年龄', birth_year: '出生年份', city: '所在城市', hometown: '家乡',
    marital_status: '婚姻状态', education: '教育背景', living_status: '居住状态', children_summary: '子女情况',
    occupation: '当前职业', industry: '所属行业', position: '当前职位', work_years: '工作年限', job_status: '工作状态',
    income_range: '收入范围', career_stage: '职业阶段', career_satisfaction: '职业满意度', career_problem: '职业困扰',
    career_goal: '职业目标', entrepreneurship_experience: '创业经历', family_summary: '家庭背景', parents_relationship: '父母关系',
    father_summary: '父亲情况', mother_summary: '母亲情况', relationship_with_father: '与父亲关系', relationship_with_mother: '与母亲关系',
    siblings: '兄弟姐妹', family_events: '家庭重要事件', family_support_level: '家庭支持程度', relationship_status: '亲密关系状态',
    partner_summary: '伴侣情况', marriage_years: '婚姻年限', relationship_satisfaction: '关系满意度', relationship_conflicts: '关系冲突',
    communication_pattern: '沟通模式', conflict_pattern: '冲突模式', relationship_goal: '关系目标', children_detail: '子女详情',
    parent_child_relationship: '亲子关系', parenting_problem: '育儿困扰', parenting_values: '育儿观念', hobbies: '兴趣爱好', sports: '运动习惯',
    reading: '阅读习惯', travel: '旅行偏好', art_preferences: '艺术偏好', social_preference: '社交偏好', sleep: '睡眠情况', diet: '饮食习惯',
    routine: '生活节奏', life_satisfaction: '生活满意度', self_description: '自我描述', personality_traits: '性格特点',
    communication_style: '沟通风格', decision_style: '决策风格', emotion_expression: '情绪表达', stress_response: '压力反应',
    conflict_style: '冲突风格', action_style: '行动风格', strengths: '优势', common_blocks: '常见卡点', core_values: '核心价值观',
    family_values: '家庭价值观', career_values: '职业价值观', money_values: '金钱观', relationship_values: '关系价值观',
    success_definition: '成功定义', happiness_definition: '幸福定义', freedom_definition: '自由定义', growth_attitude: '成长态度',
    current_core_issue: '当前核心需求', secondary_issues: '其他困扰', current_stressors: '当前压力源', current_expectation: '期待获得',
    current_resources: '当前资源', support_system: '支持系统', current_barriers: '当前阻碍', energy_state: '当前能量状态',
    recent_major_changes: '近期重要变化', ai_customer_summary: 'AI客户摘要',
  },
  serviceRecords: {
    service_record_id: '服务记录ID', customer_id: '客户ID', appointment_id: '预约ID', mentor_id: '实际服务导师ID', operator_id: '操作人ID',
    created_at: '服务时间', topic: '本次主要聊了什么', result: '本次结果', current_core_need: '当前核心需求', is_paid: '是否付费',
    sabc: 'SABC等级', intended_course: '意向课程', notes: '备注', profile_text: '客户档案补充原文',
    profile_updates_json: '档案更新明细', profile_update_confirmed: '档案更新已确认', ai_summary: 'AI本次总结',
    ai_status: 'AI当前客户状态', ai_next_step: 'AI下一步建议', mentor_confirmed: '导师已确认',
  },
  staff: {
    staff_id: '人员ID', nickname: '人员昵称', name: '姓名', phone: '手机号', login_phone: '登录手机号', role: '系统角色',
    permission_role: '权限角色', status: '账号状态', display_status: '状态', login_enabled: '允许登录', mentor_id: '导师ID',
    specialty: '专业方向', display_role: '显示身份', created_at: '创建时间', updated_at: '更新时间', deactivated_at: '注销时间',
  },
  products: {
    product_id: '产品ID', product_name: '课程名称', description: '产品描述', status: '状态',
  },
  enrollments: {
    enrollment_id: '报名记录ID', customer_id: '客户ID', product_id: '产品ID', product_name: '课程名称', amount: '金额',
    enrollment_source: '报名来源', enrolled_at: '报名时间', operator_id: '操作人ID',
    payment_status: '付款状态', paid: '是否付费', paid_at: '付款时间', created_at: '创建时间', status: '报名状态',
  },
  profileChanges: {
    field: '字段', field_key: '字段键', field_name: '字段名称', old_value: '旧值', new_value: '新值',
    source: '变更来源', confidence: '置信度', confirmed: '已确认', customer_id: '客户ID', service_record_id: '服务记录ID',
    operator_id: '操作人ID', changed_at: '变更时间', updated_at: '更新时间',
  },
}

// Temporary migration aliases. They are intentionally kept here, rather than
// scattered through Repository code, so the app remains readable while a
// Feishu field rename is being rolled out table by table.
const LEGACY_FIELD_NAMES = {
  appointments: {
    appointment_id: '预约编号', current_issue_description: '当前困扰描述', contact_method: '微信 / 联系方式',
    mentor_name: '分配导师', submitted_at: '提交时间', nickname: '昵称',
  },
  customers: { nickname: '昵称', phone: '联系电话', sabc: 'SABC' },
  staff: { login_phone: '手机号' },
  products: { status: '状态', description: '描述' },
  serviceRecords: { sabc: 'SABC' },
}

export function field(table, key) {
  return FIELD_MAPPING[table]?.[key] || key
}

export function fields(table, values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [field(table, key), DATE_FIELDS[table]?.has(key) ? serializeDateForFeishu(value) : value]))
}

export function read(table, recordFields, key) {
  const canonical = field(table, key)
  if (recordFields?.[canonical] !== undefined) return recordFields[canonical]
  const legacy = LEGACY_FIELD_NAMES[table]?.[key] || key
  return recordFields?.[legacy]
}

const DATE_FIELDS = {
  appointments: new Set(['created_at', 'completed_at']),
  customers: new Set(['created_at']),
  serviceRecords: new Set(['created_at']),
  staff: new Set(['created_at', 'updated_at', 'deactivated_at']),
  enrollments: new Set(['enrolled_at', 'paid_at', 'created_at']),
  profileChanges: new Set(['changed_at', 'updated_at']),
}
