import type { Block, Marks, Span } from "./doc";

const FENCE = "```";

function inline(spans: Span[]): string {
  return spans.map((s) => wrap(s.text, s.marks)).join("");
}

function wrap(text: string, m: Marks): string {
  if (m.code) return "`" + text + "`";
  // Markers hug the words: "**bold** " and not "**bold **".
  const lead = text.match(/^\s*/)![0];
  const trail = text.slice(lead.length).match(/\s*$/)![0];
  let core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  core = core.replace(/([\\*_`[\]~])/g, "\\$1");
  if (m.strike) core = `~~${core}~~`;
  if (m.italic) core = `*${core}*`;
  if (m.bold) core = `**${core}**`;
  if (m.link) core = `[${core}](${m.link.replace(/[()\s]/g, encodeURIComponent)})`;
  return lead + core + trail;
}

/** The document as Markdown. */
export function toMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  let number = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const prev = blocks[i - 1]?.type;
    const next = blocks[i + 1]?.type;
    number = b.type === "ol" ? number + 1 : 0;
    const list = b.type === "ul" || b.type === "ol" || b.type === "todo";
    // Items of one list, lines of one quote and lines of code stay together; everything else gets a blank line.
    const joins = (list && (prev === "ul" || prev === "ol" || prev === "todo")) || (b.type === "quote" && prev === "quote") || (b.type === "code" && prev === "code");
    if (i > 0 && !joins) out.push("");
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3":
        out.push(`${"#".repeat(Number(b.type[1]))} ${inline(b.spans)}`);
        break;
      case "ul":
        out.push(`- ${inline(b.spans)}`);
        break;
      case "ol":
        out.push(`${number}. ${inline(b.spans)}`);
        break;
      case "todo":
        out.push(`- [${b.checked ? "x" : " "}] ${inline(b.spans)}`);
        break;
      case "quote":
        out.push(`> ${inline(b.spans)}`);
        break;
      case "code":
        if (prev !== "code") out.push(FENCE);
        out.push(b.text);
        if (next !== "code") out.push(FENCE);
        break;
      default:
        out.push(inline(b.spans));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Words in the document, for the status bar. */
export function countWords(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) n += b.text.trim() ? b.text.trim().split(/\s+/).length : 0;
  return n;
}
