import { Doc, type Id, type Json, type Op, type Vector } from "../../core";
import type { OpStore } from "./persist";

export type Status = "loading" | "offline" | "connecting" | "syncing" | "online";

export type Peer = {
  id: number;
  replica: string;
  state: { name?: string; color?: string; sel?: { anchor: Id | null; head: Id | null } | null };
};

export type Snapshot = {
  status: Status;
  /** The user asked to stay offline ("modo avião"). */
  airplane: boolean;
  /** Local ops the server hasn't confirmed yet. */
  pending: number;
  peers: Peer[];
  /** Ops received from other tabs or the server since the page opened. */
  received: number;
};

type ServerMessage =
  | { type: "welcome"; have: Vector; you: number }
  | { type: "ops"; ops: Op[] }
  | { type: "synced" }
  | { type: "ack" | "have"; have: Vector }
  | { type: "presence"; peers: Peer[] };

const CHUNK = 500;

/** A fresh replica id for every page load, so a sequence number is never reused. */
export function newReplica(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/**
 * One open document: the CRDT, its local log, and the links to other
 * replicas. The document is usable as soon as the local log is loaded;
 * the network only makes it converge with others.
 *
 *   local edit ──► Doc ──► IndexedDB            (always)
 *                    ├───► other tabs           (BroadcastChannel, works offline)
 *                    └───► server ──► peers     (WebSocket, when there is one)
 */
export class Session {
  readonly doc: Doc;
  private snap: Snapshot = { status: "loading", airplane: false, pending: 0, peers: [], received: 0 };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private serverHave: Vector = {};
  private me = -1;
  private outbox: Op[] = [];
  private flushing = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private channel: BroadcastChannel | null = null;
  private presence: Json = null;
  private closed = false;

  /**
   * @param url       WebSocket endpoint, or null to never use a server.
   * @param crossTab  Sync with other tabs of this browser through a BroadcastChannel.
   */
  constructor(
    readonly id: string,
    private store: OpStore,
    private url: string | null,
    private crossTab = true,
    replica = newReplica(),
  ) {
    this.doc = new Doc(replica);
  }

  /** Loads the local log and starts syncing. */
  async start(): Promise<void> {
    try {
      this.doc.apply(await this.store.load(this.id));
    } catch (err) {
      console.warn("pauta: não foi possível ler o log local", err);
    }
    if (this.closed) return;
    this.doc.onLocal((op) => this.local(op));
    if (this.crossTab && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`pauta:${this.id}`);
      this.channel.onmessage = (e: MessageEvent<Op[]>) => {
        // The tab that created them persists them; we only apply, and pass
        // them on to the server in case that tab is offline and we are not.
        const applied = this.doc.apply(e.data);
        if (!applied.length) return;
        if (this.snap.status === "online") this.send({ type: "ops", ops: applied });
        this.update({ received: this.snap.received + applied.length });
      };
    }
    this.update({ status: "offline" });
    this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.channel?.close();
    this.ws?.close();
    this.ws = null;
  }

  // ---- state for the UI ---------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): Snapshot => this.snap;

  private update(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch, pending: this.countPending() };
    for (const l of this.listeners) l();
  }

  private countPending(): number {
    if (!this.url) return 0;
    let n = 0;
    for (const op of this.doc.history()) if (op.s > (this.serverHave[op.r] ?? 0)) n++;
    return n;
  }

  // ---- local ops ----------------------------------------------------------

  private local(op: Op): void {
    this.store.append(this.id, [op]).catch((err) => console.warn("pauta: falha ao gravar no log local", err));
    this.outbox.push(op);
    // A burst of edits (a paste, a column delete) goes out as one message.
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushing = false;
    const ops = this.outbox;
    this.outbox = [];
    this.channel?.postMessage(ops);
    if (this.snap.status === "online" || this.snap.status === "syncing") this.send({ type: "ops", ops });
    this.update({});
  }

  // ---- network ------------------------------------------------------------

  /** "Modo avião": drop the connection and stay offline until turned off. */
  setAirplane(on: boolean): void {
    this.update({ airplane: on });
    if (on) {
      clearTimeout(this.timer);
      this.ws?.close();
    } else {
      this.retry = 0;
      this.connect();
    }
  }

  setPresence(state: Json): void {
    this.presence = state;
    if (this.snap.status === "online") this.send({ type: "presence", state });
  }

  private connect(): void {
    if (!this.url || this.closed || this.snap.airplane || this.ws) return;
    this.update({ status: "connecting" });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send({ type: "hello", replica: this.doc.replica, vector: this.doc.vector() });
      this.update({ status: "syncing" });
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.receive(JSON.parse(e.data as string) as ServerMessage);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.update({ status: "offline", peers: [] });
      if (this.closed || this.snap.airplane) return;
      // Back off, with jitter so a crowd doesn't reconnect in step.
      const delay = Math.min(8000, 400 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private upload(have: Vector): void {
    const ops = this.doc.opsSince(have);
    for (let i = 0; i < ops.length; i += CHUNK) this.send({ type: "ops", ops: ops.slice(i, i + CHUNK) });
  }

  private receive(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.me = msg.you;
        this.serverHave = msg.have;
        this.upload(msg.have); // whatever was done offline, by this or by closed tabs
        this.update({});
        break;
      case "ops": {
        const applied = this.doc.apply(msg.ops);
        if (applied.length) {
          this.store.append(this.id, applied).catch((err) => console.warn("pauta: falha ao gravar no log local", err));
          this.channel?.postMessage(applied);
          for (const op of applied) this.serverHave[op.r] = Math.max(this.serverHave[op.r] ?? 0, op.s);
          this.update({ received: this.snap.received + applied.length });
        }
        break;
      }
      case "synced":
        this.retry = 0;
        this.update({ status: "online" });
        if (this.presence !== null) this.send({ type: "presence", state: this.presence });
        break;
      case "ack":
        this.serverHave = msg.have;
        this.update({});
        break;
      case "have": // the server found a gap: resend from what it has
        this.serverHave = msg.have;
        this.upload(msg.have);
        this.update({});
        break;
      case "presence":
        this.update({ peers: msg.peers.filter((p) => p.id !== this.me) });
        break;
    }
  }
}
