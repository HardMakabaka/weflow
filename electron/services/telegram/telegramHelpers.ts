import type {
  TelegramChat,
  TelegramChatType,
  TelegramMediaMeta,
  TelegramMessage,
  TelegramMessageType,
  TelegramNormalizedError
} from './types'

const TELEGRAM_CHAT_ID_PREFIX = 'telegram'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export interface ParsedTelegramChatId {
  platform: 'telegram'
  type: TelegramChatType
  id: string
}

export function clampTelegramLimit(value: unknown, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const numeric = Math.floor(Number(value || fallback))
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(numeric, max))
}

export function normalizeTelegramTimestamp(value: unknown): number {
  const numeric = Math.floor(Number(value || 0))
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 10000000000 ? Math.floor(numeric / 1000) : numeric
}

export function normalizeTelegramId(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = (value as { toString: () => string }).toString()
    return text === '[object Object]' ? '' : text
  }
  return String(value)
}

export function buildTelegramChatId(type: TelegramChatType, id: unknown): string {
  const normalizedType: TelegramChatType = type || 'unknown'
  const normalizedId = normalizeTelegramId(id)
  return `${TELEGRAM_CHAT_ID_PREFIX}:${normalizedType}:${normalizedId}`
}

export function parseTelegramChatId(chatId: string): ParsedTelegramChatId | null {
  const text = String(chatId || '').trim()
  const match = /^telegram:(private|bot|group|channel|unknown):(-?\d+)$/.exec(text)
  if (!match) return null
  return {
    platform: 'telegram',
    type: match[1] as TelegramChatType,
    id: match[2]
  }
}

export function maskTelegramPhone(phoneNumber: string): string {
  const digits = String(phoneNumber || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length <= 4) return `****${digits}`
  return `+${digits.slice(0, Math.min(3, digits.length - 4))}****${digits.slice(-4)}`
}

export function redactTelegramSecrets(value: unknown): string {
  return String(value || '')
    .replace(/\b\d{5,12}:[A-Za-z0-9_-]{20,}\b/g, '<redacted:telegram-token>')
    .replace(/\b[A-Fa-f0-9]{32}\b/g, '<redacted:api-hash>')
    .replace(/(telegramSessionString|sessionString|StringSession|session)\s*[:=]\s*['"]?[^'",\s]+/gi, '$1=<redacted>')
    .replace(/(telegramApiHash|apiHash|api_hash)\s*[:=]\s*['"]?[^'",\s]+/gi, '$1=<redacted>')
}

export function normalizeTelegramError(error: unknown): TelegramNormalizedError {
  const source = error as {
    errorMessage?: unknown
    message?: unknown
    code?: unknown
    seconds?: unknown
  }
  const rawCode = source?.errorMessage || source?.code
  const rawMessage = source?.message || source?.errorMessage || error
  const retryFromSeconds = Number(source?.seconds)
  const waitMatch = /(?:FLOOD_WAIT|SLOWMODE_WAIT)_?(\d+)/i.exec(String(rawMessage || rawCode || ''))
  const retryAfterSeconds = Number.isFinite(retryFromSeconds) && retryFromSeconds > 0
    ? Math.floor(retryFromSeconds)
    : waitMatch
      ? Math.floor(Number(waitMatch[1]))
      : undefined

  return {
    message: redactTelegramSecrets(rawMessage) || 'Telegram request failed',
    code: typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined,
    retryAfterSeconds
  }
}

function getEntityId(entity: any): string {
  return normalizeTelegramId(entity?.id || entity?.userId || entity?.chatId || entity?.channelId)
}

function getPeerId(peer: any): string {
  return normalizeTelegramId(peer?.userId || peer?.chatId || peer?.channelId || peer?.id)
}

export function resolveTelegramDisplayName(entity: any, fallback = ''): string {
  const title = String(entity?.title || '').trim()
  if (title) return title

  const firstName = String(entity?.firstName || '').trim()
  const lastName = String(entity?.lastName || '').trim()
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (fullName) return fullName

  const username = String(entity?.username || '').trim()
  if (username) return `@${username}`

  return String(fallback || getEntityId(entity) || 'Unknown Telegram chat')
}

export function resolveTelegramChatType(dialog: any): TelegramChatType {
  const entity = dialog?.entity || {}
  if (dialog?.isUser) return entity?.bot ? 'bot' : 'private'
  if (dialog?.isGroup) return 'group'
  if (dialog?.isChannel) {
    if (entity?.megagroup || entity?.gigagroup) return 'group'
    return 'channel'
  }
  const className = String(entity?.className || '')
  if (className === 'User') return entity?.bot ? 'bot' : 'private'
  if (className === 'Chat') return 'group'
  if (className === 'Channel') return entity?.broadcast ? 'channel' : 'group'
  return 'unknown'
}

export function toTelegramChat(dialog: any): TelegramChat {
  const type = resolveTelegramChatType(dialog)
  const entity = dialog?.entity || {}
  const telegramId = normalizeTelegramId(dialog?.id || getEntityId(entity))
  const lastMessage = dialog?.message || {}
  return {
    platform: 'telegram',
    chatId: buildTelegramChatId(type, telegramId),
    telegramId,
    type,
    displayName: resolveTelegramDisplayName(entity, dialog?.name || dialog?.title || telegramId),
    username: entity?.username ? String(entity.username) : undefined,
    unreadCount: Math.max(0, Math.floor(Number(dialog?.unreadCount || 0))),
    lastTimestamp: normalizeTelegramTimestamp(dialog?.date || lastMessage?.date),
    lastMessageText: trimTelegramText(lastMessage?.message || lastMessage?.text || '')
  }
}

function classNameOf(value: any): string {
  return String(value?.className || value?.constructor?.name || '')
}

function getDocumentAttribute(document: any, className: string): any | null {
  const attributes = Array.isArray(document?.attributes) ? document.attributes : []
  return attributes.find((attribute) => classNameOf(attribute) === className) || null
}

function resolveFileName(document: any): string | undefined {
  const fileNameAttribute = getDocumentAttribute(document, 'DocumentAttributeFilename')
  const fileName = String(fileNameAttribute?.fileName || '').trim()
  return fileName || undefined
}

function resolveMediaType(message: any): TelegramMessageType {
  if (message?.action) return 'system'
  if (message?.photo || classNameOf(message?.media) === 'MessageMediaPhoto') return 'image'
  if (message?.voice) return 'voice'
  if (message?.video || message?.videoNote) return 'video'
  if (message?.sticker) return 'sticker'
  if (message?.geo || message?.venue) return 'location'
  if (message?.contact) return 'contact'
  if (message?.poll) return 'poll'
  if (message?.webPreview) return 'link'
  if (message?.document || classNameOf(message?.media) === 'MessageMediaDocument') return 'file'
  if (message?.media) return 'unknown'
  return trimTelegramText(message?.message || message?.text || '') ? 'text' : 'unknown'
}

export function mapTelegramMessageType(message: any): TelegramMessageType {
  return resolveMediaType(message)
}

function toTelegramMedia(message: any, type: TelegramMessageType): TelegramMediaMeta | undefined {
  if (type === 'text' || type === 'system' || type === 'unknown') return undefined
  const document = message?.document || message?.media?.document
  const file = message?.file || {}
  const durationAttribute = getDocumentAttribute(document, 'DocumentAttributeAudio') ||
    getDocumentAttribute(document, 'DocumentAttributeVideo')
  const duration = Number(file?.duration || durationAttribute?.duration || 0)
  return {
    kind: type,
    fileName: String(file?.name || resolveFileName(document) || '').trim() || undefined,
    mimeType: String(file?.mimeType || document?.mimeType || '').trim() || undefined,
    fileSize: Number(file?.size || document?.size || 0) || undefined,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : undefined
  }
}

function resolveSenderId(message: any): string {
  return normalizeTelegramId(message?.senderId || getPeerId(message?.fromId) || getEntityId(message?.sender))
}

function trimTelegramText(value: unknown, maxLength = 4000): string {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

export function toTelegramMessage(message: any, chatId: string, senderName = ''): TelegramMessage {
  const type = mapTelegramMessageType(message)
  const media = toTelegramMedia(message, type)
  const text = trimTelegramText(
    message?.message ||
      message?.text ||
      media?.fileName ||
      (type === 'image' ? '[图片]' : '') ||
      (type === 'voice' ? '[语音]' : '') ||
      (type === 'video' ? '[视频]' : '') ||
      (type === 'sticker' ? '[贴纸]' : '') ||
      (type === 'file' ? '[文件]' : '') ||
      ''
  )
  return {
    platform: 'telegram',
    chatId,
    messageId: Math.floor(Number(message?.id || 0)),
    timestamp: normalizeTelegramTimestamp(message?.date),
    senderId: resolveSenderId(message),
    senderName: senderName || resolveTelegramDisplayName(message?.sender, resolveSenderId(message)),
    isSelf: typeof message?.out === 'boolean' ? message.out : null,
    type,
    text,
    media
  }
}
