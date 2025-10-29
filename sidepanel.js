const elements = {
  promptInput: document.getElementById("prompt-input"),
  processButton: document.getElementById("process-button"),
  stopButton: document.getElementById("stop-button"),
  resetButton: document.getElementById("reset-button"),
  status: document.getElementById("status"),
  contextChips: document.getElementById("context-chips"),
  tabsDropdown: document.getElementById("tabs-dropdown"),
  contextSection: document.querySelector(".context-section"),
  clearContexts: document.getElementById("clear-contexts"),
  toast: document.getElementById("toast"),
  responseArea: document.getElementById("response-area"),
};

const state = {
  tabContexts: [], // { tabId, title, url }
  selectionContexts: [], // { tabId, text }
  tabsDropdownVisible: false,
  activeTabId: null,
  lastPrompt: "",
  lastIntent: null,
  lastTargetTabId: null,
  pendingRequests: Object.create(null),
  history: [], // Array of response payloads for conversation history
  promptSession: null,
  currentAbortController: null,
};

const LOG_PREFIX = "[Contextual Agent]";
let toastTimer = null;

const INTENTS = Object.freeze({
  HIGHLIGHT: "HIGHLIGHT",
  SUMMARIZE: "SUMMARIZE",
  WRITE: "WRITE",
  CORRECT: "CORRECT",
  NONE: "NONE",
});

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: {
    intent: { enum: ["SUMMARIZE", "WRITE", "CORRECT", "HIGHLIGHT", "NONE"] },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["tldr", "bullets"],
      properties: {
        tldr: { type: "string", minLength: 1 },
        bullets: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    },
    draft: { type: "string", minLength: 1 },
    correction: { type: "string", minLength: 1 },
    highlights: { type: "array", items: { type: "string" }, minItems: 1 },
    explain: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  allOf: [
    {
      if: { properties: { intent: { const: "SUMMARIZE" } } },
      then: { required: ["intent", "summary"] },
    },
    {
      if: { properties: { intent: { const: "WRITE" } } },
      then: { required: ["intent", "draft"] },
    },
    {
      if: { properties: { intent: { const: "CORRECT" } } },
      then: { required: ["intent", "correction"] },
    },
    {
      if: { properties: { intent: { const: "HIGHLIGHT" } } },
      then: { required: ["intent", "highlights"] },
    },
  ],
};

const SYSTEM_INSTRUCTION = [
  "You are the SmartWeb panel assistant. ",
  "Choose ONE intent that best fulfills the user request: ",
  "SUMMARIZE, WRITE, CORRECT, or HIGHLIGHT. ",
  "Always reply with a single JSON object that follows the schema. ",
  "Required fields per intent: ",
  "SUMMARIZE requires 'summary' object with 'tldr' and 'bullets'. ",
  "WRITE requires 'draft' string with the full text to insert. ",
  "CORRECT requires 'correction' string with the corrected text. ",
  "HIGHLIGHT requires 'highlights' array with exact phrases from the page. ",
  "Prefer the SELECTION when present. When multiple tabs are provided, ",
  "extract key differences. Never include explanations outside JSON. ",
  "Return ONLY a single JSON object. Do NOT include code fences, markdown, or any text outside the JSON.",
].join("");

const CONTEXT_BUDGET = 12000;
const SELECTION_CAP = 3000;
const TAB_SNIPPET_CAP = 5000;

// Dual-API Adapter for old and new Prompt API
const PromptAPIAdapter = {
  apiType: null, // 'new' | 'old' | null
  supportsResponseConstraint: false, // OLD API doesn't support responseConstraint in streaming

  detectAPI() {
    if (self.ai?.languageModel) {
      this.apiType = 'new';
      this.supportsResponseConstraint = true;
      console.log(`${LOG_PREFIX} detected NEW Prompt API (self.ai.languageModel)`);
    } else if (typeof LanguageModel !== 'undefined') {
      this.apiType = 'old';
      this.supportsResponseConstraint = false;
      console.log(`${LOG_PREFIX} detected OLD Prompt API (LanguageModel) - responseConstraint not supported`);
    } else {
      this.apiType = null;
      this.supportsResponseConstraint = false;
      console.warn(`${LOG_PREFIX} no Prompt API detected`);
    }
    return this.apiType;
  },

  async check() {
    if (!this.apiType) this.detectAPI();

    if (!this.apiType) {
      return { state: 'unavailable', message: 'Prompt API not available' };
    }

    try {
      if (this.apiType === 'new') {
        const caps = await self.ai.languageModel.capabilities({
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        });

        if (!caps || caps.available === 'no') {
          return { state: 'unavailable', message: 'AI model not available on this device' };
        }

        if (caps.available === 'readily') {
          return { state: 'ready' };
        }

        if (caps.available === 'after-download') {
          return { state: 'after-download' };
        }

        return { state: 'unavailable', message: 'Unknown availability state' };
      } else {
        // Old API
        const availability = await LanguageModel.availability();

        if (availability === 'available') {
          return { state: 'ready' };
        }

        if (availability === 'downloadable' || availability === 'downloading') {
          return { state: 'after-download' };
        }

        return { state: 'unavailable', message: 'AI model not available' };
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} API check failed`, error);
      return { state: 'unavailable', message: error?.message || 'Failed to check API' };
    }
  },

  async createSession(opts = {}) {
    if (!this.apiType) this.detectAPI();

    if (!this.apiType) {
      throw new Error('Prompt API not available');
    }

    try {
      if (this.apiType === 'new') {
        const options = {
          systemPrompt: opts.systemPrompt,
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        };

        if (opts.monitor) {
          options.monitor = opts.monitor;
        }

        return await self.ai.languageModel.create(options);
      } else {
        // Old API
        const options = {
          initialPrompts: opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : undefined,
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        };

        if (opts.monitor) {
          options.monitor = opts.monitor;
        }

        return await LanguageModel.create(options);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} session creation failed`, error);
      throw error;
    }
  },
};


function intentDisplayLabel(intent) {
  switch (intent) {
    case INTENTS.SUMMARIZE:
      return "Summary";
    case INTENTS.WRITE:
      return "Draft";
    case INTENTS.CORRECT:
      return "Correction";
    case INTENTS.HIGHLIGHT:
      return "Highlights";
    case INTENTS.NONE:
    default:
      return "Response";
  }
}

// Entry --------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  initialiseStatus();
  await seedActiveTabContext();
  wireEventListeners();
  renderContextChips();
  renderResponse();
});

// Initialisation helpers ---------------------------------------------------

function initialiseStatus() {
  checkModelAvailability();
  chrome.runtime.sendMessage({ action: "injectContentScripts" }, () => void chrome.runtime.lastError);
}

// Prompt API functions -----------------------------------------------------

function sanitizeJSON(text) {
  // Try direct parse first (fast path)
  try {
    return JSON.parse(text);
  } catch (e) {
    // Sanitize and retry
    let cleaned = text.trim();

    // Remove markdown code fences (```json ... ``` or ``` ... ```)
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    // Extract first top-level JSON object if there's extra text
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      throw new Error('No JSON object found in response');
    }

    // Find matching closing brace
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) {
          lastBrace = i;
          break;
        }
      }
    }

    if (lastBrace === -1) {
      throw new Error('Malformed JSON object in response');
    }

    const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonStr);
  }
}

async function checkModelAvailability() {
  try {
    setProcessingState(true, "Checking AI model status...");

    const result = await PromptAPIAdapter.check();

    if (result.state === 'unavailable') {
      setProcessingState(false, result.message || "Prompt API not available. You need Chrome Dev/Canary 128+ with built-in AI enabled.");
      showToast(result.message || "Prompt API not available", 5000);
      return;
    }

    if (result.state === 'ready') {
      setProcessingState(false, "AI model is ready.");
      return;
    }

    if (result.state === 'after-download') {
      setProcessingState(false, "AI model ready to download. Send a message to start.");
      return;
    }

    setProcessingState(false, "Model status unknown.");
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to check model status`, error);
    setProcessingState(false, "Error checking AI model status.");
    showToast(error?.message || "Failed to check AI status", 4000);
  }
}

async function createSession() {
  try {
    if (state.promptSession) {
      console.log(`${LOG_PREFIX} session already exists, reusing`);
      return state.promptSession;
    }

    console.log(`${LOG_PREFIX} creating session...`);
    setProcessingState(true, "Creating AI session...");

    state.promptSession = await PromptAPIAdapter.createSession({
      systemPrompt: SYSTEM_INSTRUCTION,
    });

    console.log(`${LOG_PREFIX} session created successfully`);
    setProcessingState(false, "AI model is ready.");

    return state.promptSession;
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to create session`, error);
    setProcessingState(false, "Failed to create AI session.");
    showToast(error?.message || "Failed to create AI session", 4000);
    throw error;
  }
}

function destroySession() {
  try {
    if (state.promptSession) {
      state.promptSession.destroy();
      state.promptSession = null;
      console.log(`${LOG_PREFIX} session destroyed`);
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} error destroying session`, error);
  }
}

async function buildPackedContext(userPrompt, contexts = []) {
  const parts = [];
  let totalLength = 0;
  let truncated = false;
  const tabsUsed = [];

  const selectionContexts = contexts.filter((c) => c.type === "selection");
  const tabContexts = contexts.filter((c) => c.type === "tab");

  if (selectionContexts.length > 0) {
    const selection = selectionContexts[0];
    const text = truncateAtSentence(selection.text || "", SELECTION_CAP);
    parts.push(`[SELECTION]\n${text}`);
    totalLength += text.length;
  }

  for (const tabCtx of tabContexts) {
    if (totalLength >= CONTEXT_BUDGET) {
      truncated = true;
      break;
    }

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getTabText", tabId: tabCtx.tabId }, resolve);
      });

      const snippet = truncateAtSentence(response?.text || "", TAB_SNIPPET_CAP);
      const tabHeader = `[TAB ${tabsUsed.length + 1}]  Title: ${tabCtx.title || "Untitled"}  URL: ${tabCtx.url || ""}`;
      const tabBlock = `${tabHeader}\n${snippet}`;

      if (totalLength + tabBlock.length > CONTEXT_BUDGET) {
        truncated = true;
        break;
      }

      parts.push(tabBlock);
      totalLength += tabBlock.length;
      tabsUsed.push({ tabId: tabCtx.tabId, title: tabCtx.title, url: tabCtx.url });
    } catch (error) {
      console.warn(`${LOG_PREFIX} failed to fetch tab ${tabCtx.tabId}`, error);
    }
  }

  const contextSection = parts.length > 0 ? `CONTEXT\n=======\n${parts.join("\n\n")}` : "";
  const userSection = `USER ASK\n========\n${userPrompt}`;

  const packedContext = [contextSection, userSection].filter(Boolean).join("\n\n");

  return {
    packedContext,
    meta: {
      truncated,
      tabsUsed,
      inputLength: packedContext.length,
    },
  };
}

function truncateAtSentence(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastQuestion = truncated.lastIndexOf("?");
  const lastExclamation = truncated.lastIndexOf("!");

  const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

  if (lastSentenceEnd > maxLength * 0.7) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  return truncated.trim();
}

function validateResponse(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid response: not an object");
  }

  if (!parsed.intent || !Object.values(INTENTS).includes(parsed.intent)) {
    throw new Error("Invalid response: missing or invalid intent");
  }

  switch (parsed.intent) {
    case INTENTS.SUMMARIZE:
      if (!parsed.summary || !parsed.summary.tldr || !Array.isArray(parsed.summary.bullets) || parsed.summary.bullets.length === 0) {
        throw new Error("SUMMARIZE intent requires summary with tldr and bullets");
      }
      return {
        intent: parsed.intent,
        summary: parsed.summary,
        explain: parsed.explain,
        confidence: parsed.confidence,
      };

    case INTENTS.WRITE:
      if (!parsed.draft) {
        throw new Error("WRITE intent requires draft");
      }
      return {
        intent: parsed.intent,
        draft: parsed.draft,
        explain: parsed.explain,
        confidence: parsed.confidence,
      };

    case INTENTS.CORRECT:
      if (!parsed.correction) {
        throw new Error("CORRECT intent requires correction");
      }
      return {
        intent: parsed.intent,
        correction: parsed.correction,
        explain: parsed.explain,
        confidence: parsed.confidence,
      };

    case INTENTS.HIGHLIGHT:
      if (!Array.isArray(parsed.highlights) || parsed.highlights.length === 0) {
        throw new Error("HIGHLIGHT intent requires at least one highlight");
      }
      return {
        intent: parsed.intent,
        highlights: parsed.highlights,
        explain: parsed.explain,
        confidence: parsed.confidence,
      };

    case INTENTS.NONE:
    default:
      return {
        intent: INTENTS.NONE,
        explain: parsed.explain || "Unable to process request",
        confidence: parsed.confidence,
      };
  }
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
  elements.stopButton.addEventListener("click", handleStopClick);
  elements.resetButton.addEventListener("click", handleResetClick);
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

async function handleProcessClick() {
  const rawInput = elements.promptInput.value;
  const trimmedInput = rawInput.trim();

  if (!trimmedInput) {
    elements.status.textContent = "Please enter a question.";
    return;
  }

  if (elements.processButton.disabled) return;

  try {
    setProcessingState(true, "Processing...");

    const session = await createSession();
    if (!session) {
      throw new Error("Failed to create AI session");
    }

    const contexts = gatherContexts();
    const { packedContext, meta } = await buildPackedContext(trimmedInput, contexts);

    state.currentAbortController = new AbortController();

    // OLD API doesn't support responseConstraint in streaming mode
    const streamOptions = {
      signal: state.currentAbortController.signal,
    };

    if (PromptAPIAdapter.supportsResponseConstraint) {
      streamOptions.responseConstraint = RESPONSE_SCHEMA;
    }

    const stream = session.promptStreaming(packedContext, streamOptions);

    let fullResponse = "";
    for await (const chunk of stream) {
      fullResponse += chunk;
      // Could render partial chunks here in the future
      console.debug(`${LOG_PREFIX} received chunk:`, chunk.slice(0, 50));
    }

    const parsed = sanitizeJSON(fullResponse);
    const validated = validateResponse(parsed);

    if (validated.intent === INTENTS.HIGHLIGHT && Array.isArray(validated.highlights) && validated.highlights.length) {
      chrome.runtime.sendMessage(
        { action: "applyHighlights", highlights: validated.highlights, targetTabId: state.activeTabId },
        () => void chrome.runtime.lastError
      );
    }

    const payload = {
      prompt: trimmedInput,
      intent: validated.intent,
      targetTabId: state.activeTabId,
      data: validated,
      meta,
      receivedAt: Date.now(),
    };

    state.history.push(payload);
    state.lastPrompt = trimmedInput;
    renderResponse();

    setProcessingState(false, "AI model is ready.");
    showToast("Response received");
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to process`, error);

    if (error.name === "AbortError") {
      setProcessingState(false, "AI model is ready.");
      showToast("Request cancelled");
      return;
    }

    const errorPayload = {
      prompt: trimmedInput,
      error: { message: error?.message || "Failed to process request" },
      receivedAt: Date.now(),
    };

    state.history.push(errorPayload);
    renderResponse();

    setProcessingState(false, "Error occurred.");
    showToast(error?.message || "Failed to process request", 4000);
  } finally {
    state.currentAbortController = null;
  }
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

function handleStopClick() {
  if (state.currentAbortController) {
    state.currentAbortController.abort();
    showToast("Stopping...");
  }
}

function handleResetClick() {
  if (!confirm("Reset will clear the conversation and destroy the AI session. Continue?")) {
    return;
  }

  destroySession();
  state.history = [];
  state.pendingRequests = Object.create(null);
  renderResponse();
  setProcessingState(false, "Session reset. AI model ready.");
  showToast("Session reset");
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

function renderResponse() {
  if (!elements.responseArea) return;

  elements.responseArea.innerHTML = "";

  if (!state.history || state.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "response-empty";
    empty.textContent = "Run a command to see AI output here.";
    elements.responseArea.appendChild(empty);
    return;
  }

  // Render all history items (conversation transcript)
  state.history.forEach((payload) => {
    const question = (payload.prompt || "").trim();
    if (question) {
      elements.responseArea.appendChild(renderQuestionBlock(question));
    }

    const card = document.createElement("article");
    card.className = `response-card response-${payload.intent || 'error'}`;

    const header = document.createElement("header");
    header.className = "response-card-header";

    const title = document.createElement("span");
    title.className = "response-card-title";
    title.textContent = buildResponseTitle(payload);
    header.appendChild(title);

    const status = document.createElement("span");
    status.className = "response-card-meta";
    status.textContent = new Date(payload.receivedAt).toLocaleTimeString();
    header.appendChild(status);

    card.appendChild(header);

    if (payload.meta || payload.data?.explain || payload.data?.confidence) {
      const metaSection = document.createElement("div");
      metaSection.className = "response-meta-section";
      
      if (payload.meta?.truncated) {
        const badge = createBadge("Truncated context", "warning");
        metaSection.appendChild(badge);
      }

      if (payload.meta?.tabsUsed?.length) {
        const tabsText = payload.meta.tabsUsed.length === 1 
          ? "1 tab" 
          : `${payload.meta.tabsUsed.length} tabs`;
        const badge = createBadge(tabsText, "info");
        metaSection.appendChild(badge);
      }

      if (typeof payload.data?.confidence === "number") {
        const confidencePct = Math.round(payload.data.confidence * 100);
        const badge = createBadge(`${confidencePct}% confidence`, "info");
        metaSection.appendChild(badge);
      }

      if (payload.data?.explain) {
        const explain = document.createElement("p");
        explain.className = "response-explain";
        explain.textContent = payload.data.explain;
        metaSection.appendChild(explain);
      }

      card.appendChild(metaSection);
    }

    const body = document.createElement("div");
    body.className = "response-card-body";

    if (payload.error) {
      renderErrorBody(body, payload.error);
    } else {
      renderIntentBody(body, payload);
    }

    card.appendChild(body);

    const footer = document.createElement("footer");
    footer.className = "response-card-footer";
    renderIntentActions(footer, payload);
    if (footer.childElementCount) {
      card.appendChild(footer);
    }

    elements.responseArea.appendChild(card);
  });
}

function renderQuestionBlock(question) {
  const wrapper = document.createElement("div");
  wrapper.className = "response-question";

  const label = document.createElement("span");
  label.className = "response-question-label";
  label.textContent = "You asked";
  wrapper.appendChild(label);

  const text = document.createElement("p");
  text.className = "response-question-text";
  text.textContent = question;
  wrapper.appendChild(text);

  return wrapper;
}

function createBadge(text, type = "info") {
  const badge = document.createElement("span");
  badge.className = `response-badge response-badge-${type}`;
  badge.textContent = text;
  return badge;
}

function buildResponseTitle(payload) {
  if (payload.error) {
    return "Something went wrong";
  }

  switch (payload.intent) {
    case INTENTS.SUMMARIZE:
      return "Summary";
    case INTENTS.WRITE:
      return "Draft";
    case INTENTS.CORRECT:
      return "Correction";
    case INTENTS.HIGHLIGHT:
      return "Highlights";
    case INTENTS.NONE:
      return "Unable to process";
    default:
      return "Response";
  }
}

function renderErrorBody(container, error) {
  const message = document.createElement("p");
  message.className = "response-error";
  message.textContent = error?.message || "An unexpected error occurred.";
  container.appendChild(message);
}

function renderIntentBody(container, payload) {
  switch (payload.intent) {
    case INTENTS.SUMMARIZE:
      renderSummaryBody(container, payload.data);
      break;
    case INTENTS.WRITE:
      renderWriterBody(container, payload.data);
      break;
    case INTENTS.CORRECT:
      renderCorrectionBody(container, payload.data);
      break;
    case INTENTS.HIGHLIGHT:
    default:
      renderHighlightBody(container, payload.data);
      break;
  }
}

function renderSummaryBody(container, data) {
  if (!data || !data.summary) {
    renderEmptyBody(container);
    return;
  }

  const summary = data.summary;

  if (summary.tldr) {
    const p = document.createElement("p");
    p.className = "response-primary";
    p.textContent = summary.tldr;
    container.appendChild(p);
  }

  if (Array.isArray(summary.bullets) && summary.bullets.length) {
    appendListSection(container, "Key points", summary.bullets);
  }
}

function renderWriterBody(container, data) {
  if (!data || !data.draft) {
    renderEmptyBody(container);
    return;
  }

  const draft = document.createElement("p");
  draft.className = "response-primary";
  draft.textContent = data.draft;
  container.appendChild(draft);

  if (data.explain) {
    const explain = document.createElement("p");
    explain.className = "response-muted";
    explain.textContent = data.explain;
    container.appendChild(explain);
  }
}

function renderCorrectionBody(container, data) {
  if (!data || !data.correction) {
    renderEmptyBody(container);
    return;
  }

  const corrected = document.createElement("p");
  corrected.className = "response-primary";
  corrected.textContent = data.correction;
  container.appendChild(corrected);

  if (data.explain) {
    const explain = document.createElement("p");
    explain.className = "response-muted";
    explain.textContent = data.explain;
    container.appendChild(explain);
  }
}

function renderHighlightBody(container, data) {
  const count = Array.isArray(data?.highlights) ? data.highlights.length : 0;
  const message = count
    ? `Applied ${count} highlight${count === 1 ? "" : "s"} on the page.`
    : "No highlights were applied.";
  const p = document.createElement("p");
  p.textContent = message;
  container.appendChild(p);
}

function renderEmptyBody(container) {
  const p = document.createElement("p");
  p.className = "response-muted";
  p.textContent = "No content returned.";
  container.appendChild(p);
}

function appendListSection(container, label, items) {
  if (!Array.isArray(items) || !items.length) return;

  const heading = document.createElement("h4");
  heading.textContent = label;
  container.appendChild(heading);

  const list = document.createElement("ul");
  items.slice(0, 8).forEach((value) => {
    const li = document.createElement("li");
    li.textContent = value;
    list.appendChild(li);
  });
  container.appendChild(list);
}

function renderIntentActions(container, payload) {
  if (payload.error) {
    const retry = createActionButton("Retry", () => handleProcessClick());
    container.appendChild(retry);
    return;
  }

  const data = payload.data;

  switch (payload.intent) {
    case INTENTS.SUMMARIZE: {
      if (data?.summary) {
        const copySummary = createActionButton("Copy summary", () => copyTextToClipboard(buildSummaryClipboard(data.summary)));
        container.appendChild(copySummary);
      }
      break;
    }
    case INTENTS.WRITE: {
      if (data?.draft) {
        const insert = createActionButton("Insert draft", () => dispatchInsertDraft(data.draft, payload.targetTabId));
        container.appendChild(insert);
        const copy = createActionButton("Copy draft", () => copyTextToClipboard(data.draft));
        container.appendChild(copy);
      }
      break;
    }
    case INTENTS.CORRECT: {
      if (data?.correction) {
        const replace = createActionButton("Replace selection", () =>
          dispatchReplaceSelection(data.correction, payload.targetTabId)
        );
        container.appendChild(replace);
        const copy = createActionButton("Copy corrected", () => copyTextToClipboard(data.correction));
        container.appendChild(copy);
      }
      break;
    }
    case INTENTS.HIGHLIGHT:
      if (data?.highlights?.length) {
        const reapply = createActionButton("Reapply highlights", () =>
          dispatchHighlights(data.highlights, payload.targetTabId)
        );
        container.appendChild(reapply);
      }
      break;
    case INTENTS.NONE:
    default:
      break;
  }
}

function createActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "response-btn";
  button.textContent = label;
  button.addEventListener("click", () => {
    try {
      handler();
    } catch (error) {
      console.warn(`${LOG_PREFIX} response action failed`, error);
      showToast("Action failed", 2400);
    }
  });
  return button;
}

function buildSummaryClipboard(summary) {
  if (!summary) return "";
  const parts = [];
  if (summary.tldr) parts.push(`TL;DR: ${summary.tldr}`);
  if (Array.isArray(summary.bullets) && summary.bullets.length) {
    parts.push("\nKey points:");
    summary.bullets.forEach((item) => parts.push(`• ${item}`));
  }
  return parts.join("\n");
}

function dispatchHighlights(highlights, targetTabId) {
  if (!Array.isArray(highlights) || !highlights.length) {
    showToast("No highlights to apply.");
    return;
  }

  chrome.runtime.sendMessage({ action: "applyHighlights", highlights, targetTabId }, (response) =>
    handleActionResponse(response, "Highlights applied", "Could not apply highlights")
  );
}

function dispatchInsertDraft(draft, targetTabId) {
  if (!draft) {
    showToast("No draft available.");
    return;
  }

  chrome.runtime.sendMessage({ action: "insertDraft", draft, targetTabId }, (response) =>
    handleActionResponse(response, "Draft inserted", "Could not insert draft")
  );
}

function dispatchReplaceSelection(text, targetTabId) {
  if (!text) {
    showToast("No corrected text available.");
    return;
  }

  chrome.runtime.sendMessage({ action: "replaceSelection", text, targetTabId }, (response) =>
    handleActionResponse(response, "Selection replaced", "Could not replace selection")
  );
}

function handleActionResponse(response, successMessage, failureMessage) {
  if (chrome.runtime.lastError) {
    console.warn(`${LOG_PREFIX} action failed`, chrome.runtime.lastError);
    showToast(failureMessage, 3600);
    return;
  }

  if (response?.fallback === "clipboard" && response?.text) {
    copyTextToClipboard(response.text)
      .then(() => showToast("Copied to clipboard. Paste where needed."))
      .catch((error) => {
        console.warn(`${LOG_PREFIX} clipboard write failed`, error);
        showToast(failureMessage, 3600);
      });
    return;
  }

  if (response?.ok) {
    showToast(successMessage);
  } else {
    showToast(response?.error || failureMessage, 3600);
  }
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function copyTextToClipboard(text) {
  const value = typeof text === "string" ? text : "";
  if (!value) return Promise.reject(new Error("No text to copy"));
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }

  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (success) {
        resolve();
      } else {
        reject(new Error("Clipboard command failed"));
      }
    } catch (error) {
      reject(error);
    }
  });
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


function setProcessingState(isBusy, message) {
  elements.status.textContent = message;
  elements.processButton.disabled = isBusy;
  
  if (elements.stopButton) {
    elements.stopButton.style.display = isBusy ? "inline-flex" : "none";
  }
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
