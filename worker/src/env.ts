export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  NOTION_TOKEN: string;
  NOTION_VERSION?: string;
  AI_BASE_URL: string;
  AI_API_KEY: string;
  AI_MODEL: string;
  WEBHOOK_SECRET: string;
  /** Optional: comma-separated list of allowed chat_ids. */
  ALLOWED_CHAT_IDS?: string;
  /** Optional: chat_id that receives error alerts. */
  OWNER_CHAT_ID?: string;
  SESSIONS: DurableObjectNamespace;
}
