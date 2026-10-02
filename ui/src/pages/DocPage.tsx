import clsx from "clsx";
import { ArrowLeft, Check, Download, History, Link2, Plane, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { addThread, caret, countWords, Doc, hi, lo, threads as readThreads, toMarkdown, UndoManager, type Op, type Pending, type Sel } from "../../core";
import { Comments } from "../components/Comments";
import { Blocks, Editor, type EditorHandle, type RemoteCursor } from "../components/Editor";
import { Toolbar } from "../components/Toolbar";
import { Avatar, Button, Logo, when } from "../components/ui";
import { useRevision, useSession } from "../lib/hooks";
import { loadIdentity, rememberDoc } from "../lib/identity";
import type { Session, Snapshot } from "../lib/session";

export function DocPage() {
  const { id = "" } = useParams();
  if (!/^[a-z0-9]{4,32}$/.test(id)) {
    return (
      <div className="p-10 text-center">
        <p className="font-display text-2xl font-bold">Código de documento inválido.</p>
        <Link to="/" className="mt-3 inline-block font-semibold text-red underline">
          Voltar ao início
        </Link>
      </div>
    );
  }
  return <Opened key={id} id={id} />;
}

function Opened({ id }: { id: string }) {
  const { session, state } = useSession(id);
  if (!session || !state) return <p className="label p-10 text-center">Abrindo o documento…</p>;
  return <Workspace id={id} session={session} state={state} />;
}

const statusText: Record<Snapshot["status"], string> = { loading: "abrindo", offline: "sem conexão", connecting: "conectando", syncing: "sincronizando", online: "sincronizado" };

function Workspace({ id, session, state }: { id: string; session: Session; state: Snapshot }) {
  const doc = session.doc;
  const rev = useRevision(doc);
  const undo = useMemo(() => new UndoManager(doc), [doc]);
  const editor = useRef<EditorHandle>(null);
  const location = useLocation();
  const [me] = useState(loadIdentity);
  const [sel, setSel] = useState<Sel>(caret(0));
  const [pending, setPending] = useState<Pending>({});
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ sel: Sel; quote: string } | null>(null);
  const [linkRequest, setLinkRequest] = useState(0);
  const [history, setHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const title = (doc.get("doc", "title") as string | undefined) ?? "";
  // A document created from the home page starts with the title typed there.
  useEffect(() => {
    const wanted = (location.state as { title?: string } | null)?.title;
    if (wanted && doc.get("doc", "title") === undefined && doc.history().length === 0) doc.set("doc", "title", wanted);
  }, [doc, location.state]);
  useEffect(() => {
    rememberDoc(id, title || "Sem título");
    document.title = `${title || "Sem título"} · pauta`;
  }, [id, title]);

  // Tell the others where this caret is, as ids of characters.
  useEffect(() => {
    session.setPresence({ name: me.name, color: me.color, sel: { anchor: doc.anchor(sel.anchor), head: doc.anchor(sel.head) } });
  }, [session, doc, me, sel]);

  const peers = useMemo<RemoteCursor[]>(
    () => state.peers.filter((p) => p.state?.sel).map((p) => ({ id: p.id, name: p.state.name ?? "?", color: p.state.color ?? "#888", anchor: p.state.sel!.anchor, head: p.state.sel!.head })),
    [state.peers],
  );
  const threads = useMemo(() => readThreads(doc), [doc, rev]);
  const hidden = useMemo(() => new Set(threads.filter((t) => t.resolved).map((t) => t.id)), [threads]);
  const blocks = doc.blocks();
  const stats = doc.stats();

  const onSelect = useCallback((s: Sel, p: Pending) => {
    setSel(s);
    setPending(p);
  }, []);

  const openThread = useCallback((thread: string | null) => {
    setActive(thread);
    if (thread) document.querySelector(`[data-card="${thread}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const comment = () => {
    const s = editor.current?.selection() ?? sel;
    if (s.anchor === s.head) return;
    setDraft({ sel: s, quote: Array.from(doc.text()).slice(lo(s), hi(s)).join("") });
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([toMarkdown(blocks)], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "pauta").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "pauta"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b-2 border-ink bg-paper px-4 py-2.5">
        <Link to="/" title="Início" className="flex items-center gap-2 hover:text-red">
          <ArrowLeft className="size-4" />
          <Logo small />
        </Link>
        <span className="h-6 w-px bg-ink/20" />
        <input
          value={title}
          onChange={(e) => doc.set("doc", "title", e.target.value)}
          maxLength={100}
          placeholder="Sem título"
          aria-label="Título do documento"
          className="min-w-40 flex-1 bg-transparent font-display text-xl font-bold tracking-tight placeholder:text-ink-3 focus:outline-none"
        />

        <span className={clsx("inline-flex items-center gap-1.5 border-2 border-ink px-2 py-1 font-mono text-[11px] font-bold", state.status === "online" ? "bg-green-soft" : state.airplane ? "bg-marker" : "bg-red-soft")}>
          <span className={clsx("size-2 rounded-full border border-ink", state.status === "online" ? "bg-green" : "bg-red")} />
          {state.airplane ? "modo avião" : statusText[state.status]}
          {state.pending > 0 && ` · ${state.pending} a enviar`}
        </span>

        <div className="flex items-center">
          <Avatar name={me.name} color={me.color} title={`${me.name} (você)`} />
          {state.peers.map((p) => (
            <span key={p.id} className="-ml-1.5">
              <Avatar name={p.state?.name ?? "?"} color={p.state?.color ?? "#888"} />
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant={state.airplane ? "dark" : "plain"} icon={<Plane className="size-3.5" />} onClick={() => session.setAirplane(!state.airplane)} title="Corta a conexão para escrever offline">
            Modo avião
          </Button>
          <Button size="sm" icon={<History className="size-3.5" />} onClick={() => setHistory(true)}>
            Histórico
          </Button>
          <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>
            .md
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            onClick={async () => {
              await navigator.clipboard.writeText(window.location.href).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copiado" : "Convidar"}
          </Button>
        </div>
      </header>

      <div className="border-b-2 border-ink bg-wash px-4 py-1.5">
        <Toolbar editor={editor} doc={doc} sel={sel} pending={pending} linkRequest={linkRequest} onComment={comment} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="border-2 border-ink bg-paper px-8 py-10 shadow-hard sm:px-14" onClick={(e) => e.target === e.currentTarget && editor.current?.focus()}>
            <Editor
              ref={editor}
              doc={doc}
              undo={undo}
              peers={peers}
              hidden={hidden}
              activeThread={active}
              placeholder="Comece a escrever. Use # para título, - para lista, [] para tarefa."
              onSelect={onSelect}
              onThread={openThread}
              onLink={() => setLinkRequest((n) => n + 1)}
            />
          </div>
          <aside>
            <Comments
              doc={doc}
              threads={threads}
              me={me}
              active={active}
              onActive={openThread}
              draft={draft}
              onDraft={(body) => {
                if (body && draft) setActive(addThread(doc, lo(draft.sel), hi(draft.sel), me, body));
                setDraft(null);
                editor.current?.focus();
              }}
            />
          </aside>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t-2 border-ink bg-paper px-4 py-1.5 font-mono text-[11px] text-ink-3">
        <span>
          <b className="text-ink">{countWords(blocks)}</b> palavras
        </span>
        <span>
          <b className="text-ink">{stats.characters}</b> caracteres
        </span>
        <span>{stats.ops} operações</span>
        <span>{stats.marks} intervalos de formato</span>
        <span>{stats.tombstones} lápides</span>
        <span className="ml-auto">
          código <b className="text-ink">{id}</b>
        </span>
      </footer>

      {history && <HistoryView ops={doc.history()} onClose={() => setHistory(false)} />}
    </div>
  );
}

const opText = (op: Op): string => {
  switch (op.k) {
    case "ins":
      return op.x === "\n" ? "nova linha" : `escreveu “${op.x.length > 30 ? `${op.x.slice(0, 30)}…` : op.x}”`;
    case "rem":
      return `apagou ${op.d.reduce((n, d) => n + d[2], 0)} caractere(s)`;
    case "mark":
      return op.m.startsWith("comment:") ? "comentou um trecho" : `${op.v === false || op.v === null ? "removeu" : "aplicou"} ${op.m}`;
    case "set":
      return op.o === "doc" ? "mudou o título" : op.o.startsWith("c:") ? "escreveu num comentário" : `mudou ${op.f === "checked" ? "uma tarefa" : "o tipo do bloco"}`;
  }
};

/** The document at any point of its past: the first n operations, replayed. */
function HistoryView({ ops, onClose }: { ops: readonly Op[]; onClose: () => void }) {
  const [n, setN] = useState(ops.length);
  const past = useMemo(() => Doc.replay(ops.slice(0, n)), [ops, n]);
  const op = ops[n - 1];
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-desk">
      <header className="flex items-center gap-4 border-b-2 border-ink bg-ink px-4 py-3 text-paper">
        <History className="size-5 text-red" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold">Histórico</div>
          <div className="truncate font-mono text-[11px] text-paper/60">{op ? `operação ${n} de ${ops.length} · ${when(op.w ?? 0)} · réplica ${op.r} · ${opText(op)}` : "antes de tudo: documento vazio"}</div>
        </div>
        <Button size="sm" icon={<X className="size-3.5" />} onClick={onClose} className="text-ink">
          Fechar
        </Button>
      </header>
      <div className="border-b-2 border-ink bg-paper px-4 py-3">
        <input type="range" min={0} max={ops.length} value={n} onChange={(e) => setN(Number(e.target.value))} className="w-full accent-red" aria-label="Ponto do histórico" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto my-8 max-w-3xl border-2 border-ink bg-paper px-8 py-10 shadow-hard sm:px-14">
          <h1 className="mb-4 font-display text-3xl font-bold">{(past.get("doc", "title") as string | undefined) || "Sem título"}</h1>
          <div className="doc">
            <Blocks blocks={past.blocks()} />
          </div>
        </div>
      </div>
    </div>
  );
}
