import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker from "../worker.js";

const root = new URL("../", import.meta.url);

// Mock the ASSETS binding: serve project files by pathname, so the Worker
// can read source.html, external scripts and stylesheets.
const env = {
    ASSETS: {
        async fetch(request) {
            const path = new URL(request.url).pathname.slice(1);

            try {
                const body = readFileSync(fileURLToPath(new URL(path, root)));

                return new Response(body, { status: 200 });
            } catch {
                return new Response("Not found", { status: 404 });
            }
        }
    }
};

const base = "https://occultus.test";

async function get(path) {
    return worker.fetch(new Request(base + path), env);
}

async function post(path, body) {
    return worker.fetch(
        new Request(base + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }),
        env
    );
}

// 1. Initial load.
let res = await get("/");
if (res.status !== 200) throw new Error("load failed: " + res.status);
let html = await res.text();

if (html.includes("let count = 0")) {
    throw new Error("application script leaked to the browser");
}
if (!html.includes("__occultus_event")) {
    throw new Error("runtime not injected");
}

// 2. Resource URLs are routed through the Worker.
if (!html.includes('href="/__occultus_resource/assets/app.css"')) {
    throw new Error("stylesheet URL was not rewritten");
}
if (!html.includes('src="/__occultus_resource/assets/logo.svg"')) {
    throw new Error("image URL was not rewritten");
}
if (/<script\b[^>]*\bsrc=/i.test(html)) {
    throw new Error("external script tag leaked to the browser");
}

// 3. Resources are served with the right content type.
res = await get("/__occultus_resource/assets/app.css");
if (res.status !== 200) throw new Error("stylesheet not served: " + res.status);
if (!/text\/css/.test(res.headers.get("Content-Type") || "")) {
    throw new Error("stylesheet content type is wrong");
}
if (!(await res.text()).includes("#counter")) {
    throw new Error("stylesheet body is wrong");
}

res = await get("/__occultus_resource/assets/logo.svg");
if (res.status !== 200) throw new Error("image not served: " + res.status);
if (!/image\/svg\+xml/.test(res.headers.get("Content-Type") || "")) {
    throw new Error("image content type is wrong");
}

// 4. Application code is never served as a resource.
res = await get("/__occultus_resource/assets/app.js");
if (res.status !== 404) throw new Error("external script should not be served");

res = await get("/__occultus_resource/source.html");
if (res.status !== 404) throw new Error("source.html should not be served");

res = await get("/__occultus_resource/../source.html");
if (res.status !== 404) throw new Error("path traversal should not be served");

// 5. Click increment (new session).
res = await post("/__occultus_event", {
    sessionId: "test-session",
    html,
    action: { type: "click", target: "increment" }
});
if (res.status !== 200) throw new Error("event failed: " + res.status);
let state = await res.json();

if (!state.html.includes("Count: 1")) throw new Error("increment didn't apply");
if (state.html.includes("let count = 0")) {
    throw new Error("app script leaked after event");
}

// 6. Click increment again -> 2.
res = await post("/__occultus_event", {
    sessionId: "test-session",
    html: state.html,
    action: { type: "click", target: "increment" }
});
state = await res.json();
if (!state.html.includes("Count: 2")) throw new Error("second increment failed");

// 7. Change message.
res = await post("/__occultus_event", {
    sessionId: "test-session",
    html: state.html,
    action: { type: "click", target: "change" }
});
state = await res.json();
if (!state.html.includes("This was changed by secret JS.")) {
    throw new Error("change failed");
}
if (!state.html.includes("Count: 2")) throw new Error("counter regressed after change");

// 8. The external script ran server-side: reset works.
res = await post("/__occultus_event", {
    sessionId: "test-session",
    html: state.html,
    action: { type: "click", target: "reset" }
});
state = await res.json();
if (!state.html.includes("Count: 0")) {
    throw new Error("external script did not run (reset failed)");
}
if (!state.html.includes("Reset by external script.")) {
    throw new Error("external script message missing");
}
if (!state.html.includes('src="/__occultus_resource/assets/logo.svg"')) {
    throw new Error("resource URL lost after re-render");
}

// 9. /source.html is hidden.
res = await get("/source.html");
if (res.status !== 404) throw new Error("source.html should be 404");

console.log("Full Worker request flow passed (load, resources, event, secrecy).");
