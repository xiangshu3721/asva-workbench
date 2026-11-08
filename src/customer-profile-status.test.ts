import { describe, expect, it } from 'vitest'
import type { ProfileMaterialization } from './domain'
import {
  automaticProfileStatusMessage,
  countProfileVerificationItems,
  isAutomaticProfileInProgress,
} from './customer-profile-status'

describe('customer profile archive status', () => {
  it('keeps the initial queued marker in the automatic refresh flow', () => {
    expect(isAutomaticProfileInProgress('NOT_STARTED', true)).toBe(true)
    expect(isAutomaticProfileInProgress(undefined, true)).toBe(true)
    expect(isAutomaticProfileInProgress('NOT_STARTED', false)).toBe(false)
  })

  it('refreshes active stages and retryable failures but stops on terminal review states', () => {
    expect(isAutomaticProfileInProgress('PENDING')).toBe(true)
    expect(isAutomaticProfileInProgress('PROCESSING')).toBe(true)
    expect(isAutomaticProfileInProgress('EXTRACT_READY')).toBe(true)
    expect(isAutomaticProfileInProgress('FAILED', false, true)).toBe(true)
    expect(isAutomaticProfileInProgress('FAILED', false, false)).toBe(false)
    expect(isAutomaticProfileInProgress('REVIEW_REQUIRED', true)).toBe(false)
    expect(isAutomaticProfileInProgress('COMPLETED', true)).toBe(false)
  })

  it('counts visible items that need verification and deduplicates the same evidence', () => {
    const shared = {
      label: '家庭经历',
      text: '小时候经历过亲近的人去世',
      statusLabel: '第三方说法 · 待核实',
      evidenceIds: ['E-1'],
      basis: [],
    }
    const materialization = {
      sections: [
        { title: '家庭与关系', emptyLabel: '暂无', items: [shared] },
        { title: '兴趣偏好', emptyLabel: '暂无', items: [{ ...shared, label: '兴趣', text: '弹钢琴', statusLabel: '已确认', evidenceIds: ['E-2'] }] },
      ],
      provisionalItems: [
        { ...shared, fieldKey: 'family_events', value: null, displayText: shared.text, sourceId: 'SRC-1', evidenceId: 'E-1', contentSource: 'THIRD_PARTY_REPORTED', informationNature: 'PERSONAL_STATEMENT', verificationStatus: 'UNKNOWN', occurredAt: null, conflictState: 'UNCONFIRMED', sectionTitle: '家庭与关系' },
        { ...shared, label: '职业方向', text: '正在探索新职业', evidenceIds: ['E-3'], fieldKey: 'occupation', value: null, displayText: '正在探索新职业', sourceId: 'SRC-1', evidenceId: 'E-3', contentSource: 'CUSTOMER_DIRECT', informationNature: 'PERSONAL_STATEMENT', verificationStatus: 'UNKNOWN', occurredAt: null, conflictState: 'UNCONFIRMED', sectionTitle: '职业与事业' },
      ],
    } as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>

    expect(countProfileVerificationItems(materialization)).toBe(2)
  })

  it('treats coverage-only and partially materialized profiles as empty verification lists', () => {
    expect(countProfileVerificationItems({ coverage: { percentage: 27, domains: [] } } as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>)).toBe(0)
    expect(countProfileVerificationItems({ sections: [{ title: '家庭与关系', emptyLabel: '暂无' }] } as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>)).toBe(0)
    expect(countProfileVerificationItems({ provisionalItems: undefined } as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>)).toBe(0)
  })

  it('keeps verification counts isolated for different customer reads', () => {
    const customerA = { sections: [{ title: '家庭与关系', items: [{ label: '家庭', text: '待确认', statusLabel: '待核实', evidenceIds: [] }] }], provisionalItems: [] }
    const customerB = { sections: [{ title: '职业与事业', items: [{ label: '职业', text: '已确认', statusLabel: '已确认', evidenceIds: [] }] }], provisionalItems: [] }
    expect(countProfileVerificationItems(customerA as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>)).toBe(1)
    expect(countProfileVerificationItems(customerB as unknown as Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>)).toBe(0)
  })

  it('explains completed extraction separately from information still awaiting confirmation', () => {
    expect(automaticProfileStatusMessage('REVIEW_REQUIRED', 1)).toBe('AI整理已完成，档案已更新；另有 1 条信息待核实。')
    expect(automaticProfileStatusMessage('COMPLETED', 0)).toBe('AI整理完成，档案已更新。')
    expect(automaticProfileStatusMessage('NOT_STARTED', 0, true)).toContain('等待后台开始整理')
    expect(automaticProfileStatusMessage('FAILED', 0, false, false)).toContain('查看详情')
  })
})
