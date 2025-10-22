(() => {
  if (window.__contextualAgentContentScriptLoaded) return;
  window.__contextualAgentContentScriptLoaded = true;

  const LOG_PREFIX = "[Contextual Agent]";
  const SELECTION_DEBOUNCE_MS = 200;
  let selectionTimer = null;

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.action) {
      case "getTextContent":
        sendResponse({ textContent: getVisibleText() });
        break;
      case "getSelectedText":
        sendResponse({ text: getWindowSelection() });
        break;
      case "highlightText":
        applyHighlights(request.highlights || []);
        break;
      default:
        break;
    }
  });

  document.addEventListener("selectionchange", () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(dispatchSelectionUpdate, SELECTION_DEBOUNCE_MS);
  });

  console.log(`${LOG_PREFIX} content script loaded.`);

  function getVisibleText() {
    return document.body?.innerText ?? "";
  }

  function getWindowSelection() {
    return window.getSelection?.().toString() ?? "";
  }

  function dispatchSelectionUpdate() {
    selectionTimer = null;
    const text = getWindowSelection();
    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      console.debug(`${LOG_PREFIX} sending selection update`, trimmed.slice(0, 80));
      chrome.runtime.sendMessage({ action: "selectionUpdate", text, timestamp: Date.now() });
    } catch (error) {
      console.warn(`${LOG_PREFIX} failed to send selection update`, error);
    }
  }

  function applyHighlights(phrases) {
    if (!Array.isArray(phrases) || !phrases.length) return;

    const originalHtml = document.body?.innerHTML;
    if (!originalHtml) return;

    let highlighted = originalHtml;
    phrases.forEach((phrase) => {
      if (!phrase) return;
      const regex = new RegExp(escapeRegExp(String(phrase)), "gi");
      highlighted = highlighted.replace(
        regex,
        (match) => `<mark style="background-color: yellow; color: black;">${match}</mark>`
      );
    });

    if (highlighted !== originalHtml) {
      document.body.innerHTML = highlighted;
    }
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
