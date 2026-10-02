// Package server exposes the sync hub over WebSocket and serves the app.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"pauta/internal/hub"
	"pauta/internal/store"
	"pauta/ui"
)

// Handler builds the routes.
func Handler(st *store.Store, h *hub.Hub) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/docs/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !hub.ValidDoc(id) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "documento não encontrado"})
			return
		}
		stats, err := st.Stats(r.Context(), id)
		if err != nil {
			slog.Error("stats", "erro", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "erro interno"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "stats": stats, "online": h.Online(id)})
	})
	mux.HandleFunc("GET /ws/{id}", func(w http.ResponseWriter, r *http.Request) { serveWS(h, w, r) })
	mux.Handle("/", spa())
	return secure(mux)
}

// wsConn adapts a WebSocket to hub.Conn.
type wsConn struct{ c *websocket.Conn }

func (w wsConn) Read(ctx context.Context) ([]byte, error) {
	typ, data, err := w.c.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("server: só mensagens de texto são aceitas")
	}
	return data, nil
}

func (w wsConn) Write(ctx context.Context, msg []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return w.c.Write(ctx, websocket.MessageText, msg)
}

func serveWS(h *hub.Hub, w http.ResponseWriter, r *http.Request) {
	doc := r.PathValue("id")
	if !hub.ValidDoc(doc) {
		http.Error(w, "documento inválido", http.StatusNotFound)
		return
	}
	// Accept rejects cross-origin handshakes: the Origin host must match Host.
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(8 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() { // keepalive: detects half-open connections
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	err = h.Serve(ctx, wsConn{c}, doc)
	var violation *hub.ProtocolError
	if errors.As(err, &violation) {
		slog.Warn("cliente violou o protocolo", "doc", doc, "motivo", violation.Reason)
		c.Close(websocket.StatusPolicyViolation, truncate(violation.Reason, 100))
		return
	}
	// Anything else is the connection ending: a closed tab, a dropped network.
	c.Close(websocket.StatusNormalClosure, "")
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// spa serves the embedded frontend with a fallback to index.html.
func spa() http.Handler {
	dist, err := fs.Sub(ui.Dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasPrefix(p, "api/") || strings.HasPrefix(p, "ws/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "rota não encontrada"})
			return
		}
		if p != "" {
			if _, err := fs.Stat(dist, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "frontend não compilado: rode .\\run.ps1", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}

func secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
