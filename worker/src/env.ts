export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  NOTION_TOKEN: string;
  NOTION_VERSION?: string;
  AI_BASE_URL: string;
  AI_API_KEY: string;
  AI_MODEL: string;
  WEBHOOK_SECRET: string;
  /** Opsional: daftar chat_id yang diizinkan, dipisah koma. */
  ALLOWED_CHAT_IDS?: string;
  SESSIONS: DurableObjectNamespace;
}
