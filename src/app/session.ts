// Session auto-save in IndexedDB (project document + media File objects).
import type { ProjectDoc } from "../shared/types";

const DB = "lucid-forensic", VER = 1;
const MAX_MEDIA_BYTES = 768 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv"); if (!db.objectStoreNames.contains("files")) db.createObjectStore("files"); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? (req as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export class Session {
  private db: Promise<IDBDatabase> | null = null;
  private unavailable = false;
  private saved = new Set<string>();
  private conn() {
    if (!this.db) { try { this.db = open(); } catch (e) { this.db = Promise.reject(e); } this.db.catch(() => { this.unavailable = true; }); }
    return this.db;
  }

  async save(project: ProjectDoc, files: Map<string, File[]>) {
    if (this.unavailable) return;
    try {
      const db = await this.conn();
      await tx(db, "kv", "readwrite", (s) => s.put(JSON.parse(JSON.stringify(project)), "project"));
      let total = 0;
      for (const [id, fl] of files) {
        if (!project.sources[id]) continue;
        const size = fl.reduce((a, f) => a + f.size, 0);
        total += size;
        if (this.saved.has(id) || total > MAX_MEDIA_BYTES) continue;
        await tx(db, "files", "readwrite", (s) => s.put(fl, id));
        this.saved.add(id);
      }
    } catch { this.unavailable = true; /* IndexedDB unavailable (private mode / sandboxed context) */ }
  }

  async load(): Promise<{ project: ProjectDoc; files: Map<string, File[]> } | null> {
    if (this.unavailable) return null;
    try {
      const db = await this.conn();
      const project = await tx<ProjectDoc>(db, "kv", "readonly", (s) => s.get("project"));
      if (!project || !project.chains?.length) return null;
      const files = new Map<string, File[]>();
      for (const id of Object.keys(project.sources ?? {})) {
        const fl = await tx<File[]>(db, "files", "readonly", (s) => s.get(id));
        if (fl?.length) { files.set(id, fl); this.saved.add(id); }
      }
      return { project, files };
    } catch { this.unavailable = true; return null; }
  }

  async clear() {
    try {
      const db = await this.conn();
      await tx(db, "kv", "readwrite", (s) => s.clear());
      await tx(db, "files", "readwrite", (s) => s.clear());
      this.saved.clear();
    } catch { /* ignore */ }
  }
}
