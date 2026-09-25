export default {

    async fetch(request, env) {

        const url = new URL(request.url);


        /*
         * =====================================================
         * INITIAL PAGE
         * =====================================================
         */

        if (
            request.method === "GET" &&
            url.pathname === "/"
        ) {

            const source =
                await loadIndex(env);


            /*
             * Extract the application's JavaScript.
             */

            const scripts =
                extractScripts(source);


            /*
             * Remove application JavaScript.
             */

            let html =
                removeScripts(source);


            /*
             * Add ONLY the communication runtime.
             */

            html =
                injectRuntime(html);


            /*
             * Store the secret application somewhere
             * associated with this session in the real
             * implementation.
             *
             * For this basic prototype we're keeping it
             * in memory.
             */

            applications.set(
                getSession(request),
                scripts
            );


            return htmlResponse(html);
        }


        /*
         * =====================================================
         * EVENT FROM BROWSER
         * =====================================================
         */

        if (
            request.method === "POST" &&
            url.pathname === "/__event"
        ) {

            const data =
                await request.json();


            const session =
                getSession(request);


            const scripts =
                applications.get(session);


            if (!scripts) {

                return new Response(
                    "Session expired",
                    {
                        status: 400
                    }
                );
            }


            /*
             * Browser gives us:
             *
             *     current HTML
             *     action
             *
             * The application JS is still only on
             * the Worker.
             */

            const result =
                await executeApplication(
                    scripts,
                    data.html,
                    data.action
                );


            /*
             * Make absolutely sure application
             * scripts never get returned.
             */

            let html =
                removeScripts(result);


            /*
             * Add the tiny communication runtime again.
             */

            html =
                injectRuntime(html);


            return htmlResponse(html);
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
 * =========================================================
 * TEMPORARY APPLICATION STORAGE
 * =========================================================
 *
 * This is only for the prototype.
 *
 * A real version should use Durable Objects so every
 * browser session has persistent application state.
 */

const applications = new Map();


/*
 * =========================================================
 * LOAD INDEX.HTML
 * =========================================================
 */

async function loadIndex(env) {

    const response =
        await env.ASSETS.fetch(
            new Request(
                "https://internal/index.html"
            )
        );


    if (!response.ok) {

        throw new Error(
            "Could not load index.html"
        );
    }


    return await response.text();
}


/*
 * =========================================================
 * EXTRACT SCRIPTS
 * =========================================================
 */

function extractScripts(html) {

    const scripts = [];

    const regex =
        /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;


    let match;


    while (
        (match = regex.exec(html)) !== null
    ) {

        scripts.push({

            attributes: match[1],

            code: match[2]

        });
    }


    return scripts;
}


/*
 * =========================================================
 * REMOVE SCRIPTS
 * =========================================================
 */

function removeScripts(html) {

    return html.replace(
        /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
        ""
    );
}


/*
 * =========================================================
 * CLIENT COMMUNICATION RUNTIME
 * =========================================================
 *
 * THIS IS THE ONLY JAVASCRIPT THE BROWSER RECEIVES.
 *
 * It contains no application logic.
 * It does not know what "increment" means.
 * It does not know what your application does.
 *
 * Its only purpose is:
 *
 *     event
 *       ↓
 *     send HTML + event
 *       ↓
 *     receive HTML
 *       ↓
 *     replace document
 *
 * =========================================================
 */

function injectRuntime(html) {

    const runtime = `
<script>
(() => {

    document.addEventListener("click", async (event) => {

        const target =
            event.target.closest("[id]");

        if (!target)
            return;


        const response =
            await fetch("/__event", {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    html:
                        document.documentElement
                            .outerHTML,

                    action: {

                        type: "click",

                        target: target.id

                    }

                })

            });


        if (!response.ok) {

            console.error(
                await response.text()
            );

            return;
        }


        const result =
            await response.json();


        document.open();

        document.write(result.html);

        document.close();

    });

})();
</script>
`;


    /*
     * Put it immediately before </body>.
     */

    if (/<\/body>/i.test(html)) {

        return html.replace(
            /<\/body>/i,
            runtime + "</body>"
        );
    }


    return html + runtime;
}


/*
 * =========================================================
 * EXECUTE APPLICATION
 * =========================================================
 */

async function executeApplication(
    scripts,
    html,
    action
) {

    /*
     * -----------------------------------------------------
     * THIS IS CURRENTLY THE PLACEHOLDER.
     * -----------------------------------------------------
     *
     * The next layer is our server-side DOM:
     *
     *     document
     *     Element
     *     Node
     *     querySelector()
     *     getElementById()
     *     textContent
     *     innerHTML
     *     classList
     *     appendChild()
     *     remove()
     *     etc.
     *
     * Then the extracted script is executed against
     * that environment.
     */


    if (
        action.type === "click" &&
        action.target === "increment"
    ) {

        html =
            incrementCounter(html);
    }


    if (
        action.type === "click" &&
        action.target === "change"
    ) {

        html =
            html.replace(
                /<p id="message">[\s\S]*?<\/p>/i,

                `<p id="message">
                    The secret frontend JS ran.
                </p>`
            );
    }


    return html;
}


/*
 * =========================================================
 * DEMO DOM CHANGE
 * =========================================================
 */

function incrementCounter(html) {

    const match =
        html.match(
            /<p id="counter">Count:\s*(\d+)<\/p>/i
        );


    if (!match)
        return html;


    const count =
        Number(match[1]) + 1;


    return html.replace(
        match[0],

        `<p id="counter">Count: ${count}</p>`
    );
}


/*
 * =========================================================
 * SESSION
 * =========================================================
 */

function getSession(request) {

    /*
     * Temporary prototype session identifier.
     *
     * A production implementation should establish
     * a real session cookie and persist state with a
     * Durable Object.
     */

    const cookie =
        request.headers.get("Cookie");


    if (cookie) {

        const match =
            cookie.match(
                /secret_session=([^;]+)/
            );


        if (match) {
            return match[1];
        }
    }


    /*
     * Prototype fallback.
     */

    return "prototype";
}


/*
 * =========================================================
 * RESPONSE
 * =========================================================
 */

function htmlResponse(html) {

    return new Response(
        html,
        {
            headers: {
                "Content-Type":
                    "text/html; charset=UTF-8"
            }
        }
    );
}
