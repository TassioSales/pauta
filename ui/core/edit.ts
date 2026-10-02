/**
 * The editing commands, as functions over a document and a selection. The
 * editor view only translates keystrokes into these, so everything that
 * decides what the text becomes can be tested without a browser.
 */
import { blockObject, type Block, type BlockType, type Doc } from "./doc";
import { chars } from "./types";

/** A selection in caret positions. anchor is where it started, head where the caret is. */
export type Sel = { anchor: number; head: number };

export const caret = (pos: number): Sel => ({ anchor: pos, head: pos });
export const lo = (s: Sel) => Math.min(s.anchor, s.head);
export const hi = (s: Sel) => Math.max(s.anchor, s.head);

export type Inline = "bold" | "italic" | "strike" | "code";
export const INLINE: readonly Inline[] = ["bold", "italic", "strike", "code"];

/** Formats switched on or off with nothing selected: they apply to what is typed next. */
export type Pending = Partial<Record<Inline, boolean>>;

/** Blocks that continue on Enter: a new list item, another line of code. */
const STICKY = new Set<BlockType>(["ul", "ol", "todo", "quote", "code"]);

/** What typing a prefix and a space turns a paragraph into. */
const SHORTCUTS: Record<string, BlockType> = { "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "1.": "ol", ">": "quote", "[]": "todo", "```": "code" };

function clear(doc: Doc, sel: Sel): number {
  if (sel.anchor !== sel.head) doc.remove(lo(sel), hi(sel) - lo(sel));
  return lo(sel);
}

function setType(doc: Doc, key: string, type: BlockType): void {
  if ((doc.get(key, "type") ?? "p") !== type) doc.set(key, "type", type);
}

/** Types or pastes text over the selection. */
export function typeText(doc: Doc, sel: Sel, input: string, pending: Pending = {}): Sel {
  const text = input.replace(/\r\n?/g, "\n");
  const pos = clear(doc, sel);
  const { block } = doc.blockAt(pos);

  if (text === " " && block.type === "p") {
    const type = SHORTCUTS[block.text];
    if (type && pos === block.start + block.length) {
      doc.remove(block.start, block.length);
      setType(doc, block.key, type);
      return caret(block.start);
    }
  }

  const n = chars(text).length;
  if (n === 0) return caret(pos);
  // The formatting the new text lands in, before any pending toggle.
  const before = pos > block.start ? doc.marksAt(pos - 1) : {};
  doc.insert(pos, text);
  for (const kind of INLINE) {
    const want = pending[kind];
    if (want !== undefined && want !== !!before[kind]) doc.mark(pos, pos + n, kind, want);
  }
  return caret(pos + n);
}

/** Enter: splits the block. */
export function enter(doc: Doc, sel: Sel): Sel {
  const pos = clear(doc, sel);
  const { block } = doc.blockAt(pos);
  const sticky = STICKY.has(block.type);
  // Enter on an empty list item leaves the list.
  if (block.length === 0 && block.type !== "p") {
    setType(doc, block.key, "p");
    return caret(pos);
  }
  const op = doc.insert(pos, "\n")!;
  const lower = blockObject({ t: op.t, r: op.r });
  if (pos === block.start && !sticky) {
    // Enter at the start of a heading pushes the heading down, leaving a plain line above.
    setType(doc, lower, block.type);
    setType(doc, block.key, "p");
  } else if (sticky) {
    setType(doc, lower, block.type);
  }
  return caret(pos + 1);
}

/** Backspace. At the start of a block it first removes the block's type, then joins it to the one above. */
export function backspace(doc: Doc, sel: Sel): Sel {
  if (sel.anchor !== sel.head) return caret(clear(doc, sel));
  const pos = sel.head;
  const { block } = doc.blockAt(pos);
  if (pos === block.start && block.type !== "p") {
    setType(doc, block.key, "p");
    return caret(pos);
  }
  if (pos === 0) return caret(0);
  doc.remove(pos - 1, 1);
  return caret(pos - 1);
}

/** Delete (forward). */
export function del(doc: Doc, sel: Sel): Sel {
  if (sel.anchor !== sel.head) return caret(clear(doc, sel));
  doc.remove(sel.head, 1);
  return caret(sel.head);
}

/** Ctrl+Backspace / Ctrl+Delete: removes up to the edge of the word. */
export function deleteWord(doc: Doc, sel: Sel, direction: "back" | "forward"): Sel {
  if (sel.anchor !== sel.head) return caret(clear(doc, sel));
  const pos = sel.head;
  const { block } = doc.blockAt(pos);
  const text = chars(block.text);
  let at = pos - block.start;
  if (direction === "back") {
    if (at === 0) return backspace(doc, sel);
    const end = at;
    while (at > 0 && /\s/.test(text[at - 1]!)) at--;
    while (at > 0 && !/\s/.test(text[at - 1]!)) at--;
    doc.remove(block.start + at, end - at);
    return caret(block.start + at);
  }
  if (at === text.length) return del(doc, sel);
  const start = at;
  while (at < text.length && /\s/.test(text[at]!)) at++;
  while (at < text.length && !/\s/.test(text[at]!)) at++;
  doc.remove(pos, at - start);
  return caret(pos);
}

/** True when every character in [from, to) has the format (line breaks don't count). */
export function rangeHas(doc: Doc, from: number, to: number, kind: Inline | "link"): boolean {
  let any = false;
  for (const b of doc.blocks()) {
    let pos = b.start;
    for (const s of b.spans) {
      const n = chars(s.text).length;
      if (pos < to && pos + n > from) {
        if (!s.marks[kind]) return false;
        any = true;
      }
      pos += n;
    }
  }
  return any;
}

/** Ctrl+B and friends over a selection: on, unless all of it already is. */
export function toggleMark(doc: Doc, sel: Sel, kind: Inline): boolean {
  if (sel.anchor === sel.head) return false;
  const on = !rangeHas(doc, lo(sel), hi(sel), kind);
  doc.mark(lo(sel), hi(sel), kind, on);
  return on;
}

/** Links the selection to `url`, or unlinks it with null. */
export function setLink(doc: Doc, sel: Sel, url: string | null): void {
  if (sel.anchor !== sel.head) doc.mark(lo(sel), hi(sel), "link", url);
}

/** The blocks a selection touches. */
export function blocksIn(doc: Doc, sel: Sel): Block[] {
  return doc.blocks().filter((b) => b.start <= hi(sel) && b.start + b.length >= lo(sel));
}

/** Turns the selected blocks into `type`, or back into paragraphs if they all are already. */
export function setBlockType(doc: Doc, sel: Sel, type: BlockType): void {
  const blocks = blocksIn(doc, sel);
  const target = blocks.every((b) => b.type === type) ? "p" : type;
  for (const b of blocks) setType(doc, b.key, target);
}

export function toggleTodo(doc: Doc, key: string): void {
  doc.set(key, "checked", doc.get(key, "checked") !== true);
}
