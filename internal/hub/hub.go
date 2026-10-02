// Package hub is the sync protocol: one room per document, where clients
// exchange the operations each other is missing and share presence.
//
// Protocol (JSON over WebSocket):
//
//	C→S hello    {replica, vector}          first message
//	S→C welcome  {have}                     the server's vector, so the client can upload what's missing
//	S→C ops      {ops}                      what the client is missing, then live updates from peers
//	S→C synced                              the catch-up is complete
//	C→S ops      {ops}                      new local ops (and any the server lacks)
//	S→C ack      {have}                     those ops are durable
//	S→C have     {have}                     a gap was found: resend from here
//	C→S presence {state}                    ephemeral: name, colour, where the caret is
//	S→C presence {peers}                    everyone in the room
package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"pauta/internal/store"
)

const (
	MaxOpsPerMessage = 2000
	MaxOpBytes       = 256 << 10
	MaxPresenceBytes = 2 << 10
	sendBuffer       = 256
	chunk            = 500
)

var (
	replicaRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	docRe     = regexp.MustCompile(`^[a-z0-9]{4,32}$`)
)

// ProtocolError is a violation by the client, as opposed to a connection
// that simply went away.
type ProtocolError struct{ Reason string }

func (e *ProtocolError) Error() string { return e.Reason }

func violation(format string, args ...any) error {
	return &ProtocolError{Reason: fmt.Sprintf(format, args...)}
}

// ValidDoc reports whether id is an acceptable document id.
func ValidDoc(id string) bool { return docRe.MatchString(id) }

// Conn is the transport a client is attached to.
type Conn interface {
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, msg []byte) error
}

// Hub owns the rooms.
type Hub struct {
	st     *store.Store
	mu     sync.Mutex
	rooms  map[string]*room
	nextID atomic.Int64
}

// New returns a hub backed by st.
func New(st *store.Store) *Hub { return &Hub{st: st, rooms: map[string]*room{}} }

type room struct {
	id      string
	mu      sync.Mutex
	vector  map[string]int64
	clients map[*client]struct{}
}

type client struct {
	id       int64
	replica  string
	send     chan []byte
	presence json.RawMessage
	closed   atomic.Bool
}

// enqueue hands a message to the client's writer. A client that can't keep
// up is dropped; it will catch up from its vector when it reconnects.
func (c *client) enqueue(msg []byte) {
	if c.closed.Load() {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.closed.Store(true)
	}
}

type inbound struct {
	Type    string            `json:"type"`
	Replica string            `json:"replica"`
	Vector  map[string]int64  `json:"vector"`
	Ops     []json.RawMessage `json:"ops"`
	State   json.RawMessage   `json:"state"`
}

type opHeader struct {
	K string `json:"k"`
	R string `json:"r"`
	S int64  `json:"s"`
	T int64  `json:"t"`
	O string `json:"o"`
	F string `json:"f"`
}

func marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only our own structs get here
	}
	return b
}

// Online reports how many clients are connected to a document.
func (h *Hub) Online(doc string) int {
	h.mu.Lock()
	r := h.rooms[doc]
	h.mu.Unlock()
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients)
}

// join returns the room, loading its vector from the store if needed, with
// the client registered and the ops it is missing collected. Doing all of it
// under the room lock means no op can fall between the catch-up and the live
// stream.
func (h *Hub) join(ctx context.Context, doc string, c *client, have map[string]int64) (*room, map[string]int64, [][]byte, error) {
	for {
		h.mu.Lock()
		r := h.rooms[doc]
		if r == nil {
			r = &room{id: doc, clients: map[*client]struct{}{}}
			h.rooms[doc] = r
		}
		h.mu.Unlock()

		r.mu.Lock()
		// The room may have been emptied and removed while we waited for the lock.
		h.mu.Lock()
		current := h.rooms[doc] == r
		h.mu.Unlock()
		if !current {
			r.mu.Unlock()
			continue
		}
		if r.vector == nil {
			v, err := h.st.Vector(ctx, doc)
			if err != nil {
				r.mu.Unlock()
				return nil, nil, nil, err
			}
			r.vector = v
		}
		missing, err := h.st.Since(ctx, doc, have)
		if err != nil {
			r.mu.Unlock()
			return nil, nil, nil, err
		}
		r.clients[c] = struct{}{}
		vector := make(map[string]int64, len(r.vector))
		for k, v := range r.vector {
			vector[k] = v
		}
		r.mu.Unlock()
		return r, vector, missing, nil
	}
}

func (h *Hub) leave(r *room, c *client) {
	c.closed.Store(true)
	r.mu.Lock()
	delete(r.clients, c)
	empty := len(r.clients) == 0
	if !empty {
		r.broadcastPresence()
	}
	if empty {
		h.mu.Lock()
		if h.rooms[r.id] == r {
			delete(h.rooms, r.id)
		}
		h.mu.Unlock()
	}
	r.mu.Unlock()
}

type peer struct {
	ID      int64           `json:"id"`
	Replica string          `json:"replica"`
	State   json.RawMessage `json:"state"`
}

// broadcastPresence must be called with r.mu held.
func (r *room) broadcastPresence() {
	peers := make([]peer, 0, len(r.clients))
	for c := range r.clients {
		if c.presence != nil {
			peers = append(peers, peer{ID: c.id, Replica: c.replica, State: c.presence})
		}
	}
	msg := marshal(map[string]any{"type": "presence", "peers": peers})
	for c := range r.clients {
		c.enqueue(msg)
	}
}

// Serve runs one client until its connection ends or ctx is cancelled.
func (h *Hub) Serve(ctx context.Context, conn Conn, doc string) error {
	if !ValidDoc(doc) {
		return violation("id de documento inválido")
	}
	helloCtx, cancelHello := context.WithTimeout(ctx, 10*time.Second)
	raw, err := conn.Read(helloCtx)
	cancelHello()
	if err != nil {
		return err
	}
	var hello inbound
	if json.Unmarshal(raw, &hello) != nil || hello.Type != "hello" || !replicaRe.MatchString(hello.Replica) {
		return violation("a primeira mensagem deve ser um hello válido")
	}
	if hello.Vector == nil {
		hello.Vector = map[string]int64{}
	}

	c := &client{id: h.nextID.Add(1), replica: hello.Replica, send: make(chan []byte, sendBuffer)}
	r, have, missing, err := h.join(ctx, doc, c, hello.Vector)
	if err != nil {
		return err
	}
	defer h.leave(r, c)

	// The writer is stopped through its own channel, not by cancelling ctx:
	// cancelling a write in flight makes the WebSocket library drop the
	// connection, and the client would never see why it was closed.
	stop := make(chan struct{})
	writerDone := make(chan struct{})
	defer func() {
		close(stop)
		<-writerDone
	}()
	go func() {
		defer close(writerDone)
		write := func(msg []byte) bool {
			if err := conn.Write(ctx, msg); err != nil {
				c.closed.Store(true)
				return false
			}
			return true
		}
		if !write(marshal(map[string]any{"type": "welcome", "have": have, "you": c.id})) {
			return
		}
		for i := 0; i < len(missing); i += chunk {
			ops := make([]json.RawMessage, 0, chunk)
			for _, p := range missing[i:min(i+chunk, len(missing))] {
				ops = append(ops, p)
			}
			if !write(marshal(map[string]any{"type": "ops", "ops": ops})) {
				return
			}
		}
		if !write([]byte(`{"type":"synced"}`)) {
			return
		}
		for {
			select {
			case <-stop:
				return
			case msg := <-c.send:
				if !write(msg) {
					return
				}
			}
		}
	}()

	limiter := newLimiter(200, 400)
	for {
		raw, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if c.closed.Load() {
			return violation("cliente lento demais, desconectado")
		}
		if !limiter.allow() {
			return violation("limite de mensagens excedido")
		}
		var in inbound
		if err := json.Unmarshal(raw, &in); err != nil {
			return violation("mensagem inválida: %v", err)
		}
		switch in.Type {
		case "ops":
			if err := h.receive(ctx, r, c, in.Ops); err != nil {
				return err
			}
		case "presence":
			if len(in.State) > MaxPresenceBytes {
				return violation("presença grande demais")
			}
			r.mu.Lock()
			c.presence = in.State
			r.broadcastPresence()
			r.mu.Unlock()
		default:
			return violation("tipo de mensagem desconhecido %q", in.Type)
		}
	}
}

// receive validates, stores and relays a batch of ops from a client.
func (h *Hub) receive(ctx context.Context, r *room, c *client, raws []json.RawMessage) error {
	if len(raws) > MaxOpsPerMessage {
		return violation("no máximo %d ops por mensagem", MaxOpsPerMessage)
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	// Work on a copy of the vector: it only advances if the write succeeds.
	next := map[string]int64{}
	seen := func(replica string) int64 {
		if v, ok := next[replica]; ok {
			return v
		}
		return r.vector[replica]
	}
	var accepted []store.Op
	var relay []json.RawMessage
	gap := false
	for _, raw := range raws {
		if len(raw) > MaxOpBytes {
			return violation("op grande demais")
		}
		var op opHeader
		if err := json.Unmarshal(raw, &op); err != nil {
			return violation("op inválida: %v", err)
		}
		if !replicaRe.MatchString(op.R) || op.S < 1 || op.T < 1 || len(op.O) > 128 || len(op.F) > 128 {
			return violation("op malformada")
		}
		switch op.K {
		case "ins", "rem", "mark": // about the text: no object or field
		case "set":
			if op.O == "" || op.F == "" {
				return violation("op malformada")
			}
		default:
			return violation("op malformada")
		}
		have := seen(op.R)
		if op.S <= have {
			continue // already stored: a retry after a lost ack
		}
		if op.S != have+1 {
			gap = true // tell the client where to resume; keep what came before the gap
			break
		}
		next[op.R] = op.S
		accepted = append(accepted, store.Op{Replica: op.R, Seq: op.S, Payload: raw})
		relay = append(relay, raw)
	}

	if len(accepted) > 0 {
		if err := h.st.Append(ctx, r.id, accepted); err != nil {
			return err
		}
		for k, v := range next {
			r.vector[k] = v
		}
		msg := marshal(map[string]any{"type": "ops", "ops": relay})
		for other := range r.clients {
			if other != c {
				other.enqueue(msg)
			}
		}
	}

	reply := "ack"
	if gap {
		reply = "have"
	}
	have := make(map[string]int64, len(r.vector))
	for k, v := range r.vector {
		have[k] = v
	}
	c.enqueue(marshal(map[string]any{"type": reply, "have": have}))
	return nil
}

// limiter is a token bucket: rate tokens per second, up to burst.
type limiter struct {
	tokens float64
	rate   float64
	burst  float64
	last   time.Time
}

func newLimiter(rate, burst float64) *limiter {
	return &limiter{tokens: burst, rate: rate, burst: burst, last: time.Now()}
}

func (l *limiter) allow() bool {
	now := time.Now()
	l.tokens = min(l.burst, l.tokens+now.Sub(l.last).Seconds()*l.rate)
	l.last = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}
