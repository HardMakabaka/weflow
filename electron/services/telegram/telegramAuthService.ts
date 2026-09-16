import { Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import type { TelegramClient } from 'telegram'
import { ConfigService } from '../config'
import { maskTelegramPhone, normalizeTelegramError } from './telegramHelpers'
import { telegramClientService } from './telegramClientService'
import type { TelegramAuthResult, TelegramStatus } from './types'

interface PendingTelegramAuth {
  client: TelegramClient
  phoneNumber: string
  phoneCodeHash: string
  isCodeViaApp: boolean
}

class TelegramAuthService {
  private configService = ConfigService.getInstance()
  private pending: PendingTelegramAuth | null = null

  async getStatus(): Promise<TelegramStatus> {
    return telegramClientService.getStatus(Boolean(this.pending))
  }

  async saveCredentials(apiIdRaw: unknown, apiHashRaw: unknown): Promise<TelegramAuthResult> {
    const apiId = Math.floor(Number(apiIdRaw || 0))
    const apiHash = String(apiHashRaw || '').trim()
    if (!Number.isFinite(apiId) || apiId <= 0) {
      return { success: false, error: 'API ID 必须是正整数' }
    }
    if (!apiHash) {
      return { success: false, error: 'API Hash 不能为空' }
    }
    await this.disposePending()
    await telegramClientService.disconnect()
    this.configService.set('telegramApiId' as any, apiId as any)
    this.configService.set('telegramApiHash' as any, apiHash as any)
    this.configService.set('telegramSessionString' as any, '' as any)
    this.configService.set('telegramEnabled' as any, false as any)
    return { success: true, status: 'credentials_saved' }
  }

  async sendCode(phoneNumberRaw: unknown, forceSmsRaw = false): Promise<TelegramAuthResult> {
    const phoneNumber = String(phoneNumberRaw || '').trim()
    if (!phoneNumber) return { success: false, error: '手机号不能为空' }

    const credentials = telegramClientService.getCredentials()
    if (!credentials) return { success: false, error: '请先保存 Telegram API ID 和 API Hash' }

    await this.disposePending()
    const client = telegramClientService.createClient('')
    try {
      await client.connect()
      const result = await client.sendCode(credentials, phoneNumber, forceSmsRaw === true)
      this.pending = {
        client,
        phoneNumber,
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.isCodeViaApp
      }
      const phoneHint = maskTelegramPhone(phoneNumber)
      this.configService.set('telegramPhoneHint' as any, phoneHint as any)
      return {
        success: true,
        status: 'code_sent',
        isCodeViaApp: result.isCodeViaApp,
        phoneHint
      }
    } catch (error) {
      const normalized = normalizeTelegramError(error)
      try { await client.disconnect() } catch {}
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async signInWithCode(codeRaw: unknown): Promise<TelegramAuthResult> {
    if (!this.pending) return { success: false, error: '请先发送验证码' }
    const code = String(codeRaw || '').trim()
    if (!code) return { success: false, error: '验证码不能为空' }

    try {
      const result = await this.pending.client.invoke(new Api.auth.SignIn({
        phoneNumber: this.pending.phoneNumber,
        phoneCodeHash: this.pending.phoneCodeHash,
        phoneCode: code
      }))

      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        return { success: false, error: '该手机号需要注册 Telegram 账号，WeFlow 暂不支持注册新账号' }
      }

      return await this.finishLogin()
    } catch (error: any) {
      if (String(error?.errorMessage || error?.message || '').includes('SESSION_PASSWORD_NEEDED')) {
        return { success: true, status: 'password_required' }
      }
      const normalized = normalizeTelegramError(error)
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async signInWithPassword(passwordRaw: unknown): Promise<TelegramAuthResult> {
    if (!this.pending) return { success: false, error: '请先发送验证码并提交短信/应用验证码' }
    const password = String(passwordRaw || '')
    if (!password) return { success: false, error: '两步验证密码不能为空' }

    const credentials = telegramClientService.getCredentials()
    if (!credentials) return { success: false, error: '请先保存 Telegram API ID 和 API Hash' }

    let authError: unknown = null
    try {
      await this.pending.client.signInWithPassword(credentials, {
        password: async () => password,
        onError: async (error) => {
          authError = error
          return true
        }
      })
      return await this.finishLogin()
    } catch (error) {
      const normalized = normalizeTelegramError(authError || error)
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async disconnect(): Promise<TelegramAuthResult> {
    await this.disposePending()
    await telegramClientService.disconnect()
    telegramClientService.clearSession()
    return { success: true, status: 'disconnected' }
  }

  private async finishLogin(): Promise<TelegramAuthResult> {
    if (!this.pending) return { success: false, error: '登录流程已失效' }
    const sessionString = (this.pending.client.session as StringSession).save()
    telegramClientService.saveSession(sessionString)
    const phoneHint = maskTelegramPhone(this.pending.phoneNumber)
    this.configService.set('telegramPhoneHint' as any, phoneHint as any)
    await this.disposePending()
    await telegramClientService.disconnect()
    return {
      success: true,
      status: 'logged_in',
      phoneHint
    }
  }

  private async disposePending(): Promise<void> {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    try {
      await pending.client.disconnect()
    } catch {}
  }
}

export const telegramAuthService = new TelegramAuthService()
