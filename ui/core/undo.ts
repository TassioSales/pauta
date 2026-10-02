import type { Doc } from "./doc";
import { chars, type Id, type Json, type MarkOp } from "./types";

/** How to take one local op back. */
type Inverse =
  | { k: "remove"; runs: [number, string, number][] }
  | { k: "insert"; after: Id | null; text: string }
  | { k: "set"; o: string; f: string; v: Json }
  | { k: "mark"; op: MarkOp; v: Json };

type Step = { inverses: Inverse[]; tag?: string; at: number };

/**
 * Undo for a shared document: it takes back what *this* person did, by
 * issuing new ops that cancel theirs, and leaves everyone else's edits
 * alone. An insertion is undone by deleting those exact characters, a
 * deletion by typing them again in the same place.
 */
export class UndoManager {
  private undos: Step[] = [];
  private redos: Step[] = [];
  private capture: Inverse[] | null = null;

  constructor(
    private doc: Doc,
    private now: () => number = Date.now,
  ) {
    doc.onLocal((op, previous) => {
      if (!this.capture) return;
      switch (op.k) {
        case "ins":
          this.capture.push({ k: "remove", runs: [[op.t, op.r, chars(op.x).length]] });
          break;
        case "rem":
          this.capture.push({ k: "insert", after: doc.elementBefore({ t: op.d[0]![0], r: op.d[0]![1] }), text: doc.textOf(op.d) });
          break;
        case "set":
          this.capture.push({ k: "set", o: op.o, f: op.f, v: previous ?? null });
          break;
        case "mark":
          // Comments stay out of the undo history: taking one back by accident loses a conversation.
          if (!op.m.startsWith("comment:")) this.capture.push({ k: "mark", op, v: typeof op.v === "boolean" ? !op.v : null });
          break;
      }
    });
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }

  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  /**
   * Runs an edit and records it as one step. Steps with the same tag made
   * in quick succession (letters typed in a row) are undone together.
   */
  run<T>(edit: () => T, tag?: string): T {
    const [result, inverses] = this.record(edit);
    if (inverses.length === 0) return result;
    const last = this.undos[this.undos.length - 1];
    const at = this.now();
    if (tag && last?.tag === tag && at - last.at < 1000) {
      last.inverses.push(...inverses);
      last.at = at;
    } else {
      this.undos.push({ inverses, tag, at });
      if (this.undos.length > 500) this.undos.shift();
    }
    this.redos = [];
    return result;
  }

  /** Undoes the last step. Returns where the caret should go, or null if there was nothing to undo. */
  undo(): number | null {
    return this.move(this.undos, this.redos);
  }

  redo(): number | null {
    return this.move(this.redos, this.undos);
  }

  private record<T>(edit: () => T): [T, Inverse[]] {
    const inverses: Inverse[] = [];
    this.capture = inverses;
    try {
      return [edit(), inverses];
    } finally {
      this.capture = null;
    }
  }

  private move(from: Step[], to: Step[]): number | null {
    const step = from.pop();
    if (!step) return null;
    let caret = 0;
    // Undoing is itself an edit: what it records is how to redo.
    const [, inverses] = this.record(() => {
      for (const inv of [...step.inverses].reverse()) {
        switch (inv.k) {
          case "remove": {
            const first = inv.runs[0]!;
            caret = Math.max(0, this.doc.position({ t: first[0], r: first[1] }) - 1);
            this.doc.removeRuns(inv.runs);
            caret = Math.min(caret, this.doc.length);
            break;
          }
          case "insert": {
            const op = this.doc.insertAfter(inv.after, inv.text);
            if (op) caret = this.doc.position({ t: op.t + chars(inv.text).length - 1, r: op.r });
            break;
          }
          case "set":
            this.doc.set(inv.o, inv.f, inv.v);
            break;
          case "mark":
            this.doc.remark(inv.op, inv.v);
            break;
        }
      }
    });
    to.push({ inverses, at: 0 });
    return caret;
  }
}
