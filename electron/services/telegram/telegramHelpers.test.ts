import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTelegramChatId,
  clampTelegramLimit,
  mapTelegramMessageType,
  normalizeTelegramError,
  parseTelegramChatId,
  redactTelegramSecrets,
  toTelegramMessage
} from './telegramHelpers'

test('builds and parses Telegram chat IDs', () => {
  const chatId = buildTelegramChatId('group', '-100123456789')
  assert.equal(chatId, 'telegram:group:-100123456789')
  assert.deepEqual(parseTelegramChatId(chatId), {
    platform: 'telegram',
    type: 'group',
    id: '-100123456789'
  })
  assert.equal(parseTelegramChatId('wechat:group:1'), null)
})

test('clamps Telegram limits to safe bounds', () => {
  assert.equal(clampTelegramLimit(undefined, 100, 500), 100)
  assert.equal(clampTelegramLimit(0, 100, 500), 100)
  assert.equal(clampTelegramLimit(20, 100, 500), 20)
  assert.equal(clampTelegramLimit(900, 100, 500), 500)
})

test('maps Telegram message types without requiring live GramJS objects', () => {
  assert.equal(mapTelegramMessageType({ message: 'hello' }), 'text')
  assert.equal(mapTelegramMessageType({ photo: {} }), 'image')
  assert.equal(mapTelegramMessageType({ voice: {} }), 'voice')
  assert.equal(mapTelegramMessageType({ video: {} }), 'video')
  assert.equal(mapTelegramMessageType({ sticker: {} }), 'sticker')
  assert.equal(mapTelegramMessageType({ document: {} }), 'file')
  assert.equal(mapTelegramMessageType({ action: {} }), 'system')
})

test('normalizes Telegram message output shape', () => {
  const message = toTelegramMessage({
    id: 42,
    date: 1760000123,
    message: 'hello',
    out: false,
    senderId: { toString: () => '777000' },
    sender: { firstName: 'Telegram', lastName: 'System' }
  }, 'telegram:private:777000')

  assert.equal(message.platform, 'telegram')
  assert.equal(message.chatId, 'telegram:private:777000')
  assert.equal(message.messageId, 42)
  assert.equal(message.timestamp, 1760000123)
  assert.equal(message.senderId, '777000')
  assert.equal(message.senderName, 'Telegram System')
  assert.equal(message.isSelf, false)
  assert.equal(message.type, 'text')
  assert.equal(message.text, 'hello')
})

test('redacts Telegram secrets from errors and logs', () => {
  const text = redactTelegramSecrets('apiHash=0123456789abcdef0123456789abcdef sessionString=1A2B3C 123456:abcdefabcdefabcdefabcdefabcdef')
  assert.equal(text.includes('0123456789abcdef0123456789abcdef'), false)
  assert.equal(text.includes('1A2B3C'), false)
  assert.equal(text.includes('123456:abcdef'), false)
})

test('normalizes Telegram flood wait errors', () => {
  const normalized = normalizeTelegramError({
    errorMessage: 'FLOOD_WAIT_37',
    message: 'FLOOD_WAIT_37',
    seconds: 37
  })
  assert.equal(normalized.retryAfterSeconds, 37)
  assert.equal(normalized.code, 'FLOOD_WAIT_37')
})
