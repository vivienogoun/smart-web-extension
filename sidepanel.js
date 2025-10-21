// sidepanel.js

const promptInput = document.getElementById("prompt-input");
const processButton = document.getElementById("process-button");
const statusDiv = document.getElementById("status");

// 1. Check AI Model status when the side panel is opened.
document.addEventListener("DOMContentLoaded", () => {
  statusDiv.textContent = "Checking AI model status...";
  // Ask the service worker to check the status (it can now do this directly)
  chrome.runtime.sendMessage({ action: "checkAIModelStatus" });
});

// 2. Listen for status updates from the service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "ai-status-update") {
    updateStatus(message.status, message.error);
  }
});

// 3. Add click listener to the process button.
processButton.addEventListener("click", () => {
  const userPrompt = promptInput.value;

  if (!userPrompt) {
    statusDiv.textContent = "Please enter a command.";
    return;
  }

  processButton.disabled = true;
  processButton.textContent = "Processing...";
  statusDiv.textContent = "Sending content to AI model...";

  // Send a message to the service worker to start the process.
  chrome.runtime.sendMessage({
    action: "processPage",
    prompt: userPrompt,
  });
});

// 4. Function to update the UI based on model status
function updateStatus(status, error = "") {
  switch (status) {
    case "ready":
      statusDiv.textContent = "AI Model is ready.";
      processButton.disabled = false;
      processButton.textContent = "Process Page";
      break;
    case "downloading":
      statusDiv.textContent =
        "AI model is downloading. This may take a moment...";
      processButton.disabled = true;
      processButton.textContent = "Model Downloading...";
      break;
    case "unavailable":
      statusDiv.textContent = `Error: AI is unavailable. ${
        error || "Check console for details."
      }`;
      processButton.disabled = true;
      processButton.textContent = "AI Unavailable";
      break;
    case "processing":
      statusDiv.textContent = "AI is processing your request...";
      processButton.disabled = true;
      processButton.textContent = "Processing...";
      break;
    default:
      statusDiv.textContent = "Status unknown.";
      processButton.disabled = true;
  }
}
