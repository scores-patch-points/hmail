/*
 * Every-site starter. Registered as a content script for all pages only when
 * the user has turned on "work on every site" and granted that permission.
 * It does nothing until the page actually contains sealed text; only then does
 * it ask the worker for the circle keys.
 */
(function () {
  "use strict";
  if (!window.__hyphae || window.__hyphaeAuto) return;
  window.__hyphaeAuto = true;
  window.__hyphae.autoStart(function () {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ hyphae: "get-circles" }, function (r) {
          void chrome.runtime.lastError;
          resolve((r && r.circles) || null);
        });
      } catch (e) { resolve(null); }
    });
  });
})();
