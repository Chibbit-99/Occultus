# Secret Frontend — base Cloudflare Worker prototype

This is a minimal starting point for a server-driven frontend.

- `index.html` is the source document.
- `worker.js` handles requests and server-side application events.
- The browser receives a tiny transport/patch runtime rather than the application logic.

For a real implementation, move the application state into a Durable Object and replace the hard-coded patch generation with a server-side DOM implementation.

The demo intentionally does not claim to make HTML or behavior secret: anything sent to the browser can be inspected. The goal is to keep the application implementation on the Worker.
