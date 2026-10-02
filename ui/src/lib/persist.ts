import type { Op } from "../../core";

/** Where a replica keeps its operation log between page loads. */
export interface OpStore {
  /** Every stored op of a document, in the order they were applied. */
  load(doc: string): Promise<Op[]>;
  /** Adds ops. Ops already stored are skipped. */
  append(doc: string, ops: readonly Op[]): Promise<void>;
}

/** Keeps everything in memory: for the lab and for tests. */
export class MemoryStore implements OpStore {
  private docs = new Map<string, Map<string, Op>>();

  async load(doc: string): Promise<Op[]> {
    return [...(this.docs.get(doc)?.values() ?? [])];
  }

  async append(doc: string, ops: readonly Op[]): Promise<void> {
    let log = this.docs.get(doc);
    if (!log) this.docs.set(doc, (log = new Map()));
    for (const op of ops) {
      const k = `${op.r}/${op.s}`;
      if (!log.has(k)) log.set(k, op);
    }
  }
}

type Row = { doc: string; r: string; s: number; op: Op };

/**
 * IndexedDB log. The auto-incremented key preserves application order, which
 * is a causal order, so loading replays cleanly. A unique index on
 * (doc, replica, seq) makes appends idempotent across tabs.
 */
export class IndexedDbStore implements OpStore {
  private db: Promise<IDBDatabase>;

  constructor(name = "pauta") {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const ops = req.result.createObjectStore("ops", { autoIncrement: true });
        ops.createIndex("doc", "doc");
        ops.createIndex("id", ["doc", "r", "s"], { unique: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async load(doc: string): Promise<Op[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      // Same index key for every row, so results come back in primary-key order.
      const req = db.transaction("ops").objectStore("ops").index("doc").getAll(doc);
      req.onsuccess = () => resolve((req.result as Row[]).map((row) => row.op));
      req.onerror = () => reject(req.error);
    });
  }

  async append(doc: string, ops: readonly Op[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("ops", "readwrite");
      const store = tx.objectStore("ops");
      for (const op of ops) {
        const req = store.add({ doc, r: op.r, s: op.s, op } satisfies Row);
        req.onerror = (e) => {
          // Another tab stored it first: fine, keep the transaction alive.
          if (req.error?.name === "ConstraintError") {
            e.preventDefault();
            e.stopPropagation();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}
