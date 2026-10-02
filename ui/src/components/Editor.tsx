import clsx from "clsx";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { backspace, caret, charCount, chars, del, deleteWord, enter, toggleMark, toggleTodo, typeText, type Block, type Doc, type Id, type Inline, type Pending, type Sel, type Span, type UndoManager } from "../../core";
import { useRevision } from "../lib/hooks";

export type RemoteCursor = { id: number; name: string; color: string; anchor: Id | null; head: Id | null };

export type EditorHandle = {
  focus: () => void;
  selection: () => Sel;
  select: (sel: Sel) => void;
  /** Runs an edit as one undo step and moves the selection to what it returns. */
  exec: (edit: (doc: Doc, sel: Sel) => Sel | void, tag?: string) => void;
  /** Bold, italic…: formats the selection, or what is typed next if nothing is selected. */
  toggle: (kind: Inline) => void;
  undo: () => void;
  redo: () => void;
};

type Props = {
  doc: Doc;
  undo: UndoManager;
  readOnly?: boolean;
  placeholder?: string;
  peers?: RemoteCursor[];
  /** Comment threads that shouldn't be highlighted (resolved ones). */
  hidden?: ReadonlySet<string>;
  activeThread?: string | null;
  onSelect?: (sel: Sel, pending: Pending) => void;
  onThread?: (id: string) => void;
  onLink?: () => void;
};

// ---- rendering --------------------------------------------------------------

const safeHref = (url: string) => (/^(https?:|mailto:)/i.test(url) ? url : `https://${url}`);

function SpanView({ span, hidden, active }: { span: Span; hidden?: ReadonlySet<string>; active?: string | null }) {
  const m = span.marks;
  const threads = (m.comments ?? []).filter((id) => !hidden?.has(id));
  const className = clsx(m.bold && "b", m.italic && "i", m.strike && "s", m.code && "c", threads.length > 0 && "cm", active && threads.includes(active) && "on") || undefined;
  const thread = threads.includes(active ?? "") ? active! : threads[0];
  if (m.link) {
    return (
      <a href={safeHref(m.link)} target="_blank" rel="noopener noreferrer" className={className} data-thread={thread} title={`${m.link} (Ctrl+clique para abrir)`}>
        {span.text}
      </a>
    );
  }
  return (
    <span className={className} data-thread={thread}>
      {span.text}
    </span>
  );
}

/** The document as DOM. Shared by the editor, the history view and the lab. */
export function Blocks({ blocks, hidden, active, placeholder, onTodo }: { blocks: Block[]; hidden?: ReadonlySet<string>; active?: string | null; placeholder?: string; onTodo?: (key: string) => void }) {
  let number = 0;
  return blocks.map((b, i) => {
    number = b.type === "ol" ? number + 1 : 0;
    const code = b.type === "code";
    return (
      <div key={b.key} data-key={b.key} data-n={number || undefined} className={clsx("blk", b.type, b.type === "todo" && b.checked && "done", code && blocks[i - 1]?.type !== "code" && "first", code && blocks[i + 1]?.type !== "code" && "last")}>
        {b.type === "todo" && (
          <span
            className="box"
            contentEditable={false}
            role="checkbox"
            aria-checked={b.checked}
            onMouseDown={(e) => {
              e.preventDefault();
              onTodo?.(b.key);
            }}
          />
        )}
        <span data-content data-placeholder={i === 0 ? placeholder : undefined}>
          {b.spans.length ? b.spans.map((s, j) => <SpanView key={j} span={s} hidden={hidden} active={active} />) : <br />}
        </span>
      </div>
    );
  });
}

// ---- positions <-> DOM ------------------------------------------------------

/** UTF-16 offset of the n-th code point of a string. */
function unitOffset(text: string, n: number): number {
  let units = 0;
  for (const ch of text) {
    if (n-- <= 0) break;
    units += ch.length;
  }
  return units;
}

function blockOf(root: HTMLElement, node: Node): HTMLElement | null {
  const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(".blk") ?? null;
  return el && root.contains(el) ? el : null;
}

/** A DOM point as a caret position in the document. */
function toPos(root: HTMLElement, doc: Doc, node: Node, offset: number): number | null {
  let el = blockOf(root, node);
  if (!el && node === root) {
    // The point is between blocks: take the start of the next one, or the end of the document.
    el = (root.children[offset] as HTMLElement | undefined) ?? null;
    if (!el) return doc.length;
    offset = 0;
    node = el;
  }
  if (!el) return null;
  const block = doc.blocks().find((b) => b.key === el.dataset.key);
  const content = el.querySelector("[data-content]");
  if (!block || !content) return null;
  const range = document.createRange();
  range.selectNodeContents(content);
  if (content.contains(node)) range.setEnd(node, offset);
  else if (node === el) {
    // Between the block's children: before the text, or after it.
    if (offset <= [...el.childNodes].indexOf(content)) range.collapse(true);
  } else range.collapse(true); // inside the checkbox of a task
  return block.start + Math.min(block.length, charCount(range.toString()));
}

/** A caret position as a DOM point. */
function toDom(root: HTMLElement, doc: Doc, pos: number): [Node, number] | null {
  const { block } = doc.blockAt(Math.max(0, Math.min(pos, doc.length)));
  const content = root.querySelector(`[data-key="${CSS.escape(block.key)}"] [data-content]`);
  if (!content) return null;
  let left = pos - block.start;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const count = charCount(n.data);
    // A position between two spans belongs to the end of the first: what is typed there continues it.
    if (left <= count) return [n, unitOffset(n.data, left)];
    left -= count;
    last = n;
  }
  return last ? [last, last.data.length] : [content, 0];
}

type Rect = { left: number; top: number; width: number; height: number };
type Drawn = { id: number; name: string; color: string; caret: Rect | null; boxes: Rect[] };

// ---- the editor -------------------------------------------------------------

/**
 * A contenteditable that the browser is never allowed to edit. Every
 * keystroke arrives as a `beforeinput` event, is cancelled, and becomes a
 * command on the CRDT; React then redraws from the document and the
 * selection is put back. The DOM is always a function of the document, so
 * a remote edit and a local one go through exactly the same path.
 *
 * The exception is text composition (accents typed with dead keys, IMEs),
 * which can't be cancelled: the browser edits the DOM, and when it is done
 * the block is compared with the document and the difference applied.
 */
export const Editor = forwardRef<EditorHandle, Props>(function Editor({ doc, undo, readOnly, placeholder, peers, hidden, activeThread, onSelect, onThread, onLink }, ref) {
  const rev = useRevision(doc);
  const wrap = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // The selection is kept as ids of characters, so it stays put when others type before it.
  const anchors = useRef<{ anchor: Id | null; head: Id | null }>({ anchor: null, head: null });
  const pending = useRef<{ marks: Pending; at: number }>({ marks: {}, at: -1 });
  const composing = useRef(false);
  const refocus = useRef(false);
  const [tick, setTick] = useState(0);
  // Bumped when the browser changed the DOM by itself, to rebuild it from the document.
  const [nonce, setNonce] = useState(0);
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const blocks = doc.blocks();

  const modelSel = useCallback((): Sel => ({ anchor: doc.position(anchors.current.anchor), head: doc.position(anchors.current.head) }), [doc]);

  const readSel = useCallback((): Sel | null => {
    const s = window.getSelection();
    const el = root.current;
    if (!el || !s || !s.anchorNode || !s.focusNode || !el.contains(s.anchorNode)) return null;
    const a = toPos(el, doc, s.anchorNode, s.anchorOffset);
    const h = toPos(el, doc, s.focusNode, s.focusOffset);
    return a === null || h === null ? null : { anchor: a, head: h };
  }, [doc]);

  const select = useCallback(
    (sel: Sel, keepPending = false) => {
      anchors.current = { anchor: doc.anchor(sel.anchor), head: doc.anchor(sel.head) };
      if (keepPending) pending.current.at = sel.head;
      else if (pending.current.at !== sel.head || sel.anchor !== sel.head) pending.current = { marks: {}, at: -1 };
      setTick((t) => t + 1);
      onSelect?.(sel, pending.current.marks);
    },
    [doc, onSelect],
  );

  const current = useCallback((): Sel => readSel() ?? modelSel(), [readSel, modelSel]);

  const exec = useCallback(
    (edit: (doc: Doc, sel: Sel) => Sel | void, tag?: string) => {
      const next = undo.run(() => edit(doc, current()), tag);
      if (next) select(next, tag === "type");
    },
    [doc, undo, current, select],
  );

  const toggle = useCallback(
    (kind: Inline) => {
      const sel = current();
      if (sel.anchor !== sel.head) {
        exec((d, s) => {
          toggleMark(d, s, kind);
          return s;
        });
        return;
      }
      // Nothing selected: the format applies to what is typed next.
      const { block } = doc.blockAt(sel.head);
      const here = sel.head > block.start ? !!doc.marksAt(sel.head - 1)[kind] : false;
      const marks = pending.current.at === sel.head ? pending.current.marks : {};
      pending.current = { marks: { ...marks, [kind]: !(marks[kind] ?? here) }, at: sel.head };
      onSelect?.(sel, pending.current.marks);
    },
    [doc, current, exec, onSelect],
  );

  const stepBack = useCallback(() => {
    const pos = undo.undo();
    if (pos !== null) select(caret(pos));
  }, [undo, select]);
  const stepForward = useCallback(() => {
    const pos = undo.redo();
    if (pos !== null) select(caret(pos));
  }, [undo, select]);

  const focus = useCallback(() => {
    const el = root.current;
    if (!el) return;
    // Focusing would drop the caret at the start: put it back where it was.
    const want = modelSel();
    el.focus({ preventScroll: true });
    const a = toDom(el, doc, want.anchor);
    const h = toDom(el, doc, want.head);
    if (a && h) window.getSelection()?.setBaseAndExtent(a[0], a[1], h[0], h[1]);
  }, [doc, modelSel]);

  useImperativeHandle(ref, () => ({ focus, selection: current, select, exec, toggle, undo: stepBack, redo: stepForward }), [focus, current, select, exec, toggle, stepBack, stepForward]);

  /** Applies to the document whatever the browser changed in a block's DOM. */
  const reconcile = useCallback(() => {
    const el = root.current;
    const s = window.getSelection();
    const blockEl = el && s?.anchorNode ? blockOf(el, s.anchorNode) : null;
    const block = blockEl && doc.blocks().find((b) => b.key === blockEl.dataset.key);
    if (!blockEl || !block) {
      refocus.current = document.activeElement === el;
      setNonce((n) => n + 1);
      return;
    }
    const before = chars(block.text);
    const after = chars(blockEl.querySelector("[data-content]")?.textContent ?? "");
    let same = 0;
    while (same < before.length && same < after.length && before[same] === after[same]) same++;
    let tail = 0;
    while (tail < before.length - same && tail < after.length - same && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const removed = before.length - same - tail;
    const inserted = after.slice(same, after.length - tail).join("");
    if (removed === 0 && !inserted) return;
    const at = block.start + same;
    // The DOM is rebuilt below, which takes the focus with it.
    refocus.current = document.activeElement === el;
    undo.run(() => {
      if (removed > 0) doc.remove(at, removed);
      if (inserted) typeText(doc, caret(at), inserted, pending.current.at === at ? pending.current.marks : {});
    }, "type");
    setNonce((n) => n + 1);
    select(caret(at + charCount(inserted)), true);
  }, [doc, undo, select]);

  // Native listeners: React's onBeforeInput is a synthetic event without inputType.
  useEffect(() => {
    const el = root.current;
    if (!el || readOnly) return;

    const beforeInput = (e: InputEvent) => {
      if (e.inputType === "insertCompositionText" || composing.current) return;
      e.preventDefault();
      const marks = () => (pending.current.at === current().head ? pending.current.marks : {});
      const text = () => e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
      switch (e.inputType) {
        case "insertText":
          exec((d, s) => typeText(d, s, e.data ?? "", marks()), e.data === " " ? undefined : "type");
          break;
        case "insertReplacementText": {
          // A spelling correction: the browser says which range it replaces.
          const target = e.getTargetRanges()[0];
          const from = target && toPos(el, doc, target.startContainer, target.startOffset);
          const to = target && toPos(el, doc, target.endContainer, target.endOffset);
          exec((d, s) => typeText(d, from != null && to != null ? { anchor: from, head: to } : s, text()));
          break;
        }
        case "insertFromPaste":
        case "insertFromDrop":
        case "insertFromYank":
          exec((d, s) => typeText(d, s, text()));
          break;
        case "insertParagraph":
        case "insertLineBreak":
          exec(enter);
          break;
        case "deleteContentBackward":
          exec(backspace, "erase");
          break;
        case "deleteContentForward":
          exec(del, "erase");
          break;
        case "deleteWordBackward":
          exec((d, s) => deleteWord(d, s, "back"));
          break;
        case "deleteWordForward":
          exec((d, s) => deleteWord(d, s, "forward"));
          break;
        case "deleteSoftLineBackward":
        case "deleteHardLineBackward":
          exec((d, s) => (s.anchor !== s.head ? backspace(d, s) : backspace(d, { anchor: d.blockAt(s.head).block.start, head: s.head })));
          break;
        case "deleteByCut":
        case "deleteByDrag":
        case "deleteContent":
          exec((d, s) => (s.anchor === s.head ? s : backspace(d, s)));
          break;
        case "formatBold":
          toggle("bold");
          break;
        case "formatItalic":
          toggle("italic");
          break;
        case "formatStrikeThrough":
          toggle("strike");
          break;
        case "historyUndo":
          stepBack();
          break;
        case "historyRedo":
          stepForward();
          break;
      }
    };

    const keyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (mod && !e.altKey) {
        if (key === "b") return run(() => toggle("bold"));
        if (key === "i") return run(() => toggle("italic"));
        if (key === "e") return run(() => toggle("code"));
        if (key === "x" && e.shiftKey) return run(() => toggle("strike"));
        if (key === "z") return run(e.shiftKey ? stepForward : stepBack);
        if (key === "y") return run(stepForward);
        if (key === "k" && onLink) return run(onLink);
      }
      if (e.key === "Tab" && !mod && doc.blockAt(current().head).block.type === "code") run(() => exec((d, s) => typeText(d, s, "  ")));
    };

    const compositionStart = () => (composing.current = true);
    const compositionEnd = () => {
      composing.current = false;
      reconcile();
    };
    // A change the browser made anyway (an input type that can't be cancelled): bring the document up to date.
    const input = () => !composing.current && reconcile();
    const dragStart = (e: DragEvent) => e.preventDefault();

    el.addEventListener("beforeinput", beforeInput);
    el.addEventListener("keydown", keyDown);
    el.addEventListener("compositionstart", compositionStart);
    el.addEventListener("compositionend", compositionEnd);
    el.addEventListener("input", input);
    el.addEventListener("dragstart", dragStart);
    return () => {
      el.removeEventListener("beforeinput", beforeInput);
      el.removeEventListener("keydown", keyDown);
      el.removeEventListener("compositionstart", compositionStart);
      el.removeEventListener("compositionend", compositionEnd);
      el.removeEventListener("input", input);
      el.removeEventListener("dragstart", dragStart);
    };
  }, [doc, readOnly, nonce, current, exec, toggle, stepBack, stepForward, reconcile, onLink]);

  // The user moved the caret: remember where, as anchors.
  useEffect(() => {
    if (readOnly) return;
    const change = () => {
      if (composing.current) return;
      const sel = readSel();
      if (!sel) return;
      const was = modelSel();
      if (was.anchor === sel.anchor && was.head === sel.head) return;
      anchors.current = { anchor: doc.anchor(sel.anchor), head: doc.anchor(sel.head) };
      if (pending.current.at !== sel.head || sel.anchor !== sel.head) pending.current = { marks: {}, at: -1 };
      onSelect?.(sel, pending.current.marks);
      setTick((t) => t + 1);
    };
    document.addEventListener("selectionchange", change);
    return () => document.removeEventListener("selectionchange", change);
  }, [doc, readOnly, readSel, modelSel, onSelect]);

  // After every redraw, put the caret back where the document says it is.
  useLayoutEffect(() => {
    const el = root.current;
    if (el && refocus.current) {
      refocus.current = false;
      el.focus({ preventScroll: true });
    }
    if (!el || readOnly || composing.current || document.activeElement !== el) return;
    const want = modelSel();
    const have = readSel();
    if (have && have.anchor === want.anchor && have.head === want.head) return;
    const a = toDom(el, doc, want.anchor);
    const h = toDom(el, doc, want.head);
    if (a && h) window.getSelection()?.setBaseAndExtent(a[0], a[1], h[0], h[1]);
  }, [doc, rev, tick, nonce, readOnly, modelSel, readSel]);

  // Other people's carets and selections, drawn over the text.
  useLayoutEffect(() => {
    const el = root.current;
    const frame = wrap.current;
    if (!el || !frame) return;
    const measure = () => {
      const origin = frame.getBoundingClientRect();
      const local = (r: DOMRect): Rect => ({ left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
      const next: Drawn[] = [];
      for (const p of peers ?? []) {
        const head = doc.position(p.head);
        const anchor = doc.position(p.anchor);
        const at = toDom(el, doc, head);
        if (!at) continue;
        const range = document.createRange();
        range.setStart(at[0], at[1]);
        let rect: DOMRect | undefined = range.getClientRects()[0];
        if (!rect) {
          // An empty line has no text to measure: use the line itself.
          const box = (at[0].nodeType === Node.ELEMENT_NODE ? (at[0] as Element) : at[0].parentElement!).getBoundingClientRect();
          rect = new DOMRect(box.left, box.top, 0, box.height);
        }
        const boxes: Rect[] = [];
        if (anchor !== head) {
          const from = toDom(el, doc, Math.min(anchor, head));
          const to = toDom(el, doc, Math.max(anchor, head));
          if (from && to) {
            range.setStart(from[0], from[1]);
            range.setEnd(to[0], to[1]);
            for (const r of range.getClientRects()) if (r.width > 0) boxes.push(local(r));
          }
        }
        next.push({ id: p.id, name: p.name, color: p.color, caret: local(rect), boxes });
      }
      setDrawn((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [doc, rev, peers, nonce]);

  return (
    <div ref={wrap} className="relative">
      <div
        key={nonce}
        ref={root}
        className="doc"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
        aria-label="Texto do documento"
        data-empty={doc.length === 0}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const link = target.closest("a");
          if (link) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey || readOnly) window.open(link.href, "_blank", "noopener,noreferrer");
          }
          const thread = target.closest<HTMLElement>("[data-thread]")?.dataset.thread;
          if (thread) onThread?.(thread);
        }}
      >
        <Blocks blocks={blocks} hidden={hidden} active={activeThread} placeholder={placeholder} onTodo={readOnly ? undefined : (key) => undo.run(() => toggleTodo(doc, key))} />
      </div>
      <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden="true">
        {drawn.map((d) => (
          <div key={d.id}>
            {d.boxes.map((b, i) => (
              <div key={i} className="absolute" style={{ ...b, background: d.color, opacity: 0.22 }} />
            ))}
            {d.caret && (
              <div className="absolute" style={{ left: d.caret.left - 1, top: d.caret.top, height: d.caret.height, width: 2, background: d.color }}>
                <span className="absolute -top-[15px] left-0 px-1 py-px font-sans text-[10px] leading-tight font-bold whitespace-nowrap text-white" style={{ background: d.color }}>
                  {d.name}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
