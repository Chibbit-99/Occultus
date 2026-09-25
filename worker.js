/**
 * Minimal server-driven frontend prototype for Cloudflare Workers.
 *
 * index.html is treated as the initial document. Application state and
 * event handlers live on the Worker. The browser receives only HTML and
 * mutation patches.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(INDEX_HTML, {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/_secret/event") {
      return handleEvent(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// In a real implementation this would be loaded from index.html at build time.
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secret Frontend Demo</title>
</head>
<body>
  <main id="app">
    <h1 id="title">Hello</h1>
    <p id="count">0</p>
    <button id="increment">Increment</button>
  </main>
  <script>
    (() => {
      const send = async (event) => {
        const response = await fetch('/_secret/event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event)
        });

        if (!response.ok) return;

        const message = await response.json();
        applyPatches(message.patches || []);
      };

      const applyPatches = (patches) => {
        for (const patch of patches) {
          const node = document.querySelector(`[data-secret-id="${CSS.escape(patch.id)}"]`);
          if (!node) continue;

          if (patch.type === 'text') node.textContent = patch.value;
          if (patch.type === 'html') node.innerHTML = patch.value;
          if (patch.type === 'attribute') {
            if (patch.value == null) node.removeAttribute(patch.name);
            else node.setAttribute(patch.name, patch.value);
          }
          if (patch.type === 'property') node[patch.name] = patch.value;
          if (patch.type === 'remove') node.remove();
        }
      };

      // Event delegation means the client does not need application handlers.
      document.addEventListener('click', (event) => {
        const target = event.target.closest('[data-secret-id]');
        if (!target) return;

        send({
          type: 'click',
          target: target.dataset.secretId
        });
      });
    })();
  </script>
</body>
</html>`;

async function handleEvent(request) {
  const event = await request.json();

  // Demo state only. Durable Objects should be used for real per-user state.
  if (event.type !== "click" || event.target !== "increment") {
    return Response.json({ patches: [] });
  }

  // Replace this with your server-side DOM/state engine.
  const count = 1;

  return Response.json({
    patches: [
      {
        type: "text",
        id: "count",
        value: String(count),
      },
    ],
  });
}
