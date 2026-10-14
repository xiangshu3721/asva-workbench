import { describe, expect, it } from 'vitest'
import { humanizeDensity, humanizeEvidenceType, humanizeLevel, sanitizeUserVisibleText } from './presentationCopy'

describe('user-visible AI copy', () => {
  it('removes internal enums from explanatory copy', () => {
    const copy = sanitizeUserVisibleText('strategy=STABILIZE_FIRST, service_gate=HARD_BLOCK, willingness_to_pay=UNKNOWN, evidence_type=HYPOTHESIS')
    expect(copy).toContain('先稳定状态')
    expect(copy).toContain('暂不适合进入常规服务')
    expect(copy).toContain('待确认')
    expect(copy).toContain('AI初步判断')
    expect(copy).not.toMatch(/STABILIZE_FIRST|HARD_BLOCK|willingness_to_pay|HYPOTHESIS/)
  })

  it('keeps ordinary Chinese and customer identifiers readable', () => {
    expect(sanitizeUserVisibleText('阿文的客户档案 CUS-13455 已更新')).toBe('阿文的客户档案 CUS-13455 已更新')
  })

  it('maps evidence and profile density labels', () => {
    expect(humanizeEvidenceType('HYPOTHESIS')).toBe('AI初步判断，待确认')
    expect(humanizeDensity('SPARSE')).toBe('目前了解还比较少')
    expect(humanizeLevel('UNKNOWN')).toBe('待确认')
  })
})
