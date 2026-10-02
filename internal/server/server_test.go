package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"pauta/internal/hub"
	"pauta/internal/store"
)

type env struct {
	t   *testing.T
	url string
	st  *store.Store
}

func start(t *testing.T, path string) *env {
	t.Helper()
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Handler(st, hub.New(st)))
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &env{t: t, url: srv.URL, st: st}
}

type msg struct {
	Type  string            `json:"type"`
	Have  map[string]int64  `json:"have"`
	Ops   []json.RawMessage `json:"ops"`
	Peers []struct {
		Replica string          `json:"replica"`
		State   json.RawMessage `json:"state"`
	} `json:"peers"`
}

type peer struct {
	t *testing.T
	c *websocket.Conn
}

func (e *env) dial(doc, replica string, vector map[string]int64) *peer {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.url, "http")+"/ws/"+doc, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { c.CloseNow() })
	p := &peer{t: e.t, c: c}
	p.send(map[string]any{"type": "hello", "replica": replica, "vector": vector})
	return p
}

func (p *peer) send(v any) {
	p.t.Helper()
	raw, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.c.Write(ctx, websocket.MessageText, raw); err != nil {
		p.t.Fatal(err)
	}
}

func (p *peer) read() (msg, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := p.c.Read(ctx)
	if err != nil {
		return msg{}, err
	}
	var m msg
	return m, json.Unmarshal(raw, &m)
}

// until reads messages until one of the wanted type arrives, returning it
// and every op seen on the way.
func (p *peer) until(typ string) (msg, []string) {
	p.t.Helper()
	var ops []string
	for {
		m, err := p.read()
		if err != nil {
			p.t.Fatalf("esperando %q: %v", typ, err)
		}
		for _, o := range m.Ops {
			ops = append(ops, string(o))
		}
		if m.Type == typ {
			return m, ops
		}
	}
}

func op(replica string, seq int) map[string]any {
	return map[string]any{"k": "set", "r": replica, "s": seq, "t": seq, "o": "doc", "f": "title", "v": fmt.Sprintf("%s-%d", replica, seq)}
}

func ops(replica string, from, to int) []map[string]any {
	var out []map[string]any
	for s := from; s <= to; s++ {
		out = append(out, op(replica, s))
	}
	return out
}

func TestSyncRelayAndCatchUp(t *testing.T) {
	e := start(t, ":memory:")
	a := e.dial("doc1", "a", nil)
	a.until("synced")

	a.send(map[string]any{"type": "ops", "ops": ops("a", 1, 3)})
	ack, _ := a.until("ack")
	if ack.Have["a"] != 3 {
		t.Fatalf("ack = %v", ack.Have)
	}

	// A late joiner with nothing gets everything, then live updates.
	b := e.dial("doc1", "b", nil)
	welcome, _ := b.until("welcome")
	if welcome.Have["a"] != 3 {
		t.Fatalf("welcome = %v", welcome.Have)
	}
	_, got := b.until("synced")
	if len(got) != 3 || !strings.Contains(got[2], `"a-3"`) {
		t.Fatalf("catch-up = %v", got)
	}
	a.send(map[string]any{"type": "ops", "ops": ops("a", 4, 4)})
	live, _ := b.until("ops")
	if len(live.Ops) != 1 {
		t.Fatalf("live = %+v", live)
	}

	// A client that already has a/2 only gets the rest. Other rooms are separate.
	c := e.dial("doc1", "c", map[string]int64{"a": 2})
	_, got = c.until("synced")
	if len(got) != 2 {
		t.Fatalf("partial catch-up = %v", got)
	}
	d := e.dial("doc2", "d", nil)
	if _, got := d.until("synced"); len(got) != 0 {
		t.Fatalf("another room leaked ops: %v", got)
	}
}

func TestDuplicatesAndGaps(t *testing.T) {
	e := start(t, ":memory:")
	a := e.dial("doc1", "a", nil)
	b := e.dial("doc1", "b", nil)
	a.until("synced")
	b.until("synced")

	a.send(map[string]any{"type": "ops", "ops": ops("a", 1, 2)})
	a.until("ack")
	b.until("ops")

	// Retry after a "lost ack": 1 and 2 again plus 3. Only 3 is new.
	a.send(map[string]any{"type": "ops", "ops": ops("a", 1, 3)})
	a.until("ack")
	relayed, _ := b.until("ops")
	if len(relayed.Ops) != 1 || !strings.Contains(string(relayed.Ops[0]), `"a-3"`) {
		t.Fatalf("duplicates were relayed: %s", relayed.Ops)
	}

	// A gap: 5 without 4. The server keeps nothing and says where to resume.
	a.send(map[string]any{"type": "ops", "ops": ops("a", 5, 6)})
	have, _ := a.until("have")
	if have.Have["a"] != 3 {
		t.Fatalf("after a gap have = %v", have.Have)
	}
	stats, _ := e.st.Stats(context.Background(), "doc1")
	if stats.Ops != 3 {
		t.Fatalf("stored %d ops, want 3", stats.Ops)
	}
}

func TestPresence(t *testing.T) {
	e := start(t, ":memory:")
	a := e.dial("doc1", "a", nil)
	a.until("synced")
	a.send(map[string]any{"type": "presence", "state": map[string]string{"name": "Ana"}})
	a.until("presence")

	b := e.dial("doc1", "b", nil)
	b.until("synced")
	b.send(map[string]any{"type": "presence", "state": map[string]string{"name": "Bruno"}})
	m, _ := b.until("presence")
	if len(m.Peers) != 2 {
		t.Fatalf("b sees %d peers, want 2", len(m.Peers))
	}
	a.until("presence")

	b.c.Close(websocket.StatusNormalClosure, "")
	m, _ = a.until("presence")
	if len(m.Peers) != 1 || m.Peers[0].Replica != "a" {
		t.Fatalf("after b left, a sees %+v", m.Peers)
	}
}

func TestSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pauta.db")
	e := start(t, path)
	a := e.dial("doc1", "a", nil)
	a.until("synced")
	a.send(map[string]any{"type": "ops", "ops": ops("a", 1, 50)})
	a.until("ack")
	a.c.Close(websocket.StatusNormalClosure, "")
	e.st.Close()

	e2 := start(t, path)
	b := e2.dial("doc1", "b", nil)
	welcome, _ := b.until("welcome")
	_, got := b.until("synced")
	if welcome.Have["a"] != 50 || len(got) != 50 {
		t.Fatalf("after restart: have %v, %d ops", welcome.Have, len(got))
	}
}

func TestRejectsBadInput(t *testing.T) {
	e := start(t, ":memory:")
	closes := func(name string, first any, then ...any) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.url, "http")+"/ws/doc1", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
		for _, m := range append([]any{first}, then...) {
			raw, _ := json.Marshal(m)
			c.Write(ctx, websocket.MessageText, raw)
		}
		for {
			if _, _, err := c.Read(ctx); err != nil {
				if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
					t.Errorf("%s: connection ended with %v, want a policy violation", name, err)
				}
				return
			}
		}
	}
	hello := map[string]any{"type": "hello", "replica": "x"}
	closes("no hello", map[string]any{"type": "ops"})
	closes("bad replica id", map[string]any{"type": "hello", "replica": "../../etc"})
	closes("unknown type", hello, map[string]any{"type": "shutdown"})
	closes("malformed op", hello, map[string]any{"type": "ops", "ops": []any{map[string]any{"k": "drop", "r": "x", "s": 1, "t": 1, "o": "a", "f": "b"}}})
	closes("huge presence", hello, map[string]any{"type": "presence", "state": strings.Repeat("x", 5000)})

	for _, path := range []string{"/ws/UPPER", "/ws/a", "/api/docs/..%2Fx"} {
		res, err := http.Get(e.url + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", path, res.StatusCode)
		}
	}
	// A browser page on another site can't open the socket.
	req, _ := http.NewRequest("GET", e.url+"/ws/doc1", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Origin", "https://evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin handshake: %d, want 403", res.StatusCode)
	}
}

// TestManyWriters has several clients write concurrently to one room; every
// client must end with every op, each exactly once.
func TestManyWriters(t *testing.T) {
	e := start(t, ":memory:")
	const clients, perClient = 8, 60
	var wg sync.WaitGroup
	counts := make([]map[string]bool, clients)
	for i := range clients {
		wg.Add(1)
		go func() {
			defer wg.Done()
			name := fmt.Sprintf("w%d", i)
			p := e.dial("doc1", name, nil)
			seen := map[string]bool{}
			counts[i] = seen
			done := make(chan struct{})
			go func() {
				defer close(done)
				for len(seen) < clients*perClient-perClient {
					m, err := p.read()
					if err != nil {
						t.Errorf("%s: %v", name, err)
						return
					}
					for _, o := range m.Ops {
						if seen[string(o)] {
							t.Errorf("%s received an op twice", name)
						}
						seen[string(o)] = true
					}
				}
			}()
			for s := 1; s <= perClient; s += 5 {
				p.send(map[string]any{"type": "ops", "ops": ops(name, s, s+4)})
			}
			<-done
		}()
	}
	wg.Wait()
	stats, err := e.st.Stats(context.Background(), "doc1")
	if err != nil {
		t.Fatal(err)
	}
	if stats.Ops != clients*perClient || stats.Replicas != clients {
		t.Fatalf("stored %d ops from %d replicas, want %d from %d", stats.Ops, stats.Replicas, clients*perClient, clients)
	}
	for i, seen := range counts {
		if len(seen) != clients*perClient-perClient {
			t.Errorf("client %d saw %d ops from others, want %d", i, len(seen), clients*perClient-perClient)
		}
	}
}
