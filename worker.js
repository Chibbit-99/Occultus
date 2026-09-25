export default {

    async fetch(request, env) {

        const url = new URL(request.url);


        // ----------------------------------------
        // Initial page
        // ----------------------------------------

        if (
            request.method === "GET" &&
            url.pathname === "/"
        ) {

            const source = await getIndexHTML(
                request,
                env
            );

            if (!source) {
                return new Response(
                    "index.html not found",
                    { status: 500 }
                );
            }


            // Remove application JavaScript.

            const publicHTML =
                stripScripts(source);


            // Inject the communication runtime.

            const finalHTML =
                injectClientRuntime(publicHTML);


            return new Response(
                finalHTML,
                {
                    headers: {
                        "Content-Type":
                            "text/html; charset=UTF-8"
                    }
                }
            );
        }


        // ----------------------------------------
        // Browser → Worker
        // ----------------------------------------

        if (
            request.method === "POST" &&
            url.pathname === "/__event"
        ) {

            let data;

            try {

                data = await request.json();

            } catch {

                return Response.json(
                    {
                        error: "Invalid JSON"
                    },
                    {
                        status: 400
                    }
                );
            }


            if (
                typeof data.html !== "string" ||
                !data.action
            ) {

                return Response.json(
                    {
                        error:
                            "Expected html and action"
                    },
                    {
                        status: 400
                    }
                );
            }


            const updatedHTML =
                await handleEvent(
                    data.html,
                    data.action
                );


            return Response.json({
                html:
                    injectClientRuntime(
                        stripScripts(updatedHTML)
                    )
            });
        }


        return new Response(
            "Not found",
            {
                status: 404
            }
        );
    }
};


/* =========================================================
   GET index.html
   ========================================================= */

async function getIndexHTML(request, env) {

    /*
     * Cloudflare's Static Assets binding serves
     * the actual index.html file.
     *
     * Nothing from index.html is hardcoded here.
     */

    const url =
        new URL("/index.html", request.url);


    const response =
        await env.ASSETS.fetch(
            new Request(url)
        );


    if (!response.ok) {
        return null;
    }


    return await response.text();
}


/* =========================================================
   REMOVE SCRIPTS
   ========================================================= */

function stripScripts(html) {

    /*
     * Removes:

        <script>
            ...
        </script>

     * and:

        <script src="...">
            ...
        </script>
    */

    return html.replace(
        /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
        ""
    );
}


/* =========================================================
   INJECT PUBLIC CLIENT RUNTIME
   ========================================================= */

function injectClientRuntime(html) {

    const runtime = `

<script>
(() => {

    /*
     * This is the ONLY application-related JavaScript
     * the browser receives.
     *
     * It does not contain the application's logic.
     */


    async function sendAction(action) {

        /*
         * Capture the current state of the page.
         */

        const currentHTML =
            document.documentElement.outerHTML;


        const response =
            await fetch("/__event", {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    html: currentHTML,

                    action: action

                })

            });


        if (!response.ok) {

            console.error(
                "Frontend Worker error:",
                await response.text()
            );

            return;
        }


        const result =
            await response.json();


        if (!result.html) {
            return;
        }


        /*
         * Replace the current document with
         * the Worker-generated document.
         */

        document.open();

        document.write(result.html);

        document.close();

    }


    /*
     * Capture clicks.
     */

    document.addEventListener(
        "click",
        event => {

            const element =
                event.target.closest("[id]");


            if (!element) {
                return;
            }


            sendAction({

                type: "click",

                id: element.id

            });

        }
    );

})();
</script>

`;


    /*
     * Insert the runtime immediately before
     * </body>.
     */

    if (html.includes("</body>")) {

        return html.replace(
            /<\/body>/i,
            runtime + "</body>"
        );

    }


    /*
     * Handle HTML documents without <body>.
     */

    return html + runtime;
}


/* =========================================================
   APPLICATION EXECUTION
   ========================================================= */

async function handleEvent(html, action) {

    /*
     * THIS is where the secret frontend runtime
     * will eventually execute the original JS.
     *
     * For this first version, we're demonstrating
     * the communication architecture.
     */


    if (
        action.type === "click" &&
        action.id === "increment"
    ) {

        html = incrementCounter(html);

    }


    if (
        action.type === "click" &&
        action.id === "change"
    ) {

        html = html.replace(
            /<p id="message">[\s\S]*?<\/p>/i,
            `<p id="message">Changed by the Worker.</p>`
        );

    }


    return html;
}


/* =========================================================
   DEMO DOM MANIPULATION
   ========================================================= */

function incrementCounter(html) {

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

        `<p id="counter">Count: ${count}</p>`
    );
}
