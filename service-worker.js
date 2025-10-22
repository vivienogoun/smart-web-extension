const LOG_PREFIX = "[Contextual Agent]";

const HIGHLIGHT_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      description: "Exact text snippets to highlight on the page",
      items: { type: "string" },
    },
  },
  required: ["highlights"],
};

chrome.action.onClicked.addListener(async (tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
  await ensureContentScriptsInjected(tab.windowId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  switch (message.action) {
    case "processPage":
      handlePageProcessing(message.prompt, message.contexts);
      break;
    case "checkAIModelStatus":
      checkModelStatus();
      break;
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
    default:
      break;
  }

  return false;
});

// Helpers ------------------------------------------------------------------

async function ensureContentScriptsInjected(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    await Promise.all(
      tabs.map((tab) =>
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] })
          .catch(() => null)
      )
    );
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
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }).catch(() => null);
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
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }).catch(() => null);
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

function injectContentScripts(sendResponse) {
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await Promise.all(
        tabs.map((tab) =>
          chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] })
            .catch(() => null)
        )
      );
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ error: error?.message || "failed" });
    }
  })();
}

// AI pipeline ---------------------------------------------------------------

async function checkModelStatus() {
  if (typeof LanguageModel === "undefined") {
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: "LanguageModel API not supported in this browser.",
    });
    return;
  }

  try {
    let status = await LanguageModel.availability();
    if (status === "downloadable") {
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

    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: status === "available" ? "ready" : status,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} AI status check failed`, error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
  }
}

async function handlePageProcessing(prompt, contexts = []) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      console.warn(`${LOG_PREFIX} no active tab to process`);
      return;
    }

    const assembled = await assembleContextText(activeTab.id, contexts);
    const result = await processWithAI(assembled, prompt);

    if (result?.highlights?.length) {
      chrome.tabs.sendMessage(activeTab.id, { action: "highlightText", highlights: result.highlights });
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to process page`, error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
  }
}

async function assembleContextText(activeTabId, contexts) {
  if (!Array.isArray(contexts) || !contexts.length) {
    await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ["content-script.js"] }).catch(() => null);
    const response = await chrome.tabs.sendMessage(activeTabId, { action: "getTextContent" });
    return response?.textContent ?? "";
  }

  const pieces = await Promise.all(
    contexts.map(async (context) => {
      if (context.type === "selection") {
        return `SELECTION CONTEXT (tab ${context.tabId ?? "unknown"}):\n${truncate(context.text)}`;
      }

      if (context.type === "tab" && context.tabId) {
        const response = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: "getTabText", tabId: context.tabId }, resolve)
        );
        return `PAGE CONTEXT (${context.title ?? context.url ?? context.tabId}):\n${truncate(response?.text)}`;
      }

      return null;
    })
  );

  return pieces.filter(Boolean).join("\n\n");
}

async function processWithAI(textContent, prompt) {
  chrome.runtime.sendMessage({ action: "ai-status-update", status: "processing" });

  try {
    if (typeof LanguageModel === "undefined") {
      throw new Error("LanguageModel API not supported in this browser.");
    }

    const session = await LanguageModel.create();
    const fullPrompt = buildPrompt(textContent, prompt);

    const stream = await session.promptStreaming(fullPrompt, { responseConstraint: HIGHLIGHT_SCHEMA });
    let payload = "";
    for await (const chunk of stream) {
      payload += chunk;
    }

    session.destroy();
    chrome.runtime.sendMessage({ action: "ai-status-update", status: "ready" });
    return JSON.parse(payload);
  } catch (error) {
    console.error(`${LOG_PREFIX} AI processing failed`, error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
    return null;
  }
}

function buildPrompt(textContent, prompt) {
  const excerpt = truncate(textContent ?? "");
  return `You are an intelligent assistant that analyzes web page content.
The user wants to find and highlight specific information in the provided document.

USER REQUEST: "${prompt}"

DOCUMENT TEXT (first 4000 characters):
---
${excerpt}
---

Analyze the document and extract the exact phrases that match the user's request.`;
}

function truncate(value, length = 4000) {
  if (!value) return "";
  return String(value).slice(0, length);
}
