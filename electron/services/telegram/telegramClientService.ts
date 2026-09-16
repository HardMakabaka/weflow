import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { ConfigService } from '../config'
import { normalizeTelegramError } from './telegramHelpers'
import type { TelegramNormalizedError, TelegramStatus } from './types'

interface TelegramCredentials {
  apiId: number
  apiHash: string
}

class TelegramClientService {
  private configService = ConfigService.getInstance()
  private client: TelegramClient | null = null
  private lastError = ''

  getCredentials(): TelegramCredentials | null {
    const apiId = Math.floor(Number(this.configService.get('telegramApiId' as any) || 0))
    const apiHash = String(this.configService.get('telegramApiHash' as any) || '').trim()
    if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) return null
    return { apiId, apiHash }
  }

  getSessionString(): string {
    return String(this.configService.get('telegramSessionString' as any) || '').trim()
  }

  async getStatus(pendingAuth = false): Promise<TelegramStatus> {
    const credentials = this.getCredentials()
    const hasSession = Boolean(this.getSessionString())
    let connected = this.client?.connected === true
    let authorized = false
    if (this.client?.connected) {
      try {
        authorized = await this.client.checkAuthorization()
      } catch (error) {
        connected = false
        this.lastError = normalizeTelegramError(error).message
      }
    } else {
      authorized = hasSession
    }

    return {
      configured: Boolean(credentials),
      connected,
      authorized,
      hasSession,
      pendingAuth,
      apiId: credentials?.apiId || null,
      phoneHint: String(this.configService.get('telegramPhoneHint' as any) || ''),
      lastError: this.lastError || undefined
    }
  }

  createClient(sessionString = this.getSessionString()): TelegramClient {
    const credentials = this.getCredentials()
    if (!credentials) {
      throw new Error('Telegram API ID 和 API Hash 未配置')
    }
    return new TelegramClient(
      new StringSession(sessionString || ''),
      credentials.apiId,
      credentials.apiHash,
      {
        connectionRetries: 3
      }
    )
  }

  async ensureAuthorized(): Promise<TelegramClient> {
    const sessionString = this.getSessionString()
    if (!sessionString) {
      throw new Error('Telegram 尚未登录')
    }

    if (this.client?.connected) {
      const authorized = await this.client.checkAuthorization()
      if (authorized) return this.client
      await this.disconnect()
    }

    const client = this.createClient(sessionString)
    try {
      await client.connect()
      const authorized = await client.checkAuthorization()
      if (!authorized) {
        throw new Error('Telegram 登录会话已失效，请重新登录')
      }
      this.client = client
      this.lastError = ''
      return client
    } catch (error) {
      const normalized = normalizeTelegramError(error)
      this.lastError = normalized.message
      try { await client.disconnect() } catch {}
      throw this.toError(normalized)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return
    const client = this.client
    this.client = null
    try {
      await client.disconnect()
    } catch {}
  }

  clearSession(): void {
    this.configService.set('telegramSessionString' as any, '' as any)
    this.configService.set('telegramEnabled' as any, false as any)
  }

  saveSession(sessionString: string): void {
    this.configService.set('telegramSessionString' as any, sessionString as any)
    this.configService.set('telegramEnabled' as any, Boolean(sessionString) as any)
  }

  private toError(normalized: TelegramNormalizedError): Error {
    const error = new Error(normalized.message) as Error & {
      code?: string | number
      retryAfterSeconds?: number
    }
    error.code = normalized.code
    error.retryAfterSeconds = normalized.retryAfterSeconds
    return error
  }
}

export const telegramClientService = new TelegramClientService()
