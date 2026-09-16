import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck
} from 'lucide-react'
import type { TelegramStatus } from '../../types/electron'
import './TelegramSettingsPanel.scss'

interface TelegramSettingsPanelProps {
  showMessage: (text: string, success: boolean) => void
}

type LoginStep = 'idle' | 'code_sent' | 'password_required'

const emptyStatus: TelegramStatus = {
  configured: false,
  connected: false,
  authorized: false,
  hasSession: false,
  pendingAuth: false,
  apiId: null,
  phoneHint: ''
}

export function TelegramSettingsPanel({ showMessage }: TelegramSettingsPanelProps) {
  const [status, setStatus] = useState(emptyStatus)
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [loginStep, setLoginStep] = useState<LoginStep>('idle')
  const [busyAction, setBusyAction] = useState<string>('')
  const [inlineError, setInlineError] = useState('')

  const loading = Boolean(busyAction)
  const statusLabel = useMemo(() => {
    if (status.pendingAuth) return '登录中'
    if (status.authorized) return status.connected ? '已连接' : '已登录'
    if (status.configured) return '未登录'
    return '未配置'
  }, [status])

  const statusTone = status.authorized ? 'success' : status.configured ? 'warning' : 'muted'

  const loadStatus = async () => {
    setInlineError('')
    try {
      const nextStatus = await window.electronAPI.telegram.getStatus()
      setStatus(nextStatus)
      if (nextStatus.apiId) setApiId(String(nextStatus.apiId))
      if (nextStatus.pendingAuth && loginStep === 'idle') setLoginStep('code_sent')
    } catch (error: any) {
      setInlineError(error?.message || String(error))
    }
  }

  useEffect(() => {
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finishAction = async (message: string, success: boolean) => {
    showMessage(message, success)
    await loadStatus()
  }

  const handleSaveCredentials = async () => {
    setBusyAction('credentials')
    setInlineError('')
    try {
      const result = await window.electronAPI.telegram.saveCredentials({ apiId, apiHash })
      if (!result.success) {
        setInlineError(result.error || '保存失败')
        return
      }
      setApiHash('')
      setLoginStep('idle')
      await finishAction('Telegram API 凭据已保存', true)
    } finally {
      setBusyAction('')
    }
  }

  const handleSendCode = async () => {
    setBusyAction('code')
    setInlineError('')
    try {
      const result = await window.electronAPI.telegram.sendCode({ phoneNumber })
      if (!result.success) {
        setInlineError(result.error || '验证码发送失败')
        return
      }
      setLoginStep('code_sent')
      setCode('')
      await finishAction(result.isCodeViaApp ? '验证码已发送到 Telegram App' : '验证码已发送', true)
    } finally {
      setBusyAction('')
    }
  }

  const handleSubmitCode = async () => {
    setBusyAction('submit-code')
    setInlineError('')
    try {
      const result = await window.electronAPI.telegram.signInWithCode({ code })
      if (!result.success) {
        setInlineError(result.error || '验证码验证失败')
        return
      }
      if (result.status === 'password_required') {
        setLoginStep('password_required')
        await loadStatus()
        return
      }
      setLoginStep('idle')
      setCode('')
      await finishAction('Telegram 登录成功', true)
    } finally {
      setBusyAction('')
    }
  }

  const handleSubmitPassword = async () => {
    setBusyAction('password')
    setInlineError('')
    try {
      const result = await window.electronAPI.telegram.signInWithPassword({ password })
      if (!result.success) {
        setInlineError(result.error || '两步验证失败')
        return
      }
      setLoginStep('idle')
      setPassword('')
      await finishAction('Telegram 登录成功', true)
    } finally {
      setBusyAction('')
    }
  }

  const handleDisconnect = async () => {
    setBusyAction('disconnect')
    setInlineError('')
    try {
      const result = await window.electronAPI.telegram.disconnect()
      if (!result.success) {
        setInlineError(result.error || '断开失败')
        return
      }
      setLoginStep('idle')
      setCode('')
      setPassword('')
      await finishAction('已断开 Telegram 登录', true)
    } finally {
      setBusyAction('')
    }
  }

  return (
    <div className="tab-content telegram-settings-panel">
      <div className="form-group">
        <label>Telegram 账号模块</label>
        <span className="form-hint">独立读取 Telegram 个人账号聊天历史，并通过现有 MCP 服务开放 <code>weflow.telegram_*</code> 工具。</span>
        <div className="telegram-status-line">
          <span className={`telegram-status-pill ${statusTone}`}>
            {status.authorized ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}
            {statusLabel}
          </span>
          {status.phoneHint && <span className="telegram-phone-hint">{status.phoneHint}</span>}
          <button className="btn btn-secondary" onClick={loadStatus} disabled={loading} title="刷新状态">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>API 凭据</label>
        <span className="form-hint">从 <code>my.telegram.org</code> 获取 API ID 和 API Hash。保存新凭据会清除当前 Telegram 登录会话。</span>
        <div className="telegram-field-row">
          <input
            type="number"
            className="field-input"
            value={apiId}
            placeholder="API ID"
            min={1}
            disabled={loading}
            onChange={(event) => setApiId(event.target.value)}
          />
          <input
            type="password"
            className="field-input"
            value={apiHash}
            placeholder={status.configured ? '已保存，重新填写可覆盖' : 'API Hash'}
            disabled={loading}
            onChange={(event) => setApiHash(event.target.value)}
          />
          <button className="btn btn-primary" onClick={handleSaveCredentials} disabled={loading || !apiId || !apiHash}>
            {busyAction === 'credentials' ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
            保存
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>登录 Telegram</label>
        <span className="form-hint">使用个人账号登录后，WeFlow 只保存加密后的本地 session string，不保存验证码或两步验证密码。</span>
        <div className="telegram-field-row">
          <input
            type="tel"
            className="field-input"
            value={phoneNumber}
            placeholder="+8613800000000"
            disabled={loading || !status.configured}
            onChange={(event) => setPhoneNumber(event.target.value)}
          />
          <button className="btn btn-secondary" onClick={handleSendCode} disabled={loading || !status.configured || !phoneNumber}>
            {busyAction === 'code' ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            发送验证码
          </button>
        </div>

        {loginStep === 'code_sent' && (
          <div className="telegram-field-row">
            <input
              type="text"
              className="field-input"
              value={code}
              placeholder="Telegram 验证码"
              disabled={loading}
              onChange={(event) => setCode(event.target.value)}
            />
            <button className="btn btn-primary" onClick={handleSubmitCode} disabled={loading || !code}>
              {busyAction === 'submit-code' ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              验证
            </button>
          </div>
        )}

        {loginStep === 'password_required' && (
          <div className="telegram-field-row">
            <input
              type="password"
              className="field-input"
              value={password}
              placeholder="两步验证密码"
              disabled={loading}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="btn btn-primary" onClick={handleSubmitPassword} disabled={loading || !password}>
              {busyAction === 'password' ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
              完成登录
            </button>
          </div>
        )}
      </div>

      {inlineError && (
        <div className="telegram-inline-error" role="alert">
          <AlertTriangle size={16} />
          <span>{inlineError}</span>
        </div>
      )}

      {status.hasSession && (
        <div className="form-group">
          <label>本地登录会话</label>
          <span className="form-hint">断开后会清除本机保存的 Telegram session，MCP 工具将返回未登录状态。</span>
          <button className="btn btn-danger" onClick={handleDisconnect} disabled={loading}>
            {busyAction === 'disconnect' ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
            断开 Telegram
          </button>
        </div>
      )}
    </div>
  )
}
