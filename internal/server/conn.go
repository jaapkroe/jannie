package server

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	maxMessageBytes = 4096
	sendQueueLen    = 256
	writeTimeout    = 10 * time.Second
	pingEvery       = 25 * time.Second
	pingTimeout     = 20 * time.Second
)

// client is one websocket connection. The reader goroutine decodes and
// dispatches messages; the writer goroutine owns all writes and pings.
type client struct {
	srv  *Server
	conn   *websocket.Conn
	ip     string
	device string // the browser's User-Agent, cut short (game log)

	out      chan []byte   // bounded send queue
	quit     chan struct{} // closed when the connection is closing
	quitOnce sync.Once
	closeMu  sync.Mutex
	code     websocket.StatusCode
	reason   string
	pinging  atomic.Bool
	aborted  atomic.Bool // closing without flushing the queue

	mu   sync.Mutex
	room *room // the room this connection plays in, if any

	bucket     tokenBucket // reader only: all messages
	joinBucket tokenBucket // reader only: joins
}

func newClient(s *Server, conn *websocket.Conn, ip, device string) *client {
	return &client{
		srv:        s,
		conn:       conn,
		ip:         ip,
		device:     device,
		out:        make(chan []byte, sendQueueLen),
		quit:       make(chan struct{}),
		code:       websocket.StatusNormalClosure,
		bucket:     tokenBucket{tokens: s.msgRate, max: s.msgRate, rate: s.msgRate},
		joinBucket: tokenBucket{tokens: s.joinBurst, max: s.joinBurst, rate: s.joinRate},
	}
}

// send queues a message; a client whose queue is full is disconnected (it
// resyncs on reconnect). It never blocks.
func (c *client) send(b []byte) {
	select {
	case <-c.quit:
		return
	default:
	}
	select {
	case c.out <- b:
	default:
		c.aborted.Store(true)
		c.close(websocket.StatusPolicyViolation, "te traag")
	}
}

// sendError queues an error message.
func (c *client) sendError(code, msg string) { c.send(errorJSON(code, msg)) }

// close starts closing the connection; the writer flushes what is queued,
// then sends a close frame.
func (c *client) close(code websocket.StatusCode, reason string) {
	c.quitOnce.Do(func() {
		c.closeMu.Lock()
		c.code, c.reason = code, reason
		c.closeMu.Unlock()
		close(c.quit)
	})
}

// closeWithError queues an error message, then closes.
func (c *client) closeWithError(code, msg string, status websocket.StatusCode) {
	c.send(errorJSON(code, msg))
	c.close(status, code)
}

func (c *client) getRoom() *room {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.room
}

func (c *client) setRoom(r *room) {
	c.mu.Lock()
	c.room = r
	c.mu.Unlock()
}

// leaveRoom clears the binding if it is still r.
func (c *client) leaveRoom(r *room) {
	c.mu.Lock()
	if c.room == r {
		c.room = nil
	}
	c.mu.Unlock()
}

// writeLoop sends queued messages and pings until the connection closes.
func (c *client) writeLoop(ctx context.Context) {
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		select {
		case b := <-c.out:
			if err := c.write(ctx, b); err != nil {
				c.close(websocket.StatusGoingAway, "")
				c.conn.CloseNow()
				return
			}
		case <-tick.C:
			c.ping(ctx)
		case <-c.quit:
			if c.aborted.Load() {
				c.conn.CloseNow()
				return
			}
			c.flush(ctx)
			c.closeMu.Lock()
			code, reason := c.code, c.reason
			c.closeMu.Unlock()
			c.conn.Close(code, reason)
			return
		case <-ctx.Done():
			c.conn.CloseNow()
			return
		}
	}
}

// flush writes what is still queued (e.g. a final error), best effort.
func (c *client) flush(ctx context.Context) {
	for {
		select {
		case b := <-c.out:
			if c.write(ctx, b) != nil {
				return
			}
		default:
			return
		}
	}
}

func (c *client) write(ctx context.Context, b []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, b)
}

// ping runs one ping in the background; a missing pong closes the connection.
func (c *client) ping(ctx context.Context) {
	if !c.pinging.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer c.pinging.Store(false)
		ctx, cancel := context.WithTimeout(ctx, pingTimeout)
		defer cancel()
		if err := c.conn.Ping(ctx); err != nil {
			c.close(websocket.StatusGoingAway, "geen antwoord")
		}
	}()
}

// readLoop decodes messages and hands them to the server until the
// connection fails or is closed.
func (c *client) readLoop(ctx context.Context) {
	c.conn.SetReadLimit(maxMessageBytes)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-c.quit:
			// Give the writer time to flush and close cleanly, then make
			// sure Read returns.
			t := time.NewTimer(writeTimeout)
			defer t.Stop()
			select {
			case <-t.C:
				cancel()
			case <-ctx.Done():
			}
		case <-ctx.Done():
		}
	}()
	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		if !c.bucket.take(time.Now()) {
			c.closeWithError(errLimit, "Te veel berichten tegelijk; de verbinding is verbroken.", websocket.StatusPolicyViolation)
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var m inMsg
		if err := json.Unmarshal(data, &m); err != nil {
			c.sendError(errInvalid, "Dat bericht begrijp ik niet.")
			continue
		}
		c.srv.dispatch(c, &m)
	}
}

// isClosed reports whether the connection is closing.
func (c *client) isClosed() bool {
	select {
	case <-c.quit:
		return true
	default:
		return false
	}
}

// tokenBucket is a simple rate limiter: max tokens, refilled at rate/s.
type tokenBucket struct {
	tokens, max, rate float64
	last              time.Time
}

func (b *tokenBucket) take(now time.Time) bool {
	if !b.last.IsZero() {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.max {
			b.tokens = b.max
		}
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
