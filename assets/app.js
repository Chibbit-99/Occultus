// A second, external application script.
//
// This file never reaches the browser: the Worker reads it through the
// assets binding and executes it server-side, in the same scope as the
// inline script from source.html.

document
    .getElementById("reset")
    .addEventListener("click", () => {

        count = 0;

        document
            .getElementById("counter")
            .textContent =
                "Count: 0";

        document
            .getElementById("message")
            .textContent =
                "Reset by external script.";
    });
