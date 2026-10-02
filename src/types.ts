export type Channel = "api" | "telegram";

export interface Conversation {
  id: string;
  channel: Channel;
  externalId: string | null;
  title: string | null;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  profileId?: string | null;
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
}

export interface Attachment { id: string; conversationId: string; name: string; mimeType: string; size: number; }

export interface TelegramChat { chatId: string; title: string; conversationId: string | null; profileId: string | null; allowedSenders: string[]; }
export interface HistoryEntry { sourceId: string; date: string; author: string; direction: "inbound" | "outbound"; text: string; }

export interface EmployeeProfile {
  id: string;
  name: string;
  instructions: string;
  capabilities: string[];
  model: string | null;
  tokenLimit: number | null;
  createdAt: string;
  preview?: string | null;
  domain?: "personal" | "work";
  purpose?: string;
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
  forContext?(context: string): CodexEngine;
  run(
    input: string,
    options?: {
      threadId?: string | null;
      signal?: AbortSignal;
      onEvent?: (event: EngineEvent) => void;
      profile?: string | null;
      model?: string | null;
      images?: string[];
      tools?: { definitions: DynamicTool[]; call: (name: string, args: Record<string, unknown>) => Promise<unknown> };
      onRequest?: (method: string, params: Record<string, any>) => Promise<unknown>;
    },
  ): Promise<CodexRunResult>;
  close?(): void;
  connections?(refresh?: boolean): Promise<Connection[]>;
  connectionNotice?: string;
  isConnected?(id: string): Promise<boolean>;
  connect?(id: string): Promise<{ url: string | null }>;
}

export interface DynamicTool { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> }
export interface Connection { id: string; name: string; kind: "app" | "mcp"; detail?: string | null; connected: boolean; url: string | null; }
export interface Interaction { id: string; conversationId: string; messageId: string; title: string; detail?: string; url?: string; questions: Array<{ id: string; question: string; options: string[] }>; }

export interface MessageInput {
  conversationId?: string;
  channel: Channel;
  text: string;
  externalId?: string;
  externalChatId?: string;
  title?: string;
  /** Native clients may pin a message to an employee. Telegram uses the router. */
  profile?: string;
  author?: string;
  /** Background runs cannot wait forever for an interactive approval. */
  scheduled?: boolean;
  attachments?: string[];
  /** Downloaded channel media; never accepted as arbitrary paths by the API. */
  uploads?: Array<{ id: string; name: string; mimeType?: string; contentBase64: string }>;
}

export interface MessageResult {
  conversationId: string;
  messageId: string;
  text: string;
  attachments?: Attachment[];
  /** The employee that answered, when the router selected one. */
  profileId?: string;
}
