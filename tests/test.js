import { readFileSync } from "node:fs";

import {
    parseHTML,
    serialize,
    createSession,
    applyAction,
    extractApplicationScripts
} from "../worker.js";

const source = readFileSync(
    new URL("../source.html", import.meta.url),
    "utf8"
);
const scripts = extractApplicationScripts(source);

console.log(`extracted ${scripts.length} script(s) from source.html`);

// 1. Create a session (runs the application script against the server DOM).
const session = createSession(source, scripts);

// 2. Simulate the "Increment" click.
applyAction(session, { type: "click", target: "increment" });

let html = serialize(session.dom.root);

if (!html.includes("Count: 1")) {
    console.error("FAIL: counter did not reach 1");
    process.exit(1);
}
if (!html.includes("Clicked 1 times.")) {
    console.error("FAIL: message did not mention 1 click");
    process.exit(1);
}

// 3. Click increment again -> count 2.
applyAction(session, { type: "click", target: "increment" });
html = serialize(session.dom.root);

if (!html.includes("Count: 2")) {
    console.error("FAIL: counter did not reach 2");
    process.exit(1);
}
if (!html.includes("Clicked 2 times.")) {
    console.error("FAIL: message did not mention 2 clicks");
    process.exit(1);
}

// 4. Click "change" -> message replaced, count untouched.
applyAction(session, { type: "click", target: "change" });
html = serialize(session.dom.root);

if (!html.includes("This was changed by secret JS.")) {
    console.error("FAIL: message not changed");
    process.exit(1);
}
if (!html.includes("Count: 2")) {
    console.error("FAIL: counter regressed after change");
    process.exit(1);
}

// 5. State isolation: a second session starts at 0.
const session2 = createSession(source, scripts);
applyAction(session2, { type: "click", target: "increment" });
const html2 = serialize(session2.dom.root);

if (!html2.includes("Count: 1")) {
    console.error("FAIL: session isolation failed");
    process.exit(1);
}

console.log("All server-side DOM tests passed.");
