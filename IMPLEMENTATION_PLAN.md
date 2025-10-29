# SmartWeb Prompt API Implementation Plan

**Goal:** Migrate the extension from slash-command routing to a natural-language conversational assistant powered by Chrome's built-in Prompt API (Gemini Nano), following the spec in `conversational-assistant.md`.

---

## Phase 1: Prompt API Foundation & Availability

### 1.1 Check Prompt API availability and handle download
**Files:** `service-worker.js`, `sidepanel.js`

- [ ] Replace `checkModelStatus()` with `LanguageModel.availability()` check
- [ ] Implement status state machine: `checking → downloadable → downloading → available → ready`
- [ ] Add download monitor with progress events (`downloadprogress`) and emit to panel
- [ ] Update panel status bar to show: "Checking AI model…", "Installing on-device model… (X%)", "AI model is ready"
- [ ] Handle `unavailable` state with user-facing error banner and Chrome update instructions
- [ ] Gate Send button on `available` status

**Acceptance:**
- Panel shows download progress on first run
- Status updates correctly reflect availability states
- Send button disabled until model is ready

---

## Phase 2: Session Lifecycle & Natural Language Input

### 2.1 Create and manage Prompt API session
**Files:** `service-worker.js`

- [ ] Create session on first user gesture with `LanguageModel.create()`
- [ ] Read `defaultTemperature` and `defaultTopK` from `LanguageModel.params()`
- [ ] Seed `initialPrompts` with system instruction (Section 5.1 of spec)
- [ ] Store session reference globally; reuse across turns
- [ ] Implement `resetSession()` to destroy and recreate session
- [ ] Add per-session AbortController for global cancel

**System prompt template:**
```
You are the SmartWeb panel assistant. Choose ONE intent that best fulfills the user request: SUMMARIZE, WRITE, CORRECT, or HIGHLIGHT. Always reply with a single JSON object that follows the schema. Prefer the SELECTION when present. When multiple tabs are provided, extract key differences. For HIGHLIGHT, return short exact phrases that appear in the page text. Never include explanations outside JSON.
```

### 2.2 Remove slash-command parsing
**Files:** `sidepanel.js`

- [ ] Remove `SLASH_INTENT_MAP` and `deriveIntentPayload()`
- [ ] Update `handleProcessClick()` to send raw natural-language prompt
- [ ] Remove intent-specific fallback prompts
- [ ] Update placeholder to: "Ask a question about this page..."

**Acceptance:**
- Users can type "summarize this page" or "write a LinkedIn post" without slash commands
- Panel sends raw prompt to service worker

---

## Phase 3: Context Packer (Bounded, Deterministic)

### 3.1 Build context aggregation with budget
**Files:** `service-worker.js`

- [ ] Implement `buildPackedContext(userPrompt, contexts)` function
- [ ] Extract selection text (cap at 2-3k chars, preserve sentence boundaries)
- [ ] For each tab context, fetch visible text via `getTabText` (cap at 3-5k chars per tab)
- [ ] Include tab metadata: `title`, `url`
- [ ] Enforce total budget (≤ 10-12k chars aggregate)
- [ ] When over budget, drop lowest-priority sections and set `meta.truncated = true`
- [ ] Format as structured template (Section 4 of spec):
  ```
  SYSTEM RULES…
  
  CONTEXT
  =======
  [SELECTION]
  «text»
  
  [TAB 1] Title: … URL: …
  «snippet»
  
  USER ASK
  ========
  «prompt»
  ```

**Acceptance:**
- Context stays under budget
- Truncation flag set when needed
- Selection prioritized over tab content

---

## Phase 4: Unified JSON Schema & Structured Output

### 4.1 Define response schema
**Files:** `service-worker.js`

- [ ] Create `RESPONSE_SCHEMA` constant (Section 5.2 of spec):
  ```js
  {
    type: 'object',
    required: ['intent'],
    properties: {
      intent: { enum: ['SUMMARIZE', 'WRITE', 'CORRECT', 'HIGHLIGHT', 'NONE'] },
      summary: { type: 'object', required: ['tldr', 'bullets'], properties: { tldr, bullets } },
      draft: { type: 'string' },
      correction: { type: 'string' },
      highlights: { type: 'array', items: { type: 'string' } },
      explain: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      targets: { type: 'object', properties: { tabId: { type: 'string' } } }
    }
  }
  ```
- [ ] Remove old per-intent schemas (`HIGHLIGHT_SCHEMA`, `SUMMARY_SCHEMA`, etc.)
- [ ] Implement `validateResponse(parsed, schema)` with cross-field checks:
  - `SUMMARIZE` → `summary` present
  - `WRITE` → `draft` present
  - `CORRECT` → `correction` present
  - `HIGHLIGHT` → `highlights.length >= 1`

**Acceptance:**
- Schema validates all intent types
- Invalid responses throw clear errors

---

## Phase 5: Streaming Prompts with Stop Control

### 5.1 Implement streaming prompt flow
**Files:** `service-worker.js`, `sidepanel.js`

- [ ] Replace `session.prompt()` with `session.promptStreaming(packedContext, { responseConstraint: RESPONSE_SCHEMA })`
- [ ] Create per-prompt AbortController
- [ ] Stream chunks to panel via `process-chunk` message
- [ ] Accumulate final text and parse JSON after stream completes
- [ ] Validate parsed output and send `process-result` with intent + data
- [ ] Handle abort: catch error, send `process-aborted` message

**Panel changes:**
- [ ] Add `Stop` button (visible during streaming)
- [ ] Render partial chunks in real-time (append to response area)
- [ ] On Stop click, send `abortPrompt` message to service worker
- [ ] Clear partial content on abort

**Acceptance:**
- Streaming shows token flow in panel
- Stop button cancels cleanly without stuck spinners
- Final card renders only after validation

---

## Phase 6: Panel UI Enhancements

### 6.1 Add Stop and Reset controls
**Files:** `sidepanel.html`, `sidepanel.js`, `src/tailwind.css`

- [ ] Add `Stop` button next to Send (hidden by default, shown during streaming)
- [ ] Add `Reset` button in header to clear conversation and destroy session
- [ ] Wire Stop → `abortPrompt` message
- [ ] Wire Reset → `resetSession` message, clear response area, clear history

### 6.2 Show metadata badges
**Files:** `sidepanel.js`

- [ ] Render `Truncated context` badge when `meta.truncated === true`
- [ ] Show list of tabs used in context (from `contexts` array)
- [ ] Display `explain` text under card title if present
- [ ] Show `confidence` score if present

### 6.3 Update card rendering for unified schema
**Files:** `sidepanel.js`

- [ ] Update `renderIntentBody()` to handle new schema structure:
  - `SUMMARIZE` → `summary.tldr` + `summary.bullets`
  - `WRITE` → `draft`
  - `CORRECT` → `correction`
  - `HIGHLIGHT` → `highlights` array
- [ ] Add `explain` field rendering
- [ ] Update action buttons to match new data paths

**Acceptance:**
- Cards render correctly for all intent types
- Metadata badges visible when applicable
- Stop/Reset controls functional

---

## Phase 7: Content Script DOM Actions

### 7.1 Ensure robust DOM handlers
**Files:** `content-script.js`

- [ ] Verify `highlightText` wraps exact phrases case-insensitively, avoids double-wrapping
- [ ] Return `{ ok: true, count }` with number of highlights applied
- [ ] Verify `insertDraft` checks for focused editable, falls back to clipboard
- [ ] Return `{ ok: true, method: 'editable' | 'clipboard' }`
- [ ] Verify `replaceSelection` replaces current selection or clipboard fallback
- [ ] Return `{ ok: true, method }`
- [ ] Add `resetDom` action to remove all `<mark data-smartweb>` markers

**Performance:**
- [ ] Batch DOM mutations in `highlightText` (use TreeWalker + Range wrapping)
- [ ] Avoid layout thrash on long pages

**Acceptance:**
- Highlights apply correctly and report count
- Insert/replace use editable or clipboard with toast
- Reset removes all markers

---

## Phase 8: Conversation History & Persistence

### 8.1 Store conversation metadata
**Files:** `service-worker.js`, `sidepanel.js`

- [ ] Persist history entries: `{ ts, prompt, intent, tabsUsed, selectionLen, inputLen, truncated }`
- [ ] Never store raw page text
- [ ] Store in `chrome.storage.local` under `conversationHistory` key
- [ ] Limit to last 20 entries
- [ ] Clear history on Reset

### 8.2 Render conversation cards
**Files:** `sidepanel.js`

- [ ] Show all turns in response area (scrollable)
- [ ] Each card shows: timestamp, user prompt, AI response, actions
- [ ] Preserve action buttons for all historical cards

**Acceptance:**
- History persists across panel reopens
- Reset clears history and session
- No raw page content stored

---

## Phase 9: Error Handling & Resilience

### 9.1 User-facing error states
**Files:** `service-worker.js`, `sidepanel.js`

- [ ] `Unsupported build` (Prompt API missing) → show Chrome update steps
- [ ] `Model unavailable` → disable Send, show setup instructions
- [ ] `Invalid model output` (schema validation failed) → show error banner, no DOM changes
- [ ] `Context too large` (packer exceeded budget) → recommend smaller selection or fewer tabs
- [ ] `No highlight matches` (HIGHLIGHT but 0 matches) → show tip to adjust phrases

### 9.2 Message-port hygiene
**Files:** `service-worker.js`, `sidepanel.js`, `content-script.js`

- [ ] Ensure every `chrome.runtime.sendMessage` with callback receives `sendResponse`
- [ ] Ensure all async handlers `return true`
- [ ] Verify no "message port closed" warnings in console

**Acceptance:**
- All error states show clear user guidance
- No console warnings about message ports

---

## Phase 10: Testing & Validation

### 10.1 Black-box acceptance tests

- [ ] **Ready flow:** Open panel → see "Checking → Installing (if first run) → Ready"; Send enabled
- [ ] **Free-form summary:** "please summarize this page" → card with TL;DR + bullets; Apply highlights works
- [ ] **Selection-based writing:** Select text → "based on this selection, write a LinkedIn post" → WRITE card; Insert draft works
- [ ] **Correction:** Select text → "fix grammar" → CORRECT card; Replace selection works
- [ ] **Multi-tab compare:** Add two @tabs → "compare these tabs" → SUMMARIZE with per-tab bullets
- [ ] **Streaming:** Long request shows token flow; Stop cancels cleanly
- [ ] **Error handling:** Over-long page sets truncated badge; invalid JSON shows banner

### 10.2 Developer checklist (from spec Section 10)

- [ ] Panel sends `processAsk` with `{ prompt, contexts }`
- [ ] SW replies to every message with callback
- [ ] SW emits `ai-status-update` with all states
- [ ] Panel maps `downloadable/downloading` → "Installing…"
- [ ] Session created on first gesture, reused, Reset exposed
- [ ] `initialPrompts` seeded with system rules
- [ ] All turns use `promptStreaming()` with Stop
- [ ] Context packer includes selection + tab snippets with budget
- [ ] `responseConstraint` attached to every prompt
- [ ] Parse + validate final JSON; route by intent
- [ ] Gate actions until validation passes
- [ ] CS `highlightText` returns `{ ok, count }`
- [ ] CS `insertDraft` returns method
- [ ] CS `replaceSelection` returns method
- [ ] CS `resetDom` removes all markers
- [ ] AbortController for per-prompt cancel
- [ ] Paragraph-aware truncation

---

## Migration Strategy

### Incremental rollout:
1. **Phase 1-2:** Replace availability check and session creation (no UI changes yet)
2. **Phase 3-4:** Build context packer and schema (test with manual prompts)
3. **Phase 5:** Enable streaming (parallel with old slash-command flow for testing)
4. **Phase 6:** Update UI (Stop/Reset, badges)
5. **Phase 7-8:** Refine DOM actions and history
6. **Phase 9-10:** Polish errors and run acceptance tests
7. **Final:** Remove old slash-command code, update README

### Rollback plan:
- Keep old `INTENTS` and `deriveIntentPayload()` in a feature flag until Prompt API flow is validated
- If Prompt API unavailable, fall back to old flow with warning banner

---

## Files to Modify

| File | Changes |
|------|---------|
| `service-worker.js` | Replace AI session with Prompt API; build context packer; streaming prompts; unified schema validation |
| `sidepanel.js` | Remove slash commands; add Stop/Reset; render streaming chunks; show badges |
| `sidepanel.html` | Add Stop/Reset buttons |
| `src/tailwind.css` | Style Stop/Reset buttons, badges |
| `content-script.js` | Verify DOM actions return correct payloads; add `resetDom` |
| `manifest.json` | Ensure permissions for `aiLanguageModelOriginTrial` (if needed) |
| `README.md` | Update usage instructions (no slash commands) |

---

## Success Criteria

- ✅ Users can ask natural-language questions without slash commands
- ✅ Model downloads and installs with progress feedback
- ✅ Streaming shows token flow; Stop cancels cleanly
- ✅ All four intents (SUMMARIZE, WRITE, CORRECT, HIGHLIGHT) work via unified schema
- ✅ Context packer respects budget and sets truncated flag
- ✅ DOM actions (highlight, insert, replace) work with fallbacks
- ✅ Conversation history persists; Reset clears session
- ✅ No console errors or message-port warnings
- ✅ Error states show clear user guidance

---

**End of Plan**
