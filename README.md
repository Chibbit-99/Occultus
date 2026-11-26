# Secret Frontend — Cloudflare Worker prototype

This is a prototype of a server-driven frontend. The whole application runs
on the Worker; the browser receives only a tiny communication runtime, never
the application's JavaScript.

## How it works

- `source.html` is the source document. It contains the application's
  "secret" JavaScript as normal `<script>` blocks.
- `worker.js` handles requests and application events:

  1. On load, it reads `source.html`, strips the application scripts, and
     injects a generic communication runtime into the page.
  2. When the browser reports an action, the Worker **runs the application
     script** against a built-in server-side DOM engine, then sends back the
     transformed HTML.
  3. The browser replaces its DOM with that HTML. Per-client application
     state is kept in memory, keyed by a session id the browser mints.

Instead of hard-coding a couple of HTML-string rewrites, `worker.js` now
includes a small DOM engine (parser, element API, event dispatch) so the
application's JavaScript really executes server-side. That means you can add
more functions, elements, listeners, and state to `source.html` and the
Worker will run them — no per-action code needed in `worker.js`.

The demo intentionally does not claim to make HTML or behavior secret:
anything sent to the browser can be inspected. The goal is to keep the
application's code on the Worker.

## Project layout

| File | Role |
|------|------|
| `worker.js` | The Worker: routing, sessions, the server-side DOM engine, script extraction/removal, runtime injection, event handling. |
| `source.html` | The "real" application. Its `<script>` blocks are extracted and executed server-side. Never served to the browser. |
| `wrangler.toml` | Cloudflare Worker config (`name`, `main`, `ASSETS` binding, `run_worker_first`). |
| `test.js` | Runs the original examples (increment, change) against the server DOM. |
| `test-extra.html` / `test-extra.js` | Demonstrates that new functions (e.g. a second counter) work without Worker changes. |

## Running

```bash
npm install -g wrangler
wrangler dev
```

Open the printed local URL and click the buttons. Each click posts to the
Worker and re-renders the page. In DevTools view-source, the only script
you should see is the injected runtime — the application script from
`source.html` never reaches the browser, and `/source.html` returns 404.

## Testing

The server-side DOM engine is validated without a browser:

```bash
node test.js
node test-extra.js
```

`test.js` checks the two original interactions (increment, change) plus
session isolation; `test-extra.js` adds functions the prototype never had
(a second counter, a reset) and confirms they run untoched.

## Known limitations / next steps

- The DOM engine is deliberately small. It supports elements, attributes,
  `id`, `textContent`, `addEventListener`, and `dispatchEvent` — enough for a
  typical script, but not a full browser DOM.
- Session state lives in an in-memory `Map` on the Worker. For a production
  build, move it into a Durable Object so it survives restarts and scales.
