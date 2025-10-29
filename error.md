You just hit a classic “model wrapped its JSON in Markdown fences” failure. Here’s what each line means and exactly how to harden your panel so it never crashes on this again.

# What the messages mean

* **“detected OLD Prompt API (LanguageModel) – responseConstraint not supported”**
  Your adapter correctly fell back to the legacy `LanguageModel` surface and disabled `responseConstraint` for streaming. That’s expected on your build. 

* **“No output language was specified … [en, es, ja]”**
  Cosmetic, coming from the early availability check on the old API. Once your session is created you *are* passing an output language; you can ignore this single warning. 

* **“failed to process SyntaxError: Unexpected token '`', "```json { " … is not valid JSON”**  
  The model returned its answer inside a Markdown fenced block (like ```json … ```). Since you’re on the **old** API path (no `responseConstraint`), the model isn’t forced to output raw JSON, and `JSON.parse`explodes. This is happening in your **sidepanel** on the code path that concatenates streamed chunks and then calls`JSON.parse(fullResponse)`. 

Your UI shows the same: *Unexpected token '`' … not valid JSON*.

---

# Fix it in two moves

### 1) Tighten the instruction (prevention)

You already seed a system instruction. Make it unambiguous:

* Keep what you have and **add**:
  *“Return **only** a single JSON object. **Do not** include code fences, markdown, or any text outside the JSON.”*

Add this to the `SYSTEM_INSTRUCTION` constant in `sidepanel.js`. You already have the instruction block near the top of that file; just append the “no code fences / only JSON” line there. 

### 2) Add a tiny sanitizer before `JSON.parse` (cure)

Right now you do:

* collect streamed chunks → `fullResponse`
* `const parsed = JSON.parse(fullResponse);`
  (This is where the exception is thrown.) 

Replace the single direct parse with a **two-step parse**:

1. **Fast path:** try `JSON.parse(fullResponse)`.
2. **If it throws**, run a minimal **sanitizer**:

   * Strip any leading/trailing whitespace.
   * If the text starts with `json or ` — remove the opening and matching closing fence.
   * If there’s still extra text, **extract just the first top-level JSON object**:

     * Find the first “{”,
     * Scan forward counting `{`/`}` to find its matching closing “}”,
     * Slice that substring.
   * Try `JSON.parse` again with this cleaned substring.
3. If it still fails, set `error.message = "Model returned invalid JSON. Please try again."` and push an error card (your code already does this on exceptions). 

You don’t need to change your renderer or validator—only the parse location in **`handleProcessClick()`** where you currently build `fullResponse` and immediately call `JSON.parse`. Keep your existing `validateResponse(parsed)` call exactly as-is after the sanitized parse; it already checks “WRITE requires draft”, etc. 

---

# Why this is enough

* On **new** API builds, your adapter will pass `responseConstraint: RESPONSE_SCHEMA` and the model is far less likely to output markdown.
* On **old** API builds, your **sanitizer** tolerates common wrappers (`json … ` or stray prose), then your **validator** enforces the per-intent fields. 

---

# Sanity checks (do these after the change)

1. Prompt: “write a response for this email …”

   * Expect a **WRITE** card with a `draft`. No JSON parse error; no UnknownError.

2. Prompt: “summarize this article”

   * Still works. Summary card appears; highlights apply on click.

3. Prompt: “highlight 3 main risks”

   * HIGHLIGHT card, and your CS wraps the matches with `<mark data-contextual-agent-highlight>` (content script is already wired for this). 

4. Try a deliberately bad case (e.g., “output YAML”).

   * The sanitizer + validator should raise your user-friendly error card rather than crashing the stream. (Your side panel already pushes an error payload and renders it.) 

---

# Extra polish (optional but nice)

* **History**: you now keep a full transcript (`state.history`) and render every turn, so new prompts won’t wipe previous cards. Good—keep that version of the renderer. 
* **Actions apply to correct tab**: your SW routes `applyHighlights/insertDraft/replaceSelection` to the `targetTabId` and your CS replies with `{ok:true}`. This path doesn’t need changes. 

---

If you want, I can map the exact function where to drop the 10–15 lines of sanitizer logic (right after your streaming loop and before `validateResponse`) so your dev can paste it in a single spot and be done.
