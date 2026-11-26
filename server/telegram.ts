// Minimal Telegram Bot API client: only the types and methods Warden uses.
// https://core.telegram.org/bots/api

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  is_premium?: boolean
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
}

export interface TgEntity {
  type: string // url, text_link, mention, text_mention, ...
  offset: number
  length: number
  url?: string
  user?: TgUser
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  sender_chat?: TgChat
  chat: TgChat
  date: number
  text?: string
  caption?: string
  entities?: TgEntity[]
  caption_entities?: TgEntity[]
  new_chat_members?: TgUser[]
  left_chat_member?: TgUser
  forward_origin?: { type: string; sender_user?: TgUser; chat?: TgChat; sender_user_name?: string }
  via_bot?: TgUser
  migrate_to_chat_id?: number // a basic group became a supergroup (e.g. when an admin with custom rights is added)
  reply_markup?: { inline_keyboard?: { text: string; url?: string }[][] }
}

export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
  user: TgUser
  can_delete_messages?: boolean
  can_restrict_members?: boolean
  can_invite_users?: boolean
  can_pin_messages?: boolean
  can_send_messages?: boolean // restricted members only
  until_date?: number
}

export interface TgChatMemberUpdated {
  chat: TgChat
  from: TgUser
  date: number
  old_chat_member: TgChatMember
  new_chat_member: TgChatMember
}

export interface TgChatJoinRequest {
  chat: TgChat
  from: TgUser
  user_chat_id: number
  date: number
  bio?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  my_chat_member?: TgChatMemberUpdated
  chat_member?: TgChatMemberUpdated
  chat_join_request?: TgChatJoinRequest
}

export interface TgChatPermissions {
  can_send_messages?: boolean
  can_send_audios?: boolean
  can_send_documents?: boolean
  can_send_photos?: boolean
  can_send_videos?: boolean
  can_send_video_notes?: boolean
  can_send_voice_notes?: boolean
  can_send_polls?: boolean
  can_send_other_messages?: boolean
  can_add_web_page_previews?: boolean
  can_change_info?: boolean
  can_invite_users?: boolean
  can_pin_messages?: boolean
  can_manage_topics?: boolean
}

export const MUTED: TgChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
}

/**
 * Every ChatPermissions field set to true. Telegram lifts a member's individual
 * restriction only when all of them are true (group defaults apply again).
 */
export const ALL_ALLOWED: Required<TgChatPermissions> = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
}

export class TelegramError extends Error {
  readonly code: number
  readonly retryAfter?: number
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`${method}: ${code} ${description}`)
    this.code = code
    this.retryAfter = retryAfter
  }
}

export const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member', 'chat_member', 'chat_join_request']

export class Telegram {
  private readonly base: string

  constructor(token: string, apiBase = 'https://api.telegram.org') {
    this.base = `${apiBase.replace(/\/$/, '')}/bot${token}`
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }))) as {
        ok: boolean
        result?: T
        error_code?: number
        description?: string
        parameters?: { retry_after?: number }
      }
      if (body.ok) return body.result as T
      const retryAfter = body.parameters?.retry_after
      // Flood control: wait once, then give up so a stuck call never blocks the queue.
      if (body.error_code === 429 && retryAfter && attempt === 0 && retryAfter <= 10) {
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        continue
      }
      throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'unknown error', retryAfter)
    }
  }

  getMe() {
    return this.call<TgUser>('getMe')
  }

  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES },
      (timeoutSec + 10) * 1000,
    )
  }

  getChat(chatId: number) {
    return this.call<TgChat & { permissions?: TgChatPermissions }>('getChat', { chat_id: chatId })
  }

  getChatMember(chatId: number, userId: number) {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId })
  }

  getChatAdministrators(chatId: number) {
    return this.call<TgChatMember[]>('getChatAdministrators', { chat_id: chatId })
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text, ...extra })
  }

  /** Telegram accepts 1-100 ids per call; callers batch. */
  deleteMessages(chatId: number, messageIds: number[]) {
    if (messageIds.length < 1 || messageIds.length > 100) throw new RangeError('deleteMessages takes 1-100 ids')
    return this.call<boolean>('deleteMessages', { chat_id: chatId, message_ids: messageIds })
  }

  banChatMember(chatId: number, userId: number, revokeMessages = true) {
    return this.call<boolean>('banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: revokeMessages })
  }

  unbanChatMember(chatId: number, userId: number) {
    return this.call<boolean>('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true })
  }

  restrictChatMember(chatId: number, userId: number, permissions: TgChatPermissions, untilDate?: number) {
    return this.call<boolean>('restrictChatMember', {
      chat_id: chatId,
      user_id: userId,
      permissions,
      use_independent_chat_permissions: true,
      ...(untilDate ? { until_date: untilDate } : {}),
    })
  }

  setChatPermissions(chatId: number, permissions: TgChatPermissions) {
    return this.call<boolean>('setChatPermissions', { chat_id: chatId, permissions, use_independent_chat_permissions: true })
  }

  approveChatJoinRequest(chatId: number, userId: number) {
    return this.call<boolean>('approveChatJoinRequest', { chat_id: chatId, user_id: userId })
  }

  declineChatJoinRequest(chatId: number, userId: number) {
    return this.call<boolean>('declineChatJoinRequest', { chat_id: chatId, user_id: userId })
  }

  pinChatMessage(chatId: number, messageId: number) {
    return this.call<boolean>('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true })
  }
}

export function displayName(u: Pick<TgUser, 'first_name' | 'last_name'>): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ')
}

export function handle(u: TgUser): string {
  return u.username ? `@${u.username}` : displayName(u)
}
