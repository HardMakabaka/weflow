/**
 * MCP 服务
 * 通过本地 Streamable HTTP MCP endpoint 向 AI 客户端提供可控的聊天数据访问工具。
 */
import * as http from 'http'
import { URL } from 'url'
import { randomUUID, timingSafeEqual } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { chatService, type ChatSession, type Message } from './chatService'
import { groupAnalyticsService } from './groupAnalyticsService'
import { ConfigService } from './config'
import { registerTelegramMcpTools } from './telegram/telegramMcpTools'

type McpMessageType = 'text' | 'image' | 'voice' | 'video' | 'file' | 'emoji' | 'system' | 'link' | 'location' | 'unknown'

interface McpMessage {
  id: string
  localId: number
  serverId: string
  sessionId: string
  timestamp: number
  senderId: string
  senderName: string
  isSelf: boolean | null
  type: McpMessageType
  text: string
  media?: {
    kind: McpMessageType
    fileName?: string
    fileSize?: number
    md5?: string
    url?: string
  }
}

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000
const DEFAULT_ANALYSIS_LIMIT = 500
const MAX_ANALYSIS_LIMIT = 3000

const clampLimit = (value: unknown, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number => {
  const numeric = Math.floor(Number(value || fallback))
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(numeric, max))
}

const normalizeTimestamp = (value: unknown): number => {
  const numeric = Math.floor(Number(value || 0))
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 10000000000 ? Math.floor(numeric / 1000) : numeric
}

const normalizeSessionType = (session: ChatSession): 'private' | 'group' | 'official' | 'other' => {
  const username = String(session.username || '')
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'private'
}

const mapMessageType = (message: Message): McpMessageType => {
  if (message.localType === 1) return 'text'
  if (message.localType === 3) return 'image'
  if (message.localType === 34) return 'voice'
  if (message.localType === 43) return 'video'
  if (message.localType === 47) return 'emoji'
  if (message.localType === 48) return 'location'
  if (message.localType === 10000) return 'system'
  if (message.fileName || message.fileMd5) return 'file'
  if (message.linkUrl || message.linkTitle) return 'link'
  return 'unknown'
}

const trimText = (value: unknown, maxLength = 4000): string => {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

const toMcpMessage = (message: Message, sessionId: string): McpMessage => {
  const type = mapMessageType(message)
  const text = trimText(
    message.parsedContent ||
      message.linkTitle ||
      message.fileName ||
      message.appMsgDesc ||
      message.rawContent ||
      ''
  )
  const senderId = String(message.senderUsername || '')
  const serverId = String(message.serverIdRaw || message.serverId || '')
  const item: McpMessage = {
    id: message.messageKey || `${sessionId}:${message.localId || serverId}`,
    localId: Number(message.localId || 0),
    serverId,
    sessionId,
    timestamp: normalizeTimestamp(message.createTime),
    senderId,
    senderName: senderId,
    isSelf: message.isSend === null ? null : message.isSend === 1,
    type,
    text
  }

  if (type !== 'text' && type !== 'system' && type !== 'unknown') {
    item.media = {
      kind: type,
      fileName: message.fileName,
      fileSize: message.fileSize,
      md5: message.imageMd5 || message.videoMd5 || message.emojiMd5 || message.fileMd5,
      url: message.linkUrl || message.emojiCdnUrl || message.cdnThumbUrl
    }
  }

  return item
}

const jsonContent = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(value, null, 2)
    }
  ]
})

interface McpSession {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

class McpService {
  private server: http.Server | null = null
  private sessions: Map<string, McpSession> = new Map()
  private configService = ConfigService.getInstance()
  private running = false
  private port = 5032
  private host = '127.0.0.1'
  private connections: Set<import('net').Socket> = new Set()

  async start(port: number = 5032, host: string = '127.0.0.1'): Promise<{ success: boolean; port?: number; url?: string; error?: string }> {
    if (this.running && this.server) {
      return { success: true, port: this.port, url: this.getUrl() }
    }

    this.port = Math.max(1024, Math.min(Math.floor(Number(port || 5032)), 65535))
    this.host = String(host || '127.0.0.1').trim() || '127.0.0.1'

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        this.running = false
        this.server = null
        const error = err.code === 'EADDRINUSE'
          ? `Port ${this.port} is already in use`
          : err.message
        console.error('[McpService] Server error:', err)
        resolve({ success: false, error })
      })
      this.server.listen(this.port, this.host, () => {
        this.running = true
        console.log(`[McpService] MCP server started on ${this.getUrl()}`)
        resolve({ success: true, port: this.port, url: this.getUrl() })
      })
    })
  }

  async stop(): Promise<void> {
    for (const socket of Array.from(this.connections)) {
      try {
        socket.destroy()
      } catch {}
    }
    this.connections.clear()

    const sessions = Array.from(new Set(this.sessions.values()))
    this.sessions.clear()
    await Promise.all(sessions.map(async ({ server, transport }) => {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }))

    await new Promise<void>((resolve) => {
      if (!this.server) {
        this.running = false
        resolve()
        return
      }
      this.server.close(() => {
        this.running = false
        this.server = null
        console.log('[McpService] MCP server stopped')
        resolve()
      })
    })
  }

  isRunning(): boolean {
    return this.running
  }

  getPort(): number {
    return this.port
  }

  getHost(): string {
    return this.host
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}/mcp`
  }

  async autoStart(): Promise<void> {
    if (this.configService.get('mcpEnabled') !== true) return
    const port = Number(this.configService.get('mcpPort') || 5032)
    const host = String(this.configService.get('mcpHost') || '127.0.0.1')
    const result = await this.start(port, host)
    if (!result.success) {
      console.error('[McpService] auto start failed:', result.error)
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${this.host}:${this.port}`}`)
    if (url.pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok', service: 'mcp', running: this.running })
      return
    }
    if (url.pathname !== '/mcp') {
      this.sendJson(res, 404, { error: 'Not found' })
      return
    }
    if (!this.isAuthorized(req, url)) {
      this.sendJson(res, 401, { error: 'Unauthorized: invalid or missing access token' })
      return
    }

    const parsedBodyResult = await this.parseJsonRpcBody(req)
    if (!parsedBodyResult.ok) {
      this.sendJson(res, parsedBodyResult.status, { error: parsedBodyResult.error })
      return
    }

    const session = await this.resolveSession(req, parsedBodyResult.body)
    if (!session) {
      this.sendJson(res, 400, { error: 'Missing or invalid MCP session. Initialize the MCP connection first.' })
      return
    }

    try {
      await session.transport.handleRequest(req, res, parsedBodyResult.body)
    } catch (error) {
      console.error('[McpService] request failed:', error)
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: String(error) })
      } else {
        res.end()
      }
    }
  }

  private async parseJsonRpcBody(req: http.IncomingMessage): Promise<
    | { ok: true; body?: unknown }
    | { ok: false; status: number; error: string }
  > {
    if (req.method !== 'POST') return { ok: true }

    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        return { ok: false, status: 400, error: 'Invalid JSON-RPC request: empty body' }
      }
      return { ok: true, body: JSON.parse(raw) }
    } catch {
      return { ok: false, status: 400, error: 'Invalid JSON-RPC request body' }
    }
  }

  private async resolveSession(req: http.IncomingMessage, parsedBody?: unknown): Promise<McpSession | null> {
    const headerValue = req.headers['mcp-session-id']
    const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue
    const normalizedSessionId = String(sessionId || '').trim()
    if (normalizedSessionId) {
      return this.sessions.get(normalizedSessionId) || null
    }

    if (req.method === 'POST' && this.includesInitializeRequest(parsedBody)) {
      return this.createSession()
    }

    return null
  }

  private async createSession(): Promise<McpSession> {
    let session: McpSession
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, session)
      }
    })
    const server = this.createMcpServer()
    session = { server, transport }

    transport.onclose = () => {
      const sessionId = transport.sessionId
      if (sessionId) this.sessions.delete(sessionId)
      server.close().catch(() => {})
    }

    await server.connect(transport)
    return session
  }

  private includesInitializeRequest(parsedBody: unknown): boolean {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
    return messages.some((message) => (
      !!message &&
      typeof message === 'object' &&
      (message as { method?: unknown }).method === 'initialize'
    ))
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    const expectedToken = String(this.configService.get('mcpToken') || '').trim()
    if (!expectedToken) return false
    const authHeader = String(req.headers.authorization || '')
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      if (this.safeEqual(authHeader.slice(7).trim(), expectedToken)) return true
    }
    const queryToken = url.searchParams.get('access_token')
    if (queryToken && this.safeEqual(queryToken, expectedToken)) return true
    return false
  }

  private safeEqual(a: string, b: string): boolean {
    try {
      const left = Buffer.from(a)
      const right = Buffer.from(b)
      if (left.length !== right.length) return false
      return timingSafeEqual(left, right)
    } catch {
      return false
    }
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: 'weflow',
      version: '0.1.0'
    })

    server.registerTool(
      'weflow.list_sessions',
      {
        title: 'List WeChat Sessions',
        description: 'List local WeChat conversations available in WeFlow.',
        inputSchema: {
          type: z.enum(['all', 'private', 'group', 'official']).optional(),
          keyword: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
          offset: z.number().int().min(0).optional()
        }
      },
      async ({ type = 'all', keyword = '', limit = 100, offset = 0 }) => {
        const result = await chatService.getSessions()
        if (!result.success) return jsonContent({ success: false, error: result.error })
        const normalizedKeyword = String(keyword || '').trim().toLowerCase()
        const sessions = (result.sessions || [])
          .filter((session) => type === 'all' || normalizeSessionType(session) === type)
          .filter((session) => {
            if (!normalizedKeyword) return true
            return String(session.displayName || '').toLowerCase().includes(normalizedKeyword) ||
              String(session.username || '').toLowerCase().includes(normalizedKeyword)
          })
        const start = Math.max(0, Math.floor(Number(offset || 0)))
        const size = clampLimit(limit, 100, 500)
        return jsonContent({
          success: true,
          total: sessions.length,
          offset: start,
          limit: size,
          hasMore: start + size < sessions.length,
          sessions: sessions.slice(start, start + size).map((session) => ({
            sessionId: session.username,
            displayName: session.displayName || session.username,
            type: normalizeSessionType(session),
            summary: session.summary,
            lastTimestamp: session.lastTimestamp || session.sortTimestamp || 0,
            messageCountHint: session.messageCountHint || 0,
            unreadCount: session.unreadCount || 0
          }))
        })
      }
    )

    server.registerTool(
      'weflow.get_session_messages',
      {
        title: 'Get Conversation Messages',
        description: 'Read paginated messages from one WeChat conversation.',
        inputSchema: {
          sessionId: z.string().min(1),
          limit: z.number().int().positive().max(MAX_LIMIT).optional(),
          offset: z.number().int().min(0).optional(),
          startTime: z.number().int().min(0).optional(),
          endTime: z.number().int().min(0).optional(),
          ascending: z.boolean().optional()
        }
      },
      async ({ sessionId, limit = DEFAULT_LIMIT, offset = 0, startTime = 0, endTime = 0, ascending = true }) => {
        const size = clampLimit(limit)
        const result = await chatService.getMessages(
          sessionId,
          Math.max(0, Math.floor(Number(offset || 0))),
          size,
          normalizeTimestamp(startTime),
          normalizeTimestamp(endTime),
          ascending
        )
        if (!result.success) return jsonContent({ success: false, error: result.error })
        return jsonContent({
          success: true,
          sessionId,
          offset,
          limit: size,
          hasMore: result.hasMore === true,
          nextOffset: result.nextOffset,
          messages: (result.messages || []).map((message) => toMcpMessage(message, sessionId))
        })
      }
    )

    server.registerTool(
      'weflow.search_messages',
      {
        title: 'Search Messages',
        description: 'Search local WeChat messages by keyword, optionally scoped to a conversation and time range.',
        inputSchema: {
          keyword: z.string().min(1),
          sessionId: z.string().optional(),
          limit: z.number().int().positive().max(MAX_LIMIT).optional(),
          offset: z.number().int().min(0).optional(),
          startTime: z.number().int().min(0).optional(),
          endTime: z.number().int().min(0).optional()
        }
      },
      async ({ keyword, sessionId, limit = DEFAULT_LIMIT, offset = 0, startTime = 0, endTime = 0 }) => {
        const size = clampLimit(limit)
        const result = await chatService.searchMessages(
          keyword,
          sessionId,
          size,
          Math.max(0, Math.floor(Number(offset || 0))),
          normalizeTimestamp(startTime),
          normalizeTimestamp(endTime)
        )
        if (!result.success) return jsonContent({ success: false, error: result.error })
        return jsonContent({
          success: true,
          keyword,
          sessionId: sessionId || null,
          offset,
          limit: size,
          messages: (result.messages || []).map((message) => {
            const resolvedSessionId = String((message as Message & { sessionId?: string }).sessionId || sessionId || '')
            return toMcpMessage(message, resolvedSessionId)
          })
        })
      }
    )

    server.registerTool(
      'weflow.get_session_stats',
      {
        title: 'Get Conversation Stats',
        description: 'Get message and media statistics for one conversation.',
        inputSchema: {
          sessionId: z.string().min(1),
          startTime: z.number().int().min(0).optional(),
          endTime: z.number().int().min(0).optional(),
          includeRelations: z.boolean().optional()
        }
      },
      async ({ sessionId, startTime = 0, endTime = 0, includeRelations = true }) => {
        const result = await chatService.getExportSessionStats([sessionId], {
          includeRelations,
          beginTimestamp: normalizeTimestamp(startTime),
          endTimestamp: normalizeTimestamp(endTime)
        })
        if (!result.success) return jsonContent({ success: false, error: result.error })
        return jsonContent({
          success: true,
          sessionId,
          stats: result.data?.[sessionId] || null,
          cache: result.cache?.[sessionId] || null
        })
      }
    )

    server.registerTool(
      'weflow.get_group_members',
      {
        title: 'Get Group Members',
        description: 'Get group member details for a WeChat group conversation.',
        inputSchema: {
          chatroomId: z.string().min(1)
        }
      },
      async ({ chatroomId }) => {
        const result = await groupAnalyticsService.getGroupMembers(chatroomId)
        if (!result.success) return jsonContent({ success: false, error: result.error })
        return jsonContent({
          success: true,
          chatroomId,
          members: result.data || []
        })
      }
    )

    server.registerTool(
      'weflow.prepare_analysis_pack',
      {
        title: 'Prepare Conversation Analysis Pack',
        description: 'Prepare a bounded, AI-friendly conversation analysis pack with stats and a sampled message slice.',
        inputSchema: {
          sessionId: z.string().min(1),
          startTime: z.number().int().min(0).optional(),
          endTime: z.number().int().min(0).optional(),
          messageLimit: z.number().int().positive().max(MAX_ANALYSIS_LIMIT).optional()
        }
      },
      async ({ sessionId, startTime = 0, endTime = 0, messageLimit = DEFAULT_ANALYSIS_LIMIT }) => {
        const size = clampLimit(messageLimit, DEFAULT_ANALYSIS_LIMIT, MAX_ANALYSIS_LIMIT)
        const [statsResult, messagesResult, detailResult] = await Promise.all([
          chatService.getExportSessionStats([sessionId], {
            includeRelations: true,
            beginTimestamp: normalizeTimestamp(startTime),
            endTimestamp: normalizeTimestamp(endTime)
          }),
          chatService.getMessages(sessionId, 0, size, normalizeTimestamp(startTime), normalizeTimestamp(endTime), true),
          chatService.getSessionDetailFast(sessionId)
        ])
        if (!messagesResult.success) {
          return jsonContent({ success: false, error: messagesResult.error || '读取消息失败' })
        }
        return jsonContent({
          success: true,
          session: {
            sessionId,
            detail: detailResult.success ? detailResult.detail : null
          },
          range: {
            startTime: normalizeTimestamp(startTime),
            endTime: normalizeTimestamp(endTime)
          },
          stats: statsResult.success ? statsResult.data?.[sessionId] || null : null,
          sample: {
            limit: size,
            hasMore: messagesResult.hasMore === true,
            nextOffset: messagesResult.nextOffset,
            messages: (messagesResult.messages || []).map((message) => toMcpMessage(message, sessionId))
          },
          guidance: 'Use weflow.get_session_messages with nextOffset and the same time range to request more detail only when needed.'
        })
      }
    )

    registerTelegramMcpTools(server)

    return server
  }
}

export const mcpService = new McpService()
