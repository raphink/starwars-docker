package restapi

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	errors "github.com/go-openapi/errors"
	runtime "github.com/go-openapi/runtime"
	middleware "github.com/go-openapi/runtime/middleware"
	graceful "github.com/tylerb/graceful"

	"github.com/cilium/starwars-docker/restapi/operations"
)

// This file is safe to edit. Once it exists it will not be overwritten

//go:generate swagger generate server --target .. --name  --spec ../swagger.yaml

var backtrace = `Panic: deathstar exploded

goroutine 1 [running]:
main.HandleGarbage(0x2080c3f50, 0x2, 0x4, 0x425c0, 0x5, 0xa)
        /code/src/github.com/empire/deathstar/
        temp/main.go:9 +0x64
main.main()
        /code/src/github.com/empire/deathstar/
        temp/main.go:5 +0x85
`

var hostname, _ = os.Hostname()

var info = fmt.Sprintf(`{
	"name": "Death Star",
	"hostname": "%s",
	"model": "DS-1 Orbital Battle Station",
	"manufacturer": "Imperial Department of Military Research, Sienar Fleet Systems",
	"cost_in_credits": "1000000000000",
	"length": "120000",
	"crew": "342953",
	"passengers": "843342",
	"cargo_capacity": "1000000000000",
	"hyperdrive_rating": "4.0",
	"starship_class": "Deep Space Mobile Battlestation",
	"api": [
		"GET   /v1",
		"GET   /v1/healthz",
		"POST  /v1/request-landing",
		"PUT   /v1/cargobay",
		"GET   /v1/hyper-matter-reactor/status",
		"PUT   /v1/exhaust-port"
	]
}
`, hostname)

func configureFlags(api *operations.DeathstarAPI) {
	// api.CommandLineOptionsGroups = []swag.CommandLineOptionsGroup{ ... }
}

func configureAPI(api *operations.DeathstarAPI) http.Handler {
	// configure the api here
	api.ServeError = errors.ServeError

	// Set your custom logger if needed. Default one is log.Printf
	// Expected interface func(string, ...interface{})
	//
	// Example:
	// s.api.Logger = log.Printf

	api.JSONConsumer = runtime.JSONConsumer()

	api.TxtProducer = runtime.TextProducer()

	api.GetHandler = operations.GetHandlerFunc(func(params operations.GetParams) middleware.Responder {
		return operations.NewGetOK().WithPayload(info)
	})
	api.PutExhaustPortHandler = operations.PutExhaustPortHandlerFunc(func(params operations.PutExhaustPortParams) middleware.Responder {
		go func() {
			time.Sleep(2 * time.Second)
			panic("deathstar exploded")
		}()
		return operations.NewPutExhaustPortServiceUnavailable().WithPayload(backtrace)
	})
	api.PostRequestLandingHandler = operations.PostRequestLandingHandlerFunc(func(params operations.PostRequestLandingParams) middleware.Responder {
		return operations.NewPostRequestLandingOK().WithPayload("Ship landed\n")
	})

	api.ServerShutdown = func() {}

	return setupGlobalMiddleware(api.Serve(setupMiddlewares))
}

// The TLS configuration before HTTPS server starts.
func configureTLS(tlsConfig *tls.Config) {
	// Make all necessary changes to the TLS configuration here.
}

// As soon as server is initialized but not run yet, this function will be called.
// If you need to modify a config, store server instance to stop it individually later, this is the place.
// This function can be called multiple times, depending on the number of serving schemes.
// scheme value will be set accordingly: "http", "https" or "unix"
func configureServer(s *graceful.Server, scheme string) {
	// Disable write timeout so SSE connections can be held open indefinitely.
	s.WriteTimeout = 0
}

// The middleware configuration is for the handler executors. These do not apply to the swagger.json document.
// The middleware executes after routing but before authentication, binding and validation
func setupMiddlewares(handler http.Handler) http.Handler {
	return handler
}

// setupGlobalMiddleware wraps the entire handler stack. It:
//  1. Routes GET /v1/events to the SSE hub (before the swagger router sees it).
//  2. Routes PUT /v1/shield/{level} to the shield control handler.
//  3. Wraps every other request with a status-capturing recorder so each completed
//     request is broadcast as an Event to all connected SSE clients.
func setupGlobalMiddleware(handler http.Handler) http.Handler {
	mux := http.NewServeMux()

	// SSE endpoint — must be registered before the catch-all below.
	mux.Handle("/v1/events", globalHub)

	// Shield control — PUT /v1/shield/{level} where level is "none", "l3l4", or "l7".
	// This endpoint is intentionally not in the swagger spec; it is a demo control plane.
	mux.HandleFunc("/v1/shield/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		level := strings.TrimPrefix(r.URL.Path, "/v1/shield/")
		switch level {
		case "none", "l3l4", "l7":
		default:
			http.Error(w, `level must be "none", "l3l4", or "l7"`, http.StatusBadRequest)
			return
		}
		globalHub.Broadcast(Event{
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
			Type:      "shield",
			Level:     level,
			Allowed:   true,
		})
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "shield level set to %s\n", level)
	})

	// All other requests go through the swagger handler, wrapped by the event emitter.
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		handler.ServeHTTP(rec, r)

		globalHub.Broadcast(Event{
			Timestamp: start.UTC().Format(time.RFC3339Nano),
			Type:      eventType(r.URL.Path),
			Endpoint:  r.URL.Path,
			Method:    r.Method,
			Source:    resolveSource(r),
			Status:    rec.status,
			LatencyMs: time.Since(start).Milliseconds(),
			Identity:  resolveIdentity(r),
			Allowed:   rec.status < 400,
		})
	}))

	return mux
}

// eventType maps a request path to a named event type.
func eventType(path string) string {
	switch {
	case strings.HasSuffix(path, "/request-landing"):
		return "request-landing"
	case strings.HasSuffix(path, "/exhaust-port"):
		return "exhaust-port"
	default:
		return "other"
	}
}

// resolveSource returns the best available client IP for an event.
// Prefers X-Forwarded-For (set by Nginx proxy), falls back to RemoteAddr.
func resolveSource(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// X-Forwarded-For may be a comma-separated list; take the first entry.
		if idx := strings.IndexByte(xff, ','); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// resolveIdentity returns the caller's declared identity.
// Prefers X-Source-Identity (explicit label), falls back to X-Forwarded-For.
func resolveIdentity(r *http.Request) string {
	if id := r.Header.Get("X-Source-Identity"); id != "" {
		return id
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	return ""
}

// statusRecorder wraps http.ResponseWriter to capture the written status code.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}
