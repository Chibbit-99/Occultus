import { readFileSync } from "node:fs";

import worker from "./worker.js";

const source = readFileSync("./source.html", "utf8");

// Mock the ASSETS binding so getSource() can read source.html.
const env = {
    ASSETS: {
        async fetch() {
            return new Response(source, { status: 200 });
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

// 2. Click increment (new session).
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

// 3. Click increment again -> 2.
res = await post("/__occultus_event", {
    sessionId: "test-session",
    html: state.html,
    action: { type: "click", target: "increment" }
});
state = await res.json();
if (!state.html.includes("Count: 2")) throw new Error("second increment failed");

// 4. Change message.
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

// 5. /source.html is hidden.
res = await get("/source.html");
if (res.status !== 404) throw new Error("source.html should be 404");

console.log("Full Worker request flow passed (load, event, secrecy).");
