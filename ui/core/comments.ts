/**
 * Comment threads. A thread is anchored to text by a formatting range of
 * its own kind ("comment:<id>"), so it follows the words it is about
 * through any edit; what was said lives in registers under "c:<id>".
 */
import type { Doc } from "./doc";
import { chars, type Json } from "./types";

export type Reply = { id: string; author: string; color: string; body: string; at: number };

export type Thread = Reply & {
  resolved: boolean;
  replies: Reply[];
  /** The text the thread is attached to, as it reads now. Empty if it was all deleted. */
  quote: string;
  /** Where the quoted text starts, or null if it is gone. */
  from: number | null;
  to: number | null;
};

export type Author = { name: string; color: string };

const str = (v: Json | undefined) => (typeof v === "string" ? v : "");
const num = (v: Json | undefined) => (typeof v === "number" ? v : 0);

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
}

/** Starts a thread on [from, to). */
export function addThread(doc: Doc, from: number, to: number, author: Author, body: string, now = Date.now()): string | null {
  const id = newId();
  if (!doc.mark(from, to, `comment:${id}`, true)) return null;
  const o = `c:${id}`;
  doc.set(o, "author", author.name);
  doc.set(o, "color", author.color);
  doc.set(o, "body", body);
  doc.set(o, "at", now);
  return id;
}

/** Each reply is a register of its own, so two people replying at once both keep theirs. */
export function addReply(doc: Doc, thread: string, author: Author, body: string, now = Date.now()): void {
  doc.set(`c:${thread}`, `reply:${newId()}`, { author: author.name, color: author.color, body, at: now });
}

export function setResolved(doc: Doc, thread: string, resolved: boolean): void {
  doc.set(`c:${thread}`, "resolved", resolved);
}

/** Every thread, in the order their text appears; threads whose text is gone come last. */
export function threads(doc: Doc): Thread[] {
  const where = new Map<string, { from: number; to: number; quote: string }>();
  for (const b of doc.blocks()) {
    let pos = b.start;
    for (const s of b.spans) {
      const n = chars(s.text).length;
      for (const id of s.marks.comments ?? []) {
        const cur = where.get(id);
        if (cur) {
          cur.quote += (cur.to === pos ? "" : " ") + s.text;
          cur.to = pos + n;
        } else where.set(id, { from: pos, to: pos + n, quote: s.text });
      }
      pos += n;
    }
  }

  const out: Thread[] = [];
  for (const o of doc.objects()) {
    if (!o.startsWith("c:") || doc.get(o, "body") === undefined) continue;
    const id = o.slice(2);
    const replies: Reply[] = [];
    for (const [f, v] of doc.fields(o)) {
      if (!f.startsWith("reply:") || !v || typeof v !== "object" || Array.isArray(v)) continue;
      replies.push({ id: f.slice(6), author: str(v.author), color: str(v.color), body: str(v.body), at: num(v.at) });
    }
    replies.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const w = where.get(id);
    out.push({
      id,
      author: str(doc.get(o, "author")),
      color: str(doc.get(o, "color")),
      body: str(doc.get(o, "body")),
      at: num(doc.get(o, "at")),
      resolved: doc.get(o, "resolved") === true,
      replies,
      quote: w?.quote ?? "",
      from: w?.from ?? null,
      to: w?.to ?? null,
    });
  }
  return out.sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity) || a.at - b.at || (a.id < b.id ? -1 : 1));
}
