import { FIELD_MAPPING } from './field-mapping.mjs'

const DATE_KEYS = new Set(['created_at', 'updated_at', 'deactivated_at', 'completed_at', 'submitted_at', 'profile_updated_at', 'enrolled_at', 'paid_at', 'changed_at'])
const BOOLEAN_KEYS = new Set(['is_paid', 'followup_info_completed', 'followup_handled', 'login_enabled', 'confirmed', 'profile_update_confirmed', 'mentor_confirmed'])
const NUMBER_KEYS = new Set(['amount', 'confidence'])
const PHONE_KEYS = new Set(['phone', 'login_phone'])
const SINGLE_SELECT_KEYS = new Set(['status', 'display_status', 'role', 'permission_role', 'sabc', 'result', 'payment_status'])
const TEXT_DATE_KEYS = new Set(['submitted_at', 'profile_updated_at'])

function typeFor(key, table) {
  if (table === 'customers' && key === 'paid') return 'Text'
  if (table === 'enrollments' && key === 'paid') return 'Checkbox'
  if (table === 'profileChanges' && key === 'source') return 'SingleSelect'
  if (PHONE_KEYS.has(key)) return 'Phone'
  if (SINGLE_SELECT_KEYS.has(key)) return 'SingleSelect'
  if (TEXT_DATE_KEYS.has(key)) return 'Text'
  if (DATE_KEYS.has(key)) return 'DateTime'
  if (BOOLEAN_KEYS.has(key)) return 'Checkbox'
  if (NUMBER_KEYS.has(key)) return 'Number'
  return 'Text'
}

function fieldDefinition(internalKey, feishuName, overrides = {}) {
  return {
    internal_key: internalKey,
    feishu_name: feishuName,
    type: typeFor(internalKey),
    required: false,
    nullable: true,
    readable: true,
    writable: true,
    enum: null,
    date_format: DATE_KEYS.has(internalKey) ? 'ISO-8601 (domain/API); Feishu DateTime milliseconds (adapter)' : null,
    deprecated: false,
    ...overrides,
  }
}

export const SCHEMA_CONTRACT = Object.fromEntries(Object.entries(FIELD_MAPPING).map(([table, mapping]) => [table, Object.entries(mapping).map(([internalKey, feishuName]) => fieldDefinition(internalKey, feishuName, { type: typeFor(internalKey, table) }))]))

SCHEMA_CONTRACT.customers = SCHEMA_CONTRACT.customers.map((field) => field.internal_key === 'current_mentor_id' ? fieldDefinition(field.internal_key, field.feishu_name, { writable: true }) : field)
SCHEMA_CONTRACT.appointments = SCHEMA_CONTRACT.appointments.map((field) => fieldDefinition(field.internal_key, field.feishu_name, { writable: field.internal_key !== 'appointment_id' }))
SCHEMA_CONTRACT.customers.push(fieldDefinition('mentor_id_legacy', '导师ID', { readable: true, writable: false, deprecated: true }))
SCHEMA_CONTRACT.profileChanges = SCHEMA_CONTRACT.profileChanges.map((field) => field.internal_key === 'field_name' ? fieldDefinition('field_name', '字段名称', { type: 'Text', enum: ['婚姻状态'], required: false }) : field)

export const SCHEMA_GAPS = [
  { table: 'customers', feishu_name: '父亲情况', internal_key: 'father_summary', reason: '当前生产表未发现可确认的同义字段；暂不扩表，保留映射与缺口记录。' },
]

export function contractFields(table) { return SCHEMA_CONTRACT[table] || [] }
export function contractFieldByName(table, name) { return contractFields(table).find((field) => field.feishu_name === name) }
