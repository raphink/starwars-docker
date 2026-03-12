package restapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Event represents a single API activity event broadcast to SSE clients.
type Event struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`  // RFC3339Nano UTC
	Type      string `json:"type"`       // "request-landing" | "exhaust-port" | "connected" | "shield" | "other"
	Endpoint  string `json:"endpoint"`   // raw request path
	Method    string `json:"method"`     // HTTP method
	Source    string `json:"source"`     // client IP (port stripped)
	Status    int    `json:"status"`     // HTTP status code
	LatencyMs int64  `json:"latency_ms"` // handler duration in ms
	Identity  string `json:"identity"`   // X-Source-Identity, or first X-Forwarded-For, or ""
	Allowed   bool   `json:"allowed"`    // status < 400
	Level     string `json:"level,omitempty"` // for "shield" events: "none" | "l3l4" | "l7"
}

// Hub manages SSE client connections and broadcasts events to all of them.
type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	counter atomic.Int64
}

// globalHub is the singleton hub wired into the middleware and the /v1/events handler.
var globalHub = &Hub{
	clients: make(map[chan []byte]struct{}),
}

// nextID returns the next monotonic event ID as a string.
func (h *Hub) nextID() string {
	return fmt.Sprintf("%d", h.counter.Add(1))
}

// Broadcast serialises e and pushes the SSE frame to every registered client.
// Slow clients (full channel buffer) are skipped — they lose that event rather than blocking.
func (h *Hub) Broadcast(e Event) {
	e.ID = h.nextID()
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	// SSE frame: id / event / data lines followed by a blank line.
	frame := []byte(fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", e.ID, e.Type, data))

	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- frame:
		default:
			// client channel full — drop this event for that client
		}
	}
}

// register adds a client channel to the hub.
func (h *Hub) register(ch chan []byte) {
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
}

// unregister removes a client channel from the hub.
func (h *Hub) unregister(ch chan []byte) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
}

// ServeHTTP handles GET /v1/events as a Server-Sent Events stream.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// SSE headers — X-Accel-Buffering disables Nginx proxy buffering.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := make(chan []byte, 64)
	h.register(ch)
	defer func() {
		h.unregister(ch)
		close(ch)
	}()

	// Announce the new connection.
	h.Broadcast(Event{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Type:      "connected",
		Endpoint:  r.URL.Path,
		Method:    r.Method,
		Status:    http.StatusOK,
		Allowed:   true,
	})

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case frame, open := <-ch:
			if !open {
				return
			}
			_, err := w.Write(frame)
			if err != nil {
				return
			}
			flusher.Flush()

		case <-keepalive.C:
			_, err := fmt.Fprint(w, ": keepalive\n\n")
			if err != nil {
				return
			}
			flusher.Flush()

		case <-r.Context().Done():
			return
		}
	}
}
