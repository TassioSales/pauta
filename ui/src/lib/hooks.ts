import { useEffect, useState, useSyncExternalStore } from "react";
import type { Doc } from "../../core";
import { IndexedDbStore, type OpStore } from "./persist";
import { Session, type Snapshot } from "./session";

/** Re-renders whenever the document changes; returns its revision. */
export function useRevision(doc: Doc): number {
  return useSyncExternalStore(
    (cb) => doc.subscribe(cb),
    () => doc.revision,
  );
}

let sharedStore: OpStore | null = null;
const localStore = () => (sharedStore ??= new IndexedDbStore());

/** Opens a document: local log first, then the network. */
export function useSession(id: string): { session: Session | null; state: Snapshot | null } {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const s = new Session(id, localStore(), `${scheme}://${location.host}/ws/${id}`);
    let alive = true;
    s.start().then(() => alive && setSession(s));
    return () => {
      alive = false;
      s.close();
      setSession(null);
    };
  }, [id]);
  const state = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.snapshot ?? noSnapshot);
  return { session, state };
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;
