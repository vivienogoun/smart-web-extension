// service-worker.js
// All logic is now contained in the service worker, no offscreen document needed.

// --- AI Schema ---
const HIGHLIGHT_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      description:
        "An array of exact text phrases from the document that should be highlighted based on the user's request.",
      items: { type: "string" },
    },
  },
  required: ["highlights"],
};

// --- Event Listeners ---

// 1. Open the side panel when the extension icon is clicked.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
  // Inject content script into all tabs in the current window so selectionchange handlers are present
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      for (const t of tabs) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content-script.js"] });
        } catch (e) {
          // ignore injection errors for restricted pages
        }
      }
    } catch (e) {
      // ignore
    }
  })();
});

// 2. Listen for messages from the side panel.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "processPage":
      console.log("Service Worker received 'processPage' request.");
      // message may include structured contexts or a full prompt
      handlePageProcessing(message.prompt, message.contexts);
      break;

    case "checkAIModelStatus":
      console.log("Service Worker received 'checkAIModelStatus' request.");
      checkModelStatus();
      break;
    case "listTabs":
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const mapped = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
          sendResponse({ tabs: mapped });
        } catch (e) {
          sendResponse({ error: e?.message || 'failed' });
        }
      })();
      return true;
    case "getTabText":
      (async () => {
        try {
          const tabId = message.tabId;
          // Ensure content script is injected
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }).catch(() => {});
          const res = await chrome.tabs.sendMessage(tabId, { action: 'getTextContent' });
          sendResponse({ text: res?.textContent || '' });
        } catch (e) {
          sendResponse({ error: e?.message || 'failed' });
        }
      })();
      return true;
    case "getSelectedText":
      (async () => {
        try {
          const tabId = message.tabId;
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }).catch(() => {});
          const res = await chrome.tabs.sendMessage(tabId, { action: 'getSelectedText' });
          sendResponse({ text: res?.text || '' });
        } catch (e) {
          sendResponse({ error: e?.message || 'failed' });
        }
      })();
      return true;
    case 'forwardSelectionUpdate':
      // Forward selection updates to any open side panel (it listens for 'selectionUpdate')
      // Use sender.tab.id if the sender didn't include a tabId (content scripts don't need to know tabId).
      const forwardedTabId = message.tabId ?? (sender && sender.tab && sender.tab.id) ?? null;
      chrome.runtime.sendMessage({ action: 'selectionUpdate', tabId: forwardedTabId, text: message.text }).catch(()=>{});
      sendResponse({ ok: true });
      return true;
    case 'injectContentScripts':
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          for (const t of tabs) {
            try {
              await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content-script.js"] });
            } catch (e) {
              // ignore errors for restricted pages
            }
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: e?.message || 'failed' });
        }
      })();
      return true;
  }
  return true; // Indicates we will respond asynchronously.
});

// --- Core Functions ---

/**
 * Checks the availability of the LanguageModel and sends an update to the side panel.
 */
async function checkModelStatus() {
  try {
    let status = await LanguageModel.availability();
    console.log("AI Model Status:", status);
    if (status === "downloadable") {
      const session = await LanguageModel.create({
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            console.log(`Downloaded ${e.loaded * 100}%`);
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
    console.error("Error checking AI status:", error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
  }
}

/**
 * Orchestrates getting page content and then calling the AI.
 * @param {string} prompt The user's prompt from the side panel.
 */
async function handlePageProcessing(prompt) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return console.error("No active tab found.");
  // If structured contexts were provided, fetch texts for them; otherwise fall back to active tab text
  let assembledText = '';
  try {
    if (messageHasContexts(prompt, arguments[1])) {
      // If the caller passed contexts as structured data (array of {tabId, type, text})
      const contexts = arguments[1] || [];
      const pieces = [];
      for (const c of contexts) {
        if (c.type === 'selection') {
          pieces.push(`SELECTION CONTEXT (from tab ${c.tabId}):\n${truncate(c.text || '')}`);
        } else if (c.type === 'tab') {
          // fetch tab text
          const res = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getTabText', tabId: c.tabId }, resolve));
          pieces.push(`PAGE CONTEXT (${c.title || c.url}):\n${truncate(res?.text || '')}`);
        }
      }
      assembledText = pieces.join('\n\n');
    } else {
      // Default: get active tab text
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] }).catch(() => {});
      const response = await chrome.tabs.sendMessage(tab.id, { action: "getTextContent" });
      assembledText = response?.textContent || '';
    }

    const aiResult = await processWithAI(assembledText, prompt);

    if (aiResult && aiResult.highlights) {
      chrome.tabs.sendMessage(tab.id, {
        action: "highlightText",
        highlights: aiResult.highlights,
      });
    }
  } catch (e) {
    console.error('Error in handlePageProcessing:', e);
    chrome.runtime.sendMessage({ action: 'ai-status-update', status: 'unavailable', error: e?.message });
  }
}

function messageHasContexts(promptArg, contextsArg) {
  return Array.isArray(arguments[1]) || Array.isArray(contextsArg);
}

function truncate(s, n = 4000) {
  if (!s) return '';
  return s.substring(0, n);
}

/**
 * Processes text with the user's prompt using the built-in LanguageModel.
 * (This logic was previously in offscreen.js)
 * @param {string} textContent The text from the webpage.
 * @param {string} userPrompt The natural language command from the user.
 * @returns {object|null} The parsed JSON result from the AI or null on error.
 */
async function processWithAI(textContent, userPrompt) {
  console.log("Service Worker: Processing with AI...");
  chrome.runtime.sendMessage({
    action: "ai-status-update",
    status: "processing",
  });

  try {
    const session = await LanguageModel.create();

    const fullPrompt = `
      You are an intelligent assistant that analyzes web page content.
      The user wants to find and highlight specific information in the provided document.
      
      USER REQUEST: "${userPrompt}"
      
      DOCUMENT TEXT (first 4000 characters):
      ---
      ${textContent.substring(0, 4000)} 
      ---
      
      Analyze the document and extract the exact phrases that match the user's request.
    `;

    const stream = await session.promptStreaming(fullPrompt, {
      responseConstraint: HIGHLIGHT_SCHEMA,
    });

    let fullResult = "";
    for await (const chunk of stream) {
      fullResult += chunk;
    }

    console.log("Service Worker: AI Raw Result:", fullResult);
    const parsedResult = JSON.parse(fullResult);

    session.destroy();
    chrome.runtime.sendMessage({ action: "ai-status-update", status: "ready" });
    return parsedResult;
  } catch (error) {
    console.error("Service Worker: Error processing with AI:", error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
    return null;
  }
}
