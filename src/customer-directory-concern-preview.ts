import type { Customer } from './domain'
import { buildLocalConsultationTopics } from './clientApi'

const preview = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 56)

/**
 * Directory rows are a deliberately limited projection (need + notes, not
 * verified Evidence or supplemental records). Never claim the customer has
 * "no current concern" merely because the directory projection is sparse.
 * Preserve the old need-field display; do not expose excerpts from notes in
 * the list, where unrelated customers are visible at once.
 */
export function customerDirectoryConcernPreview(customer: Customer): string {
  const recordedNeed = preview(customer.need)
  if (recordedNeed) return recordedNeed

  const topics = buildLocalConsultationTopics(customer).topics
  const lead = topics[0]
  if (lead?.kind === 'EXPLICIT_CONCERN') return '已记录困扰线索 · 查看详情'
  if (lead?.kind === 'PROVISIONAL_DIRECTION') {
    const direction = preview(lead.title.replace(/方面的咨询方向$/, ''))
    return direction ? `咨询方向：${direction} · 待确认` : '已记录咨询方向 · 查看详情'
  }
  return '查看详情中的咨询线索'
}
