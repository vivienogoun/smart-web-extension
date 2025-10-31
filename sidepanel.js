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
  thinkingBlock: document.getElementById("thinking-block"),
  thinkingContext: document.getElementById("thinking-context"),
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
  streaming: {
    buffer: '',
    timer: null,
    isActive: false,
    currentBubble: null,
  },
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

// JSON instruction for NEW Prompt API
const SYSTEM_INSTRUCTION = [
  "You are the SmartWeb panel assistant. ",
  "User text can contain typos, slang, or grammar errors. Infer intent anyway. ",
  "Valid intents (uppercase only): SUMMARIZE, WRITE, CORRECT, HIGHLIGHT. ",
  "If the user's ask is ambiguous, pick the most helpful intent (do NOT ask back). ",
  "Always reply with a single JSON object that follows the schema. ",
  "Required fields per intent: ",
  "SUMMARIZE requires 'summary' object with 'tldr' and 'bullets'. ",
  "WRITE requires 'draft' string with the full text to insert. ",
  "CORRECT requires 'correction' string with the corrected text. ",
  "HIGHLIGHT requires 'highlights' array with exact phrases from the page. ",
  "Return exactly: {\"intent\":\"<ONE_OF>\", ...} — do NOT invent other keys like 'type' or 'action'. ",
  "Prefer the SELECTION when present. When multiple tabs are provided, ",
  "extract key differences. Never include explanations outside JSON. ",
  "Return ONLY a single JSON object. Do NOT include code fences, markdown, or any text outside the JSON. ",
  "Keep responses concise: tldr max 150 chars, max 5 bullets (each 120 chars max), draft/correction max 1000 chars, max 5 highlights.",
].join("");

// Text protocol instruction for OLD Prompt API (truncation-tolerant)
const SYSTEM_INSTRUCTION_TEXT = [
  "You are the SmartWeb panel assistant. ",
  "User text can contain typos, slang, or grammar errors. Infer intent anyway. ",
  "Valid intents (uppercase only): SUMMARIZE, WRITE, CORRECT, HIGHLIGHT. ",
  "If the user's ask is ambiguous, pick the most helpful intent (do NOT ask back). ",
  "Prefer the SELECTION when present. When multiple tabs are provided, extract key differences. ",
  "\n",
  "OUTPUT FORMAT: Return ONLY plain text with the following sections and labels. Do not include code fences or JSON.\n",
  "\n",
  "For SUMMARIZE:\n",
  "INTENT: SUMMARIZE\n",
  "TLDR: <one-sentence summary, max 150 chars>\n",
  "BULLETS:\n",
  "- <bullet 1, max 120 chars>\n",
  "- <bullet 2>\n",
  "- <bullet 3>\n",
  "- <bullet 4>\n",
  "- <bullet 5>\n",
  "END\n",
  "\n",
  "For WRITE:\n",
  "INTENT: WRITE\n",
  "DRAFT:\n",
  "<draft text, max 1000 chars>\n",
  "END\n",
  "\n",
  "For CORRECT:\n",
  "INTENT: CORRECT\n",
  "CORRECTION:\n",
  "<corrected text, max 1000 chars>\n",
  "END\n",
  "\n",
  "For HIGHLIGHT:\n",
  "INTENT: HIGHLIGHT\n",
  "HIGHLIGHTS:\n",
  "- <phrase 1>\n",
  "- <phrase 2>\n",
  "- <phrase 3>\n",
  "- <phrase 4>\n",
  "- <phrase 5>\n",
  "END\n",
  "\n",
  "Rules: Use exact labels above (uppercase). Do not include any other text or explanations. Never include Markdown fences. Keep within max lengths. End with the line 'END'.\n",
  "\n",
  "IMPORTANT: **Begin output with `INTENT: <NAME>` on the first line.** If an `INTENT HINT: <NAME>` line is present in the user message, **use that intent**. Return **only** the section(s) for that intent; **do not** include sections for other intents.",
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
          expectedInputs: [{ type: 'text', languages: ['en'] }],
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
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        };

        if (opts.monitor) {
          options.monitor = opts.monitor;
        }

        return await self.ai.languageModel.create(options);
      } else {
        // Old API - add few-shot examples to improve robustness
        const initialPrompts = [];
        
        // System prompt
        if (opts.systemPrompt) {
          initialPrompts.push({ role: 'system', content: opts.systemPrompt });
        }
        
        // Few-shot examples (messy input → clean JSON)
        if (opts.fewShot !== false) {
          initialPrompts.push(
            { role: 'user', content: 'plz wrte coment agree with post' },
            { role: 'assistant', content: '{"intent":"WRITE","draft":"I completely agree with your post. Well said!"}' },
            { role: 'user', content: 'sumariz this page pls' },
            { role: 'assistant', content: '{"intent":"SUMMARIZE","summary":{"tldr":"Main topic summary","bullets":["Key point 1","Key point 2"]}}' },
            { role: 'user', content: 'highlight 3 risks pls' },
            { role: 'assistant', content: '{"intent":"HIGHLIGHT","highlights":["risk of data loss","security vulnerability","compliance issue"]}' }
          );
        }
        
        const options = {
          initialPrompts,
          expectedInputs: [{ type: 'text', languages: ['en'] }],
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
  
  // Load conversation for current tab
  if (state.activeTabId) {
    await loadConversation(state.activeTabId);
  }
  
  wireEventListeners();
  renderContextChips();
});

// Initialisation helpers ---------------------------------------------------

function initialiseStatus() {
  checkModelAvailability();
  chrome.runtime.sendMessage({ action: "injectContentScripts" }, () => void chrome.runtime.lastError);
}

// Prompt API functions -----------------------------------------------------

// Infer intent from user prompt (for OLD API intent hints)
function inferIntentFromPrompt(prompt) {
  const lower = prompt.toLowerCase();
  
  if (/write|draft|reply|respond|comment|compose/i.test(lower)) {
    return 'WRITE';
  }
  if (/correct|fix|proofread|polish|improve|edit/i.test(lower)) {
    return 'CORRECT';
  }
  if (/highlight|extract|key points|risks|important|phrases/i.test(lower)) {
    return 'HIGHLIGHT';
  }
  
  // Default to SUMMARIZE
  return 'SUMMARIZE';
}

// Parse text protocol response (OLD API - truncation-tolerant)
function parseTextProtocol(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  
  let intent = null;
  let tldr = null;
  let bullets = [];
  let draft = null;
  let correction = null;
  let highlights = [];
  
  let currentSection = null;
  let collectingMultiline = false;
  let multilineBuffer = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Normalize bullet markers (• to -)
    if (line.startsWith('• ')) {
      line = '- ' + line.substring(2);
    }
    
    // Check for END marker (case-insensitive)
    if (line.toUpperCase() === 'END') {
      break;
    }
    
    // Check for section headers (case-insensitive)
    const lineUpper = line.toUpperCase();
    
    if (lineUpper.startsWith('INTENT:')) {
      intent = line.substring(7).trim().toUpperCase();
      continue;
    }
    
    if (lineUpper.startsWith('TLDR:')) {
      tldr = line.substring(5).trim();
      // Cap at 150 chars
      if (tldr.length > 150) {
        tldr = tldr.substring(0, 147) + '...';
      }
      continue;
    }
    
    if (lineUpper === 'BULLETS:') {
      currentSection = 'bullets';
      continue;
    }
    
    if (lineUpper === 'DRAFT:' || lineUpper.startsWith('DRAFT:')) {
      currentSection = 'draft';
      collectingMultiline = true;
      multilineBuffer = [];
      // Check if content is on the same line as the label
      const contentAfterLabel = line.substring(6).trim();
      if (contentAfterLabel) {
        multilineBuffer.push(contentAfterLabel);
      }
      continue;
    }
    
    if (lineUpper === 'CORRECTION:' || lineUpper.startsWith('CORRECTION:')) {
      currentSection = 'correction';
      collectingMultiline = true;
      multilineBuffer = [];
      // Check if content is on the same line as the label
      const contentAfterLabel = line.substring(11).trim();
      if (contentAfterLabel) {
        multilineBuffer.push(contentAfterLabel);
      }
      continue;
    }
    
    if (lineUpper === 'HIGHLIGHTS:') {
      currentSection = 'highlights';
      continue;
    }
    
    // Collect content based on current section
    if (currentSection === 'bullets' && line.startsWith('- ')) {
      let bullet = line.substring(2).trim();
      // Cap at 120 chars
      if (bullet.length > 120) {
        bullet = bullet.substring(0, 117) + '...';
      }
      // Max 5 bullets
      if (bullets.length < 5) {
        bullets.push(bullet);
      }
    } else if (currentSection === 'highlights' && line.startsWith('- ')) {
      let highlight = line.substring(2).trim();
      // Max 5 highlights
      if (highlights.length < 5) {
        highlights.push(highlight);
      }
    } else if (currentSection === 'draft' && collectingMultiline) {
      multilineBuffer.push(line);
    } else if (currentSection === 'correction' && collectingMultiline) {
      multilineBuffer.push(line);
    }
  }
  
  // Finalize multiline sections with length caps
  if (currentSection === 'draft' && multilineBuffer.length > 0) {
    draft = multilineBuffer.join('\n');
    // Cap at 1200 chars
    if (draft.length > 1200) {
      draft = draft.substring(0, 1197) + '...';
    }
  }
  if (currentSection === 'correction' && multilineBuffer.length > 0) {
    correction = multilineBuffer.join('\n');
    // Cap at 1200 chars
    if (correction.length > 1200) {
      correction = correction.substring(0, 1197) + '...';
    }
  }
  
  // Infer intent from sections if not explicitly provided
  if (!intent) {
    if (draft) {
      intent = 'WRITE';
      console.debug(`${LOG_PREFIX} inferred intent=WRITE from DRAFT section`);
    } else if (correction) {
      intent = 'CORRECT';
      console.debug(`${LOG_PREFIX} inferred intent=CORRECT from CORRECTION section`);
    } else if (highlights.length > 0) {
      intent = 'HIGHLIGHT';
      console.debug(`${LOG_PREFIX} inferred intent=HIGHLIGHT from HIGHLIGHTS section`);
    } else if (tldr || bullets.length > 0) {
      intent = 'SUMMARIZE';
      console.debug(`${LOG_PREFIX} inferred intent=SUMMARIZE from TLDR/BULLETS section`);
    }
  }
  
  // Build response object based on intent
  const result = {};
  
  // Only add intent if we have one
  if (intent) {
    result.intent = intent;
  }
  
  if (intent === 'SUMMARIZE') {
    result.summary = {
      tldr: tldr || 'Summary not available',
      bullets: bullets.length > 0 ? bullets : ['Content summary']
    };
  } else if (intent === 'WRITE') {
    result.draft = draft || 'Draft not available';
  } else if (intent === 'CORRECT') {
    result.correction = correction || 'Correction not available';
  } else if (intent === 'HIGHLIGHT') {
    result.highlights = highlights.length > 0 ? highlights : ['No highlights found'];
  } else {
    // No valid intent found - try to build something from what we have
    if (draft) {
      result.intent = 'WRITE';
      result.draft = draft;
    } else if (correction) {
      result.intent = 'CORRECT';
      result.correction = correction;
    } else if (highlights.length > 0) {
      result.intent = 'HIGHLIGHT';
      result.highlights = highlights;
    } else if (tldr || bullets.length > 0) {
      result.intent = 'SUMMARIZE';
      result.summary = {
        tldr: tldr || 'Summary not available',
        bullets: bullets.length > 0 ? bullets : ['Content summary']
      };
    }
  }
  
  const inferredNote = result.intent && !lines.some(l => l.toUpperCase().startsWith('INTENT:')) ? ' (inferred)' : '';
  console.debug(`${LOG_PREFIX} parsed text protocol: intent=${result.intent}${inferredNote}, sections=${Object.keys(result).join(',')}`);
  return result;
}

// Complete incomplete JSON by closing open strings, arrays, and objects
function completeIncompleteJSON(text) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escapeNext = false;
  
  // Scan through text to track state
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{') braceDepth++;
      if (char === '}') braceDepth--;
      if (char === '[') bracketDepth++;
      if (char === ']') bracketDepth--;
    }
  }
  
  let completed = text;
  
  // Close open string if needed
  if (inString) {
    completed += '"';
    console.debug(`${LOG_PREFIX} EOF completion: closed open string`);
  }
  
  // Close open brackets (inner to outer)
  while (bracketDepth > 0) {
    completed += ']';
    bracketDepth--;
  }
  
  // Close open braces
  while (braceDepth > 0) {
    completed += '}';
    braceDepth--;
  }
  
  if (completed !== text) {
    console.debug(`${LOG_PREFIX} EOF completion: added ${completed.length - text.length} chars`);
  }
  
  return completed;
}

function sanitizeJSON(text) {
  const MAX_LENGTH = 200000;
  
  // Step 0: Early guards
  if (!text || !text.trim()) {
    throw new Error('No JSON object found in response');
  }
  
  // Remove BOM and zero-width characters
  let cleaned = text.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
  
  // Cap length
  if (cleaned.length > MAX_LENGTH) {
    console.warn(`${LOG_PREFIX} sanitizer: truncated input from ${cleaned.length} to ${MAX_LENGTH} chars`);
    cleaned = cleaned.slice(0, MAX_LENGTH);
  }
  
  // Step 1: Fast path parse
  try {
    const parsed = JSON.parse(cleaned);
    // If it's an object, return it
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    // If it's an array with exactly one object, return that object
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
      return parsed[0];
    }
  } catch (e) {
    // Continue to sanitization
  }
  
  // Step 2: Fenced-block extraction (preferred)
  const fenceMatch = cleaned.match(/```(?:json|js|javascript|txt)?\s*\r?\n?([\s\S]*?)\r?\n?```/i);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    const result = tryParseCandidates([candidate]);
    if (result) return result;
  }
  
  // Step 3 & 4: Global balanced scan (objects and arrays)
  const candidates = extractBalancedCandidates(cleaned);
  const result = tryParseCandidates(candidates);
  if (result) return result;
  
  // Step 5: EOF completion (last resort for truncated responses)
  try {
    let completed = completeIncompleteJSON(cleaned);
    
    // Normalize the completed JSON (critical: removes trailing commas, etc.)
    completed = completed.trim();
    completed = completed.replace(/^`+|`+$/g, ''); // Remove lone backticks
    completed = completed.replace(/[\u2018\u2019]/g, "'"); // Normalize smart quotes
    completed = completed.replace(/[\u201C\u201D]/g, '"');
    completed = completed.replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas
    completed = completed.replace(/\u00A0/g, ' '); // Collapse NBSP
    
    const parsed = JSON.parse(completed);
    
    // If it's an object, return it
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      console.warn(`${LOG_PREFIX} recovered from incomplete JSON via EOF completion + normalization`);
      return parsed;
    }
    
    // If it's an array with exactly one object, unwrap it
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
      console.warn(`${LOG_PREFIX} recovered from incomplete JSON via EOF completion + normalization (unwrapped array)`);
      return parsed[0];
    }
  } catch (e) {
    // EOF completion didn't help, continue to error
  }
  
  // No valid JSON found
  console.error(`${LOG_PREFIX} sanitizer failed. First 300 chars:`, cleaned.slice(0, 300));
  throw new Error('Malformed JSON object in response');
}

function extractBalancedCandidates(text) {
  const candidates = [];
  let i = 0;
  
  while (i < text.length && candidates.length < 10) {
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    
    const char = text[i];
    
    // Try to extract balanced object
    if (char === '{') {
      const extracted = extractBalanced(text, i, '{', '}');
      if (extracted) {
        candidates.push({ type: 'object', text: extracted.text, end: extracted.end });
        i = extracted.end + 1;
        continue;
      }
    }
    
    // Try to extract balanced array
    if (char === '[') {
      const extracted = extractBalanced(text, i, '[', ']');
      if (extracted) {
        candidates.push({ type: 'array', text: extracted.text, end: extracted.end });
        i = extracted.end + 1;
        continue;
      }
    }
    
    i++;
  }
  
  return candidates.map(c => c.text);
}

function extractBalanced(text, start, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === openChar) depth++;
      if (char === closeChar) {
        depth--;
        if (depth === 0) {
          return { text: text.slice(start, i + 1), end: i };
        }
      }
    }
  }
  
  return null;
}

function tryParseCandidates(candidates) {
  for (const candidate of candidates) {
    // Step 5: Candidate normalization
    let normalized = candidate.trim();
    
    // Remove lone backticks
    normalized = normalized.replace(/^`+|`+$/g, '');
    
    // Normalize quotes (smart quotes to straight)
    normalized = normalized.replace(/[\u2018\u2019]/g, "'");
    normalized = normalized.replace(/[\u201C\u201D]/g, '"');
    
    // Remove trailing commas before } or ]
    normalized = normalized.replace(/,(\s*[}\]])/g, '$1');
    
    // Collapse non-breaking spaces
    normalized = normalized.replace(/\u00A0/g, ' ');
    
    // Step 6: Lenient parse
    try {
      const parsed = JSON.parse(normalized);
      
      // If it's an object, return it
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      
      // If it's an array with exactly one object, unwrap it
      if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
        return parsed[0];
      }
    } catch (e) {
      // Try next candidate
      continue;
    }
  }
  
  return null;
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
    
    // Use text protocol for OLD API (truncation-tolerant), JSON for NEW API
    const systemPrompt = PromptAPIAdapter.apiType === 'old' 
      ? SYSTEM_INSTRUCTION_TEXT 
      : SYSTEM_INSTRUCTION;
    
    console.log(`${LOG_PREFIX} using ${PromptAPIAdapter.apiType === 'old' ? 'TEXT' : 'JSON'} protocol`);
    
    state.promptSession = await PromptAPIAdapter.createSession({
      systemPrompt: systemPrompt,
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

// Base64 decode helper for OLD API (handles UTF-8)
function base64Decode(str) {
  if (!str || typeof str !== 'string') {
    return str;
  }
  
  try {
    // Decode Base64 to binary string
    const binaryString = atob(str);
    
    // Convert binary string to UTF-8
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Decode UTF-8 bytes to string
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  } catch (error) {
    console.error(`${LOG_PREFIX} Base64 decode failed:`, error);
    throw new Error('Invalid Base64 encoding in response');
  }
}

// Decode Base64-encoded payload fields (OLD API only)
function decodePayload(parsed, useBase64) {
  // NEW API or no Base64 mode - return as-is
  if (!useBase64 || !parsed || typeof parsed !== 'object') {
    return parsed;
  }
  
  try {
    const intent = parsed.intent;
    
    switch (intent) {
      case 'WRITE':
        if (parsed.draft) {
          parsed.draft = base64Decode(parsed.draft);
        }
        break;
        
      case 'CORRECT':
        if (parsed.correction) {
          parsed.correction = base64Decode(parsed.correction);
        }
        break;
        
      case 'SUMMARIZE':
        if (parsed.summary) {
          if (parsed.summary.tldr) {
            parsed.summary.tldr = base64Decode(parsed.summary.tldr);
          }
          if (Array.isArray(parsed.summary.bullets)) {
            parsed.summary.bullets = parsed.summary.bullets.map(b => base64Decode(b));
          }
        }
        break;
        
      case 'HIGHLIGHT':
        if (Array.isArray(parsed.highlights)) {
          parsed.highlights = parsed.highlights.map(h => base64Decode(h));
        }
        break;
    }
    
    console.debug(`${LOG_PREFIX} decoded Base64 payload for intent: ${intent}`);
    return parsed;
  } catch (error) {
    console.error(`${LOG_PREFIX} payload decode failed:`, error);
    throw new Error('Invalid Base64 encoding in response');
  }
}

function coerceIntent(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  // 1. Map synonyms (type, action) to intent
  if (!parsed.intent && (parsed.type || parsed.action)) {
    parsed.intent = parsed.type || parsed.action;
    console.debug(`${LOG_PREFIX} coerced intent from synonym:`, parsed.intent);
  }

  // 2. Uppercase intent if present
  if (typeof parsed.intent === 'string') {
    const original = parsed.intent;
    parsed.intent = parsed.intent.toUpperCase();
    if (original !== parsed.intent) {
      console.debug(`${LOG_PREFIX} uppercased intent: ${original} → ${parsed.intent}`);
    }
  }

  // 3. Infer intent from payload if still missing
  if (!parsed.intent) {
    if (parsed.draft) {
      parsed.intent = 'WRITE';
      console.debug(`${LOG_PREFIX} inferred WRITE from draft field`);
    } else if (parsed.correction) {
      parsed.intent = 'CORRECT';
      console.debug(`${LOG_PREFIX} inferred CORRECT from correction field`);
    } else if (parsed.summary?.tldr && parsed.summary?.bullets) {
      parsed.intent = 'SUMMARIZE';
      console.debug(`${LOG_PREFIX} inferred SUMMARIZE from summary fields`);
    } else if (Array.isArray(parsed.highlights) && parsed.highlights.length > 0) {
      parsed.intent = 'HIGHLIGHT';
      console.debug(`${LOG_PREFIX} inferred HIGHLIGHT from highlights array`);
    }
  }

  return parsed;
}

function createFallbackResponse(userPrompt, contexts) {
  // Last-resort fallback: default to SUMMARIZE with a helpful message
  console.warn(`${LOG_PREFIX} creating fallback SUMMARIZE response`);
  
  return {
    intent: 'SUMMARIZE',
    summary: {
      tldr: 'Unable to process your request in the expected format.',
      bullets: [
        'The AI response was unclear or incomplete',
        'Defaulting to a summary view',
        'Try rephrasing your request or use simpler language'
      ]
    },
    explain: 'Fallback response due to unclear model output',
    _isFallback: true,
  };
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
    
    // Show thinking block with context info
    showThinkingBlock(contexts);
    
    let { packedContext, meta } = await buildPackedContext(trimmedInput, contexts);
    
    // For OLD API: Prepend intent hint to guide the model
    if (PromptAPIAdapter.apiType === 'old') {
      const inferredIntent = inferIntentFromPrompt(trimmedInput);
      packedContext = `INTENT HINT: ${inferredIntent}\n\n${packedContext}`;
      console.log(`${LOG_PREFIX} intent hint inferred: ${inferredIntent}`);
    }

    state.currentAbortController = new AbortController();

    // Short-prompt optimization: use non-streaming for very short asks
    // This reduces drift on OLD API for simple prompts like "Summarize"
    // OLD API uses higher threshold (64) to avoid truncation
    const streamingThreshold = PromptAPIAdapter.apiType === 'old' ? 64 : 24;
    const useStreaming = trimmedInput.length >= streamingThreshold;
    let fullResponse = "";

    if (useStreaming) {
      // Streaming path
      const streamOptions = {
        signal: state.currentAbortController.signal,
      };

      if (PromptAPIAdapter.supportsResponseConstraint) {
        streamOptions.responseConstraint = RESPONSE_SCHEMA;
      }

      const stream = session.promptStreaming(packedContext, streamOptions);

      // Start streaming display
      startStreaming(trimmedInput);

      let firstChunk = true;
      for await (const chunk of stream) {
        // Hide thinking block on first chunk
        if (firstChunk) {
          hideThinkingBlock();
          firstChunk = false;
        }
        
        fullResponse += chunk;
        
        // Handle streaming display with coalescing
        handleStreamChunk(chunk);
        
        console.debug(`${LOG_PREFIX} received chunk:`, chunk.slice(0, 50));
      }
      
      // End streaming display
      endStreaming();
    } else {
      // Non-streaming path for short prompts
      console.debug(`${LOG_PREFIX} using non-streaming for short prompt (${trimmedInput.length} chars)`);
      
      const promptOptions = {
        signal: state.currentAbortController.signal,
      };

      if (PromptAPIAdapter.supportsResponseConstraint) {
        promptOptions.responseConstraint = RESPONSE_SCHEMA;
      }

      fullResponse = await session.prompt(packedContext, promptOptions);
      
      // Hide thinking block after response
      hideThinkingBlock();
      
      console.debug(`${LOG_PREFIX} received response:`, fullResponse.slice(0, 100));
    }

    // Parse response based on protocol (TEXT for OLD API, JSON for NEW API)
    let validated;
    
    if (PromptAPIAdapter.apiType === 'old') {
      // OLD API: Use text protocol (truncation-tolerant, no retry needed)
      console.log(`${LOG_PREFIX} parsing with TEXT protocol`);
      console.log(`${LOG_PREFIX} raw response:`, fullResponse);
      
      let parsed;
      
      // Check if model returned JSON instead of text protocol
      const trimmedResponse = fullResponse.trim();
      if (trimmedResponse.startsWith('{') || trimmedResponse.startsWith('[')) {
        console.log(`${LOG_PREFIX} model returned JSON instead of text protocol, parsing as JSON`);
        try {
          parsed = sanitizeJSON(fullResponse);
        } catch (jsonError) {
          console.warn(`${LOG_PREFIX} JSON parsing failed, falling back to text protocol:`, jsonError);
          parsed = parseTextProtocol(fullResponse);
        }
      } else {
        // Use text protocol parser
        parsed = parseTextProtocol(fullResponse);
      }
      
      console.log(`${LOG_PREFIX} parsed result:`, JSON.stringify(parsed, null, 2));
      
      // Coerce intent if missing (infer from sections present)
      if (!parsed.intent) {
        if (parsed.draft) {
          parsed.intent = 'WRITE';
          console.debug(`${LOG_PREFIX} coerced intent to WRITE from draft field`);
        } else if (parsed.correction) {
          parsed.intent = 'CORRECT';
          console.debug(`${LOG_PREFIX} coerced intent to CORRECT from correction field`);
        } else if (parsed.highlights && parsed.highlights.length > 0) {
          parsed.intent = 'HIGHLIGHT';
          console.debug(`${LOG_PREFIX} coerced intent to HIGHLIGHT from highlights field`);
        } else if (parsed.summary) {
          parsed.intent = 'SUMMARIZE';
          console.debug(`${LOG_PREFIX} coerced intent to SUMMARIZE from summary field`);
        }
      }
      
      const coerced = coerceIntent(parsed);
      validated = validateResponse(coerced);
    } else {
      // NEW API: Use JSON protocol with retry logic
      console.debug(`${LOG_PREFIX} parsing with JSON protocol`);
      let retryAttempted = false;
      
      while (true) {
        try {
          const parsed = sanitizeJSON(fullResponse);
          const coerced = coerceIntent(parsed);
          validated = validateResponse(coerced);
          break; // Success, exit loop
        } catch (parseError) {
          // Check if this looks like EOF truncation and we haven't retried yet
          const isEOFError = parseError.message?.includes('Malformed JSON') && !retryAttempted;
          
          if (isEOFError) {
            console.warn(`${LOG_PREFIX} detected possible EOF truncation, attempting continuation...`);
            retryAttempted = true;
            
            try {
              // Request continuation
              const continuationPrompt = "Continue the previous reply by outputting only the remainder of the JSON. Do not repeat earlier parts and do not add any text outside JSON.";
              const continuation = await session.prompt(continuationPrompt, {
                signal: state.currentAbortController.signal,
              });
              
              console.debug(`${LOG_PREFIX} received continuation:`, continuation.slice(0, 100));
              
              // Smart concatenation: check if continuation has fenced block or new JSON object
              const hasFence = /```(?:json|js|javascript)?/i.test(continuation);
              const hasNewObject = continuation.trim().startsWith('{');
              
              if (hasFence || hasNewObject) {
                // Continuation has structure - let sanitizer find first complete object
                fullResponse = fullResponse + "\n" + continuation;
                console.debug(`${LOG_PREFIX} continuation has structure, re-sanitizing combined buffer`);
              } else {
                // Looks like a plain tail, append directly
                fullResponse += continuation;
                console.debug(`${LOG_PREFIX} continuation looks like tail, appending`);
              }
              
              continue; // Retry parse with concatenated response
            } catch (retryError) {
              console.error(`${LOG_PREFIX} continuation failed:`, retryError);
              throw parseError; // Throw original error
            }
          } else {
            // Not an EOF error or already retried, throw original error
            throw parseError;
          }
        }
      }
    }

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
    
    // Save conversation to storage
    await saveConversation();

    setProcessingState(false, "AI model is ready.");
    showToast("Response received");
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to process`, error);
    
    // Hide thinking block on error
    hideThinkingBlock();

    if (error.name === "AbortError") {
      setProcessingState(false, "AI model is ready.");
      showToast("Request cancelled");
      return;
    }

    // Check if this is a validation or sanitize error - use fallback
    const isValidationError = error.message?.includes('Invalid response') || 
                              error.message?.includes('missing or invalid intent') ||
                              error.message?.includes('requires') ||
                              error.message?.includes('Malformed JSON') ||
                              error.message?.includes('No JSON object found');
    
    if (isValidationError) {
      console.warn(`${LOG_PREFIX} validation failed, using fallback response`);
      
      const contexts = gatherContexts();
      const fallbackData = createFallbackResponse(trimmedInput, contexts);
      
      const fallbackPayload = {
        prompt: trimmedInput,
        intent: fallbackData.intent,
        targetTabId: state.activeTabId,
        data: fallbackData,
        meta: { fallback: true },
        receivedAt: Date.now(),
      };
      
      state.history.push(fallbackPayload);
      renderResponse();
      await saveConversation();
      
      setProcessingState(false, "AI model is ready.");
      showToast("Response unclear - showing fallback summary", 3000);
    } else {
      // Other errors (network, session, etc.)
      const errorPayload = {
        prompt: trimmedInput,
        error: { message: error?.message || "Failed to process request" },
        receivedAt: Date.now(),
      };

      state.history.push(errorPayload);
      renderResponse();
      await saveConversation();

      setProcessingState(false, "Error occurred.");
      showToast(error?.message || "Failed to process request", 4000);
    }
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

async function handleResetClick() {
  if (!confirm("Reset will clear the conversation and destroy the AI session. Continue?")) {
    return;
  }

  destroySession();
  state.history = [];
  state.pendingRequests = Object.create(null);
  
  // Clear conversation from storage
  await clearConversation(state.activeTabId);
  
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

function showThinkingBlock(contexts) {
  if (!elements.thinkingBlock || !elements.thinkingContext) return;

  // Build context info
  const contextLines = [];
  
  // Check for selection
  const hasSelection = contexts.some(ctx => ctx.type === 'selection');
  if (hasSelection) {
    contextLines.push('<div class="thinking-context-line">Using selection</div>');
  }

  // Check for tabs
  const tabContexts = contexts.filter(ctx => ctx.type === 'tab');
  if (tabContexts.length > 0) {
    contextLines.push(`<div class="thinking-context-line">Reading ${tabContexts.length} tab(s)</div>`);
    
    // Show first 2 tab titles + "+X more"
    const tabsList = ['<div class="thinking-tabs-list">'];
    const maxTitles = 2;
    
    tabContexts.slice(0, maxTitles).forEach(tab => {
      const title = truncateTitle(tab.title || 'Untitled', 48);
      tabsList.push(`<div class="thinking-tab-item">• ${title}</div>`);
    });
    
    if (tabContexts.length > maxTitles) {
      const remaining = tabContexts.length - maxTitles;
      tabsList.push(`<div class="thinking-tab-item">• +${remaining} more</div>`);
    }
    
    tabsList.push('</div>');
    contextLines.push(tabsList.join(''));
  }

  elements.thinkingContext.innerHTML = contextLines.join('');
  elements.thinkingBlock.classList.remove('hidden', 'fade-out');
}

function hideThinkingBlock() {
  if (!elements.thinkingBlock) return;
  
  // Fade out then hide
  elements.thinkingBlock.classList.add('fade-out');
  setTimeout(() => {
    elements.thinkingBlock.classList.add('hidden');
  }, 300);
}

function truncateTitle(title, maxLength) {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength - 1) + '…';
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

  // Render all history items as chat bubbles
  state.history.forEach((payload) => {
    // User message bubble
    const question = (payload.prompt || "").trim();
    if (question) {
      const userBubble = document.createElement("div");
      userBubble.className = "message-bubble message-user";
      
      const content = document.createElement("div");
      content.className = "message-content";
      content.textContent = question;
      userBubble.appendChild(content);
      
      elements.responseArea.appendChild(userBubble);
    }

    // AI response bubble
    const aiBubble = document.createElement("div");
    aiBubble.className = "message-bubble message-ai";

    const contentWrapper = document.createElement("div");
    contentWrapper.className = "message-content";

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

      contentWrapper.appendChild(metaSection);
    }

    // Add intent-specific content
    const body = document.createElement("div");
    body.className = "response-body";

    if (payload.error) {
      renderErrorBody(body, payload.error);
    } else {
      renderIntentBody(body, payload);
    }

    contentWrapper.appendChild(body);
    aiBubble.appendChild(contentWrapper);

    // Add timestamp
    const timestamp = document.createElement("div");
    timestamp.className = "message-timestamp";
    timestamp.textContent = new Date(payload.receivedAt).toLocaleTimeString();
    aiBubble.appendChild(timestamp);

    // Add action buttons
    const footer = document.createElement("footer");
    footer.className = "response-card-footer";
    renderIntentActions(footer, payload);
    if (footer.childElementCount) {
      aiBubble.appendChild(footer);
    }

    elements.responseArea.appendChild(aiBubble);
  });
  
  // Auto-scroll to bottom
  scrollToBottom();
}

function scrollToBottom() {
  if (elements.responseArea) {
    elements.responseArea.scrollTop = elements.responseArea.scrollHeight;
  }
}

function startStreaming(userPrompt) {
  // Reset streaming state
  state.streaming.buffer = '';
  state.streaming.isActive = true;
  state.streaming.currentBubble = null;
  
  // Add user bubble immediately
  const userBubble = document.createElement("div");
  userBubble.className = "message-bubble message-user";
  
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = userPrompt;
  userBubble.appendChild(content);
  
  elements.responseArea.appendChild(userBubble);
  scrollToBottom();
}

function handleStreamChunk(chunk) {
  if (!state.streaming.isActive) return;
  
  state.streaming.buffer += chunk;
  
  // Coalesce chunks - flush every 250ms
  if (!state.streaming.timer) {
    state.streaming.timer = setTimeout(() => {
      flushStreamingBuffer();
      state.streaming.timer = null;
    }, 250);
  }
}

function flushStreamingBuffer() {
  if (!state.streaming.isActive) return;
  
  // Create AI bubble if it doesn't exist
  if (!state.streaming.currentBubble) {
    const aiBubble = document.createElement("div");
    aiBubble.className = "message-bubble message-ai";
    
    const contentWrapper = document.createElement("div");
    contentWrapper.className = "message-content streaming-content";
    aiBubble.appendChild(contentWrapper);
    
    elements.responseArea.appendChild(aiBubble);
    state.streaming.currentBubble = aiBubble;
  }
  
  // Update content
  const contentEl = state.streaming.currentBubble.querySelector('.message-content');
  if (contentEl) {
    contentEl.textContent = state.streaming.buffer;
  }
  
  scrollToBottom();
}

function endStreaming() {
  // Final flush
  if (state.streaming.timer) {
    clearTimeout(state.streaming.timer);
    state.streaming.timer = null;
  }
  
  flushStreamingBuffer();
  
  // Remove streaming bubble (will be replaced by full response)
  if (state.streaming.currentBubble) {
    state.streaming.currentBubble.remove();
  }
  
  // Reset state
  state.streaming.buffer = '';
  state.streaming.isActive = false;
  state.streaming.currentBubble = null;
}

// Per-tab persistence
async function saveConversation() {
  const tabId = state.activeTabId;
  if (!tabId) return;
  
  const key = `smartweb:convo:${tabId}`;
  const data = {
    history: state.history,
    timestamp: Date.now(),
  };
  
  try {
    await chrome.storage.local.set({ [key]: data });
    console.debug(`${LOG_PREFIX} saved conversation for tab ${tabId}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to save conversation`, error);
  }
}

async function loadConversation(tabId) {
  if (!tabId) return;
  
  const key = `smartweb:convo:${tabId}`;
  
  try {
    const result = await chrome.storage.local.get(key);
    
    if (result[key]) {
      state.history = result[key].history || [];
      console.debug(`${LOG_PREFIX} loaded conversation for tab ${tabId}`, state.history.length, 'items');
      renderResponse();
    } else {
      state.history = [];
      renderResponse();
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to load conversation`, error);
    state.history = [];
    renderResponse();
  }
}

async function clearConversation(tabId) {
  if (!tabId) return;
  
  const key = `smartweb:convo:${tabId}`;
  
  try {
    await chrome.storage.local.remove(key);
    console.debug(`${LOG_PREFIX} cleared conversation for tab ${tabId}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to clear conversation`, error);
  }
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
    const retry = createActionButton("Retry", "action-retry", () => handleProcessClick());
    container.appendChild(retry);
    return;
  }

  const data = payload.data;

  switch (payload.intent) {
    case INTENTS.SUMMARIZE: {
      if (data?.summary) {
        const copySummary = createActionButton("Copy", "action-copy", () => {
          copyTextToClipboard(buildSummaryClipboard(data.summary));
          showToast("Copied to clipboard");
        });
        container.appendChild(copySummary);
      }
      break;
    }
    case INTENTS.WRITE: {
      if (data?.draft) {
        const insert = createActionButton("Insert", "action-insert", () => {
          dispatchInsertDraft(data.draft, payload.targetTabId);
          showToast("Inserted into editor");
        });
        container.appendChild(insert);
        const copy = createActionButton("Copy", "action-copy", () => {
          copyTextToClipboard(data.draft);
          showToast("Copied to clipboard");
        });
        container.appendChild(copy);
      }
      break;
    }
    case INTENTS.CORRECT: {
      if (data?.correction) {
        const replace = createActionButton("Replace", "action-replace", () => {
          dispatchReplaceSelection(data.correction, payload.targetTabId);
          showToast("Selection replaced");
        });
        container.appendChild(replace);
        const copy = createActionButton("Copy", "action-copy", () => {
          copyTextToClipboard(data.correction);
          showToast("Copied to clipboard");
        });
        container.appendChild(copy);
      }
      break;
    }
    case INTENTS.HIGHLIGHT:
      if (data?.highlights?.length) {
        const reapply = createActionButton("Apply", "action-apply", () => {
          dispatchHighlights(data.highlights, payload.targetTabId);
          showToast("Highlights applied");
        });
        container.appendChild(reapply);
      }
      break;
    case INTENTS.NONE:
    default:
      break;
  }
}

function createActionButton(label, actionClass, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-btn ${actionClass}`;
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
