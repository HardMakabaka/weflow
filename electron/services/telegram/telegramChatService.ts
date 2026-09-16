import { telegramClientService } from './telegramClientService'
import {
  buildTelegramChatId,
  clampTelegramLimit,
  normalizeTelegramError,
  normalizeTelegramTimestamp,
  parseTelegramChatId,
  resolveTelegramDisplayName,
  toTelegramChat,
  toTelegramMessage
} from './telegramHelpers'
import type {
  TelegramChat,
  TelegramListChatsOptions,
  TelegramMessage,
  TelegramMessagesOptions,
  TelegramSearchOptions
} from './types'

interface TelegramListChatsResult {
  success: boolean
  total?: number
  offset?: number
  limit?: number
  hasMore?: boolean
  chats?: TelegramChat[]
  error?: string
  retryAfterSeconds?: number
}

interface TelegramMessagesResult {
  success: boolean
  chatId?: string
  limit?: number
  hasMore?: boolean
  nextBeforeMessageId?: number | null
  messages?: TelegramMessage[]
  error?: string
  retryAfterSeconds?: number
}

interface TelegramAnalysisPackResult extends TelegramMessagesResult {
  chat?: TelegramChat | null
  stats?: {
    sampleMessages: number
    firstTimestamp: number
    lastTimestamp: number
    byType: Record<string, number>
  }
}

class TelegramChatService {
  private inputEntityCache = new Map<string, unknown>()
  private chatCache = new Map<string, TelegramChat>()

  async listChats(options: TelegramListChatsOptions = {}): Promise<TelegramListChatsResult> {
    try {
      const client = await telegramClientService.ensureAuthorized()
      const offset = Math.max(0, Math.floor(Number(options.offset || 0)))
      const limit = clampTelegramLimit(options.limit, 100, 500)
      const fetchLimit = Math.min(1000, Math.max(offset + limit, 100))
      const dialogs = await client.getDialogs({ limit: fetchLimit })
      for (const dialog of dialogs as any[]) {
        const chat = toTelegramChat(dialog)
        this.inputEntityCache.set(chat.chatId, dialog.inputEntity)
        this.chatCache.set(chat.chatId, chat)
      }

      const keyword = String(options.keyword || '').trim().toLowerCase()
      const type = options.type || 'all'
      const filtered = Array.from(this.chatCache.values())
        .filter((chat) => type === 'all' || chat.type === type)
        .filter((chat) => {
          if (!keyword) return true
          return chat.displayName.toLowerCase().includes(keyword) ||
            chat.chatId.toLowerCase().includes(keyword) ||
            String(chat.username || '').toLowerCase().includes(keyword)
        })
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp)

      return {
        success: true,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
        chats: filtered.slice(offset, offset + limit)
      }
    } catch (error) {
      const normalized = normalizeTelegramError(error)
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async getChatMessages(options: TelegramMessagesOptions): Promise<TelegramMessagesResult> {
    try {
      const chatId = String(options.chatId || '').trim()
      const parsed = parseTelegramChatId(chatId)
      if (!parsed) return { success: false, error: '无效的 Telegram chatId' }

      const client = await telegramClientService.ensureAuthorized()
      const inputEntity = await this.resolveInputEntity(chatId)
      const limit = clampTelegramLimit(options.limit, 100, 500)
      const hasTimeRange = Boolean(options.startTime || options.endTime)
      const fetchLimit = hasTimeRange ? Math.min(limit * 3, 1000) : limit
      const rawMessages = await client.getMessages(inputEntity as any, {
        limit: fetchLimit,
        offsetId: Math.max(0, Math.floor(Number(options.beforeMessageId || 0))),
        minId: Math.max(0, Math.floor(Number(options.afterMessageId || 0))),
        reverse: options.ascending === true
      } as any)
      const messages = await this.mapMessages(rawMessages as any[], chatId)
      const filtered = this.filterByTime(messages, options.startTime, options.endTime)
      const sliced = filtered.slice(0, limit)
      return {
        success: true,
        chatId,
        limit,
        hasMore: filtered.length > limit || rawMessages.length >= fetchLimit,
        nextBeforeMessageId: this.resolveNextBeforeMessageId(sliced),
        messages: sliced
      }
    } catch (error) {
      const normalized = normalizeTelegramError(error)
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async searchChatMessages(options: TelegramSearchOptions): Promise<TelegramMessagesResult> {
    try {
      const keyword = String(options.keyword || '').trim()
      if (!keyword) return { success: false, error: '搜索关键词不能为空' }
      const chatId = String(options.chatId || '').trim()
      if (!parseTelegramChatId(chatId)) {
        return { success: false, error: 'Telegram v1 搜索需要指定 chatId' }
      }

      const client = await telegramClientService.ensureAuthorized()
      const inputEntity = await this.resolveInputEntity(chatId)
      const limit = clampTelegramLimit(options.limit, 100, 500)
      const hasTimeRange = Boolean(options.startTime || options.endTime)
      const fetchLimit = hasTimeRange ? Math.min(limit * 3, 1000) : limit
      const rawMessages = await client.getMessages(inputEntity as any, {
        limit: fetchLimit,
        search: keyword,
        offsetId: Math.max(0, Math.floor(Number(options.beforeMessageId || 0))),
        minId: Math.max(0, Math.floor(Number(options.afterMessageId || 0))),
        reverse: options.ascending === true
      } as any)
      const messages = await this.mapMessages(rawMessages as any[], chatId)
      const filtered = this.filterByTime(messages, options.startTime, options.endTime)
      const sliced = filtered.slice(0, limit)
      return {
        success: true,
        chatId,
        limit,
        hasMore: filtered.length > limit || rawMessages.length >= fetchLimit,
        nextBeforeMessageId: this.resolveNextBeforeMessageId(sliced),
        messages: sliced
      }
    } catch (error) {
      const normalized = normalizeTelegramError(error)
      return {
        success: false,
        error: normalized.message,
        retryAfterSeconds: normalized.retryAfterSeconds
      }
    }
  }

  async prepareAnalysisPack(options: TelegramMessagesOptions): Promise<TelegramAnalysisPackResult> {
    const messagesResult = await this.getChatMessages(options)
    if (!messagesResult.success) return messagesResult
    const messages = messagesResult.messages || []
    const byType: Record<string, number> = {}
    for (const message of messages) {
      byType[message.type] = (byType[message.type] || 0) + 1
    }
    const timestamps = messages.map((message) => message.timestamp).filter((value) => value > 0)
    return {
      ...messagesResult,
      chat: this.chatCache.get(String(options.chatId || '')) || null,
      stats: {
        sampleMessages: messages.length,
        firstTimestamp: timestamps.length ? Math.min(...timestamps) : 0,
        lastTimestamp: timestamps.length ? Math.max(...timestamps) : 0,
        byType
      }
    }
  }

  private async resolveInputEntity(chatId: string): Promise<unknown> {
    const cached = this.inputEntityCache.get(chatId)
    if (cached) return cached

    const parsed = parseTelegramChatId(chatId)
    if (!parsed) throw new Error('无效的 Telegram chatId')

    const client = await telegramClientService.ensureAuthorized()
    const dialogs = await client.getDialogs({ limit: 1000 })
    for (const dialog of dialogs as any[]) {
      const type = toTelegramChat(dialog).type
      const id = dialog?.id || dialog?.entity?.id
      const resolvedChatId = buildTelegramChatId(type, id)
      this.inputEntityCache.set(resolvedChatId, dialog.inputEntity)
      this.chatCache.set(resolvedChatId, toTelegramChat(dialog))
      if (resolvedChatId === chatId) return dialog.inputEntity
    }

    throw new Error('未找到该 Telegram 聊天，请先在 Telegram 中确认账号有权限访问')
  }

  private async mapMessages(rawMessages: any[], chatId: string): Promise<TelegramMessage[]> {
    const messages: TelegramMessage[] = []
    for (const rawMessage of rawMessages || []) {
      let senderName = ''
      try {
        const sender = await rawMessage?.getSender?.()
        senderName = resolveTelegramDisplayName(sender)
      } catch {}
      messages.push(toTelegramMessage(rawMessage, chatId, senderName))
    }
    return messages.filter((message) => message.messageId > 0)
  }

  private filterByTime(messages: TelegramMessage[], startTimeRaw?: number, endTimeRaw?: number): TelegramMessage[] {
    const startTime = normalizeTelegramTimestamp(startTimeRaw)
    const endTime = normalizeTelegramTimestamp(endTimeRaw)
    return messages.filter((message) => {
      if (startTime && message.timestamp < startTime) return false
      if (endTime && message.timestamp > endTime) return false
      return true
    })
  }

  private resolveNextBeforeMessageId(messages: TelegramMessage[]): number | null {
    if (messages.length === 0) return null
    return Math.min(...messages.map((message) => message.messageId).filter((id) => id > 0))
  }
}

export const telegramChatService = new TelegramChatService()
