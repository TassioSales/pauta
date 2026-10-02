import clsx from "clsx";
import { Check, CornerDownRight, MessageSquare, RotateCcw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { addReply, setResolved, type Author, type Doc, type Thread } from "../../core";
import { Avatar, Button, when } from "./ui";

type Props = {
  doc: Doc;
  threads: Thread[];
  me: Author;
  active: string | null;
  onActive: (id: string | null) => void;
  /** Text selected for a new comment, while its form is open. */
  draft: { quote: string } | null;
  onDraft: (body: string | null) => void;
};

/** The margin of the page: one card per conversation, in the order of the text. */
export function Comments({ doc, threads, me, active, onActive, draft, onDraft }: Props) {
  const open = threads.filter((t) => !t.resolved);
  const done = threads.filter((t) => t.resolved);
  const [showDone, setShowDone] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b-2 border-ink pb-2">
        <span className="label !text-ink">Comentários</span>
        <span className="font-mono text-[11px] text-ink-3">{open.length} em aberto</span>
      </div>

      {draft && <Draft quote={draft.quote} me={me} onDone={onDraft} />}

      {open.length === 0 && !draft && (
        <div className="border-2 border-dashed border-ink/25 p-4 text-center">
          <MessageSquare className="mx-auto size-5 text-ink-3" />
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">Selecione um trecho e clique em Comentar. O comentário acompanha as palavras, mesmo que o texto em volta mude.</p>
        </div>
      )}

      {open.map((t) => (
        <Card key={t.id} doc={doc} thread={t} me={me} active={active === t.id} onActive={onActive} />
      ))}

      {done.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowDone(!showDone)} className="label hover:!text-ink">
            {showDone ? "Esconder" : "Ver"} resolvidos ({done.length})
          </button>
          {showDone && (
            <div className="mt-3 space-y-3">
              {done.map((t) => (
                <Card key={t.id} doc={doc} thread={t} me={me} active={false} onActive={onActive} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Quote({ text }: { text: string }) {
  return <p className="border-l-[3px] border-marker-deep bg-marker/40 px-2 py-1 font-serif text-[13px] leading-snug italic">{text.length > 120 ? `${text.slice(0, 120)}…` : text}</p>;
}

function Draft({ quote, me, onDone }: { quote: string; me: Author; onDone: (body: string | null) => void }) {
  const [body, setBody] = useState("");
  return (
    <form
      className="rise space-y-2 border-2 border-ink bg-paper p-3 shadow-hard-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(body.trim() || null);
      }}
    >
      <div className="flex items-center gap-2 text-[13px] font-bold">
        <Avatar name={me.name} color={me.color} size={22} /> {me.name}
      </div>
      <Quote text={quote} />
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone(null);
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onDone(body.trim() || null);
        }}
        rows={3}
        maxLength={2000}
        placeholder="Escreva o comentário"
        className="w-full resize-none border-2 border-ink bg-paper p-2 text-[13px] focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!body.trim()}>
          Comentar
        </Button>
      </div>
    </form>
  );
}

function Card({ doc, thread: t, me, active, onActive }: { doc: Doc; thread: Thread; me: Author; active: boolean; onActive: (id: string | null) => void }) {
  const [reply, setReply] = useState("");
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    addReply(doc, t.id, me, reply.trim());
    setReply("");
  };
  return (
    <article
      data-card={t.id}
      onClick={() => onActive(t.id)}
      className={clsx("cursor-pointer border-2 bg-paper p-3 transition-shadow", active ? "border-ink shadow-hard-sm" : "border-ink/25 hover:border-ink", t.resolved && "opacity-70")}
    >
      {t.from === null ? <p className="label">o trecho comentado foi apagado</p> : <Quote text={t.quote} />}
      <Message author={t.author} color={t.color} at={t.at} body={t.body} />
      {t.replies.map((r) => (
        <div key={r.id} className="mt-2 flex gap-1.5 border-t border-rule pt-2">
          <CornerDownRight className="mt-1 size-3 shrink-0 text-ink-3" />
          <div className="min-w-0 flex-1">
            <Message author={r.author} color={r.color} at={r.at} body={r.body} />
          </div>
        </div>
      ))}
      {active && !t.resolved && (
        <form onSubmit={send} className="mt-3 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          <input value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} placeholder="Responder" className="h-8 min-w-0 flex-1 border-2 border-ink bg-paper px-2 text-xs focus:outline-none" />
          <Button size="sm" variant="dark" type="submit" disabled={!reply.trim()}>
            Enviar
          </Button>
        </form>
      )}
      <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
        {t.resolved ? (
          <button type="button" onClick={() => setResolved(doc, t.id, false)} className="inline-flex items-center gap-1 text-[11px] font-bold text-ink-2 hover:text-ink">
            <RotateCcw className="size-3" /> Reabrir
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setResolved(doc, t.id, true);
              onActive(null);
            }}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-green hover:underline"
          >
            <Check className="size-3" /> Resolver
          </button>
        )}
      </div>
    </article>
  );
}

function Message({ author, color, at, body }: { author: string; color: string; at: number; body: string }) {
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <Avatar name={author} color={color || "#888"} size={20} />
        <span className="truncate text-xs font-bold">{author}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{when(at)}</span>
      </div>
      <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap">{body}</p>
    </div>
  );
}
