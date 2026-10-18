import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('./clientApi.ts', import.meta.url), 'utf8')
const assistantSource = readFileSync(new URL('./GlobalAIAssistant.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('R043 我的页面渐进加载', () => {
  it('renders the account shell from current staff without waiting for the full database', () => {
    expect(appSource).toContain('const mePage = <MePage staff={activeStaff}')
    expect(appSource).not.toContain('const mePage = database ? <MePage')
    expect(appSource).toContain("if (view !== 'customers' || !loggedInStaffId")
  })

  it('keeps account statistics and mentor management on independent resources', () => {
    expect(appSource).toContain("api.basicDashboard(staff.id)")
    expect(appSource).toContain("api.teamSnapshot(staffId)")
    expect(appSource).toContain('customerPreviews')
    expect(apiSource).toContain('TeamSnapshotCustomerPreview')
    expect(appSource).not.toContain('function AccountPanel({ staff, database')
    expect(appSource).not.toContain('function TeamPanel({ staffId, database')
  })

  it('keeps role-specific entry points and logout available before account stats resolve', () => {
    expect(appSource).toContain("staff.permissionRole === 'ADMIN'")
    expect(appSource).toContain('修改个人密码')
    expect(appSource).toContain('退出当前账号')
    expect(appSource).toContain('accountStatsLoading')
  })
})

describe('R043 mobile AI assistant FAB', () => {
  it('keeps the accessible open/close control and compact mobile dimensions', () => {
    expect(assistantSource).toContain('aria-label="打开 AI 助手"')
    expect(assistantSource).toContain('className="ai-fab-label"')
    expect(stylesSource).toContain('.ai-fab { width: 46px; height: 46px;')
    expect(stylesSource).toContain('right: 12px; bottom: calc(65px + env(safe-area-inset-bottom) + 12px)')
    expect(stylesSource).toContain('.ai-fab-label { display: none; }')
  })
})
