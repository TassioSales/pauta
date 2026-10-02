import { describe, expect, it } from "vitest";
import { addReply, addThread, backspace, caret, del, deleteWord, Doc, enter, rangeHas, setBlockType, setLink, setResolved, threads, toggleMark, toggleTodo, toMarkdown, typeText, UndoManager, countWords, type Block, type Op, type Sel } from "./index";

/** A compact picture of the formatting: text wrapped in the initials of its marks. */
function show(doc: Doc): string {
  return doc
    .blocks()
    .map((b) => (b.type === "p" ? "" : `${b.type}:`) + b.spans.map((s) => {
      const tags = [s.marks.bold && "b", s.marks.italic && "i", s.marks.strike && "s", s.marks.code && "c", s.marks.link && "a", s.marks.comments && "#"].filter(Boolean).join("");
      return tags ? `<${tags}>${s.text}</>` : s.text;
    }).join(""))
    .join("|");
}

/** Two replicas that already agree on `text`. */
function pair(text: string): [Doc, Doc] {
  const a = new Doc("a");
  const b = new Doc("b");
  a.insert(0, text);
  b.apply(a.history());
  return [a, b];
}

/** Delivers everything each side is missing. */
function sync(...docs: Doc[]): void {
  for (const x of docs) for (const y of docs) if (x !== y) y.apply(x.opsSince(y.vector()));
}

const sel = (anchor: number, head: number): Sel => ({ anchor, head });

describe("texto e blocos", () => {
  it("divide o texto em blocos nas quebras de linha", () => {
    const d = new Doc("a");
    d.insert(0, "Título\nPrimeiro parágrafo\n\nFim");
    const blocks = d.blocks();
    expect(blocks.map((b) => b.text)).toEqual(["Título", "Primeiro parágrafo", "", "Fim"]);
    expect(blocks.map((b) => b.start)).toEqual([0, 7, 26, 27]);
    expect(d.blockAt(7).index).toBe(1);
    expect(d.blockAt(6).index).toBe(0);
    expect(d.blockAt(26).block.text).toBe("");
    expect(d.text()).toBe("Título\nPrimeiro parágrafo\n\nFim");
    expect(d.length).toBe(30);
  });

  it("trata um emoji como um caractere só", () => {
    const d = new Doc("a");
    d.insert(0, "oi 👩‍🚀!");
    d.remove(d.length - 1, 1);
    expect(d.text()).toBe("oi 👩‍🚀");
    d.mark(3, 4, "bold", true);
    expect(d.blocks()[0]!.spans.map((s) => s.text)).toEqual(["oi ", "👩", "‍🚀"]);
  });

  it("converge quando duas pessoas digitam no mesmo ponto", () => {
    const [a, b] = pair("ac");
    a.insert(1, "X");
    b.insert(1, "Y");
    sync(a, b);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toMatch(/^a(XY|YX)c$/);
  });

  it("guarda o tipo de cada bloco e o perde quando o bloco é unido ao de cima", () => {
    const d = new Doc("a");
    typeText(d, caret(0), "um\ndois");
    setBlockType(d, caret(4), "h2");
    expect(show(d)).toBe("um|h2:dois");
    backspace(d, caret(3)); // first Backspace at the start only clears the type
    expect(show(d)).toBe("um|dois");
    backspace(d, caret(3));
    expect(show(d)).toBe("umdois");
  });
});

describe("formatação (Peritext)", () => {
  it("negrito aplicado enquanto outra pessoa digita no meio cobre o texto novo", () => {
    const [a, b] = pair("A raposa pulou");
    a.mark(0, 8, "bold", true);
    b.insert(2, "veloz ");
    sync(a, b);
    expect(show(a)).toBe("<b>A veloz raposa</> pulou");
    expect(show(b)).toBe(show(a));
  });

  it("negrito e itálico sobrepostos, feitos ao mesmo tempo, se combinam", () => {
    const [a, b] = pair("A raposa pulou");
    a.mark(0, 8, "bold", true);
    b.mark(2, 14, "italic", true);
    sync(a, b);
    expect(show(a)).toBe("<b>A </><bi>raposa</><i> pulou</>");
    expect(show(b)).toBe(show(a));
  });

  it("aplicar e remover o mesmo formato ao mesmo tempo tem um vencedor único", () => {
    const [a, b] = pair("A raposa pulou");
    a.mark(0, 14, "bold", true);
    sync(a, b);
    a.mark(0, 8, "bold", false);
    b.mark(2, 14, "bold", true);
    sync(a, b);
    // Both ops are concurrent with the same Lamport time: the replica id breaks the tie, the same way everywhere.
    expect(show(a)).toBe(show(b));
    expect(show(a)).toBe("A <b>raposa pulou</>");
  });

  it("negrito continua no que é digitado no fim; link e comentário não", () => {
    const d = new Doc("a");
    d.insert(0, "abc def");
    d.mark(0, 3, "bold", true);
    d.insert(3, "X");
    expect(show(d)).toBe("<b>abcX</> def");
    d.mark(5, 8, "link", "https://exemplo.com");
    d.insert(8, "Y");
    expect(show(d)).toBe("<b>abcX</> <a>def</>Y");
    // Typing before a formatted range stays outside it.
    d.insert(0, "Z");
    expect(show(d)).toBe("Z<b>abcX</> <a>def</>Y");
  });

  it("o formato sobrevive quando as letras das pontas são apagadas", () => {
    const [a, b] = pair("0123456789");
    a.mark(2, 8, "bold", true);
    sync(a, b);
    b.remove(1, 3); // takes the first bold characters with it
    b.remove(4, 3); // and the last, plus the character the range stopped at
    sync(a, b);
    expect(show(a)).toBe("0<b>456</>");
    a.insert(4, "X");
    expect(show(a)).toBe("0<b>456X</>");
    expect(show(b)).not.toBe(show(a));
    sync(a, b);
    expect(show(b)).toBe(show(a));
  });

  it("o formato atravessa blocos e some com um intervalo vazio", () => {
    const d = new Doc("a");
    d.insert(0, "um\ndois");
    d.mark(1, 5, "italic", true);
    expect(show(d)).toBe("u<i>m</>|<i>do</>is");
    expect(d.mark(3, 3, "bold", true)).toBeNull();
    expect(rangeHas(d, 1, 5, "italic")).toBe(true);
    expect(rangeHas(d, 0, 5, "italic")).toBe(false);
    expect(d.marksAt(1).italic).toBe(true);
    expect(d.marksAt(2)).toEqual({});
  });

  it("espera pelas letras quando o formato chega antes delas", () => {
    const a = new Doc("a");
    a.insert(0, "texto");
    a.mark(0, 5, "bold", true);
    const [ins, mark] = a.history() as [Op, Op];
    const b = new Doc("b");
    expect(b.apply(mark)).toEqual([]);
    expect(b.buffered).toBe(1);
    expect(b.apply([ins, ins, mark])).toHaveLength(2);
    expect(show(b)).toBe("<b>texto</>");
    expect(b.buffered).toBe(0);
  });
});

describe("convergência", () => {
  it("três réplicas com edições aleatórias, entregues fora de ordem e repetidas, terminam iguais", () => {
    let seed = 20261001;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const kinds = ["bold", "italic", "strike", "code", "link", "comment:x"];
    for (let round = 0; round < 30; round++) {
      const docs = [new Doc("a"), new Doc("b"), new Doc("c")];
      for (let step = 0; step < 60; step++) {
        const d = docs[rnd(3)]!;
        const n = d.length;
        const what = rnd(10);
        if (what < 4 || n === 0) d.insert(rnd(n + 1), ["x", "yz", "\n", "é", "🙂 "][rnd(5)]!);
        else if (what < 6) d.remove(rnd(n), 1 + rnd(3));
        else if (what < 9) {
          const from = rnd(n);
          const kind = kinds[rnd(kinds.length)]!;
          d.mark(from, from + 1 + rnd(n - from), kind, kind === "link" ? (rnd(3) ? "https://x.y" : null) : rnd(4) > 0);
        } else {
          const blocks = d.blocks();
          d.set(blocks[rnd(blocks.length)]!.key, "type", ["h1", "ul", "p", "code"][rnd(4)]!);
        }
        // Now and then, a partial and shuffled exchange.
        if (rnd(4) === 0) {
          const from = docs[rnd(3)]!;
          const to = docs[rnd(3)]!;
          const ops = from.opsSince(to.vector()).slice(0, 1 + rnd(8));
          for (let i = ops.length - 1; i > 0; i--) {
            const j = rnd(i + 1);
            [ops[i], ops[j]] = [ops[j]!, ops[i]!];
          }
          to.apply([...ops, ...ops.slice(0, rnd(3))]);
          // What was held back for a missing dependency arrives later.
          to.apply(from.opsSince(to.vector()));
        }
      }
      sync(...docs);
      sync(...docs);
      const [a, b, c] = docs.map((d) => JSON.stringify(d.blocks()));
      expect(b).toBe(a);
      expect(c).toBe(a);
      expect(docs.every((d) => d.buffered === 0)).toBe(true);
      // Rebuilding from the log gives the same document.
      expect(JSON.stringify(Doc.replay(docs[0]!.history()).blocks())).toBe(a);
    }
  });
});

describe("comandos de edição", () => {
  const typed = (text: string): Doc => {
    const d = new Doc("a");
    let s = caret(0);
    for (const ch of text) s = ch === "\n" ? enter(d, s) : typeText(d, s, ch);
    return d;
  };

  it("transforma prefixos de Markdown em tipos de bloco", () => {
    expect(show(typed("# Título"))).toBe("h1:Título");
    expect(show(typed("## Seção"))).toBe("h2:Seção");
    expect(show(typed("- item"))).toBe("ul:item");
    expect(show(typed("1. item"))).toBe("ol:item");
    expect(show(typed("> citação"))).toBe("quote:citação");
    expect(show(typed("[] tarefa"))).toBe("todo:tarefa");
    expect(show(typed("``` x = 1"))).toBe("code:x = 1");
    // Only at the very start of a plain paragraph.
    expect(show(typed("a # b"))).toBe("a # b");
    expect(show(typed("# a\n# b"))).toBe("h1:a|h1:b");
  });

  it("Enter continua listas, sai delas num item vazio e não continua títulos", () => {
    expect(show(typed("- um\ndois"))).toBe("ul:um|ul:dois");
    expect(show(typed("- um\n\nfora"))).toBe("ul:um|fora");
    expect(show(typed("# Título\ntexto"))).toBe("h1:Título|texto");
    const d = typed("# Título");
    enter(d, caret(0));
    expect(show(d)).toBe("|h1:Título");
    const mid = typed("- abcd");
    expect(enter(mid, caret(2))).toEqual(caret(3));
    expect(show(mid)).toBe("ul:ab|ul:cd");
  });

  it("digitar sobre uma seleção a substitui, e colar várias linhas cria blocos", () => {
    const d = typed("um dois três");
    expect(typeText(d, sel(3, 7), "2")).toEqual(caret(4));
    expect(d.text()).toBe("um 2 três");
    typeText(d, caret(d.length), "\r\nlinha A\r\nlinha B");
    expect(d.blocks().map((b) => b.text)).toEqual(["um 2 três", "linha A", "linha B"]);
    expect(enter(d, sel(0, d.length))).toEqual(caret(1));
    expect(d.text()).toBe("\n");
  });

  it("apaga para trás, para frente e por palavra", () => {
    const d = typed("alfa beta  gama\ndelta");
    expect(deleteWord(d, caret(11), "back")).toEqual(caret(5));
    expect(d.text()).toBe("alfa gama\ndelta");
    expect(deleteWord(d, caret(4), "forward")).toEqual(caret(4));
    expect(d.text()).toBe("alfa\ndelta");
    expect(del(d, caret(4))).toEqual(caret(4));
    expect(d.text()).toBe("alfadelta");
    expect(backspace(d, sel(4, 9))).toEqual(caret(4));
    expect(backspace(d, caret(0))).toEqual(caret(0));
    expect(deleteWord(d, caret(0), "back")).toEqual(caret(0));
    expect(del(d, caret(4))).toEqual(caret(4));
    expect(d.text()).toBe("alfa");
  });

  it("alterna formatos na seleção e aplica os pendentes ao que é digitado", () => {
    const d = typed("um dois");
    expect(toggleMark(d, sel(3, 7), "bold")).toBe(true);
    expect(toggleMark(d, sel(0, 7), "bold")).toBe(true); // part of it wasn't bold yet
    expect(show(d)).toBe("<b>um dois</>");
    expect(toggleMark(d, sel(0, 2), "bold")).toBe(false);
    expect(show(d)).toBe("um<b> dois</>");
    expect(toggleMark(d, caret(1), "bold")).toBe(false);

    // Bold switched off with the caret at the end of bold text.
    typeText(d, caret(7), "!", { bold: false });
    expect(show(d)).toBe("um<b> dois</>!");
    // Italic switched on in plain text.
    typeText(d, caret(1), "X", { italic: true });
    expect(show(d)).toBe("u<i>X</>m<b> dois</>!");
    setLink(d, sel(0, 3), "https://exemplo.com");
    expect(d.marksAt(0).link).toBe("https://exemplo.com");
    setLink(d, sel(0, 3), null);
    expect(d.marksAt(0).link).toBeUndefined();
  });

  it("muda o tipo de vários blocos e marca tarefas", () => {
    const d = typed("a\nb\nc");
    setBlockType(d, sel(0, 3), "todo");
    expect(show(d)).toBe("todo:a|todo:b|c");
    toggleTodo(d, d.blocks()[1]!.key);
    expect(d.blocks().map((b) => b.checked)).toEqual([false, true, false]);
    setBlockType(d, sel(0, 3), "todo"); // all already are: back to paragraphs
    expect(show(d)).toBe("a|b|c");
  });
});

describe("desfazer", () => {
  it("junta letras digitadas em sequência e refaz", () => {
    let now = 0;
    const d = new Doc("a");
    const u = new UndoManager(d, () => now);
    let s = caret(0);
    for (const ch of "olá") {
      s = u.run(() => typeText(d, s, ch), "type");
      now += 100;
    }
    now += 5000;
    for (const ch of " mundo") {
      s = u.run(() => typeText(d, s, ch), "type");
      now += 100;
    }
    expect(u.undo()).toBe(3);
    expect(d.text()).toBe("olá");
    expect(u.undo()).toBe(0);
    expect(d.text()).toBe("");
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBe(3);
    expect(u.redo()).toBe(9);
    expect(d.text()).toBe("olá mundo");
    expect(u.canRedo).toBe(false);
  });

  it("desfaz só o que esta pessoa fez, deixando o que os outros escreveram", () => {
    const [a, b] = pair("base");
    const u = new UndoManager(a);
    u.run(() => typeText(a, caret(4), " meu"));
    b.insert(0, "deles ");
    sync(a, b);
    expect(a.text()).toBe("deles base meu");
    u.undo();
    expect(a.text()).toBe("deles base");
    sync(a, b);
    expect(b.text()).toBe("deles base");
  });

  it("recoloca o que foi apagado, desfaz tipos de bloco e formatos", () => {
    const d = new Doc("a");
    const u = new UndoManager(d);
    u.run(() => typeText(d, caret(0), "um dois três"));
    u.run(() => backspace(d, sel(2, 7)));
    expect(d.text()).toBe("um três");
    expect(u.undo()).toBe(7);
    expect(d.text()).toBe("um dois três");

    u.run(() => toggleMark(d, sel(0, 2), "bold"));
    expect(show(d)).toBe("<b>um</> dois três");
    u.undo();
    expect(show(d)).toBe("um dois três");
    u.redo();
    expect(show(d)).toBe("<b>um</> dois três");

    // The Markdown shortcut is one step: undoing brings back the "#" and the paragraph.
    const e = new Doc("b");
    const v = new UndoManager(e);
    v.run(() => typeText(e, caret(0), "#"));
    v.run(() => typeText(e, caret(1), " "));
    expect(show(e)).toBe("h1:");
    v.undo();
    expect(show(e)).toBe("#");
  });
});

describe("comentários", () => {
  const ana = { name: "Ana", color: "#c00" };
  const beto = { name: "Beto", color: "#00c" };

  it("o comentário acompanha o texto, e respostas simultâneas ficam as duas", () => {
    const [a, b] = pair("O prazo é sexta-feira.");
    const id = addThread(a, 10, 21, ana, "Sexta mesmo?", 1000)!;
    sync(a, b);
    b.insert(0, "Atenção: ");
    addReply(b, id, beto, "Sim.", 2000);
    addReply(a, id, ana, "Confirmado com o cliente.", 2000);
    sync(a, b);
    const [t] = threads(a);
    expect(t).toMatchObject({ id, author: "Ana", body: "Sexta mesmo?", quote: "sexta-feira", from: 19, to: 30, resolved: false });
    expect(t!.replies.map((r) => r.author).sort()).toEqual(["Ana", "Beto"]);
    expect(threads(b)).toEqual(threads(a));
    // Text typed right after the commented words stays outside the comment.
    a.insert(30, "!!");
    expect(threads(a)[0]!.quote).toBe("sexta-feira");
  });

  it("resolve, e sobrevive ao texto ser apagado", () => {
    const d = new Doc("a");
    d.insert(0, "um dois três");
    const first = addThread(d, 3, 7, ana, "sobre dois", 1)!;
    const second = addThread(d, 0, 2, beto, "sobre um", 2)!;
    expect(threads(d).map((t) => t.id)).toEqual([second, first]);
    expect(d.marksAt(3).comments).toEqual([first]);
    setResolved(d, first, true);
    expect(threads(d).find((t) => t.id === first)!.resolved).toBe(true);
    d.remove(0, 3);
    expect(threads(d).map((t) => [t.id, t.quote, t.from])).toEqual([
      [first, "dois", 0],
      [second, "", null],
    ]);
    expect(addThread(d, 2, 2, ana, "nada selecionado")).toBeNull();
  });

  it("não entra no histórico de desfazer", () => {
    const d = new Doc("a");
    const u = new UndoManager(d);
    u.run(() => typeText(d, caret(0), "texto"));
    u.run(() => addThread(d, 0, 5, ana, "nota"));
    u.undo();
    expect(threads(d)).toHaveLength(1);
  });
});

describe("exportação", () => {
  it("gera Markdown", () => {
    const d = new Doc("a");
    const types = ["h1", "p", "ul", "ul", "todo", "quote", "code", "code", "p"];
    d.insert(0, ["Plano", "Texto com negrito e link.", "um", "dois", "feito", "citação", "let x = 1;", "y*2", "fim"].join("\n"));
    for (const [i, b] of d.blocks().entries()) d.set(b.key, "type", types[i]!);
    const blocks: Block[] = d.blocks();
    const p = blocks[1]!;
    d.mark(p.start + 10, p.start + 18, "bold", true);
    d.mark(p.start + 20, p.start + 24, "link", "https://exemplo.com/a b");
    toggleTodo(d, d.blocks().find((b) => b.type === "todo")!.key);
    expect(toMarkdown(d.blocks())).toBe(
      ["# Plano", "", "Texto com **negrito** e [link](https://exemplo.com/a%20b).", "", "- um", "- dois", "- [x] feito", "", "> citação", "", "```", "let x = 1;", "y*2", "```", "", "fim", ""].join("\n"),
    );
    expect(countWords(d.blocks())).toBe(16);
  });
});
