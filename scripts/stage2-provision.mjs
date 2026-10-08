import { config } from '../server/config.mjs'
import { createField, createTable, listFields, listTables } from '../server/feishu.mjs'
import { FIELD_MAPPING } from '../server/field-mapping.mjs'

const definitions = [
  ['sourceRecords', 'ASVA 客户原始资料'],
  ['evidenceItems', 'ASVA 客户证据'],
  ['profileUpdateProposals', 'ASVA 档案更新建议'],
  ['evidenceConflicts', 'ASVA 信息冲突'],
]

const fieldsFor = (table) => Object.values(FIELD_MAPPING[table] || {}).filter(Boolean).filter((name, index, all) => all.indexOf(name) === index).map((field_name) => ({ field_name, type: 1 }))
const tableByName = new Map((await listTables()).map((table) => [table.name, table]))
const result = []

for (const [key, name] of definitions) {
  let table = tableByName.get(name)
  if (!table) {
    const created = await createTable(name, fieldsFor(key))
    table = created.table || created
  }
  const tableId = table.table_id || table.id
  if (!tableId) throw new Error(`无法取得表 ID: ${name}`)
  const liveFields = await listFields(tableId)
  const existing = new Set(liveFields.map((field) => field.field_name))
  for (const fieldName of fieldsFor(key).map((item) => item.field_name)) {
    if (!existing.has(fieldName)) await createField(tableId, fieldName, 1)
  }
  result.push({ key, name, tableId, fieldCount: fieldsFor(key).length })
}

console.log(JSON.stringify({ ok: true, tables: result }))
