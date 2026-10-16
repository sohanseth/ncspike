import { createFileRoute } from "@tanstack/react-router";

// Opened from the QR code on the Mac app. Must answer directly (no auth
// check, no redirect — a redirect would carry the key fragment to the next
// address) and must not load anything else: the CSP below blocks every
// network request this page could make.
function page(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect this device</title>
<script nonce="${nonce}">
(function () {
  function say(title, msg) {
    function go() { document.getElementById("t").textContent = title; document.getElementById("m").textContent = msg; }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  }
  function run() {
    var p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname);
    var k = p.get("k") || "", kid = p.get("kid") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(k) || !/^[0-9a-f]{8}$/.test(kid)) {
      say("That link isn't complete", "On your Mac, open Settings, then Your phone and the web, then Open it on your phone, and scan the code again.");
      return;
    }
    var raw = atob(k.replace(/-/g, "+").replace(/_/g, "/") + "="), bytes = new Uint8Array(32);
    for (var i = 0; i < 32; i++) bytes[i] = raw.charCodeAt(i);
    crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt"]).then(function (key) {
      bytes.fill(0);
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open("nc-keys", 1);
        req.onupgradeneeded = function () { req.result.createObjectStore("keys"); };
        req.onerror = function () { reject(req.error); };
        req.onsuccess = function () {
          var tx = req.result.transaction("keys", "readwrite");
          tx.objectStore("keys").put(key, kid);
          tx.oncomplete = function () { req.result.close(); resolve(); };
          tx.onerror = function () { reject(tx.error); };
        };
      });
    }).then(function () {
      say("This device can now read the cards from your Mac", "Open your workspace to see them. Sign in first if you need to.");
    }, function () {
      say("This browser couldn't save the key", "Private browsing can block it. Open the link in a normal window.");
    });
  }
  run();
  window.addEventListener("hashchange", run);   // a second link opened in the same tab
})();
</script>
<style nonce="${nonce}">body{font:17px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:32px 20px;max-width:34rem}h1{font-size:1.5rem;line-height:1.25;margin:0 0 .5rem}a{color:inherit}</style>
</head><body><main><h1 id="t">Connecting this device…</h1><p id="m"></p><p><a href="/workspace">Go to your workspace</a></p></main></body></html>`;
}

export const Route = createFileRoute("/link")({
  server: {
    handlers: {
      GET: async () => {
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        return new Response(page(nonce), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
