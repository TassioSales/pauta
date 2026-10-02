import { Seq } from "./seq";
import { chars, compareIds, idKey, span, type End, type Id, type InsOp, type Json, type MarkOp, type Op, type RemOp, type SetOp, type Vector } from "./types";

export type BlockType = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "todo" | "quote" | "code";
export const BLOCK_TYPES: readonly BlockType[] = ["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code"];

/** The formatting of one stretch of text. */
export type Marks = {
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  link?: string;
  /** Ids of the comment threads attached here. */
  comments?: string[];
};

export type Span = { text: string; marks: Marks };

export type Block = {
  /** Stable name of the block: the id of the line break that opens it. */
  key: string;
  type: BlockType;
  checked: boolean;
  /** Position of the block's first character in the document. */
  start: number;
  /** Characters in the block, not counting the line break that ends it. */
  length: number;
  text: string;
  spans: Span[];
};

/** Formats that keep going when you type at their end. Links and comments don't. */
const GROWS = new Set(["bold", "italic", "strike", "code"]);
const FIRST_BLOCK = "b:0";

type Register = { v: Json; t: number; r: string };

/** What happened when an op was offered to a document. */
export type Applied = "applied" | "duplicate" | "buffered";

/**
 * A replicated rich-text document.
 *
 * Three CRDTs share one operation log:
 *   - the text is a sequence (RGA) of characters, where "\n" opens a block;
 *   - formatting is a set of ranges anchored to characters, in the manner of
 *     Peritext: overlapping ranges of the same kind are settled by op id;
 *   - block types, the title and comment threads are last-writer-wins registers.
 *
 * Local changes return the op to persist and send. Remote ops can arrive in
 * any order, more than once: an op waits in a buffer until what it refers to
 * is in, and replicas that have seen the same ops show the same document.
 */
export class Doc {
  readonly replica: string;
  private clock = 0;
  private seq: Vector = {};
  private text_ = new Seq();
  private marks: MarkOp[] = [];
  private registers = new Map<string, Map<string, Register>>();
  private log: Op[] = [];
  private waiting: Op[] = [];
  private listeners = new Set<() => void>();
  private localListeners = new Set<(op: Op, previous?: Json) => void>();
  private rev = 0;
  private cache: { rev: number; blocks: Block[] } | null = null;

  /** @param now  Wall clock used to date local ops (shown in the history, never used for ordering). */
  constructor(
    replica: string,
    private now: () => number = Date.now,
  ) {
    if (!replica) throw new Error("doc: replica id is required");
    this.replica = replica;
  }

  /** A read-only reconstruction of a document from a prefix of someone's history. */
  static replay(ops: readonly Op[]): Doc {
    const doc = new Doc("@replay");
    doc.apply(ops);
    return doc;
  }

  // ---- reading -----------------------------------------------------------

  /** Visible characters, line breaks included. */
  get length(): number {
    return this.text_.length;
  }

  /**
   * The document as blocks of formatted spans. Computed once per revision
   * by a single sweep over the sequence: formatting ranges open and close
   * at element indexes, and at each character the winner of every kind of
   * mark is the covering op with the greatest id.
   */
  blocks(): Block[] {
    if (this.cache?.rev === this.rev) return this.cache.blocks;

    const at = new Map<string, number>();
    let i = 0;
    for (const el of this.text_.elements()) at.set(idKey(el.id), i++);
    const opens = new Map<number, MarkOp[]>();
    const closes = new Map<number, MarkOp[]>();
    for (const m of this.marks) {
      const from = at.get(idKey(m.from))!;
      const to = m.to === "end" ? Infinity : "before" in m.to ? at.get(idKey(m.to.before))! : at.get(idKey(m.to.after))! + 1;
      if (to <= from) continue;
      push(opens, from, m);
      if (to !== Infinity) push(closes, to, m);
    }

    const blocks: Block[] = [];
    const open = (key: string, start: number): Block => ({ key, type: this.blockType(key), checked: this.get(key, "checked") === true, start, length: 0, text: "", spans: [] });
    let block = open(FIRST_BLOCK, 0);
    const active = new Map<string, MarkOp[]>();
    let current: Marks = {};
    let dirty = false;
    let pos = 0;
    i = 0;
    for (const el of this.text_.elements()) {
      for (const m of closes.get(i) ?? []) {
        const list = active.get(m.m)!;
        list.splice(list.indexOf(m), 1);
        dirty = true;
      }
      for (const m of opens.get(i) ?? []) {
        push(active, m.m, m);
        dirty = true;
      }
      i++;
      if (el.deleted) continue;
      if (el.ch === "\n") {
        blocks.push(block);
        block = open(`b:${idKey(el.id)}`, ++pos);
        continue;
      }
      if (dirty) {
        const next = resolve(active);
        // Keep the same object when nothing visible changed, so the characters join one span.
        if (!sameMarks(next, current)) current = next;
        dirty = false;
      }
      const last = block.spans[block.spans.length - 1];
      if (last && last.marks === current) last.text += el.ch;
      else block.spans.push({ text: el.ch, marks: current });
      block.text += el.ch;
      block.length++;
      pos++;
    }
    blocks.push(block);
    this.cache = { rev: this.rev, blocks };
    return blocks;
  }

  /** The whole text, blocks separated by "\n". */
  text(): string {
    return this.blocks()
      .map((b) => b.text)
      .join("\n");
  }

  /** The block that contains caret position `pos`, and its index. */
  blockAt(pos: number): { block: Block; index: number } {
    const blocks = this.blocks();
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.start <= pos) return { block: blocks[i]!, index: i };
    return { block: blocks[0]!, index: 0 };
  }

  /** Formatting of the character at `pos` ({} for a line break or past the end). */
  marksAt(pos: number): Marks {
    const { block } = this.blockAt(pos);
    let offset = pos - block.start;
    for (const s of block.spans) {
      const n = chars(s.text).length;
      if (offset < n) return s.marks;
      offset -= n;
    }
    return {};
  }

  /** Value of a register, or undefined if it was never set. */
  get(object: string, field: string): Json | undefined {
    return this.registers.get(object)?.get(field)?.v;
  }

  /** Every field of an object. */
  fields(object: string): [string, Json][] {
    return [...(this.registers.get(object) ?? [])].map(([f, reg]) => [f, reg.v]);
  }

  /** Ids of every object that has at least one register. */
  objects(): string[] {
    return [...this.registers.keys()];
  }

  /**
   * A stable reference to caret position `pos`: the id of the character
   * before it. Unlike an index, it still points at the same place after
   * other replicas insert or delete text around it.
   */
  anchor(pos: number): Id | null {
    return this.text_.idBefore(Math.max(0, Math.min(pos, this.text_.length)));
  }

  /** Where an anchor is now, as a caret position. */
  position(anchor: Id | null): number {
    return this.text_.positionAfter(anchor);
  }

  /** Highest contiguous sequence number applied from each replica. */
  vector(): Vector {
    return { ...this.seq };
  }

  /** Changes on every applied op; cheap way to know something moved. */
  get revision(): number {
    return this.rev;
  }

  /** Ops applied here that a peer with `theirs` hasn't seen, in an order it can apply. */
  opsSince(theirs: Vector): Op[] {
    return this.log.filter((op) => op.s > (theirs[op.r] ?? 0));
  }

  /** Every applied op, in application order. */
  history(): readonly Op[] {
    return this.log;
  }

  /** Ops received but still waiting for a dependency. */
  get buffered(): number {
    return this.waiting.length;
  }

  stats() {
    return { ops: this.log.length, characters: this.text_.length, tombstones: this.text_.size - this.text_.length, marks: this.marks.length, clock: this.clock, buffered: this.waiting.length };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Called with every op created here, so it can be persisted and sent. For
   * a register write, `previous` is the value it replaced.
   */
  onLocal(listener: (op: Op, previous?: Json) => void): () => void {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }

  // ---- local changes -----------------------------------------------------

  /** Inserts text at a caret position. */
  insert(pos: number, text: string): InsOp | null {
    if (text === "") return null;
    const op: InsOp = { k: "ins", ...this.stamp(), a: this.text_.idBefore(Math.max(0, Math.min(pos, this.text_.length))), x: text };
    this.commit(op);
    return op;
  }

  /** Inserts text right after an element, wherever that element is now. Used to undo a deletion. */
  insertAfter(after: Id | null, text: string): InsOp | null {
    if (text === "") return null;
    const op: InsOp = { k: "ins", ...this.stamp(), a: after, x: text };
    this.commit(op);
    return op;
  }

  /** Deletes `len` characters starting at `pos`. */
  remove(pos: number, len: number): RemOp | null {
    len = Math.min(len, this.text_.length - pos);
    if (len <= 0) return null;
    return this.removeRuns(this.text_.runs(pos, len));
  }

  /** Deletes specific characters by id. Used to undo an insertion. */
  removeRuns(runs: [number, string, number][]): RemOp | null {
    if (runs.length === 0) return null;
    const op: RemOp = { k: "rem", ...this.stamp(), d: runs };
    this.commit(op);
    return op;
  }

  /**
   * Formats the characters in [from, to). The range is stored as anchors to
   * the characters at its ends, so it follows them through later edits.
   */
  mark(from: number, to: number, kind: string, value: Json): MarkOp | null {
    to = Math.min(to, this.text_.length);
    if (to <= from) return null;
    const last = this.text_.idAt(to - 1);
    let end: End = { after: last };
    if (GROWS.has(kind)) {
      const next = this.text_.after(last);
      end = next ? { before: next } : "end";
    }
    const op: MarkOp = { k: "mark", ...this.stamp(), m: kind, v: value, from: this.text_.idAt(from), to: end };
    this.commit(op);
    return op;
  }

  /** Formats the same range as an earlier mark with another value. Used to undo it. */
  remark(earlier: MarkOp, value: Json): MarkOp {
    const op: MarkOp = { k: "mark", ...this.stamp(), m: earlier.m, v: value, from: earlier.from, to: earlier.to };
    this.commit(op);
    return op;
  }

  /** Writes a register. */
  set(object: string, field: string, value: Json): SetOp {
    const op: SetOp = { k: "set", ...this.stamp(), o: object, f: field, v: value };
    this.commit(op, this.get(object, field) ?? null);
    return op;
  }

  // ---- for undo ----------------------------------------------------------

  /** The text of removed (or live) characters, by id. */
  textOf(runs: [number, string, number][]): string {
    let out = "";
    for (const [t, r, n] of runs) for (let i = 0; i < n; i++) out += this.text_.charOf({ t: t + i, r });
    return out;
  }

  /** The element before `id` in the sequence, tombstones included. */
  elementBefore(id: Id): Id | null {
    return this.text_.before(id);
  }

  // ---- remote ops --------------------------------------------------------

  /**
   * Offers ops from elsewhere. Returns the ones that were newly applied (in
   * application order), including ops released from the buffer.
   */
  apply(ops: Op | readonly Op[]): Op[] {
    const applied: Op[] = [];
    for (const op of Array.isArray(ops) ? ops : [ops as Op]) {
      if (this.offer(op) === "applied") applied.push(op);
    }
    // Something new may have unblocked ops that were waiting.
    for (let progress = applied.length > 0; progress && this.waiting.length > 0; ) {
      progress = false;
      const still: Op[] = [];
      for (const op of this.waiting) {
        const result = this.tryApply(op);
        if (result === "applied") {
          applied.push(op);
          progress = true;
        } else if (result === "buffered") still.push(op);
      }
      this.waiting = still;
    }
    if (applied.length > 0) this.notify();
    return applied;
  }

  private offer(op: Op): Applied {
    const result = this.tryApply(op);
    if (result === "buffered" && !this.waiting.some((w) => w.r === op.r && w.s === op.s)) this.waiting.push(op);
    return result;
  }

  private tryApply(op: Op): Applied {
    const seen = this.seq[op.r] ?? 0;
    if (op.s <= seen) return "duplicate";
    if (op.s > seen + 1) return "buffered"; // an earlier op of this replica is missing
    if (!this.ready(op)) return "buffered";
    this.integrate(op);
    return "applied";
  }

  /** True when everything the op refers to is already here. */
  private ready(op: Op): boolean {
    switch (op.k) {
      case "ins":
        return op.a === null || this.text_.has(op.a);
      case "rem":
        // A replica's ops arrive in order, so if the last id of a run is here the rest are too.
        return op.d.every(([t, r, n]) => this.text_.has({ t: t + n - 1, r }));
      case "mark":
        return this.text_.has(op.from) && (op.to === "end" || this.text_.has("before" in op.to ? op.to.before : op.to.after));
      case "set":
        return true;
    }
  }

  // ---- internals ---------------------------------------------------------

  private blockType(key: string): BlockType {
    const v = this.get(key, "type");
    return BLOCK_TYPES.includes(v as BlockType) ? (v as BlockType) : "p";
  }

  /** Envelope for the next local op. The clock itself advances in integrate(). */
  private stamp() {
    return { r: this.replica, s: (this.seq[this.replica] ?? 0) + 1, t: this.clock + 1, w: this.now() };
  }

  private commit(op: Op, previous?: Json): void {
    this.integrate(op);
    for (const l of this.localListeners) l(op, previous);
    this.notify();
  }

  private integrate(op: Op): void {
    switch (op.k) {
      case "ins":
        this.text_.insert(op.a, { t: op.t, r: op.r }, chars(op.x));
        break;
      case "rem":
        for (const [t, r, n] of op.d) this.text_.remove(t, r, n);
        break;
      case "mark":
        this.marks.push(op);
        break;
      case "set": {
        let fields = this.registers.get(op.o);
        if (!fields) this.registers.set(op.o, (fields = new Map()));
        const cur = fields.get(op.f);
        if (!cur || compareIds(op, cur) > 0) fields.set(op.f, { v: op.v, t: op.t, r: op.r });
        break;
      }
    }
    this.seq[op.r] = op.s;
    this.clock = Math.max(this.clock, op.t + span(op) - 1);
    this.log.push(op);
    this.rev++;
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The visible formatting given the ranges covering a character: per kind, the greatest id wins. */
function resolve(active: Map<string, MarkOp[]>): Marks {
  const winner = (kind: string): Json => {
    const list = active.get(kind);
    if (!list?.length) return null;
    let win = list[0]!;
    for (const m of list) if (compareIds(m, win) > 0) win = m;
    return win.v;
  };
  // Fields are filled in a fixed order, so equal formatting is equal JSON on every replica.
  const out: Marks = {};
  for (const kind of ["bold", "italic", "strike", "code"] as const) if (winner(kind) === true) out[kind] = true;
  const link = winner("link");
  if (typeof link === "string" && link) out.link = link;
  const comments = [...active.keys()].filter((k) => k.startsWith("comment:") && winner(k) === true).map((k) => k.slice(8));
  if (comments.length) out.comments = comments.sort();
  return out;
}

function sameMarks(a: Marks, b: Marks): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link && (a.comments ?? []).join() === (b.comments ?? []).join();
}

/** The register object that holds a block's attributes. */
export const blockObject = (id: Id) => `b:${idKey(id)}`;
