import type { MessageContext } from "./message-context.js";

export type Channel = "api" | "telegram";
export interface TelegramLinkButton { text: string; url: string }

export interface Conversation {
  id: string;
  channel: Channel;
  externalId: string | null;
  title: string | null;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  profileId?: string | null;
  modelSelection?: import("./model-settings.js").ModelSelection;
}

export interface Message {
  id: string;
  conversationId: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  replyToId: string | null;
  text: string;
  externalId: string | null;
  createdAt: string;
  status?: "queued" | "running" | "completed" | "failed";
  error?: string | null;
  kind?: "text" | "notice";
  author?: string | null;
  imported?: boolean;
  attachments?: Attachment[];
  /** Presentation metadata only. Never changes the conversation's audience or model context. */
  origin?: { channel: "api" | "telegram" | "archive"; title: string; chatId?: string; url?: string; canReply?: boolean };
  delivery?: { state: "pending" | "delivered" | "unknown" | "not_sent"; error?: string };
  /** A version of a News story; its text is the same story as Markdown. */
  story?: NewsStory;
  /** The story this message belongs to: a version, or a question and answer about it. */
  storyId?: string;
  /** What the owner attached from the app: a business client, or a quoted message or story. Shown with the request. */
  context?: MessageContext;
}

export interface NewsStory {
  id: string; edition: string | null; rank: number | null; section: string; status: string; title: string; summary: string; body: string;
  view: string | null; check: string | null; verification: string; eventAt: string | null; change: string | null;
  sources: Array<{ title: string; url: string; role: string; publishedAt: string | null }>;
  /** How this version reaches the desk's Telegram chat: "alert" with sound, "card" silently; null or absent stays in the app and the edition. */
  telegram?: "alert" | "card" | null;
}

export interface Attachment { id: string; conversationId: string; name: string; mimeType: string; size: number; }

export interface TelegramChat { chatId: string; title: string; conversationId: string | null; profileId: string | null; allowedSenders: string[]; access: "approved" | "members"; replies: "instructions" | "mentions"; enabled?: boolean; }
export interface HistoryEntry { sourceId: string; date: string; author: string; direction: "inbound" | "outbound"; text: string; }

export interface EmployeeProfile {
  appearance?: import("./agent-appearance.js").AgentAppearance;
  id: string;
  name: string;
  instructions: string;
  capabilities: string[];
  /** Null with a model means ChatGPT, as stored before providers existed. */
  provider?: string | null;
  model: string | null;
  serviceTier?: string | null;
  reasoningEffort?: string | null;
  tokenLimit: number | null;
  createdAt: string;
  preview?: string | null;
  domain?: "personal" | "work";
  purpose?: string;
  /** The employee publishes News stories, so the app lists its reader among the feeds. */
  news?: boolean;
}

export interface EngineEvent {
  type: string;
  payload: unknown;
}

export interface CodexRunResult {
  threadId: string;
  response: string;
  events: EngineEvent[];
}

export interface CodexEngine {
  /** Native app-server input for an already running turn; false means no turn. */
  steer?(input: string, options: { threadId: string; images?: string[] }): Promise<boolean>;
  forContext?(context: string): CodexEngine;
  forAgent?(agentId: string, context: string, conversationId?: string): CodexEngine;
  run(
    input: string,
    options?: {
      threadId?: string | null;
      conversationId?: string;
      /** The inbound message this turn answers. */
      messageId?: string;
      signal?: AbortSignal;
      onEvent?: (event: EngineEvent) => void;
      profile?: string | null;
      /** The resolved provider; a turn stays on its route. */
      provider?: string | null;
      model?: string | null;
      serviceTier?: string | null;
      /** A direct chat on the device's model: the ordinary speed becomes Fast where the model offers it. */
      fast?: boolean;
      reasoningEffort?: string | null;
      /** Permanent employees offered as native Codex roles on this device. */
      employees?: EmployeeProfile[];
      images?: string[];
      /** A native app's JSON Schema for this turn's final answer. The engine constrains the reply to it. */
      outputSchema?: Record<string, unknown>;
      /** Snapshotted when the queued turn starts on its execution device. */
      approvalMode?: import("./approval-mode.js").ApprovalMode;
      groupContext?: boolean;
      /** Trusted: this chat is a Telegram group itself, not an owner's chat that only keeps its files with one. Set by MessageService. */
      groupChat?: boolean;
      /** Trusted: the device owner sent this turn. Set by the server from the owner's session and by the Telegram adapter, never from a request body. */
      byOwner?: boolean;
      /** Trusted: false when the Telegram sender is not on this Home's access list. Set only by MessageService from the adapter's sender id, never from a request body. */
      access?: boolean;
      /** Trusted server-selected source paths. Never populated from a request body. */
      readPaths?: string[];
      /** Trusted read-only source grant for a running private schedule, checked against its saved receipt. Never populated from a request body; does not confer owner authority. */
      privateSourceAccess?: boolean;
      /** Trusted owner-registered checkout, resolved at execution time by Home. */
      project?: import("./projects.js").ProjectTurn;
      /** A schedule started this turn. */
      scheduled?: boolean;
      /** Trusted, set only by MessageService: a new session that is never resumed. No saved thread is read or written
       * back on any provider. Codex also stores no rollout of it, so it never becomes a native memory. */
      ephemeral?: boolean;
      /** Trusted, set only by MessageService: false keeps the turn on its chosen model, without the device's reserves,
       * as a chat or employee with its own model already is. */
      reserves?: boolean;
      /** Verified channel identity, supplied only by the Telegram adapter. */
      telegramActor?: { userId: string; chatId: string; messageId: string };
      tools?: { definitions: DynamicTool[]; call: (name: string, args: Record<string, unknown>) => Promise<unknown> };
      onRequest?: (method: string, params: Record<string, any>) => Promise<unknown>;
      /** The running counters the engine reported for this thread after its previous recorded turn (`turn.usage` `engine.totals`). */
      usageBaseline?: unknown;
    },
  ): Promise<CodexRunResult>;
  close?(): void;
  models?(refresh?: boolean): Promise<import("./model-settings.js").ModelChoice[]>;
  connections?(refresh?: boolean): Promise<Connection[]>;
  connectionNotice?: string;
  isConnected?(id: string): Promise<boolean>;
  connect?(id: string, options?: { callbackURL: string }): Promise<ServiceSignIn>;
  extensions?(): import("./extensions.js").CodexExtensions | Promise<import("./extensions.js").CodexExtensions>;
}

export interface ServiceSignIn {
  url: string | null;
  /** In-memory continuation, never serialized or exposed as a generic proxy. */
  oauth?: { complete(callback: string): Promise<void>; cancel(): void };
}

export interface DynamicTool { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> }
export interface Connection { id: string; name: string; kind: "app" | "mcp"; detail?: string | null; connected: boolean; url: string | null; status?: "ready" | "sign_in" | "unavailable" | "disabled" | "available" | "unknown"; toolCount?: number; removable?: boolean; }
export interface Interaction { id: string; conversationId: string; messageId: string; title: string; detail?: string; url?: string; requestedBy?: string; questions: Array<{ id: string; question: string; options: string[] }>; }

export interface MessageInput {
  mode?: "steer" | "queue";
  conversationId?: string;
  channel: Channel;
  text: string;
  externalId?: string;
  externalChatId?: string;
  title?: string;
  /** Explicit employee chat. Delegation never changes the conversation's owner. */
  profile?: string;
  author?: string;
  /** Trusted Telegram delivery metadata, not accepted from the public message API. */
  replyToAssistant?: boolean;
  /** The Telegram message this one replies to, as Telegram delivered it. */
  replyTo?: { messageId: number; author?: string; text: string };
  /** An app question about a News story in this chat: the story's message id. */
  replyToId?: string;
  telegramSenderId?: string;
  /** Trusted adapter input: preserve group context without invoking the model. */
  contextOnly?: boolean;
  /** Background runs cannot wait forever for an interactive approval. */
  scheduled?: boolean;
  /** Trusted scheduler destination; null means app-only. Never accepted from a request body. */
  scheduleTelegramChatId?: string | null;
  /** Trusted: the device owner sent this message. Set by the server and the Telegram adapter, never from a request body. */
  byOwner?: boolean;
  attachments?: string[];
  /** Downloaded channel media; never accepted as arbitrary paths by the API. */
  uploads?: Array<{ id: string; name: string; mimeType?: string; contentBase64: string }>;
  /** Trusted: the server resolved it against this Home's store or the client source before submitting. */
  context?: MessageContext;
  /** A native app asks for a structured answer: the reply's text is one JSON document matching this schema. */
  outputSchema?: Record<string, unknown>;
  /** A native app's reasoning level for its own chat, used while the owner has chosen no model for that chat. */
  reasoningEffort?: string;
}

export interface MessageResult {
  conversationId: string;
  messageId: string;
  text: string;
  attachments?: Attachment[];
  /** The employee whose conversation is open, not a delegated helper. */
  profileId?: string;
}
