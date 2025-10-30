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
        sendResponse(applyHighlights(request.highlights || []));
        break;
      case "insertDraft":
        sendResponse(insertDraftIntoDocument(request.draft));
        break;
      case "replaceSelection":
        sendResponse(replaceSelectionWithText(request.text));
        break;
      case "resetDom":
        sendResponse(resetDomMarkers());
        break;
      default:
        break;
    }
    return true;
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
    if (!Array.isArray(phrases) || !document.body) {
      clearPreviousHighlights();
      return { ok: true, count: 0 };
    }

    const validPhrases = phrases
      .map((phrase) => (typeof phrase === "string" ? phrase : String(phrase ?? "")))
      .map((phrase) => phrase.trim())
      .filter(Boolean);

    clearPreviousHighlights();

    if (!validPhrases.length) {
      return { ok: true, count: 0 };
    }

    let totalCount = 0;
    const seen = new Set();
    validPhrases.forEach((phrase) => {
      if (seen.has(phrase.toLowerCase())) return;
      seen.add(phrase.toLowerCase());
      totalCount += highlightPhrase(phrase);
    });

    return { ok: true, count: totalCount };
  }

  function clearPreviousHighlights() {
    document
      .querySelectorAll("mark[data-contextual-agent-highlight]")
      .forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
      });
  }

  function highlightPhrase(rawPhrase) {
    const phrase = String(rawPhrase ?? "").trim();
    if (!phrase || phrase.length === 0 || !document.body) return 0;

    let matchCount = 0;
    const phraseLength = phrase.length;
    const phraseLower = phrase.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest("mark[data-contextual-agent-highlight]")) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      let currentNode = walker.currentNode;
      if (!currentNode?.data) continue;

      while (currentNode?.data) {
        const nodeDataLower = currentNode.data.toLowerCase();
        const matchIndex = nodeDataLower.indexOf(phraseLower);
        if (matchIndex === -1) break;

        currentNode = wrapMatch(currentNode, matchIndex, phraseLength);
        if (currentNode) matchCount++;
        if (!currentNode) break;
      }
    }

    return matchCount;
  }

  function wrapMatch(node, start, length) {
    if (!node || typeof node.splitText !== "function" || length <= 0) {
      return null;
    }

    const matchNode = node.splitText(start);
    const afterNode = matchNode.splitText(length);
    const mark = document.createElement("mark");
    mark.dataset.contextualAgentHighlight = "true";
    mark.style.backgroundColor = "yellow";
    mark.style.color = "black";

    const parent = matchNode.parentNode;
    if (!parent) {
      return afterNode;
    }

    parent.insertBefore(mark, matchNode);
    mark.appendChild(matchNode);

    return afterNode;
  }

  function insertDraftIntoDocument(draft) {
    const text = coerceString(draft);
    if (!text) {
      return { error: "Draft is empty." };
    }

    if (insertIntoActiveElement(text)) {
      return { ok: true, method: "editable" };
    }

    if (replaceSelectionRange(text)) {
      return { ok: true, method: "selection" };
    }

    return { fallback: "clipboard", text };
  }

  function replaceSelectionWithText(nextText) {
    const text = coerceString(nextText);
    if (!text) {
      return { error: "No text to insert." };
    }

    if (replaceSelectionRange(text)) {
      return { ok: true, method: "selection" };
    }

    return { fallback: "clipboard", text };
  }

  function resetDomMarkers() {
    try {
      clearPreviousHighlights();
      return { ok: true };
    } catch (error) {
      console.error(`${LOG_PREFIX} failed to reset DOM markers`, error);
      return { error: error.message || "Failed to reset markers" };
    }
  }

  function insertIntoActiveElement(text) {
    const activeElement = document.activeElement;
    if (!activeElement) return false;

    if (isTextInput(activeElement)) {
      const start = activeElement.selectionStart ?? activeElement.value.length;
      const end = activeElement.selectionEnd ?? activeElement.value.length;
      const value = String(activeElement.value ?? "");
      activeElement.value = value.slice(0, start) + text + value.slice(end);
      const cursor = start + text.length;
      activeElement.selectionStart = activeElement.selectionEnd = cursor;
      activeElement.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    if (isContentEditable(activeElement)) {
      return replaceSelectionRange(text, activeElement);
    }

    return false;
  }

  function replaceSelectionRange(text, root = document.body) {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      return false;
    }

    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function isTextInput(element) {
    if (!element || element.disabled || element.readOnly) return false;
    const tag = element.tagName;
    return tag === "TEXTAREA" || (tag === "INPUT" && /^(?:text|search|email|url|tel)$/i.test(element.type || "text"));
  }

  function isContentEditable(element) {
    return Boolean(element?.isContentEditable);
  }

  function coerceString(value) {
    if (value == null) return "";
    return typeof value === "string" ? value : String(value);
  }
})();
