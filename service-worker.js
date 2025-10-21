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
    const status = await LanguageModel.availability();
    console.log("AI Model Status:", status);
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

// // service-worker.js

// // --- Setup Offscreen Document ---
// let creating; // A global promise to avoid race conditions

// async function setupOffscreenDocument(path) {
//   if (await chrome.offscreen.hasDocument()) return;
//   if (creating) {
//     await creating;
//   } else {
//     creating = chrome.offscreen.createDocument({
//       url: path,
//       reasons: ["WORKERS"],
//       justification: "To run the window.ai API which requires a DOM context.",
//     });
//     await creating;
//     creating = null;
//   }
// }

// // --- Main Logic ---

// // 1. Open the side panel when the extension icon is clicked.
// chrome.action.onClicked.addListener((tab) => {
//   chrome.sidePanel.open({ windowId: tab.windowId });
// });

// // 2. Listen for messages from the side panel or other scripts.
// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//   // Use a switch statement for clarity
//   switch (message.action) {
//     case "processPage":
//       console.log("Service Worker received 'processPage' request.");

//       // Get the current active tab to inject the content script.
//       chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//         if (tabs.length > 0) {
//           const tabId = tabs[0].id;

//           // Inject the content script to extract page text.
//           chrome.scripting.executeScript(
//             {
//               target: { tabId: tabId },
//               files: ["content-script.js"],
//             },
//             () => {
//               // After injecting, send a message to the content script to get the text.
//               chrome.tabs.sendMessage(
//                 tabId,
//                 { action: "getTextContent" },
//                 (response) => {
//                   if (response && response.textContent) {
//                     // Once we have the text, we can process it with the AI.
//                     const aiResult = processWithAI(
//                       response.textContent,
//                       message.prompt
//                     );
//                     console.log("AI Result:", aiResult);
//                     if (aiResult && aiResult.highlights) {
//                       forwardResultToContentScript(aiResult.highlights);
//                     }
//                   } else {
//                     console.error("Could not get text content from the page.");
//                   }
//                 }
//               );
//             }
//           );
//         }
//       });
//       //   getPageContent(message.prompt);
//       break;

//     case "ai-result":
//       console.log(
//         "Service Worker received AI result from offscreen doc:",
//         message.result
//       );
//       if (message.result && message.result.highlights) {
//         forwardResultToContentScript(message.result.highlights);
//       }
//       break;

//     case "checkAIModelStatus":
//       console.log("Service Worker received 'checkAIModelStatus' request.");
//       // A new case to check the model's availability from the offscreen doc
//       checkModelStatus();
//       break;
//   }
//   return true; // Indicates we will respond asynchronously.
// });

// // Define the schema for the AI's response to guarantee valid JSON.
// const HIGHLIGHT_SCHEMA = {
//   type: "object",
//   properties: {
//     highlights: {
//       type: "array",
//       description:
//         "An array of exact text phrases from the document that should be highlighted based on the user's request.",
//       items: { type: "string" },
//     },
//   },
//   required: ["highlights"],
// };

// /**
//  * Processes text with the user's prompt using the built-in LanguageModel.
//  * @param {string} textContent The text from the webpage.
//  * @param {string} userPrompt The natural language command from the user.
//  * @returns {object|null} The parsed JSON result from the AI or null on error.
//  */
// async function processWithAI(textContent, userPrompt) {
//   console.log("Offscreen: Processing with AI...");
//   chrome.runtime.sendMessage({
//     action: "ai-status-update",
//     status: "processing",
//   });

//   try {
//     const session = await LanguageModel.create();

//     const fullPrompt = `
//       You are an intelligent assistant that analyzes web page content.
//       The user wants to find and highlight specific information in the provided document.

//       USER REQUEST: "${userPrompt}"

//       DOCUMENT TEXT (first 4000 characters):
//       ---
//       ${textContent.substring(0, 4000)}
//       ---

//       Analyze the document and extract the exact phrases that match the user's request.
//     `;

//     // Use promptStreaming and enforce the schema with responseConstraint.
//     const stream = await session.promptStreaming(fullPrompt, {
//       responseConstraint: HIGHLIGHT_SCHEMA,
//     });

//     let fullResult = "";
//     for await (const chunk of stream) {
//       fullResult += chunk;
//     }

//     console.log("Offscreen: AI Raw Result:", fullResult);
//     const parsedResult = JSON.parse(fullResult);

//     session.destroy();
//     // chrome.runtime.sendMessage({ action: "ai-status-update", status: "ready" });
//     forwardResultToContentScript(parsedResult.highlights);
//     return parsedResult;
//   } catch (error) {
//     console.error("Error processing with AI:", error);
//     chrome.runtime.sendMessage({
//       action: "ai-status-update",
//       status: "unavailable",
//       error: error.message,
//     });
//     return null;
//   }
// }

// async function checkModelStatus() {
//   const status = await LanguageModel.availability();
//   console.log("AI Model availability status:", status);
//   if (status === "downloadable") {
//     const session = await LanguageModel.create({
//       monitor(m) {
//         m.addEventListener("downloadprogress", (e) => {
//           console.log(`Downloaded ${e.loaded * 100}%`);
//         });
//       },
//     });
//   }
//   //   await setupOffscreenDocument("offscreen.html");
//   //   chrome.runtime.sendMessage({ action: "get-ai-status" });
// }

// async function getPageContent(prompt) {
//   await setupOffscreenDocument("offscreen.html");
//   const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
//   if (!tab) return console.error("No active tab found.");

//   await chrome.scripting.executeScript({
//     target: { tabId: tab.id },
//     files: ["content-script.js"],
//   });

//   const response = await chrome.tabs.sendMessage(tab.id, {
//     action: "getTextContent",
//   });
//   if (response && response.textContent) {
//     chrome.runtime.sendMessage({
//       action: "process-with-ai",
//       textContent: response.textContent,
//       userPrompt: prompt,
//     });
//   } else {
//     console.error("Could not get text content from the page.");
//   }
// }

// function forwardResultToContentScript(highlights) {
//   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//     if (tabs.length > 0) {
//       chrome.tabs.sendMessage(tabs[0].id, {
//         action: "highlightText",
//         highlights: highlights,
//       });
//     }
//   });
// }

// // service-worker.js

// // This is the main background script for the extension.
// // It listens for events and orchestrates the AI processing.

// // 1. Open the side panel when the extension icon is clicked.
// chrome.action.onClicked.addListener((tab) => {
//   chrome.sidePanel.open({ windowId: tab.windowId });
// });

// // 2. Listen for messages from the side panel UI or content scripts.
// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//   // Check if the message is a request to process the page content.
//   if (message.action === "processPage") {
//     console.log("Service Worker received a 'processPage' request.");

//     // Get the current active tab to inject the content script.
//     chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//       if (tabs.length > 0) {
//         const tabId = tabs[0].id;

//         // Inject the content script to extract page text.
//         chrome.scripting.executeScript(
//           {
//             target: { tabId: tabId },
//             files: ["content-script.js"],
//           },
//           () => {
//             // After injecting, send a message to the content script to get the text.
//             chrome.tabs.sendMessage(
//               tabId,
//               { action: "getTextContent" },
//               (response) => {
//                 if (response && response.textContent) {
//                   // Once we have the text, we can process it with the AI.
//                   processWithAI(response.textContent, message.prompt);
//                 } else {
//                   console.error("Could not get text content from the page.");
//                 }
//               }
//             );
//           }
//         );
//       }
//     });

//     // Return true to indicate that we will send a response asynchronously.
//     return true;
//   }
// });

// /**
//  * Processes the extracted text with the user's prompt using the built-in AI.
//  * @param {string} textContent The text from the webpage.
//  * @param {string} userPrompt The natural language command from the user.
//  */
// async function processWithAI(textContent, userPrompt) {
//   console.log("Processing with AI...");
//   console.log("User Prompt:", userPrompt);

//   try {
//     const session = await LanguageModel.create();

//     const fullPrompt = `
//           You are an intelligent assistant that analyzes web page content.
//           The user wants to find and highlight specific information in the provided document.

//           USER REQUEST: "${userPrompt}"

//           DOCUMENT TEXT (first 4000 characters):
//           ---
//           ${textContent.substring(0, 4000)}
//           ---

//           Analyze the document and extract the exact phrases that match the user's request.
//         `;

//     // Use promptStreaming and enforce the schema with responseConstraint.
//     const stream = await session.promptStreaming(fullPrompt, {
//       responseConstraint: HIGHLIGHT_SCHEMA,
//     });

//     let result = "";
//     for await (const chunk of stream) {
//       result += chunk;
//     }
//     console.log("AI Raw Result:", result);

//     // 5. Parse the result and send it to the content script for action.
//     const parsedResult = JSON.parse(result);
//     if (parsedResult.highlights) {
//       chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//         if (tabs.length > 0) {
//           chrome.tabs.sendMessage(tabs[0].id, {
//             action: "highlightText",
//             highlights: parsedResult.highlights,
//           });
//         }
//       });
//     }

//     // Don't forget to destroy the session when done.
//     session.destroy();
//   } catch (error) {
//     console.error("Error processing with AI:", error);
//     // TODO: Send an error message back to the UI.
//   }
// }
