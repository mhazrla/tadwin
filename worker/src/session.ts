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
  };
}

type PushField = "materials" | "audios" | "images";

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

      default:
        return Response.json({ error: "bad op" }, { status: 400 });
    }
  }
}
