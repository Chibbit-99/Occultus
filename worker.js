/*
|--------------------------------------------------------------------------
| Occultus — Secret Frontend prototype (Cloudflare Worker)
|--------------------------------------------------------------------------
|
| The whole application runs on the Worker. The browser receives only a
| tiny communication runtime, never the application's JavaScript.
|
| This version ships a small server-side DOM engine. The application
| script from source.html is executed inside the Worker against a
| lightweight DOM implementation, so any of its behaviour — elements,
| listeners, state, DOM writes — behaves like a normal page.
|
| Per-client application state lives in memory, keyed by a session id
| the browser generates. A production build would back this with a
| Durable Object so state survives Worker restarts.
|
*/

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Initial application load
        if (request.method === "GET" && url.pathname === "/") {
            return serveApplication(env);
        }

        // Browser -> Worker application events
        if (
            request.method === "POST" &&
            url.pathname === "/__occultus_event"
        ) {
            return handleEvent(request, env);
        }

        // Resources referenced by source.html (images, stylesheets...)
        if (url.pathname.startsWith(RESOURCE_PREFIX)) {
            return serveResource(env, url.pathname);
        }

        // Never expose the original source file
        if (url.pathname === "/source.html") {
            return new Response("Not found", {
                status: 404
            });
        }

        return new Response("Not found", {
            status: 404
        });
    }
};


/*
|--------------------------------------------------------------------------
| Sessions
|--------------------------------------------------------------------------
|
| Each browser tab gets its own execution context, so the application's
| JavaScript state (e.g. the `count` variable) is isolated per client.
|
| This is an in-memory Map: the Worker is stateless across restarts, so
| this is a demo-grade store. The README notes that a Durable Object is
| the intended durable replacement.
|
*/

const sessions = new Map();
const MAX_SESSIONS = 256;

function getSession(sessionId, html, scripts) {
    const id = typeof sessionId === "string" ? sessionId : "default";

    let session = sessions.get(id);

    if (!session) {
        session = createSession(html, scripts);
        sessions.set(id, session);

        // Keep the map bounded.
        while (sessions.size > MAX_SESSIONS) {
            sessions.delete(sessions.keys().next().value);
        }
    }

    return session;
}


/*
|--------------------------------------------------------------------------
| Initial page
|--------------------------------------------------------------------------
|
| source.html is the actual application source.
|
| The Worker:
|   1. Reads source.html
|   2. Removes application scripts
|   3. Injects the tiny communication runtime
|   4. Sends the transformed HTML to the browser
|
*/

async function serveApplication(env) {
    const source = await getSource(env);

    if (!source) {
        return new Response(
            "Application source unavailable.",
            { status: 500 }
        );
    }

    let html = removeApplicationScripts(source);

    // Point images/stylesheets at the Worker's resource route.
    html = rewriteResourceURLs(html);

    html = injectRuntime(html);

    return htmlResponse(html);
}


/*
|--------------------------------------------------------------------------
| Application events
|--------------------------------------------------------------------------
|
| The browser sends:
|
| {
|     html: "<!DOCTYPE html>...",
|     sessionId: "s_...",
|     action: {
|         type: "click",
|         target: "increment"
|     }
| }
|
| `html` is ALWAYS the browser's current state, but it is not used for
| state here: the server-side DOM tree is authoritative for the session.
|
*/

async function handleEvent(request, env) {
    let data;

    try {
        data = await request.json();
    } catch {
        return Response.json(
            { error: "Invalid JSON." },
            { status: 400 }
        );
    }

    if (
        typeof data.html !== "string" ||
        !data.action ||
        typeof data.action !== "object"
    ) {
        return Response.json(
            { error: "Missing html or action." },
            { status: 400 }
        );
    }

    const source = await getSource(env);

    if (!source) {
        return Response.json(
            { error: "Application source unavailable." },
            { status: 500 }
        );
    }

    const applicationScripts = await loadApplicationScripts(source, env);

    // Obtain (or create) the client's server-side execution context.
    const session = getSession(
        data.sessionId,
        data.html,
        applicationScripts
    );

    // Run the action against the server-side DOM.
    applyAction(session, data.action);

    let updatedHTML = serialize(session.dom.root);

    // Absolutely no application JavaScript is allowed to reach the browser.
    updatedHTML = removeApplicationScripts(updatedHTML);

    // Keep resource URLs on the Worker route after re-rendering.
    updatedHTML = rewriteResourceURLs(updatedHTML);

    // Add the ONLY JavaScript the browser receives.
    updatedHTML = injectRuntime(updatedHTML);

    return Response.json({
        html: updatedHTML
    });
}


/*
|--------------------------------------------------------------------------
| Get source.html
|--------------------------------------------------------------------------
*/

async function getSource(env) {
    const response = await env.ASSETS.fetch(
        new Request(
            "https://occultus.internal/source.html"
        )
    );

    if (!response.ok) {
        return null;
    }

    return await response.text();
}


/*
|--------------------------------------------------------------------------
| Resources (images, stylesheets, other static files)
|--------------------------------------------------------------------------
|
| source.html can reference files next to it:
|
|   <link rel="stylesheet" href="assets/app.css">
|   <img src="assets/logo.svg">
|   <script src="assets/app.js"></script>
|
| Stylesheets and images are proxied through the Worker under
| RESOURCE_PREFIX, so the browser never needs direct access to the
| project folder. JavaScript files are NOT proxied: they are application
| code, so they are loaded by the Worker and executed server-side
| (see loadApplicationScripts).
|
*/

const RESOURCE_PREFIX = "/__occultus_resource/";

// Files that must never be handed to the browser as a resource.
const SECRET_FILE = /(?:^|\/)(?:source\.html?)$|\.(?:m?js|html?)$/i;

// Point local resource URLs at the Worker's resource route.
function rewriteResourceURLs(html) {
    return html.replace(
        /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g,
        (full, tagName, attrs) => {
            const tag = tagName.toLowerCase();

            // Only <link> uses href for resources; <a href> is navigation.
            const names = tag === "link" ? ["src", "href"] : ["src", "poster"];

            const rewritten = attrs.replace(
                /(\s)(src|href|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
                (match, space, name, equals, dq, sq, uq) => {
                    if (!names.includes(name.toLowerCase())) return match;

                    const value = dq ?? sq ?? uq ?? "";
                    const next = resourceURL(value);

                    if (next === value) return match;

                    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
                    return `${space}${name}${equals}${quote}${next}${quote}`;
                }
            );

            return `<${tagName}${rewritten}>`;
        }
    );
}

function resourceURL(value) {
    const url = value.trim();

    if (!url) return value;

    // Anchors, data/blob URLs, and absolute URLs are left untouched.
    if (url.startsWith("#")) return value;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return value;

    // Already routed through the Worker.
    if (url.startsWith(RESOURCE_PREFIX)) return value;

    // Keep any query string or fragment after the rewritten path.
    const split = url.search(/[?#]/);
    const suffix = split < 0 ? "" : url.slice(split);
    const path = normalizeResourcePath(split < 0 ? url : url.slice(0, split));

    // Escaping paths are left alone; the Worker will answer 404.
    if (!path) return value;

    return RESOURCE_PREFIX + path + suffix;
}

// Resolve a local URL to a project-relative path. Returns "" for an empty
// path and null when the path climbs out of the project root.
function normalizeResourcePath(path) {
    const parts = [];

    for (const part of path.trim().replace(/\\/g, "/").split("/")) {
        if (!part || part === ".") continue;

        if (part === "..") {
            if (parts.length === 0) return null;
            parts.pop();
            continue;
        }

        parts.push(part);
    }

    return parts.join("/");
}

async function serveResource(env, pathname) {
    let path;

    try {
        path = decodeURIComponent(
            pathname.slice(RESOURCE_PREFIX.length)
        );
    } catch {
        return notFound();
    }

    path = normalizeResourcePath(path.split(/[?#]/)[0]);

    if (!path) {
        return notFound();
    }

    // Application code and the source document stay on the Worker.
    if (SECRET_FILE.test(path)) {
        return notFound();
    }

    let response;

    try {
        response = await env.ASSETS.fetch(
            new Request("https://occultus.internal/" + path)
        );
    } catch {
        return notFound();
    }

    if (!response.ok) {
        return notFound();
    }

    const headers = new Headers();

    headers.set(
        "Content-Type",
        response.headers.get("Content-Type") || contentTypeFor(path)
    );
    headers.set("Cache-Control", "public, max-age=3600");

    return new Response(response.body, { status: 200, headers });
}

function contentTypeFor(path) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

    const types = {
        css: "text/css; charset=UTF-8",
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        avif: "image/avif",
        ico: "image/x-icon",
        woff: "font/woff",
        woff2: "font/woff2",
        ttf: "font/ttf",
        json: "application/json",
        txt: "text/plain; charset=UTF-8"
    };

    return types[ext] || "application/octet-stream";
}

function notFound() {
    return new Response("Not found", { status: 404 });
}


/*
|--------------------------------------------------------------------------
| Load application JavaScript (inline and <script src>)
|--------------------------------------------------------------------------
|
| Scripts are executed by the Worker, never by the browser. A script that
| lives in its own file is read from the assets binding, so it stays as
| secret as an inline one.
|
*/

async function loadApplicationScripts(html, env) {
    const scripts = [];

    const regex =
        /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const attributes = match[1];
        const code = match[2];
        const src = getAttribute(attributes, "src");

        if (!src) {
            scripts.push({ attributes, code });
            continue;
        }

        const path = localScriptPath(src);

        // Remote scripts are not fetched: only the project's own code runs.
        if (!path) continue;

        let response;

        try {
            response = await env.ASSETS.fetch(
                new Request("https://occultus.internal/" + path)
            );
        } catch {
            continue;
        }

        if (!response.ok) continue;

        scripts.push({ attributes, code: await response.text() });
    }

    return scripts;
}

function localScriptPath(src) {
    const url = src.trim();

    if (!url) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return null;

    const path = normalizeResourcePath(url.split(/[?#]/)[0]);

    return path || null;
}

function getAttribute(attributes, name) {
    const re = new RegExp(
        `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
        "i"
    );

    const match = attributes.match(re);

    return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}


/*
|--------------------------------------------------------------------------
| Extract application JavaScript
|--------------------------------------------------------------------------
*/

function extractApplicationScripts(html) {
    const scripts = [];

    const regex =
        /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        scripts.push({
            attributes: match[1],
            code: match[2]
        });
    }

    return scripts;
}


/*
|--------------------------------------------------------------------------
| Remove application JavaScript
|--------------------------------------------------------------------------
*/

function removeApplicationScripts(html) {
    return html.replace(
        /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
        ""
    );
}


/*
|--------------------------------------------------------------------------
| Server-side DOM
|--------------------------------------------------------------------------
|
| A deliberately small DOM engine, sized to run the application script
| from source.html (elements, attributes, textContent, addEventListener).
|
| It is intentionally tiny and not a full browser DOM: it implements only
| what a typical application script needs. The key point is that the
| application's JS actually executes here, instead of being faked by
| hand-written HTML string surgery.
|
*/

const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "param", "source", "track", "wbr"
]);

function parseHTML(html) {
    const root = {
        tag: "#root",
        attrs: {},
        children: [],
        parent: null
    };

    const stack = [root];
    const n = html.length;
    let i = 0;

    while (i < n) {
        const ch = html[i];

        // Text up to the next tag.
        if (ch !== "<") {
            let j = html.indexOf("<", i);
            if (j < 0) j = n;

            const text = html.slice(i, j);
            if (text) stack[stack.length - 1].children.push(text);

            i = j;
            continue;
        }

        // Comment.
        if (html.startsWith("<!--", i)) {
            let e = html.indexOf("-->", i + 4);
            if (e < 0) e = n;
            i = e + 3;
            continue;
        }

        // Doctype / declarations.
        if (html.startsWith("<!", i)) {
            const m = html.slice(i).match(/^<![^>]*>/);
            i += m ? m[0].length : 1;
            continue;
        }

        // Processing instructions.
        if (html.startsWith("<?", i)) {
            const m = html.slice(i).match(/^<\?[^>]*\?>/);
            i += m ? m[0].length : 1;
            continue;
        }

        // Closing tag.
        if (html.startsWith("</", i)) {
            const m = html.slice(i).match(
                /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/
            );
            if (m) {
                const tag = m[1].toLowerCase();
                while (
                    stack.length > 1 &&
                    stack[stack.length - 1].tag !== tag
                ) {
                    stack.pop();
                }
                if (stack.length > 1) stack.pop();
                i += m[0].length;
            } else {
                i++;
            }
            continue;
        }

        // Opening tag.
        const m = html.slice(i).match(
            /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/
        );
        if (!m) {
            i++;
            continue;
        }

        const tag = m[1].toLowerCase();
        const attrs = parseAttrs(m[2]);
        const selfClose = !!m[3];

        const parent = stack[stack.length - 1];
        const el = { tag, attrs, children: [], parent };

        parent.children.push(el);
        i += m[0].length;

        if (selfClose || VOID_ELEMENTS.has(tag)) {
            continue;
        }

        stack.push(el);

        // Script and style bodies are raw text until their closing tag.
        if (tag === "script" || tag === "style") {
            const close = "</" + tag;
            const e = html.toLowerCase().indexOf(close, i);
            const end = e < 0 ? n : e;

            el.children.push(html.slice(i, end));
            i = e < 0 ? n : e + close.length;
            stack.pop();
        }
    }

    return root;
}

function parseAttrs(str) {
    const attrs = {};
    const re =
        /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

    let m;
    while ((m = re.exec(str)) !== null) {
        attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
    }

    return attrs;
}

function isVoid(tag) {
    return VOID_ELEMENTS.has(tag);
}

function findByID(node, id) {
    if (node.attrs && node.attrs.id === id) return node;

    for (const child of node.children) {
        if (typeof child === "string") continue;
        const found = findByID(child, id);
        if (found) return found;
    }

    return null;
}

function collectText(node) {
    if (typeof node === "string") return node;
    return node.children.map(collectText).join("");
}

function serialize(node) {
    if (typeof node === "string") return node;

    if (node.tag === "#root") {
        return node.children.map(serialize).join("");
    }

    const attrStr = Object.entries(node.attrs)
        .map(([k, v]) => (v === "" ? k : `${k}="${v}"`))
        .join(" ");

    const open = `<${node.tag}${attrStr ? " " + attrStr : ""}>`;

    if (isVoid(node.tag)) {
        return open;
    }

    return open + node.children.map(serialize).join("") + `</${node.tag}>`;
}

/*
| Add the DOM element API to a parsed node. Nodes are plain objects from
| the parser; we attach methods/properties lazily so handlers registered
| by the application script keep working across the session's lifetime.
*/
function ensureElementAPI(node) {
    if (node.__api) return node;
    node.__api = true;

    node._handlers = {};

    Object.defineProperty(node, "id", {
        get() { return this.attrs.id ?? ""; },
        configurable: true
    });

    Object.defineProperty(node, "textContent", {
        get() { return collectText(this); },
        set(value) { this.children = [String(value)]; },
        configurable: true
    });

    Object.defineProperty(node, "outerHTML", {
        get() { return serialize(this); },
        configurable: true
    });

    node.addEventListener = function (type, fn) {
        (this._handlers[type] ||= []).push(fn);
    };

    node.dispatchEvent = function (event) {
        event.target = this;
        const handlers = this._handlers[event.type] || [];
        for (const fn of handlers) {
            fn(event);
        }
    };

    return node;
}

function createDocument(dom) {
    return {
        getElementById(id) {
            const found = dom.root ? findByID(dom.root, id) : null;
            return found ? ensureElementAPI(found) : null;
        },
        addEventListener() {
            // Reserved for future document-level listeners.
        },
        createElement() {
            throw new Error("createElement is not supported by the server DOM");
        }
    };
}


/*
|--------------------------------------------------------------------------
| Execute application
|--------------------------------------------------------------------------
|
| The application script runs once per session, inside a fresh server-side
| DOM. Its closures (variables like `count`, and registered listeners) live
| for the whole session, so state persists between events exactly as it
| would on a normal page.
|
*/

function createSession(html, scripts) {
    const dom = { root: parseHTML(html) };
    const document = createDocument(dom);

    const code = scripts.map(s => s.code).join("\n");

    const fn = new Function("document", "window", "self", "globalThis", code);
    fn(document, {}, {}, {});

    return { dom, document };
}

function applyAction(session, action) {
    if (!action || typeof action.target !== "string") return;

    const el = session.document.getElementById(action.target);

    if (el && typeof el.dispatchEvent === "function") {
        el.dispatchEvent({ type: action.type || "click" });
    }
}


/*
|--------------------------------------------------------------------------
| Browser communication runtime
|--------------------------------------------------------------------------
|
| This is the ONLY JavaScript that gets sent to the browser.
|
| It does NOT contain application logic. Its only job is to send the
| current DOM plus the user's action to the Worker, and to replace the
| DOM with the transformed HTML the Worker returns.
|
| It also mints a stable session id (kept in sessionStorage) so the
| Worker can keep per-client application state.
|
*/

function injectRuntime(html) {
    const runtime = `
<script>
(() => {
    let sessionId;

    try {
        sessionId = sessionStorage.getItem("__occultus_sid");
    } catch (e) {
        sessionId = null;
    }

    if (!sessionId) {
        sessionId =
            "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2);

        try {
            sessionStorage.setItem("__occultus_sid", sessionId);
        } catch (e) {
            // Ignore storage failures; the id still lives for this page.
        }
    }

    async function send(action) {
        try {
            const currentHTML = document.documentElement.outerHTML;

            const response = await fetch(
                "/__occultus_event",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        html: currentHTML,
                        sessionId: sessionId,
                        action: action
                    })
                }
            );

            if (!response.ok) {
                console.error(
                    "Occultus request failed:",
                    await response.text()
                );
                return;
            }

            const result = await response.json();

            if (!result.html) {
                return;
            }

            // Replace the entire DOM with the Worker's state.
            document.open();
            document.write(result.html);
            document.close();

        } catch (error) {
            console.error("Occultus communication error:", error);
        }
    }

    // Generic event detection. The application itself needs no browser
    // side event listeners.
    document.addEventListener(
        "click",
        event => {
            const element = event.target.closest("[id]");

            if (!element) {
                return;
            }

            send({
                type: "click",
                target: element.id
            });
        }
    );
})();
</script>
`;

    if (/<\/body>/i.test(html)) {
        return html.replace(
            /<\/body>/i,
            runtime + "</body>"
        );
    }

    return html + runtime;
}


/*
|--------------------------------------------------------------------------
| HTML response
|--------------------------------------------------------------------------
*/

function htmlResponse(html) {
    return new Response(
        html,
        {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=UTF-8",
                "Cache-Control": "no-store"
            }
        }
    );
}


/*
|--------------------------------------------------------------------------
| Exports (also used by the test harness)
|--------------------------------------------------------------------------
*/

export {
    parseHTML,
    serialize,
    createSession,
    applyAction,
    extractApplicationScripts,
    loadApplicationScripts,
    removeApplicationScripts,
    rewriteResourceURLs,
    serveResource,
    RESOURCE_PREFIX
};
