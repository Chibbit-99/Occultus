import { readFileSync } from "node:fs";

import { createSession, applyAction, serialize } from "./worker.js";

const source = readFileSync("./test-extra.html", "utf8");

const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => ({ attributes: "", code: m[1] }));

const session = createSession(source, scripts);

// Two different clicks, two separate counters.
applyAction(session, { type: "click", target: "go" });
applyAction(session, { type: "click", target: "go" });

let html = serialize(session.dom.root);
if (!html.includes("Count: 10")) throw new Error("count should be 10");
if (!html.includes("Other: 2")) throw new Error("other should be 2");

// Reset works too.
applyAction(session, { type: "click", target: "reset" });
html = serialize(session.dom.root);
if (!html.includes("Count: 0")) throw new Error("reset failed");

console.log("Extra functions (multi-counter, reset) work.");
