export interface AudioRef {
  fileId: string;
  name: string;
  mime: string;
  rawMime: string;
}

export interface ImageRef {
  fileId: string;
  name: string;
  mime: string;
  caption: string;
}

/** One toggle heading on a page, kept so a button tap can resolve back to it. */
export interface SectionRef {
  id: string;
  title: string;
}

/** One child page, kept so a button tap can open it. */
export interface PageRef {
  id: string;
  title: string;
}

export interface SessionState {
  pageId: string | null;
  pageUrl: string | null;
  title: string | null;
  materials: string[];
  audios: AudioRef[];
  images: ImageRef[];
  sections: SectionRef[];
  sectionsPageId: string | null;
  pages: PageRef[];
  pagesPageId: string | null;
  homePageId: string | null;
  navStack: string[];
  listKind: "sections" | "pages" | null;
  listPage: number;
  pendingBlocks: unknown[];
  awaitingEdit: "title" | "material" | null;
  awaitingTitle: boolean;
}

export function emptyState(): SessionState {
  return {
    pageId: null,
    pageUrl: null,
    title: null,
    materials: [],
    audios: [],
    images: [],
    sections: [],
    sectionsPageId: null,
    pages: [],
    pagesPageId: null,
    homePageId: null,
    navStack: [],
    listKind: null,
    listPage: 0,
    pendingBlocks: [],
    awaitingEdit: null,
    awaitingTitle: false,
  };
}

type PushField = "materials" | "audios" | "images";

/**
 * Bot message IDs live under their own key, not inside the session, so /cancel
 * (which deletes the session) cannot erase the record /clearchat depends on.
 */
const MESSAGES_KEY = "botMessages";
const MAX_TRACKED_MESSAGES = 200;

export class SessionDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let body: Record<string, unknown> = { op: "get" };
    if (request.method === "POST") {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "bad json" }, { status: 400 });
      }
    }

    const stored = await this.state.storage.get<SessionState>("session");
    const current: SessionState = { ...emptyState(), ...(stored ?? {}) };

    switch (body.op) {
      case "get":
        return Response.json(current);

      case "setTitle": {
        const value = typeof body.title === "string" ? body.title.trim() : "";
        const next: SessionState = { ...current, title: value || null };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setPage": {
        const next: SessionState = {
          ...current,
          pageId: (body.pageId as string) ?? null,
          pageUrl: (body.pageUrl as string) ?? null,
          // A different page means the cached section list no longer applies.
          sections: [],
          sectionsPageId: null,
          pages: [],
          pagesPageId: null,
          listKind: null,
          listPage: 0,
          pendingBlocks: [],
          awaitingEdit: null,
          awaitingTitle: false,
        };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setSections": {
        const items = Array.isArray(body.items) ? (body.items as SectionRef[]) : [];
        const next: SessionState = {
          ...current,
          sections: items,
          sectionsPageId: (body.pageId as string) ?? null,
        };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "clearSections": {
        const next: SessionState = { ...current, sections: [], sectionsPageId: null };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setPages": {
        const items = Array.isArray(body.items) ? (body.items as PageRef[]) : [];
        const next: SessionState = {
          ...current,
          pages: items,
          pagesPageId: (body.pageId as string) ?? null,
        };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "clearPages": {
        const next: SessionState = { ...current, pages: [], pagesPageId: null };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "clearMaterials": {
        const next: SessionState = { ...current, materials: [] };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setPendingBlocks": {
        const items = Array.isArray(body.items) ? body.items : [];
        const next: SessionState = { ...current, pendingBlocks: items };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "clearPendingBlocks": {
        const next: SessionState = { ...current, pendingBlocks: [] };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setAwaitingEdit": {
        const value = body.value === "title" || body.value === "material" ? body.value : null;
        const next: SessionState = { ...current, awaitingEdit: value };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setAwaitingTitle": {
        const value = Boolean(body.value);
        const next: SessionState = { ...current, awaitingTitle: value };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setHome": {
        const next: SessionState = { ...current, homePageId: (body.homePageId as string) ?? null };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setNavStack": {
        const items = Array.isArray(body.items) ? (body.items as string[]) : [];
        const next: SessionState = { ...current, navStack: items };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "setListState": {
        const kind = body.kind === "sections" || body.kind === "pages" ? body.kind : null;
        const page = typeof body.page === "number" ? body.page : 0;
        const next: SessionState = { ...current, listKind: kind, listPage: page };
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "push": {
        const field = body.field as PushField;
        if (!["materials", "audios", "images"].includes(field)) {
          return Response.json({ error: "bad field" }, { status: 400 });
        }
        const list = [...(current[field] as unknown[]), body.value];
        const next = { ...current, [field]: list } as SessionState;
        await this.state.storage.put("session", next);
        return Response.json(next);
      }

      case "clear": {
        await this.state.storage.delete("session");
        return Response.json(emptyState());
      }

      case "addBotMessages": {
        const incoming = Array.isArray(body.items)
          ? (body.items as unknown[]).filter(
              (value): value is number => typeof value === "number" && value > 0,
            )
          : [];
        if (incoming.length === 0) return Response.json({ count: 0 });

        const existing = (await this.state.storage.get<number[]>(MESSAGES_KEY)) ?? [];
        const merged = [...existing, ...incoming].slice(-MAX_TRACKED_MESSAGES);
        await this.state.storage.put(MESSAGES_KEY, merged);
        return Response.json({ count: merged.length });
      }

      case "getBotMessages": {
        const list = (await this.state.storage.get<number[]>(MESSAGES_KEY)) ?? [];
        return Response.json(list);
      }

      case "clearBotMessages": {
        await this.state.storage.delete(MESSAGES_KEY);
        return Response.json({ count: 0 });
      }

      case "setLastAlert": {
        const value =
          typeof body.value === "number" && body.value > 0 ? body.value : Date.now();
        await this.state.storage.put("lastAlert", value);
        return Response.json(value);
      }

      case "getLastAlert": {
        const value = (await this.state.storage.get<number>("lastAlert")) ?? 0;
        return Response.json(value);
      }

      case "setLastClearChat": {
        const value =
          typeof body.value === "number" && body.value > 0 ? body.value : Date.now();
        await this.state.storage.put("lastClearChat", value);
        return Response.json(value);
      }

      case "getLastClearChat": {
        const value = (await this.state.storage.get<number>("lastClearChat")) ?? 0;
        return Response.json(value);
      }

      case "setLastDone": {
        const value =
          typeof body.value === "number" && body.value > 0 ? body.value : Date.now();
        await this.state.storage.put("lastDone", value);
        return Response.json(value);
      }

      case "getLastDone": {
        const value = (await this.state.storage.get<number>("lastDone")) ?? 0;
        return Response.json(value);
      }

      default:
        return Response.json({ error: "bad op" }, { status: 400 });
    }
  }
}
