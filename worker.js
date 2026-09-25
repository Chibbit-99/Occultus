/*
 * OCCULTUS
 *
 * source.html
 *     ↓
 * Worker
 *     ↓
 * extract application JS
 *     ↓
 * remove application JS
 *     ↓
 * inject communication runtime
 *     ↓
 * browser
 *
 *
 * Browser interaction:
 *
 * browser
 *     ↓
 * current HTML + action
 *     ↓
 * Worker
 *     ↓
 * server-side application
 *     ↓
 * new HTML
 *     ↓
 * browser
 */


export default {

    async fetch(request, env) {

        const url = new URL(request.url);


        /*
         * ==================================================
         * ROOT PAGE
         * ==================================================
         */

        if (
            request.method === "GET" &&
            url.pathname === "/"
        ) {

            return serveApplication(env);
        }


        /*
         * ==================================================
         * EVENT
         * ==================================================
         */

        if (
            request.method === "POST" &&
            url.pathname === "/__occultus_event"
        ) {

            return handleEvent(
                request,
                env
            );
        }


        /*
         * Never expose source.html directly.
         */

        if (
            url.pathname === "/source.html"
        ) {

            return new Response(
                "Not found",
                {
                    status: 404
                }
            );
        }


        return new Response(
            "Not found",
            {
                status: 404
            }
        );
    }
};


/*
 * ==========================================================
 * SERVE APPLICATION
 * ==========================================================
 */

async function serveApplication(env) {

    /*
     * Read source.html from the Cloudflare Assets
     * system.
     */

    const response =
        await env.ASSETS.fetch(
            new Request(
                "https://occultus.internal/source.html"
            )
        );


    if (!response.ok) {

        return new Response(
            "source.html could not be found.",
            {
                status: 500
            }
        );
    }


    const source =
        await response.text();


    /*
     * Extract the actual application JavaScript.
     *
     * This remains on the Worker.
     */

    const application =
        extractApplication(source);


    /*
     * Remove the application JavaScript
     * from the HTML.
     */

    let html =
        removeScripts(source);


    /*
     * Inject ONLY the communication runtime.
     */

    html =
        injectRuntime(html);


    return htmlResponse(html);
}


/*
 * ==========================================================
 * HANDLE EVENT
 * ==========================================================
 */

async function handleEvent(request, env) {

    let data;


    try {

        data =
            await request.json();

    } catch {

        return Response.json(
            {
                error: "Invalid request."
            },
            {
                status: 400
            }
        );
    }


    /*
     * Expected:
     *
     * {
     *     html: "...",
     *
     *     action: {
     *         type: "click",
     *         target: "increment"
     *     }
     * }
     */

    if (
        typeof data.html !== "string" ||
        !data.action
    ) {

        return Response.json(
            {
                error:
                    "Missing html or action."
            },
            {
                status: 400
            }
        );
    }


    /*
     * Load the original source again.
     *
     * The application JS comes from the Worker-side
     * source, NOT from the HTML supplied by the client.
     */

    const sourceResponse =
        await env.ASSETS.fetch(
            new Request(
                "https://occultus.internal/source.html"
            )
        );


    if (!sourceResponse.ok) {

        return Response.json(
            {
                error:
                    "Application source unavailable."
            },
            {
                status: 500
            }
        );
    }


    const source =
        await sourceResponse.text();


    const application =
        extractApplication(source);


    /*
     * Execute the application against the current
     * page.
     *
     * This is currently our server-side DOM layer.
     */

    const updated =
        await executeApplication(
            data.html,
            data.action,
            application
        );


    /*
     * NEVER allow application scripts into the
     * response.
     */

    let html =
        removeScripts(updated);


    /*
     * Add the communication runtime back.
     */

    html =
        injectRuntime(html);


    return Response.json({
        html
    });
}


/*
 * ==========================================================
 * EXTRACT APPLICATION SCRIPTS
 * ==========================================================
 */

function extractApplication(html) {

    const scripts = [];

    const regex =
        /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;


    let match;


    while (
        (match = regex.exec(html)) !== null
    ) {

        scripts.push({

            attributes:
                match[1],

            code:
                match[2]

        });
    }


    return scripts;
}


/*
 * ==========================================================
 * REMOVE SCRIPTS
 * ==========================================================
 */

function removeScripts(html) {

    return html.replace(
        /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
        ""
    );
}


/*
 * ==========================================================
 * CLIENT COMMUNICATION RUNTIME
 * ==========================================================
 *
 * THIS IS THE ONLY JAVASCRIPT SENT TO THE BROWSER.
 *
 * It contains no application logic.
 *
 * It only:
 *
 *     1. Detects an interaction.
 *     2. Gets the current HTML.
 *     3. Sends HTML + action to Worker.
 *     4. Receives HTML.
 *     5. Replaces the document.
 *
 * ==========================================================
 */

function injectRuntime(html) {

    const runtime = `
<script>
(() => {

    async function send(action) {

        const response = await fetch(
            "/__occultus_event",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    html:
                        document
                            .documentElement
                            .outerHTML,

                    action

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


        const result =
            await response.json();


        if (
            !result.html
        ) {
            return;
        }


        document.open();

        document.write(
            result.html
        );

        document.close();

    }


    /*
     * Capture clicks.
     *
     * The runtime does not know what the click
     * actually means.
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

                target:
                    element.id

            });

        }
    );

})();
</script>
`;


    if (
        /<\/body>/i.test(html)
    ) {

        return html.replace(
            /<\/body>/i,
            runtime + "</body>"
        );
    }


    return html + runtime;
}


/*
 * ==========================================================
 * SERVER-SIDE APPLICATION
 * ==========================================================
 *
 * TEMPORARY IMPLEMENTATION
 *
 * This demonstrates the protocol.
 *
 * The next stage replaces this with an actual
 * server-side DOM implementation and executes
 * the extracted application JavaScript.
 *
 * ==========================================================
 */

async function executeApplication(
    html,
    action,
    application
) {

    /*
     * IMPORTANT:
     *
     * `application` contains the secret JS extracted
     * from source.html.
     *
     * It is NEVER sent back to the browser.
     */


    /*
     * Demo: increment
     */

    if (
        action.type === "click" &&
        action.target === "increment"
    ) {

        html =
            updateCounter(html);
    }


    /*
     * Demo: change message
     */

    if (
        action.type === "click" &&
        action.target === "change"
    ) {

        html =
            html.replace(
                /<p id="message">[\s\S]*?<\/p>/i,

                `<p id="message">
                    This was changed by secret JS.
                </p>`
            );
    }


    return html;
}


/*
 * ==========================================================
 * DEMO COUNTER
 * ==========================================================
 */

function updateCounter(html) {

    const match =
        html.match(
            /<p id="counter">Count:\s*(\d+)<\/p>/i
        );


    if (!match) {
        return html;
    }


    const count =
        Number(match[1]) + 1;


    return html.replace(
        match[0],

        `<p id="counter">
            Count: ${count}
        </p>`
    );
}


/*
 * ==========================================================
 * RESPONSE
 * ==========================================================
 */

function htmlResponse(html) {

    return new Response(
        html,
        {
            headers: {
                "Content-Type":
                    "text/html; charset=UTF-8",

                "Cache-Control":
                    "no-store"
            }
        }
    );
}
