// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanuoyunOnboardingDialog } from '../src/client/PanuoyunOnboardingDialog.tsx'
import type { PanuoyunOnboardingDialogProps } from '../src/client/PanuoyunOnboardingDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); document.getElementById('root')?.remove() })

function props() {
  const complete = vi.fn()
  const panuoyun = {
    configure: vi.fn(async () => {}), login: vi.fn(async () => {}),
    groups: vi.fn(async () => [{ id: '42', name: 'Research' }]),
    selectApiKey: vi.fn(async () => {}), createApiKey: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
  }
  const state = {
    status: 'ready', error: null, credentialError: null, writable: true,
    rows: [{ entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true }, apiKeyEnv: 'DEEPSEEK_API_KEY', credential: { writable: true, configured: false } }],
  }
  const input = {
    automatic: true, explicit: false, stepId: 'panuoyun', complete,
    controller: { load: vi.fn(async () => {}) }, useModels: (selector: (snapshot: typeof state) => unknown) => selector(state),
    operations: {}, panuoyun, t: (key: keyof typeof en) => en[key],
  } as unknown as PanuoyunOnboardingDialogProps
  return { input, complete, panuoyun }
}

describe('PanuoyunOnboardingDialog', () => {
  it('defaults to personal login, permits enterprise login input, and sends only the typed key to the host', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root)
    const h = props()
    render(<PanuoyunOnboardingDialog {...h.input} />)
    expect(await screen.findByRole('dialog', { name: '派诺云账号' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>('版本').value).toBe('personal')
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: 'enterprise' } })
    fireEvent.change(screen.getByLabelText('企业专属登录地址'), { target: { value: 'https://tenant.ainoriahub.com' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => { expect(h.panuoyun.configure).toHaveBeenCalledWith('enterprise', 'https://tenant.ainoriahub.com') })
    expect(h.panuoyun.login).toHaveBeenCalledWith('member@example.com', 'password-secret')
    expect(await screen.findByText('Research')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('已有 API Key'), { target: { value: 'selected-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并继续' }))
    await waitFor(() => { expect(h.panuoyun.selectApiKey).toHaveBeenCalledWith('selected-secret') })
    expect(h.complete).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('selected-secret')
  })

  it('creates one dedicated key for the selected numeric group and never offers a key list', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root)
    const h = props()
    render(<PanuoyunOnboardingDialog {...h.input} />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByText('Research')
    fireEvent.change(screen.getByLabelText('分组'), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: '新建专用 Key' }))
    await waitFor(() => { expect(h.panuoyun.createApiKey).toHaveBeenCalledWith('DeepSeek Harness', 42) })
    expect(screen.queryByText(/已有 Key 列表/)).toBeNull()
  })
})
