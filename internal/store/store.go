// Package store keeps each document's operation log in SQLite.
//
// The server never interprets operations: it stores them in arrival order
// and hands back the ones a client is missing. Arrival order is a valid
// causal order, because a client can only create an op that depends on ops
// it already has, and those reached the server first.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, no cgo
)

// Op is one stored operation. Payload is the client's JSON, untouched.
type Op struct {
	Replica string
	Seq     int64
	Payload []byte
}

// Store is a SQLite-backed operation log.
type Store struct {
	db *sql.DB
	// SQLite allows one writer at a time; serializing here avoids SQLITE_BUSY.
	write sync.Mutex
}

const schema = `
CREATE TABLE IF NOT EXISTS ops (
	n       INTEGER PRIMARY KEY AUTOINCREMENT,
	doc     TEXT    NOT NULL,
	replica TEXT    NOT NULL,
	seq     INTEGER NOT NULL,
	payload BLOB    NOT NULL,
	at      INTEGER NOT NULL,
	UNIQUE (doc, replica, seq)
);
CREATE INDEX IF NOT EXISTS ops_by_doc ON ops (doc, n);
`

// Open opens (or creates) the database at path. Use ":memory:" for tests.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)"
	if path == ":memory:" {
		// A shared in-memory database: every connection of the pool sees the same data.
		dsn = fmt.Sprintf("file:mem%d?mode=memory&cache=shared", time.Now().UnixNano())
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: criar esquema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Vector returns the highest sequence number stored for each replica of doc.
func (s *Store) Vector(ctx context.Context, doc string) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT replica, max(seq) FROM ops WHERE doc = ? GROUP BY replica", doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	v := map[string]int64{}
	for rows.Next() {
		var r string
		var seq int64
		if err := rows.Scan(&r, &seq); err != nil {
			return nil, err
		}
		v[r] = seq
	}
	return v, rows.Err()
}

// Append stores ops atomically: all of them or none.
func (s *Store) Append(ctx context.Context, doc string, ops []Op) error {
	if len(ops) == 0 {
		return nil
	}
	s.write.Lock()
	defer s.write.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO ops (doc, replica, seq, payload, at) VALUES (?, ?, ?, ?, ?)")
	if err != nil {
		return err
	}
	defer stmt.Close()
	now := time.Now().UnixMilli()
	for _, op := range ops {
		if _, err := stmt.ExecContext(ctx, doc, op.Replica, op.Seq, op.Payload, now); err != nil {
			return fmt.Errorf("store: gravar %s/%d: %w", op.Replica, op.Seq, err)
		}
	}
	return tx.Commit()
}

// Since returns, in arrival order, the payloads of ops that a client with
// the given vector has not seen.
func (s *Store) Since(ctx context.Context, doc string, have map[string]int64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT replica, seq, payload FROM ops WHERE doc = ? ORDER BY n", doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var r string
		var seq int64
		var payload []byte
		if err := rows.Scan(&r, &seq, &payload); err != nil {
			return nil, err
		}
		if seq > have[r] {
			out = append(out, payload)
		}
	}
	return out, rows.Err()
}

// Stats describes a document's log.
type Stats struct {
	Ops      int64  `json:"ops"`
	Bytes    int64  `json:"bytes"`
	Replicas int64  `json:"replicas"`
	Updated  *int64 `json:"updatedAt,omitempty"` // unix ms
}

// Stats summarizes a document.
func (s *Store) Stats(ctx context.Context, doc string) (Stats, error) {
	var st Stats
	err := s.db.QueryRowContext(ctx,
		"SELECT count(*), coalesce(sum(length(payload)), 0), count(DISTINCT replica), max(at) FROM ops WHERE doc = ?", doc).
		Scan(&st.Ops, &st.Bytes, &st.Replicas, &st.Updated)
	return st, err
}
