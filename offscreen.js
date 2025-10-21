// offscreen.js

// This script runs in the offscreen document, which has access to the window and LanguageModel objects.

// Define the schema for the AI's response to guarantee valid JSON.
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

// Listen for messages from the service worker.
chrome.runtime.onMessage.addListener(handleMessages);

async function handleMessages(message) {
  switch (message.action) {
    case "process-with-ai":
      const aiResult = await processWithAI(
        message.textContent,
        message.userPrompt
      );
      chrome.runtime.sendMessage({
        action: "ai-result",
        result: aiResult,
      });
      break;

    case "get-ai-status":
      // New case to check model availability and report back.
      const status = await LanguageModel.availability();
      chrome.runtime.sendMessage({
        action: "ai-status-update",
        status: status === "readily" ? "ready" : status,
      });
      break;
  }
}

/**
 * Processes text with the user's prompt using the built-in LanguageModel.
 * @param {string} textContent The text from the webpage.
 * @param {string} userPrompt The natural language command from the user.
 * @returns {object|null} The parsed JSON result from the AI or null on error.
 */
async function processWithAI(textContent, userPrompt) {
  console.log("Offscreen: Processing with AI...");
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

    // Use promptStreaming and enforce the schema with responseConstraint.
    const stream = await session.promptStreaming(fullPrompt, {
      responseConstraint: HIGHLIGHT_SCHEMA,
    });

    let fullResult = "";
    for await (const chunk of stream) {
      fullResult += chunk;
    }

    console.log("Offscreen: AI Raw Result:", fullResult);
    const parsedResult = JSON.parse(fullResult);

    session.destroy();
    chrome.runtime.sendMessage({ action: "ai-status-update", status: "ready" });
    return parsedResult;
  } catch (error) {
    console.error("Offscreen: Error processing with AI:", error);
    chrome.runtime.sendMessage({
      action: "ai-status-update",
      status: "unavailable",
      error: error.message,
    });
    return null;
  }
}

// // offscreen.js

// // This script runs in the offscreen document, which has access to the window and LanguageModel objects.

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

// // Listen for messages from the service worker.
// chrome.runtime.onMessage.addListener(handleMessages);

// async function handleMessages(message) {
//   switch (message.action) {
//     case "process-with-ai":
//       const aiResult = await processWithAI(
//         message.textContent,
//         message.userPrompt
//       );
//       chrome.runtime.sendMessage({
//         action: "ai-result",
//         result: aiResult,
//       });
//       break;

//     case "get-ai-status":
//       // New case to check model availability and report back.
//       const status = await LanguageModel.availability();
//       chrome.runtime.sendMessage({
//         action: "ai-status-update",
//         status: status === "readily" ? "ready" : status,
//       });
//       break;
//   }
// }

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
//     chrome.runtime.sendMessage({ action: "ai-status-update", status: "ready" });
//     return parsedResult;
//   } catch (error) {
//     console.error("Offscreen: Error processing with AI:", error);
//     chrome.runtime.sendMessage({
//       action: "ai-status-update",
//       status: "unavailable",
//       error: error.message,
//     });
//     return null;
//   }
// }
