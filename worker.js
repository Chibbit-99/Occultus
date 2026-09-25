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
|     action: {
|         type: "click",
|         target: "increment"
|     }
| }
|
| `html` is ALWAYS the browser's current state.
|
*/

async function handleEvent(request, env) {
    let data;

    try {
        data = await request.json();
    } catch {
        return Response.json(
            {
                error: "Invalid JSON."
            },
            {
                status: 400
            }
        );
    }

    if (
        typeof data.html !== "string" ||
        !data.action ||
        typeof data.action !== "object"
    ) {
        return Response.json(
            {
                error: "Missing html or action."
            },
            {
                status: 400
            }
        );
    }

    /*
     * Load the original source ONLY to obtain the
     * application's secret JavaScript.
     *
     * The source HTML itself is NOT used as the
     * current DOM state.
     */
    const source = await getSource(env);

    if (!source) {
        return Response.json(
            {
                error: "Application source unavailable."
            },
            {
                status: 500
            }
        );
    }

    const applicationScripts = extractApplicationScripts(source);

    /*
     * Transform the HTML that the browser actually sent.
     */
    let updatedHTML = await executeApplication(
        data.html,
        data.action,
        applicationScripts
    );

    /*
     * Absolutely no application JavaScript is allowed
     * to reach the browser.
     */
    updatedHTML = removeApplicationScripts(updatedHTML);

    /*
     * Add the ONLY JavaScript the browser receives.
     */
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
| Extract application JavaScript
|--------------------------------------------------------------------------
|
| This is currently kept separate so the next step can execute
| these scripts inside a server-side DOM environment.
|
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
| Browser communication runtime
|--------------------------------------------------------------------------
|
| This is the ONLY JavaScript that gets sent to the browser.
|
| It does NOT contain application logic.
|
| Its only job is:
|
|   browser DOM
|       ↓
|   current HTML
|       +
|   user action
|       ↓
|   Worker
|       ↓
|   transformed HTML
|       ↓
|   browser DOM
|
*/

function injectRuntime(html) {
    const runtime = `
<script>
(() => {
    async function send(action) {
        try {
            const currentHTML =
                document.documentElement.outerHTML;

            const response = await fetch(
                "/__occultus_event",
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json"
                    },

                    body: JSON.stringify({
                        html: currentHTML,
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

            /*
             * Replace the entire DOM with the state
             * returned by the Worker.
             */
            document.open();
            document.write(result.html);
            document.close();

        } catch (error) {
            console.error(
                "Occultus communication error:",
                error
            );
        }
    }


    /*
     * Generic event detection.
     *
     * The application itself does not need to contain
     * browser-side event listeners.
     */
    document.addEventListener(
        "click",
        event => {
            const element =
                event.target.closest("[id]");

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
| Execute application
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| `html` is the CURRENT browser state.
|
| The Worker does NOT recreate the page.
| It transforms the HTML it received.
|
| `applicationScripts` contains the secret JS from
| source.html and will eventually be executed against
| a server-side DOM implementation.
|
*/

async function executeApplication(
    html,
    action,
    applicationScripts
) {
    /*
     * Temporary execution layer.
     *
     * This section demonstrates the intended behaviour
     * until the actual server-side JavaScript/DOM runtime
     * is implemented.
     *
     * Notice that every modification starts with `html`,
     * which came directly from the browser.
     */

    if (
        action.type === "click" &&
        action.target === "increment"
    ) {
        html = incrementCounter(html);
    }

    if (
        action.type === "click" &&
        action.target === "change"
    ) {
        html = changeMessage(html);
    }

    return html;
}


/*
|--------------------------------------------------------------------------
| Increment
|--------------------------------------------------------------------------
|
| Reads the CURRENT counter from the HTML.
|
| 0 → 1
| 1 → 2
| 2 → 3
| ...
|
*/

function incrementCounter(html) {
    const counterRegex =
        /(<p\b[^>]*\bid=["']counter["'][^>]*>)[\s\S]*?(\d+)([\s\S]*?<\/p>)/i;

    const match = html.match(counterRegex);

    if (!match) {
        return html;
    }

    const currentCount =
        Number(match[2]);

    const newCount =
        currentCount + 1;

    html = html.replace(
        match[0],
        `${match[1]}Count: ${newCount}${match[3]}`
    );

    /*
     * Update the message using the SAME new state.
     */
    html = html.replace(
        /(<p\b[^>]*\bid=["']message["'][^>]*>)[\s\S]*?(<\/p>)/i,
        `$1Clicked ${newCount} times.$2`
    );

    return html;
}


/*
|--------------------------------------------------------------------------
| Change message
|--------------------------------------------------------------------------
*/

function changeMessage(html) {
    return html.replace(
        /(<p\b[^>]*\bid=["']message["'][^>]*>)[\s\S]*?(<\/p>)/i,
        `$1This was changed by secret JS.$2`
    );
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
                "Content-Type":
                    "text/html; charset=UTF-8",

                "Cache-Control":
                    "no-store"
            }
        }
    );
}
