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
});

// 2. Listen for messages from the side panel.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "processPage":
      console.log("Service Worker received 'processPage' request.");
      handlePageProcessing(message.prompt);
      break;

    case "checkAIModelStatus":
      console.log("Service Worker received 'checkAIModelStatus' request.");
      checkModelStatus();
      break;
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

  // Inject content script to get text
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-script.js"],
  });

  // Get text from the content script
  const response = await chrome.tabs.sendMessage(tab.id, {
    action: "getTextContent",
  });

  if (response && response.textContent) {
    // Now that we have the text, process it directly in the service worker
    const aiResult = await processWithAI(response.textContent, prompt);

    // Send the result to the content script for highlighting
    if (aiResult && aiResult.highlights) {
      chrome.tabs.sendMessage(tab.id, {
        action: "highlightText",
        highlights: aiResult.highlights,
      });
    }
  } else {
    console.error("Could not get text content from the page.");
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: "Could not read page.",
    });
  }
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
