import { Bold, Code, Heading1, Heading2, Heading3, Italic, Link2, List, ListChecks, ListOrdered, MessageSquarePlus, Pilcrow, Redo2, SquareCode, Strikethrough, TextQuote, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { hi, lo, rangeHas, setBlockType, setLink, type BlockType, type Doc, type Inline, type Pending, type Sel } from "../../core";
import type { EditorHandle } from "./Editor";
import { Key } from "./ui";

const blockKeys: { type: BlockType; label: string; icon: typeof Pilcrow }[] = [
  { type: "p", label: "Parágrafo", icon: Pilcrow },
  { type: "h1", label: "Título (# )", icon: Heading1 },
  { type: "h2", label: "Seção (## )", icon: Heading2 },
  { type: "h3", label: "Subseção (### )", icon: Heading3 },
  { type: "ul", label: "Lista (- )", icon: List },
  { type: "ol", label: "Lista numerada (1. )", icon: ListOrdered },
  { type: "todo", label: "Tarefas ([] )", icon: ListChecks },
  { type: "quote", label: "Citação (> )", icon: TextQuote },
  { type: "code", label: "Código (``` )", icon: SquareCode },
];

const inlineKeys: { kind: Inline; label: string; icon: typeof Bold }[] = [
  { kind: "bold", label: "Negrito (Ctrl+B)", icon: Bold },
  { kind: "italic", label: "Itálico (Ctrl+I)", icon: Italic },
  { kind: "strike", label: "Riscado (Ctrl+Shift+X)", icon: Strikethrough },
  { kind: "code", label: "Código (Ctrl+E)", icon: Code },
];

type Props = {
  editor: RefObject<EditorHandle | null>;
  doc: Doc;
  sel: Sel;
  pending: Pending;
  /** Bumped by Ctrl+K to open the link field. */
  linkRequest?: number;
  onComment?: () => void;
};

export function Toolbar({ editor, doc, sel, pending, linkRequest, onComment }: Props) {
  const [linking, setLinking] = useState<{ sel: Sel; url: string } | null>(null);
  const range = sel.anchor !== sel.head;
  const { block } = doc.blockAt(Math.min(sel.head, doc.length));
  const on = (kind: Inline) => (range ? rangeHas(doc, lo(sel), hi(sel), kind) : (pending[kind] ?? (sel.head > block.start ? !!doc.marksAt(sel.head - 1)[kind] : false)));
  const linked = range && rangeHas(doc, lo(sel), hi(sel), "link");

  const link = () => {
    if (!range) return;
    if (linked) editor.current?.exec((d, s) => (setLink(d, s, null), s));
    else setLinking({ sel, url: "" });
  };
  // Ctrl+K in the editor asks for the link field.
  const seen = useRef(linkRequest ?? 0);
  useEffect(() => {
    if (linkRequest === undefined || linkRequest === seen.current) return;
    seen.current = linkRequest;
    link();
  });

  return (
    <div className="relative flex flex-wrap items-center gap-0.5">
      <Key label="Desfazer (Ctrl+Z)" onClick={() => editor.current?.undo()}>
        <Undo2 className="size-4" />
      </Key>
      <Key label="Refazer (Ctrl+Y)" onClick={() => editor.current?.redo()}>
        <Redo2 className="size-4" />
      </Key>
      <Divider />
      {blockKeys.map(({ type, label, icon: Icon }) => (
        <Key key={type} label={label} active={block.type === type} onClick={() => editor.current?.exec((d, s) => (setBlockType(d, s, type), s))}>
          <Icon className="size-4" />
        </Key>
      ))}
      <Divider />
      {inlineKeys.map(({ kind, label, icon: Icon }) => (
        <Key key={kind} label={label} active={on(kind)} onClick={() => editor.current?.toggle(kind)}>
          <Icon className="size-4" />
        </Key>
      ))}
      <Key label={linked ? "Remover link" : "Link (Ctrl+K)"} active={linked} disabled={!range} onClick={link}>
        <Link2 className="size-4" />
      </Key>
      {onComment && (
        <>
          <Divider />
          <Key label="Comentar o trecho selecionado" disabled={!range} onClick={onComment} className="text-ink">
            <MessageSquarePlus className="size-4" /> Comentar
          </Key>
        </>
      )}

      {linking && (
        <form
          className="rise absolute top-full left-0 z-20 mt-2 flex w-96 max-w-full gap-2 border-2 border-ink bg-paper p-2 shadow-hard"
          onSubmit={(e) => {
            e.preventDefault();
            const url = linking.url.trim();
            if (url) editor.current?.exec((d) => (setLink(d, linking.sel, url), linking.sel));
            setLinking(null);
            editor.current?.focus();
          }}
        >
          <input
            autoFocus
            value={linking.url}
            onChange={(e) => setLinking({ ...linking, url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setLinking(null);
                editor.current?.focus();
              }
            }}
            placeholder="https://"
            className="h-8 min-w-0 flex-1 border-2 border-ink bg-paper px-2 font-mono text-xs focus:outline-none"
          />
          <button type="submit" className="h-8 bg-ink px-3 text-xs font-bold text-paper">
            Ligar
          </button>
        </form>
      )}
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-ink/20" />;
}
