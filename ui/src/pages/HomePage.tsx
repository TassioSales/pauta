import { ArrowRight, FlaskConical, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Avatar, Button, inputClass, Logo, Panel } from "../components/ui";
import { forgetDoc, loadIdentity, newDocId, PALETTE, recentDocs, saveIdentity } from "../lib/identity";

const facts = [
  ["Formatação que converge", "Negrito, links e comentários são intervalos ancorados nas letras, não em posições. Duas pessoas formatando o mesmo trecho chegam ao mesmo resultado."],
  ["Local primeiro", "Cada tecla é gravada neste aparelho antes de ir para a rede. Sem internet o editor continua igual; quando ela volta, tudo se junta."],
  ["Sem biblioteca de editor", "O CRDT, o protocolo de sincronização e o próprio editor foram escritos do zero. Nenhuma tecla é tratada pelo navegador."],
];

export function HomePage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [me, setMe] = useState(loadIdentity);
  const [recent, setRecent] = useState(recentDocs);
  const cleanCode = code.trim().toLowerCase().split("/").pop() ?? "";
  const update = (patch: Partial<typeof me>) => {
    const next = { ...me, ...patch };
    setMe(next);
    saveIdentity(next);
  };

  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <Logo />
      <div className="staff mt-6" />
      <section className="mt-8 max-w-4xl">
        <h1 className="font-display text-5xl leading-[1.04] font-bold tracking-tight sm:text-7xl">
          Escrevam juntos. <span className="text-red italic">Mesmo</span> sem internet.
        </h1>
        <p className="mt-5 max-w-2xl font-serif text-xl leading-relaxed text-ink-2">Um editor de texto colaborativo em que ninguém espera por ninguém: cada pessoa escreve na sua cópia, e as cópias se juntam sozinhas, letra por letra e negrito por negrito.</p>
      </section>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <Panel className="p-6">
          <div className="label">Novo</div>
          <h2 className="mt-1 font-display text-2xl font-bold">Abrir uma pauta</h2>
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/d/${newDocId()}`, { state: { title: title.trim() } });
            }}
          >
            <input className={inputClass} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="Título (ex.: Reunião de segunda)" />
            <Button type="submit" variant="primary" icon={<ArrowRight className="size-4" />}>
              Criar
            </Button>
          </form>

          <h2 className="mt-8 font-display text-2xl font-bold">Entrar com um código</h2>
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^[a-z0-9]{4,32}$/.test(cleanCode)) navigate(`/d/${cleanCode}`);
            }}
          >
            <input className={inputClass + " font-mono"} value={code} onChange={(e) => setCode(e.target.value)} placeholder="código ou link" />
            <Button type="submit" disabled={!/^[a-z0-9]{4,32}$/.test(cleanCode)}>
              Entrar
            </Button>
          </form>
        </Panel>

        <Panel className="p-6">
          <div className="label">Você</div>
          <h2 className="mt-1 font-display text-2xl font-bold">Como você aparece</h2>
          <div className="mt-4 flex items-center gap-3">
            <Avatar name={me.name} color={me.color} size={44} />
            <input className={inputClass} value={me.name} maxLength={40} aria-label="Seu nome" onChange={(e) => update({ name: e.target.value })} />
          </div>
          <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Sua cor">
            {PALETTE.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={me.color === c} aria-label={`cor ${c}`} onClick={() => update({ color: c })} className={`size-7 rounded-full border-2 border-ink ${me.color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-paper" : ""}`} style={{ background: c }} />
            ))}
          </div>

          <h2 className="mt-8 font-display text-2xl font-bold">Neste aparelho</h2>
          {recent.length === 0 ? (
            <p className="mt-2 text-sm text-ink-3">Nenhum documento ainda.</p>
          ) : (
            <ul className="mt-2 divide-y divide-rule border-t border-rule">
              {recent.map((r) => (
                <li key={r.id} className="group flex items-center gap-3 py-2">
                  <Link to={`/d/${r.id}`} className="min-w-0 flex-1">
                    <span className="block truncate font-serif text-base font-semibold hover:text-red">{r.title}</span>
                    <span className="font-mono text-[11px] text-ink-3">{r.id}</span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Esquecer ${r.title}`}
                    title="Tirar da lista (o texto continua no aparelho)"
                    onClick={() => {
                      forgetDoc(r.id);
                      setRecent(recentDocs());
                    }}
                    className="p-1 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-ink/10 hover:text-ink focus:opacity-100"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Link to="/lab" className="mt-6 flex items-center gap-4 border-2 border-ink bg-ink p-5 text-paper shadow-[4px_4px_0_var(--color-red)] transition-transform hover:-translate-y-0.5">
        <FlaskConical className="size-9 shrink-0 text-red" />
        <div>
          <p className="font-display text-2xl font-bold">Laboratório de conflitos</p>
          <p className="text-sm text-paper/70">Duas cópias do mesmo texto e um interruptor de rede. Uma pessoa põe em negrito, a outra escreve no meio: religue e veja a fusão.</p>
        </div>
        <ArrowRight className="ml-auto size-5 shrink-0" />
      </Link>

      <section className="mt-12 grid gap-6 border-t-2 border-ink pt-6 md:grid-cols-3">
        {facts.map(([t, d], i) => (
          <div key={t}>
            <div className="font-mono text-xs font-bold text-red">0{i + 1}</div>
            <h3 className="mt-1 font-display text-xl font-bold">{t}</h3>
            <p className="mt-1.5 font-serif text-[15px] leading-relaxed text-ink-2">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
