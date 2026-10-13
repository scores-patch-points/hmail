/*
 * Hub bridge. Runs only on the Hyphae hub origin (see manifest content_scripts).
 *
 * The hub page holds the Matrix session and receives circle keys over E2EE
 * Matrix. It hands them to the extension through this script. The channel is
 * one-way for secrets: circles go page -> extension; the only thing that ever
 * goes back is a count.
 */
(function () {
  "use strict";
  if (window.__hyphaeBridge) return;
  window.__hyphaeBridge = true;

  function toPage(msg) {
    msg.source = "hyphae-ext";
    window.postMessage(msg, window.location.origin);
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.source !== "hyphae-app") return;

    if (d.type === "ping") {
      toPage({ type: "hello" });
    } else if (d.type === "circles" && Array.isArray(d.circles)) {
      chrome.runtime.sendMessage({ hyphae: "merge-circles", circles: d.circles }, function (r) {
        toPage({ type: "ack", added: (r && r.added) || 0, total: (r && r.total) || 0 });
      });
    }
  });

  toPage({ type: "hello" });
})();
