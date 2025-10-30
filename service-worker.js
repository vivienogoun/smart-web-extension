const LOG_PREFIX = "[Contextual Agent]";
const CONTENT_SCRIPT_FILE = "content-script.js";

let activePanelTabId = null;


function humanReadableError(error) {
  if (!error) return "An unexpected error occurred.";
  if (typeof error === "string") return error;
  if (error?.message === "BAD_JSON") return "Model returned invalid JSON. Please try again.";
  if (error?.message === "SUMMARY_SCHEMA_MISSING_CONTENT") return "Summary response missing TL;DR or bullets.";
  if (error?.message === "WRITER_SCHEMA_MISSING_DRAFT") return "Writer response missing draft text.";
  if (error?.message === "CORRECTION_SCHEMA_MISSING_TEXT") return "Correction response missing corrected text.";
  if (error?.message === "LanguageModel API not supported in this browser.") return error.message;
  return error?.message ?? "An unexpected error occurred.";
}

function errorCodeFromError(error) {
  if (!error) return "UNKNOWN";
  if (typeof error === "string") return error;
  return error?.message ?? "UNKNOWN";
}

function buildErrorPayload(code, message) {
  return { code, message };
}

async function injectContentScriptsIntoTabs(tabs = []) {
  await Promise.all(
    tabs
      .filter((tab) => typeof tab?.id === "number")
      .map((tab) =>
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null)
      )
  );
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !tab?.windowId) return;
  
  // Open panel immediately to preserve user gesture
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    activePanelTabId = tab.id;
    ensureContentScriptsInjected(tab.windowId);
  }).catch((error) => {
    console.warn(`${LOG_PREFIX} failed to open panel`, error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  switch (message.action) {
    case "listTabs":
      listTabs(sendResponse);
      return true;
    case "getTabText":
      getTabText(message.tabId, sendResponse);
      return true;
    case "getSelectedText":
      getSelectedText(message.tabId, sendResponse);
      return true;
    case "selectionUpdate":
      sendResponse({ ok: true });
      return false;
    case "forwardSelectionUpdate":
      forwardSelectionUpdate(message, sender);
      sendResponse({ ok: true });
      return true;
    case "injectContentScripts":
      injectContentScripts(sendResponse);
      return true;
    case "applyHighlights":
      applyHighlightsToTab(message, sendResponse);
      return true;
    case "insertDraft":
      insertDraftIntoTab(message, sendResponse);
      return true;
    case "replaceSelection":
      replaceSelectionInTab(message, sendResponse);
      return true;
    default:
      break;
  }

  return false;
});

// Helpers ------------------------------------------------------------------

async function ensureContentScriptsInjected(windowId) {
  try {
    const query = typeof windowId === "number" ? { windowId } : { currentWindow: true };
    const tabs = await chrome.tabs.query(query);
    await injectContentScriptsIntoTabs(tabs);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to inject content scripts`, error);
  }
}

function listTabs(sendResponse) {
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      sendResponse({
        tabs: tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
        })),
      });
    } catch (error) {
      sendResponse({ error: error?.message || "failed" });
    }
  })();
}

function getTabText(tabId, sendResponse) {
  (async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null);
      const response = await chrome.tabs.sendMessage(tabId, { action: "getTextContent" });
      sendResponse({ text: response?.textContent ?? "" });
    } catch (error) {
      sendResponse({ error: error?.message || "failed" });
    }
  })();
}

function getSelectedText(tabId, sendResponse) {
  (async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null);
      const response = await chrome.tabs.sendMessage(tabId, { action: "getSelectedText" });
      sendResponse({ text: response?.text ?? "" });
    } catch (error) {
      sendResponse({ error: error?.message || "failed" });
    }
  })();
}

function forwardSelectionUpdate(message, sender) {
  const tabId = message.tabId ?? sender?.tab?.id ?? null;
  try {
    chrome.runtime.sendMessage(
      { action: "selectionUpdate", tabId, text: message.text },
      () => void chrome.runtime.lastError
    );
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to relay selection update`, error);
  }
}

function applyHighlightsToTab(message, sendResponse) {
  (async () => {
    try {
      const tabId = await resolveTargetTabId(message.targetTabId);
      if (typeof tabId !== "number") {
        sendResponse({ error: "No tab available to apply highlights." });
        return;
      }

      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null);
      const highlights = sanitizeStringArray(message.highlights);
      await chrome.tabs.sendMessage(tabId, { action: "highlightText", highlights });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ error: humanReadableError(error) });
    }
  })();
}

function insertDraftIntoTab(message, sendResponse) {
  (async () => {
    try {
      const tabId = await resolveTargetTabId(message.targetTabId);
      if (typeof tabId !== "number") {
        sendResponse({ error: "No tab available to insert draft." });
        return;
      }

      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null);
      const draft = sanitizeString(message.draft);
      const response = await chrome.tabs.sendMessage(tabId, { action: "insertDraft", draft });
      sendResponse(response ?? { ok: true });
    } catch (error) {
      sendResponse({ error: humanReadableError(error) });
    }
  })();
}

function replaceSelectionInTab(message, sendResponse) {
  (async () => {
    try {
      const tabId = await resolveTargetTabId(message.targetTabId);
      if (typeof tabId !== "number") {
        sendResponse({ error: "No tab available to replace selection." });
        return;
      }

      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }).catch(() => null);
      const text = sanitizeString(message.text);
      const response = await chrome.tabs.sendMessage(tabId, { action: "replaceSelection", text });
      sendResponse(response ?? { ok: true });
    } catch (error) {
      sendResponse({ error: humanReadableError(error) });
    }
  })();
}

async function resolveTargetTabId(preferredTabId) {
  if (typeof preferredTabId === "number") {
    return preferredTabId;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id ?? null;
}

function injectContentScripts(sendResponse) {
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await injectContentScriptsIntoTabs(tabs);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ error: error?.message || "failed" });
    }
  })();
}

// AI pipeline ---------------------------------------------------------------

async function checkModelStatus() {
  if (typeof LanguageModel === "undefined") {
    emitStatus("unavailable", "LanguageModel API not supported in this browser.");
    return;
  }

  try {
    let status = await LanguageModel.availability();
    if (status === "downloadable") {
      emitStatus("downloading");
      const session = await LanguageModel.create({
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            console.log(`${LOG_PREFIX} downloading model: ${Math.round(event.loaded * 100)}%`);
          });
        },
      });
      session.destroy();
      status = await LanguageModel.availability();
    }

    emitStatus(status === "available" ? "ready" : status);
  } catch (error) {
    console.error(`${LOG_PREFIX} AI status check failed`, error);
    emitStatus("unavailable", error?.message || "Failed to check model status.");
  }
}

