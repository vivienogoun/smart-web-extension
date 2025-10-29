# SmartWeb — Prompt‑Only Conversational Side Panel (Product + Engineering Spec)

**Version:** 1.1
**Target:** Chrome desktop 138+ (Dev/Canary/Stable where available)
**Model runtime:** Chrome’s on‑device Gemini Nano via **Prompt API**
**Scope:** Natural‑language chat with any open tab(s); summarize, write, correct, and highlight using a **single Prompt API session** with **structured JSON output**.

---

## 0) Why Prompt‑Only

* One API surface to maintain: **Prompt API** handles all behaviors.
* Natural language input (no slash commands). The model chooses the action and returns **one JSON object** that your UI can apply deterministically.
* Fully on‑device (private, zero cost once installed), with streaming for responsiveness.

---

## 1) Environment & Preconditions (baked into product)

### Hardware & OS

* Windows 10/11, macOS 13+, Linux, or ChromeOS (Chromebook Plus).
* Storage: **≥ 22 GB free** on the Chrome profile volume (model cached here).
* Either **GPU** with **> 4 GB VRAM** *or* **CPU** with **≥ 16 GB RAM** and **≥ 4 cores**.

### Availability & first‑run download

* `LanguageModel.availability()` returns one of: `"available" | "downloadable" | "downloading" | "unavailable"`.
* First use requires a **user gesture** (click/Enter) before download may start.
* To initiate the download and monitor progress, create a session with a `monitor`:

```js
const availability = await LanguageModel.availability();
if (availability === 'downloadable' || availability === 'downloading') {
  const session = await LanguageModel.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        // e.progress in [0,1]; show as percentage to the user
        panel.updateProgress(Math.round((e.progress || 0) * 100));
      });
    },
  });
  session.destroy(); // free resources; the model stays installed
}
```

**Panel status machine:** `checking → downloading (with %) → ready → processing → error`.

---

## 2) UX Overview

* **Single input**: Users type natural language (e.g., “summarize this page”, “compare these two tabs”, “based on this selection write a LinkedIn post”).
* **Context chips**: chips for **Selection** and for **@Tabs** the user adds; panel shows what will be used.
* **Response area**: scrollable list of **cards** (one per turn) rendered beneath the input.
* **Card actions**:

  * **Apply highlights** (wrap text nodes with `<mark data-smartweb>`),
  * **Insert draft** (into focused editable; clipboard fallback),
  * **Replace selection** (on the target tab; clipboard fallback).
* **Controls**: **Stop** during generation; **Reset** to clear the conversation/session.

---

## 3) High‑Level Architecture

* **Side Panel (UI)**: input box, status, context chips, history renderer, Stop/Reset, action buttons.
* **Service Worker (SW / Orchestrator)**: availability gating; session lifecycle; **context packer**; Prompt API calls with **responseConstraint** schema; message bridge to content script.
* **Content Script (CS / DOM agent)**: selection capture; visible‑text extraction; highlight/insert/replace handlers; undo/reset.

**Messaging contract** (panel ⇄ SW ⇄ CS):

* `checkAIModelStatus` → SW emits `ai-status-update` events.
* `processAsk` (panel → SW): `{ prompt, contexts }`.
* `process-result` (SW → panel): `{ intent, data, meta }` for rendering.
* `highlightText` / `insertDraft` / `replaceSelection` (SW → CS) with required payloads; CS must **sendResponse({ ok: true })**.

---

## 4) Context Packer (deterministic, bounded)

**Goal:** Build one coherent model input from the current **Selection** and any **@Tab** contexts.

1. **Selection (if present)**: take verbatim, trim to cap (e.g., 2–3k chars), keep sentence boundaries.
2. **Per‑tab snippet**: extract visible body text (skip `script/style/hidden`), normalize whitespace, cap (e.g., 3–5k chars per tab).
3. **Metadata**: include each tab’s `title` and `url`.
4. **Total budget**: keep aggregate under your session input quota (target ≤ 10–12k chars by default). When over, drop lowest‑priority sections and set `meta.truncated=true`.

**Packed layout passed to the model:**

```
SYSTEM RULES…

CONTEXT
=======
[SELECTION]
«selected text…»

[TAB 1]  Title: …  URL: …
«snippet…»

[TAB 2]  Title: …  URL: …
«snippet…»

USER ASK
========
«raw user prompt…»
```

---

## 5) Prompt‑Only Conversation Model

### 5.1 Session creation & reuse

Create **one** Prompt API session after the first user gesture; reuse it for the whole chat; offer **Reset** to destroy and recreate.

```js
// Optional: read default temperature/topK to keep consistent behavior
const { defaultTemperature, defaultTopK } = await LanguageModel.params();

const controller = new AbortController(); // for Stop button
const session = await LanguageModel.create({
  temperature: defaultTemperature,
  topK: defaultTopK,
  signal: controller.signal,
  // Seed instruction & history so the model knows the format
  initialPrompts: [
    { role: 'system', content: [
      'You are the SmartWeb panel assistant. ',
      'Choose ONE intent that best fulfills the user request: ',
      'SUMMARIZE, WRITE, CORRECT, or HIGHLIGHT. ',
      'Always reply with a single JSON object that follows the schema. ',
      'Prefer the SELECTION when present. When multiple tabs are provided, ',
      'extract key differences. For HIGHLIGHT, return short exact phrases ',
      'that appear in the page text. Never include explanations outside JSON.'
    ].join('') },
  ],
});
```

### 5.2 Unified structured output (one schema)

We constrain responses with a **JSON Schema** passed as `responseConstraint`. The model must return a single JSON object. If it’s invalid, we show an error and do nothing to the page.

```js
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent'],
  properties: {
    intent: { enum: ['SUMMARIZE', 'WRITE', 'CORRECT', 'HIGHLIGHT', 'NONE'] },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['tldr', 'bullets'],
      properties: {
        tldr: { type: 'string', minLength: 1 },
        bullets: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
    draft: { type: 'string' },
    correction: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    explain: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    targets: {
      type: 'object',
      additionalProperties: false,
      properties: { tabId: { type: 'string' } },
    },
  },
  // Cross‑field rules enforced in app logic after parse:
  // SUMMARIZE → summary present; WRITE → draft; CORRECT → correction; HIGHLIGHT → highlights.length>=1
};
```

### 5.3 Natural language only (no slash commands)

We let the **model decide** the `intent` based on the **USER ASK** and **CONTEXT**. The panel simply sends the packed prompt; no regex routing in UI.

### 5.4 Prompting with streaming

Use `promptStreaming()` to provide partial feedback and a Stop button; enable card actions only after final validation.

```js
const stream = session.promptStreaming(
  PACKED_CONTEXT_TEXT, // see Section 4
  { responseConstraint: RESPONSE_SCHEMA }
);
let finalText = '';
for await (const chunk of stream) {
  panel.renderPartial(chunk); // show token flow
  finalText += chunk;
}
const parsed = JSON.parse(finalText);
validateOrThrow(parsed, RESPONSE_SCHEMA);
panel.renderFinal(parsed);
```

### 5.5 Abort (Stop button)

Expose an AbortController per **prompt** (and optionally per **session**):

```js
const promptController = new AbortController();
const stream = session.promptStreaming(PACKED_CONTEXT_TEXT, {
  responseConstraint: RESPONSE_SCHEMA,
  signal: promptController.signal,
});
// panel Stop → promptController.abort();
```

---

## 6) Rendering & Actions (panel + CS)

### 6.1 Card rendering rules

* **SUMMARIZE** → Card with `TL;DR` and bullets, optional **Apply highlights** if `highlights` present.
* **WRITE** → Card with `draft`, actions: **Insert draft**, **Copy**.
* **CORRECT** → Card with `correction`, actions: **Replace selection**, **Copy**.
* **HIGHLIGHT** → Card listing phrases; action: **Apply highlights**.
* Show a small `explain` string under the title (rationale), if present.
* Show badges: `Truncated context` (if `meta.truncated`) and list of tabs used.

### 6.2 DOM actions — content script responsibilities

* **highlightText(payload)**: for each phrase, find case‑insensitive matches in visible text nodes; wrap with `<mark data-smartweb="1">…</mark>`; avoid double wrapping; store original ranges for undo; **sendResponse({ ok: true, count })**.
* **insertDraft(payload)**: if a focused editable exists (`contenteditable`, `textarea`, `input[type=text|search]`), insert at cursor; else copy to clipboard and show a toast in the panel; **sendResponse({ ok: true, method: 'editable'|'clipboard' })**.
* **replaceSelection(payload)**: replace current selection if it exists; else copy to clipboard; **sendResponse({ ok: true, method })**.
* **resetDom()**: remove all `<mark data-smartweb>` and restore any hidden elements.

**Performance note:** highlight must batch DOM mutations (e.g., with a tree walker + range wrapping) to avoid layout thrash on long pages.

---

## 7) Status & Errors (user‑visible behavior defined here)

**Status labels in panel:**

* `Checking AI model…` (initial availability call)
* `Installing on‑device model… (37%)` (from monitor events)
* `AI model is ready.`
* `Processing…` (when a prompt is in flight)
* Error banners (non‑blocking):

  * `Unsupported build` (Prompt API missing): show Chrome update steps.
  * `Model unavailable` (availability === 'unavailable'): disable Send; show setup steps.
  * `Invalid model output` (schema failed): ask user to retry or narrow scope.
  * `Context too large` (packer exceeded budget): recommend selecting a smaller region or fewer tabs.
  * `No highlight matches` (HIGHLIGHT but 0 matches): show tip to adjust phrases.

**Message‑port hygiene:** every `chrome.runtime.sendMessage` that supplies a callback **must** receive a `sendResponse` (and the receiver must `return true` if asynchronous). Otherwise Chrome logs: *“The message port closed before a response was received.”*

---

## 8) Conversation Lifecycle & Storage

* **Single session** reused across turns until **Reset**.
* **History entries** (persisted locally): `{ ts, prompt, intent, tabsUsed, selectionLen, inputLen, truncated }`.
* **Never store raw page text**.
* **Reset** destroys session, clears history, removes highlights.

---

## 9) Acceptance Tests (black‑box)

1. **Ready flow**: open panel on a supported machine → see `Checking → Installing (if first run) → Ready`; Send button enabled.
2. **Free‑form summary**: “please summarize this page” → card with TL;DR + 4–6 bullets; **Apply highlights** marks phrases; **Reset** restores page.
3. **Selection‑based writing**: select a paragraph → “based on this selection, write a ~120‑word LinkedIn post” → **WRITE** card; **Insert draft** populates composer or copies to clipboard with toast.
4. **Correction**: select messy text → “fix grammar and improve clarity” → **CORRECT** card; **Replace selection** updates page.
5. **Multi‑tab compare**: add two @tabs → “compare these tabs and give key differences” → **SUMMARIZE** with per‑tab bullets + deltas.
6. **Streaming**: long request shows token flow; **Stop** cancels quickly; no stuck spinners.
7. **Error handling**: over‑long page sets `truncated` badge; invalid JSON shows banner and no DOM changes.

---

## 10) Developer Checklists

### A) Wiring

* [ ] Panel sends `processAsk` with `{ prompt, contexts }`.
* [ ] SW replies to **every** message with a callback (avoid port‑closed warning).
* [ ] SW emits `ai-status-update` with states: `checking | downloading | ready | processing | error`.
* [ ] Panel maps `downloadable/downloading` → “Installing…” and polls `availability()` until `available`.

### B) Prompt‑Only session

* [ ] Create session on first user gesture; reuse; expose Reset.
* [ ] Seed `initialPrompts` with system rules (Section 5.1).
* [ ] All turns use `promptStreaming()` and show Stop.

### C) Context packer

* [ ] Include selection (bounded) and per‑tab snippets (bounded), with title+URL.
* [ ] Maintain total budget; mark `truncated` when applicable.

### D) Structured output & routing

* [ ] Attach `responseConstraint: RESPONSE_SCHEMA` to every prompt call.
* [ ] Parse + validate final JSON; route by `intent` to card types.
* [ ] Gate Apply/Insert/Replace until validation passes.

### E) DOM actions (CS)

* [ ] `highlightText` wraps exact phrases and returns `{ ok, count }`.
* [ ] `insertDraft` uses focused editable or clipboard with toast; returns method.
* [ ] `replaceSelection` replaces or clipboard with toast; returns method.
* [ ] `resetDom` removes all markers.

### F) Resilience

* [ ] AbortController for per‑prompt cancel.
* [ ] Paragraph‑aware truncation; no mid‑token or mid‑markup splits.
* [ ] SPA route changes: a **Reapply highlights** button if needed.

---

## 11) Example End‑to‑End (what dev should reproduce)

**User** selects a section and types: *“Based on this selection, write a ~120‑word LinkedIn post with a confident tone.”*

**Panel → SW**: `processAsk({ prompt, contexts:[{type:'selection', text:…}, {type:'tab', id:…}] })`

**SW** packs context (Section 4) and calls:

```js
const text = buildPackedContext(selection, tabs, userAsk);
const stream = session.promptStreaming(text, { responseConstraint: RESPONSE_SCHEMA });
for await (const chunk of stream) panel.partial(chunk);
const json = JSON.parse(collected);
validateOrThrow(json, RESPONSE_SCHEMA);
```

**Model output** (example):

```json
{
  "intent": "WRITE",
  "draft": "Here’s the refined 120‑word LinkedIn post…",
  "explain": "Used selection as the main source; adapted tone to confident.",
  "confidence": 0.82
}
```

**Panel** renders a **WRITE** card with **Insert draft** and **Copy**.
**CS** inserts text into the active composer, returns `{ ok:true, method:'editable' }`.
**Panel** shows toast: *“Draft inserted in active editor.”*

---

## 12) Out‑of‑scope (for later)

* Provider abstraction for non‑Chrome browsers (e.g., remote Grok/OpenAI) using the same schema.
* Multimodal inputs (audio/image) — currently gated and not required for MVP.

---

**End of Spec**
