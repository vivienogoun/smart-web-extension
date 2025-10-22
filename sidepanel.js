const elements = {
  promptInput: document.getElementById("prompt-input"),
  processButton: document.getElementById("process-button"),
  status: document.getElementById("status"),
  contextChips: document.getElementById("context-chips"),
  tabsDropdown: document.getElementById("tabs-dropdown"),
  contextSection: document.querySelector(".context-section"),
  clearContexts: document.getElementById("clear-contexts"),
  toast: document.getElementById("toast"),
};

const state = {
  tabContexts: [], // { tabId, title, url }
  selectionContexts: [], // { tabId, text }
  tabsDropdownVisible: false,
  activeTabId: null,
};

const LOG_PREFIX = "[Contextual Agent]";
let toastTimer = null;

// Entry --------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  initialiseStatus();
  await seedActiveTabContext();
  wireEventListeners();
  renderContextChips();
});

// Initialisation helpers ---------------------------------------------------

function initialiseStatus() {
  elements.status.textContent = "Checking AI model status...";
  chrome.runtime.sendMessage({ action: "checkAIModelStatus" }, () => void chrome.runtime.lastError);
  chrome.runtime.sendMessage({ action: "injectContentScripts" }, () => void chrome.runtime.lastError);
}

async function seedActiveTabContext() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;

    state.activeTabId = activeTab.id;
    addTabContext({
      tabId: activeTab.id,
      title: activeTab.title,
      url: activeTab.url,
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to fetch active tab`, error);
  }
}

function wireEventListeners() {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  elements.clearContexts.addEventListener("click", handleClearContexts);
  elements.processButton.addEventListener("click", handleProcessClick);
  elements.promptInput.addEventListener("keydown", handlePromptKeyDown);
  elements.promptInput.addEventListener("keyup", handlePromptKeyUp);
  document.addEventListener("click", handleDocumentClick);
}

// Runtime messaging ---------------------------------------------------------

function handleRuntimeMessage(message, sender) {
  if (!message || typeof message !== "object") return;

  switch (message.action) {
    case "selectionUpdate":
      handleSelectionUpdate(message, sender);
      break;
    case "ai-status-update":
      updateStatus(message.status, message.error);
      break;
    default:
      break;
  }
}

function handleSelectionUpdate(message, sender) {
  const text = (message.text || "").trim();
  if (!text) return;

  const originatingTabId = message.tabId ?? sender?.tab?.id ?? null;
  console.debug(`${LOG_PREFIX} selection update`, { tabId: originatingTabId, preview: text.slice(0, 80) });

  addSelectionContext({ tabId: originatingTabId, text });
  renderContextChips();
  insertIntoPrompt(text);
  showToast("Selection added to context");
}

// UI events ----------------------------------------------------------------

function handleProcessClick() {
  const prompt = elements.promptInput.value.trim();
  if (!prompt) {
    elements.status.textContent = "Please enter a command.";
    return;
  }

  setProcessingState(true, "Sending content to AI model...");

  const contexts = gatherContexts();
  chrome.runtime.sendMessage({ action: "processPage", prompt, contexts }, () => void chrome.runtime.lastError);
  showToast("Sent to AI");
}

function handlePromptKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleProcessClick();
  }
}

async function handlePromptKeyUp(event) {
  const { value, selectionStart } = elements.promptInput;
  const charBefore = value?.[selectionStart - 1];
  if (charBefore === "@") {
    const tabs = await listTabs();
    renderTabsDropdown(tabs);
  }
}

function handleDocumentClick(event) {
  if (!elements.tabsDropdown) return;
  if (!elements.tabsDropdown.contains(event.target) && event.target !== elements.promptInput) {
    hideTabsDropdown();
  }
}

function handleClearContexts() {
  state.tabContexts = [];
  state.selectionContexts = [];
  renderContextChips();
  insertIntoPrompt("");
  seedActiveTabContext();
}

// Context management -------------------------------------------------------

function addTabContext(tab) {
  if (!tab || state.tabContexts.some((ctx) => ctx.tabId === tab.tabId)) {
    return;
  }
  state.tabContexts.unshift(tab);
  renderContextChips();
}

function addSelectionContext(selection) {
  if (!selection || !selection.text) return;
  state.selectionContexts.unshift(selection);
}

function removeTabContext(index) {
  state.tabContexts.splice(index, 1);
  renderContextChips();
}

function removeSelectionContext(index) {
  state.selectionContexts.splice(index, 1);
  renderContextChips();
}

function gatherContexts() {
  return [
    ...state.tabContexts.map((ctx) => ({ type: "tab", ...ctx })),
    ...state.selectionContexts.map((ctx) => ({ type: "selection", ...ctx })),
  ];
}

// Rendering ----------------------------------------------------------------

function renderContextChips() {
  if (!elements.contextChips) return;
  elements.contextChips.innerHTML = "";

  state.tabContexts.forEach((context, index) => {
    elements.contextChips.appendChild(createTabChip(context, index));
  });

  state.selectionContexts.forEach((context, index) => {
    elements.contextChips.appendChild(createSelectionChip(context, index));
  });

  updateContextVisibility();
}

function createTabChip(context, index) {
  const chip = document.createElement("span");
  chip.className = "chip";

  const label = document.createElement("span");
  label.textContent = context.title || context.url || `Tab ${context.tabId}`;
  chip.appendChild(label);

  const remove = document.createElement("button");
  remove.textContent = "×";
  remove.title = "Remove context";
  remove.addEventListener("click", () => removeTabContext(index));
  chip.appendChild(remove);

  return chip;
}

function createSelectionChip(context, index) {
  const chip = document.createElement("span");
  chip.className = "chip";

  const label = document.createElement("span");
  const preview = context.text.length > 80 ? `${context.text.slice(0, 77)}…` : context.text;
  label.textContent = preview;
  chip.appendChild(label);

  const remove = document.createElement("button");
  remove.textContent = "×";
  remove.title = "Remove context";
  remove.addEventListener("click", () => removeSelectionContext(index));
  chip.appendChild(remove);

  return chip;
}

function updateContextVisibility() {
  if (!elements.contextSection) return;
  const hasContexts = state.tabContexts.length > 1 || state.selectionContexts.length > 0 || state.tabsDropdownVisible;
  elements.contextSection.style.display = hasContexts ? "flex" : "none";
}

// Tabs dropdown ------------------------------------------------------------

async function listTabs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "listTabs" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG_PREFIX} failed to list tabs`, chrome.runtime.lastError);
        resolve([]);
        return;
      }
      resolve(response?.tabs ?? []);
    });
  });
}

function renderTabsDropdown(tabs) {
  if (!elements.tabsDropdown) return;
  elements.tabsDropdown.innerHTML = "";

  if (!tabs.length) {
    hideTabsDropdown();
    return;
  }

  const searchWrapper = document.createElement("div");
  searchWrapper.className = "search";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Find tab...";
  searchWrapper.appendChild(searchInput);

  const list = document.createElement("div");
  list.className = "list";

  const renderList = (entries) => {
    list.innerHTML = "";
    entries.forEach((tab) => {
      const item = document.createElement("div");
      item.className = "item";
      item.textContent = tab.title || tab.url;
      item.addEventListener("click", () => {
        addTabContext({ tabId: tab.id, title: tab.title, url: tab.url });
        hideTabsDropdown();
      });
      list.appendChild(item);
    });
  };

  renderList(tabs);

  searchInput.addEventListener("input", (event) => {
    const query = (event.target.value || "").toLowerCase();
    const filtered = tabs.filter((tab) => `${tab.title ?? ""} ${tab.url ?? ""}`.toLowerCase().includes(query));
    renderList(filtered);
  });

  elements.tabsDropdown.appendChild(searchWrapper);
  elements.tabsDropdown.appendChild(list);
  elements.tabsDropdown.style.display = "block";
  state.tabsDropdownVisible = true;
  updateContextVisibility();
}

function hideTabsDropdown() {
  if (!elements.tabsDropdown) return;
  elements.tabsDropdown.style.display = "none";
  state.tabsDropdownVisible = false;
  updateContextVisibility();
}

// Status & feedback --------------------------------------------------------

function updateStatus(status, error = "") {
  switch (status) {
    case "ready":
      setProcessingState(false, "AI Model is ready.");
      break;
    case "downloading":
      setProcessingState(true, "AI model is downloading. This may take a moment...");
      break;
    case "processing":
      setProcessingState(true, "AI is processing your request...");
      break;
    case "unavailable":
      setProcessingState(true, `Error: AI is unavailable. ${error || "Check console for details."}`);
      break;
    default:
      setProcessingState(true, "Status unknown.");
      break;
  }
}

function setProcessingState(isBusy, message) {
  elements.status.textContent = message;
  elements.processButton.disabled = isBusy;
  elements.processButton.textContent = isBusy ? "Processing..." : "Process Page";
}

function insertIntoPrompt(text) {
  if (!text) {
    elements.promptInput.value = "";
    return;
  }
  const existing = elements.promptInput.value;
  elements.promptInput.value = existing ? `${existing}\n${text}` : text;
}

function showToast(message, duration = 1800) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), duration);
}

// Expose helpers for manual testing ---------------------------------------

window.__contextualPanelDebug = {
  addTabContext,
  addSelectionContext,
  state,
};
