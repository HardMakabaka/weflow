export type TelegramChatType = 'private' | 'bot' | 'group' | 'channel' | 'unknown'
export type TelegramMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'link'
  | 'system'
  | 'unknown'

export interface TelegramStatus {
  configured: boolean
  connected: boolean
  authorized: boolean
  hasSession: boolean
  pendingAuth: boolean
  apiId: number | null
  phoneHint: string
  lastError?: string
}

export interface TelegramAuthResult {
  success: boolean
  status?: 'credentials_saved' | 'code_sent' | 'password_required' | 'logged_in' | 'disconnected'
  isCodeViaApp?: boolean
  phoneHint?: string
  error?: string
  retryAfterSeconds?: number
}

export interface TelegramChat {
  platform: 'telegram'
  chatId: string
  telegramId: string
  type: TelegramChatType
  displayName: string
  username?: string
  unreadCount: number
  lastTimestamp: number
  lastMessageText: string
}

export interface TelegramMediaMeta {
  kind: TelegramMessageType
  fileName?: string
  mimeType?: string
  fileSize?: number
  durationSeconds?: number
}

export interface TelegramMessage {
  platform: 'telegram'
  chatId: string
  chatType?: TelegramChatType
  messageId: number
  timestamp: number
  senderId: string
  senderName: string
  isSelf: boolean | null
  type: TelegramMessageType
  text: string
  media?: TelegramMediaMeta
}

export interface TelegramListChatsOptions {
  type?: 'all' | TelegramChatType
  keyword?: string
  limit?: number
  offset?: number
}

export interface TelegramMessagesOptions {
  chatId: string
  limit?: number
  beforeMessageId?: number
  afterMessageId?: number
  startTime?: number
  endTime?: number
  ascending?: boolean
}

export interface TelegramSearchOptions extends TelegramMessagesOptions {
  keyword: string
}

export interface TelegramNormalizedError {
  message: string
  code?: string | number
  retryAfterSeconds?: number
}
