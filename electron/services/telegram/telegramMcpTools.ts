import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { telegramAuthService } from './telegramAuthService'
import { telegramChatService } from './telegramChatService'

const jsonContent = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(value, null, 2)
    }
  ]
})

export function registerTelegramMcpTools(server: McpServer): void {
  server.registerTool(
    'weflow.telegram_status',
    {
      title: 'Get Telegram Status',
      description: 'Check whether the independent Telegram account module is configured and authorized.',
      inputSchema: {}
    },
    async () => jsonContent({
      success: true,
      status: await telegramAuthService.getStatus()
    })
  )

  server.registerTool(
    'weflow.telegram_list_chats',
    {
      title: 'List Telegram Chats',
      description: 'List Telegram chats available to the logged-in Telegram user account.',
      inputSchema: {
        type: z.enum(['all', 'private', 'bot', 'group', 'channel', 'unknown']).optional(),
        keyword: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional()
      }
    },
    async (args) => jsonContent(await telegramChatService.listChats(args))
  )

  server.registerTool(
    'weflow.telegram_get_chat_messages',
    {
      title: 'Get Telegram Chat Messages',
      description: 'Read paginated Telegram messages from one chat. This returns text and media metadata only.',
      inputSchema: {
        chatId: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        beforeMessageId: z.number().int().min(0).optional(),
        afterMessageId: z.number().int().min(0).optional(),
        startTime: z.number().int().min(0).optional(),
        endTime: z.number().int().min(0).optional(),
        ascending: z.boolean().optional()
      }
    },
    async (args) => jsonContent(await telegramChatService.getChatMessages(args))
  )

  server.registerTool(
    'weflow.telegram_search_chat_messages',
    {
      title: 'Search Telegram Chat Messages',
      description: 'Search Telegram messages by keyword within one chat.',
      inputSchema: {
        chatId: z.string().min(1),
        keyword: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        beforeMessageId: z.number().int().min(0).optional(),
        afterMessageId: z.number().int().min(0).optional(),
        startTime: z.number().int().min(0).optional(),
        endTime: z.number().int().min(0).optional(),
        ascending: z.boolean().optional()
      }
    },
    async (args) => jsonContent(await telegramChatService.searchChatMessages(args))
  )

  server.registerTool(
    'weflow.telegram_prepare_analysis_pack',
    {
      title: 'Prepare Telegram Analysis Pack',
      description: 'Prepare a bounded Telegram chat analysis pack with sampled messages and basic type counts.',
      inputSchema: {
        chatId: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        beforeMessageId: z.number().int().min(0).optional(),
        afterMessageId: z.number().int().min(0).optional(),
        startTime: z.number().int().min(0).optional(),
        endTime: z.number().int().min(0).optional(),
        ascending: z.boolean().optional()
      }
    },
    async (args) => jsonContent(await telegramChatService.prepareAnalysisPack(args))
  )
}
