/**
 * Wire and storage types. Everything a replica does is an Op; replicas that
 * have applied the same set of ops, in any order, are in the same state.
 */

/** Identifies one element (a character, a mark, a register write). Lamport time first, replica breaks ties. */
export type Id = { t: number; r: string };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Envelope = {
  /** Replica that created the op. */
  r: string;
  /** Position in that replica's own log, starting at 1 with no gaps. Used for sync. */
  s: number;
  /** Lamport time. Used for ordering and conflict resolution. */
  t: number;
  /** Wall-clock time (ms) when the op was created. For display only: never used to order anything. */
  w?: number;
};

/** Insert the characters of `x` after element `a` (null = start). They take ids (t, r), (t+1, r), … A "\n" starts a new block. */
export type InsOp = Envelope & { k: "ins"; a: Id | null; x: string };

/** Delete runs of consecutive elements: [t, r, length]. */
export type RemOp = Envelope & { k: "rem"; d: [number, string, number][] };

/**
 * Where a formatting range stops. Anchoring to characters instead of
 * positions is what lets a range survive concurrent edits.
 *   before: up to, not including, that character. Text typed at the end of
 *           the range lands before it, so the range grows (bold, italic).
 *   after:  up to and including that character. Text typed right after it
 *           stays outside (links, comments).
 */
export type End = { before: Id } | { after: Id } | "end";

/**
 * Formatting over a range: from the character `from` (inclusive) to `to`.
 * `m` is what is being set ("bold", "link", "comment:<id>") and `v` its
 * value; false or null removes it. Where ranges of the same `m` overlap,
 * the op with the greatest id wins.
 */
export type MarkOp = Envelope & { k: "mark"; m: string; v: Json; from: Id; to: End };

/** Last-writer-wins register write: block attributes, the title, comment threads. */
export type SetOp = Envelope & { k: "set"; o: string; f: string; v: Json };

export type Op = InsOp | RemOp | MarkOp | SetOp;

/** Highest contiguous sequence number seen from each replica. */
export type Vector = Record<string, number>;

/** Total order on ids: Lamport time, then replica id. */
export function compareIds(a: Id, b: Id): number {
  return a.t !== b.t ? a.t - b.t : a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}

/** How many Lamport ticks an op consumes. */
export function span(op: Op): number {
  return op.k === "ins" ? Math.max(1, charCount(op.x)) : 1;
}

/**
 * Text is split by code point, not UTF-16 unit, so an emoji is one element
 * and can never be torn in half by a concurrent edit.
 */
export function chars(s: string): string[] {
  return Array.from(s);
}

export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export const idKey = (id: Id) => `${id.t}@${id.r}`;
