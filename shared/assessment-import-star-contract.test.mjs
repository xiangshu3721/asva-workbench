import { describe, expect, it } from 'vitest'
import { normalizeStarReportPreview, parseStarShareUrl } from './assessment-import-star-contract.mjs'

const reportId = 'rpt_abcdefghijk'
const secret = 'abcdefghijklmnoP'
const base = 'https://xiangshu3721.github.io/mindtest-web/r/'
const report = () => ({
  reportId,
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '测试昵称',
  completedAt: '2026-11-17T10:02:03+08:00',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造', '自由', '探索'] },
    { id: 'pursue', name: '现实追求', kind: 'category', score: null, labels: ['成长', '表达', '连接'] },
  ],
  extensionData: { rounds: { cull1: ['私人信息'], revived: ['不应外传'] }, consent: { scopes: ['store', 'share_link', 'mentor_read'] } },
  ownerToken: 'PRIVATE_DO_NOT_ECHO',
  linkSecret: secret,
})

describe('Stage 1A star-only assessment import contract', () => {
  it('parses canonical share link with stripped report prefix', () => {
    expect(parseStarShareUrl(base + '#abcdefghijk.' + secret)).toEqual({
      provider: 'mindtest-web', reportId, linkSecret: secret,
    })
  })

  it('accepts the prefixed report ID only in the approved origin/path', () => {
    expect(parseStarShareUrl(base + '#' + reportId + '.' + secret).reportId).toBe(reportId)
    for (const input of [
      'http://xiangshu3721.github.io/mindtest-web/r/#abcdefghijk.' + secret,
      'https://evil.example/mindtest-web/r/#abcdefghijk.' + secret,
      'https://xiangshu3721.github.io/mindtest-web/r.evil/#abcdefghijk.' + secret,
      'https://xiangshu3721.github.io/mindtest-web/r/?test=1#abcdefghijk.' + secret,
      'https://xiangshu3721.github.io/mindtest-web/r/#abcdefghijk.short',
      'https://xiangshu3721.github.io@evil.example/mindtest-web/r/#abcdefghijk.' + secret,
      'https://xiangshu3721.github.io/mindtest-web/r/../../admin#abcdefghijk.' + secret,
      'file:///mindtest-web/r/#abcdefghijk.' + secret,
      'https://xiangshu3721.github.io/mindtest-web/r/#abcdefghijk.' + secret + '#extra',
      'https://xiangshu3721.github.io/mindtest-web/r/#abcdefghijk.' + secret + '\ninvalid',
      'rpt_abcdefghijk.' + secret,
    ]) {
      expect(() => parseStarShareUrl(input)).toThrow()
    }
  })

  it('validates recognized star payload and exposes minimal preview only', () => {
    const input = report()
    const p = normalizeStarReportPreview(input, reportId)
    expect(p).toMatchObject({
      reportId, assessmentId: 'star', nickname: '测试昵称',
      keyMetrics: [{ id: 'drive' }, { id: 'pursue' }],
    })
    expect(p.headline).toContain('创造')
    const serialized = JSON.stringify(p)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('PRIVATE_DO_NOT_ECHO')
    expect(serialized).not.toContain('私人信息')
    expect(serialized).not.toContain('consent')
    expect(input.extensionData.rounds.cull1).toEqual(['私人信息'])
  })

  it('rejects other assessments and incompatible schemas instead of silently importing', () => {
    for (const patch of [{ assessmentId: 'sefs' }, { assessmentId: 'pdq4' }, { schemaVersion: '2.0.0' }]) {
      expect(() => normalizeStarReportPreview({ ...report(), ...patch }, reportId)).toThrow()
    }
  })

  it('rejects provider report-ID mismatch before any customer binding', () => {
    expect(() => normalizeStarReportPreview(report(), 'rpt_xyzxyzxyzxy')).toThrow()
    expect(() => normalizeStarReportPreview({ ...report(), reportId: 'rpt_zzzzzzzzzzz' }, reportId)).toThrow()
  })

  it('rejects missing timestamps, nickname, versions and malformed dimensions', () => {
    for (const patch of [
      { completedAt: 'yesterday' },
      { completedAt: '2026-99-17T10:02:03+08:00' },
      { nickname: '' },
      { assessmentVersion: '' },
      { dimensions: [{ id: 'drive', labels: ['创造', '自由', '探索'] }] },
      { dimensions: [{ id: 'drive', labels: ['创造', '自由', '探索'] }, { id: 'pursue', labels: ['探索', '表达', '连接'] }] },
      { dimensions: [{ id: 'drive', labels: ['创造', '自由', '<script>'] }, { id: 'pursue', labels: ['成长', '表达', '连接'] }] },
    ]) expect(() => normalizeStarReportPreview({ ...report(), ...patch }, reportId)).toThrow()
  })

  it('does not treat a valid nickname or original mentor_read scope as customer identity/ASVA authorization', () => {
    const p = normalizeStarReportPreview(report(), reportId)
    expect(p).not.toHaveProperty('customerId')
    expect(p).not.toHaveProperty('verified')
    expect(p).not.toHaveProperty('consent')
    expect(p).not.toHaveProperty('linkSecret')
  })

  it('has controlled error messages that never echo the bearer secret', () => {
    for (const action of [
      () => parseStarShareUrl('https://evil.example/#' + reportId + '.' + secret),
      () => normalizeStarReportPreview({ ...report(), assessmentId: 'sefs' }, reportId),
    ]) {
      try { action(); throw new Error('expected to throw') }
      catch (error) {
        expect(String(error.message)).not.toContain(secret)
        expect(String(error.message)).not.toContain(reportId)
      }
    }
  })
})
