/**
 * Convert Markdown (Gemini output) and Telegram entities into Notion blocks
 * with inline annotations: **bold**, *italic*, `code`, ~~strike~~, [link](url).
 * Independent of how Telegram renders a message — plain text is safe too.
 */

export type Block = Record<string, unknown>;
export type RichItem = Record<string, unknown>;

const MAX_TEXT = 2000;

interface Token {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

function textItem(token: Token): RichItem {
  const annotations: Record<string, boolean> = {};
  if (token.bold) annotations.bold = true;
  if (token.italic) annotations.italic = true;
  if (token.strike) annotations.strikethrough = true;
  if (token.code) annotations.code = true;

  const text: Record<string, unknown> = { content: token.text };
  if (token.link) text.link = { url: token.link };

  const item: RichItem = { type: "text", text };
  if (Object.keys(annotations).length) item.annotations = annotations;
  return item;
}

/** Split one Markdown line into annotated tokens. */
function parseInline(input: string): Token[] {
  const tokens: Token[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) tokens.push({ text: buffer });
    buffer = "";
  };

  while (i < input.length) {
    const rest = input.slice(i);
    let match: RegExpMatchArray | null = null;

    if ((match = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/))) {
      flush();
      tokens.push({ text: match[1], bold: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^__(?=\S)([\s\S]*?\S)__/))) {
      flush();
      tokens.push({ text: match[1], bold: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^\*(?=\S)([^*\n]*?\S)\*/))) {
      flush();
      tokens.push({ text: match[1], italic: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^_(?=\S)([^_\n]*?\S)_/))) {
      flush();
      tokens.push({ text: match[1], italic: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
      flush();
      tokens.push({ text: match[1], strike: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^`([^`\n]+)`/))) {
      flush();
      tokens.push({ text: match[1], code: true });
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      flush();
      tokens.push({ text: match[1], link: match[2] });
      i += match[0].length;
      continue;
    }
    if (rest.startsWith("\\") && rest.length > 1) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    buffer += input[i];
    i += 1;
  }

  flush();
  return tokens;
}

/** Markdown text -> Notion rich_text, including annotations and 2000-char splitting. */
export function inlineRichText(markdown: string): RichItem[] {
  const source = markdown.length ? markdown : " ";
  const tokens = parseInline(source);
  if (!tokens.length) return [{ type: "text", text: { content: " " } }];

  const out: RichItem[] = [];
  for (const token of tokens) {
    for (let i = 0; i < token.text.length; i += MAX_TEXT) {
      out.push(textItem({ ...token, text: token.text.slice(i, i + MAX_TEXT) }));
    }
  }
  return out;
}

function codeBlock(code: string, language = "plain text"): Block {
  const content = code.length ? code : " ";
  const rich: RichItem[] = [];
  for (let i = 0; i < content.length; i += MAX_TEXT) {
    rich.push({ type: "text", text: { content: content.slice(i, i + MAX_TEXT) } });
  }
  return {
    object: "block",
    type: "code",
    code: { rich_text: rich, language },
  };
}

const ALLOWED = new Set([
  "paragraph",
  "quote",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "divider",
]);

/** One Notion block from a type plus Markdown text. */
export function blockOf(type: string, markdown: string): Block | null {
  if (type === "divider") {
    return { object: "block", type: "divider", divider: {} };
  }
  const text = markdown.trim();
  if (!text) return null;
  const safe = ALLOWED.has(type) ? type : "paragraph";
  return {
    object: "block",
    type: safe,
    [safe]: { rich_text: inlineRichText(text) },
  };
}

const FENCE = /^```/;
const DIVIDER = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\|.*\|$/;

/** Full Markdown -> Notion blocks (headings, quotes, lists, code, tables). */
export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const block = blockOf("paragraph", paragraph.join("\n"));
    if (block) blocks.push(block);
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const block = blockOf("quote", quote.join("\n"));
    if (block) blocks.push(block);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (FENCE.test(line)) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      blocks.push(codeBlock(body.join("\n")));
      continue;
    }

    if (!line) {
      flushAll();
      continue;
    }

    if (DIVIDER.test(line)) {
      flushAll();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushAll();
      const block = blockOf(heading[1].length <= 1 ? "heading_2" : "heading_3", heading[2]);
      if (block) blocks.push(block);
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      flushAll();
      const block = blockOf("bulleted_list_item", bullet[1]);
      if (block) blocks.push(block);
      continue;
    }

    const numbered = line.match(NUMBERED);
    if (numbered) {
      flushAll();
      const block = blockOf("numbered_list_item", numbered[1]);
      if (block) blocks.push(block);
      continue;
    }

    if (TABLE_ROW.test(line)) {
      flushAll();
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i].trim())) {
        rows.push(lines[i].trim());
        i++;
      }
      i--;
      blocks.push(codeBlock(rows.join("\n")));
      continue;
    }

    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

/**
 * Telegram entities -> Markdown markers. Entity offsets are UTF-16 units,
 * the same as JavaScript string indices, so they can be used directly.
 * Applied back-to-front so earlier offsets do not shift.
 */
export function entitiesToMarkdown(text: string, entities?: TgEntity[]): string {
  if (!entities?.length) return text;

  const usable = entities
    .filter((e) => e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length)
    .sort((a, b) => b.offset - a.offset || b.length - a.length);

  let out = text;
  for (const entity of usable) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    const chunk = out.slice(start, end);
    let wrapped = chunk;

    switch (entity.type) {
      case "bold":
        wrapped = `**${chunk}**`;
        break;
      case "italic":
        wrapped = `*${chunk}*`;
        break;
      case "strikethrough":
        wrapped = `~~${chunk}~~`;
        break;
      case "code":
        wrapped = "`" + chunk + "`";
        break;
      case "pre":
        wrapped = "```\n" + chunk + "\n```";
        break;
      case "text_link":
        wrapped = entity.url ? `[${chunk}](${entity.url})` : chunk;
        break;
      case "blockquote":
        wrapped = chunk
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        break;
      default:
        wrapped = chunk;
    }

    out = out.slice(0, start) + wrapped + out.slice(end);
  }
  return out;
}
