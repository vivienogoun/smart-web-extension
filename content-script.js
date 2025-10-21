// content-script.js

// This script is injected into the webpage and can directly interact with the DOM.

// Listen for messages from the service worker.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getTextContent") {
    // When asked, extract the visible text from the page and send it back.
    const pageText = document.body.innerText;
    sendResponse({ textContent: pageText });
  } else if (request.action === "highlightText") {
    // When receiving highlight data, perform the highlighting.
    console.log("Highlights received:", request.highlights);
    highlightPhrases(request.highlights);
  }
});

/**
 * Finds and highlights specific phrases on the page.
 * @param {string[]} phrases - An array of exact phrases to highlight.
 */
function highlightPhrases(phrases) {
  if (!phrases || phrases.length === 0) return;

  // A simple (but not perfect) way to highlight.
  // It finds the first occurrence of each phrase.
  // A more robust solution would use a TreeWalker and handle overlapping phrases.

  const content = document.body.innerHTML;
  let newContent = content;

  phrases.forEach((phrase) => {
    // Use a regular expression to find all occurrences of the phrase.
    // The 'gi' flags make it global (find all) and case-insensitive.
    const regex = new RegExp(escapeRegExp(phrase), "gi");
    newContent = newContent.replace(
      regex,
      (match) =>
        `<mark style="background-color: yellow; color: black;">${match}</mark>`
    );
  });

  if (newContent !== content) {
    document.body.innerHTML = newContent;
  }
}

/**
 * Escapes special characters in a string for use in a regular expression.
 * @param {string} string - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log("Contextual Agent content script loaded.");
