import clsx from "clsx";
import { ArrowLeft, Cable, RotateCcw, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { caret, Doc, UndoManager, type Pending, type Sel } from "../../core";
import { Editor, type EditorHandle } from "../components/Editor";
import { Toolbar } from "../components/Toolbar";
import { Button, Logo } from "../components/ui";
import { useRevision } from "../lib/hooks";

type Scenario = {
  name: string;
  text: string;
  /** What each person does while the cable is unplugged. */
  ana: (doc: Doc) => void;
  beto: (doc: Doc) => void;
  anaDoes: string;
  betoDoes: string;
  result: string;
};

const BASE = "A raposa pulou a cerca";

const scenarios: Scenario[] = [
  {
    name: "Negrito × texto novo",
    text: BASE,
    ana: (d) => d.mark(2, 8, "bold", true),
    beto: (d) => d.insert(8, " vermelha"),
    anaDoes: "põe “raposa” em negrito",
    betoDoes: "escreve “ vermelha” logo depois de “raposa”",
    result: "O negrito cobre “raposa vermelha”: o intervalo termina antes da letra seguinte, então o que foi escrito no fim entra nele.",
  },
  {
    name: "Negrito × itálico",
    text: BASE,
    ana: (d) => d.mark(0, 14, "bold", true),
    beto: (d) => d.mark(9, 22, "italic", true),
    anaDoes: "põe “A raposa pulou” em negrito",
    betoDoes: "põe “pulou a cerca” em itálico",
    result: "Os dois formatos convivem: “pulou” fica em negrito e itálico. Formatos de tipos diferentes nunca disputam.",
  },
  {
    name: "Aplicar × remover",
    text: BASE,
    ana: (d) => {
      d.mark(0, 22, "bold", true);
    },
    beto: (d) => d.mark(2, 8, "bold", false),
    anaDoes: "põe a frase inteira em negrito",
    betoDoes: "tira o negrito de “raposa” (que ainda nem estava)",
    result: "No trecho em disputa vence a operação de maior id, e o desempate é o mesmo em toda réplica. O importante: as duas cópias mostram exatamente o mesmo.",
  },
  {
    name: "Link × texto na ponta",
    text: BASE,
    ana: (d) => d.mark(15, 22, "link", "https://pt.wikipedia.org/wiki/Cerca"),
    beto: (d) => d.insert(22, "do alto"),
    anaDoes: "transforma “a cerca” em link",
    betoDoes: "escreve “do alto” colado no fim da frase",
    result: "O link fica só em “a cerca”. Ao contrário do negrito, um link termina na última letra dele: o que é escrito na ponta fica de fora.",
  },
  {
    name: "Dois tipos de bloco",
    text: BASE,
    ana: (d) => d.set(d.blocks()[0]!.key, "type", "h1"),
    beto: (d) => d.set(d.blocks()[0]!.key, "type", "quote"),
    anaDoes: "transforma a linha em título",
    betoDoes: "transforma a linha em citação",
    result: "O tipo do bloco é um registro em que a última escrita vence. Uma das duas escolhas se perde, mas ninguém fica vendo algo diferente.",
  },
];

function fresh(text: string): [Doc, Doc] {
  const a = new Doc("ana");
  const b = new Doc("beto");
  a.insert(0, text);
  b.apply(a.history());
  return [a, b];
}

export function LabPage() {
  const [docs, setDocs] = useState(() => fresh(BASE));
  const [linked, setLinked] = useState(true);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [a, b] = docs;
  const revA = useRevision(a);
  const revB = useRevision(b);

  // While the cable is in, every op of one side goes straight to the other.
  useEffect(() => {
    if (!linked) return;
    b.apply(a.opsSince(b.vector()));
    a.apply(b.opsSince(a.vector()));
    const offA = a.onLocal((op) => b.apply(op));
    const offB = b.onLocal((op) => a.apply(op));
    return () => {
      offA();
      offB();
    };
  }, [a, b, linked]);

  const run = (s: Scenario) => {
    const pair = fresh(s.text);
    setLinked(false);
    s.ana(pair[0]);
    s.beto(pair[1]);
    setDocs(pair);
    setScenario(s);
  };

  const same = useMemo(() => JSON.stringify(a.blocks()) === JSON.stringify(b.blocks()), [a, b, revA, revB]);
  const behind = a.opsSince(b.vector()).length + b.opsSince(a.vector()).length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 hover:text-red">
          <ArrowLeft className="size-4" />
          <Logo small />
        </Link>
        <span className="label">laboratório</span>
      </div>
      <h1 className="mt-6 font-display text-4xl leading-tight font-bold tracking-tight sm:text-5xl">
        O que acontece quando duas pessoas <span className="text-red italic">mexem no mesmo trecho</span>?
      </h1>
      <p className="mt-3 max-w-3xl font-serif text-lg leading-relaxed text-ink-2">Duas cópias do mesmo documento, cada uma com seu editor. Tire o cabo, edite as duas, e ligue de novo. Ou escolha um dos casos clássicos abaixo, que já deixa as duas edições feitas.</p>

      <div className="mt-6 flex flex-wrap gap-2">
        {scenarios.map((s) => (
          <button key={s.name} type="button" onClick={() => run(s)} className={clsx("border-2 border-ink px-3 py-1.5 text-[13px] font-bold transition-colors", scenario === s ? "bg-ink text-paper" : "bg-paper hover:bg-wash")}>
            {s.name}
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw className="size-3.5" />}
          className="h-[34px]"
          onClick={() => {
            setDocs(fresh(BASE));
            setScenario(null);
            setLinked(true);
          }}
        >
          Recomeçar
        </Button>
      </div>

      <div className="mt-6 grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <Replica key={`a${a.replica}${revKey(docs)}`} doc={a} name="Ana" color="#d6293e" did={!linked && scenario ? scenario.anaDoes : null} />
        <div className="flex flex-row items-center justify-center gap-3 lg:flex-col">
          <button
            type="button"
            onClick={() => setLinked(!linked)}
            aria-pressed={linked}
            className={clsx("flex size-16 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-ink shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none", linked ? "bg-green-soft" : "bg-red text-white")}
          >
            {linked ? <Cable className="size-5" /> : <Unplug className="size-5" />}
            <span className="font-mono text-[9px] font-bold uppercase">{linked ? "ligado" : "cortado"}</span>
          </button>
          <span className={clsx("border-2 border-ink px-2 py-1 text-center font-mono text-[10px] font-bold", same ? "bg-green-soft" : "bg-marker")}>{same ? "iguais" : `${behind} op. a trocar`}</span>
        </div>
        <Replica key={`b${b.replica}${revKey(docs)}`} doc={b} name="Beto" color="#2450b8" did={!linked && scenario ? scenario.betoDoes : null} />
      </div>

      {scenario && (
        <div className="rise mt-6 border-2 border-ink bg-paper p-5 shadow-hard">
          <div className="label">{linked ? "o que aconteceu" : "ligue o cabo para ver"}</div>
          <p className="mt-1 font-serif text-lg leading-relaxed">{linked ? scenario.result : `Sem conexão, Ana ${scenario.anaDoes} e Beto ${scenario.betoDoes}. Clique no botão do meio para juntar as duas cópias.`}</p>
        </div>
      )}
    </div>
  );
}

// A new pair of documents remounts both editors.
const ids = new WeakMap<object, number>();
let nextId = 0;
function revKey(pair: object): number {
  if (!ids.has(pair)) ids.set(pair, nextId++);
  return ids.get(pair)!;
}

function Replica({ doc, name, color, did }: { doc: Doc; name: string; color: string; did: string | null }) {
  useRevision(doc);
  const undo = useMemo(() => new UndoManager(doc), [doc]);
  const editor = useRef<EditorHandle>(null);
  const [sel, setSel] = useState<Sel>(caret(0));
  const [pending, setPending] = useState<Pending>({});
  const onSelect = useCallback((s: Sel, p: Pending) => {
    setSel(s);
    setPending(p);
  }, []);
  const stats = doc.stats();
  return (
    <section className="flex min-w-0 flex-col border-2 border-ink bg-paper shadow-hard">
      <header className="flex items-center gap-2 border-b-2 border-ink px-3 py-2">
        <span className="size-3 rounded-full border-2 border-ink" style={{ background: color }} />
        <span className="font-display text-lg font-bold">{name}</span>
        {did && <span className="ml-auto truncate text-xs text-ink-2">{did}</span>}
      </header>
      <div className="border-b border-rule bg-wash px-2 py-1">
        <Toolbar editor={editor} doc={doc} sel={sel} pending={pending} />
      </div>
      <div className="min-h-44 flex-1 px-5 py-4" onClick={(e) => e.target === e.currentTarget && editor.current?.focus()}>
        <Editor ref={editor} doc={doc} undo={undo} onSelect={onSelect} />
      </div>
      <footer className="border-t border-rule px-3 py-1.5 font-mono text-[10.5px] text-ink-3">
        {stats.ops} operações · {stats.marks} intervalos · relógio {stats.clock}
      </footer>
    </section>
  );
}
