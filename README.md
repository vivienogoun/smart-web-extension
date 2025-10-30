# SmartWeb

**SmartWeb** is a Chrome Extension that brings built-in AI capabilities directly into any browsing experience. It allows users to *chat with their tabs*, summarize content, write or rewrite text, and take contextual actions using Chrome’s on-device Gemini Nano model  all privately, locally, and in real time.

---

##  Overview

###  Purpose

Most AI browsers like Arc, Atlas, and Perplexity Comet are powerful but limited  available only for macOS or specific ecosystems. SmartWeb solves this by making AI assistance universal and browser-agnostic.

**SmartWeb turns any browser into an intelligent workspace**. It empowers users to:

* Summarize or explain what’s on a page.
* Write, proofread, or rephrase text in context.
* Extract, analyze, or highlight data automatically.
* Chat naturally with web pages  all processed locally using **Chrome’s built-in AI APIs**.

This project was built for the **Chrome Built-in AI Hackathon 2025**.

---

##  Features

*  **Chat With Tabs** – Use natural language to ask questions or make requests about the current page.
* ⚡ **On-Device AI (Gemini Nano)** – Runs fully on Chrome’s local built-in model for private, offline-capable processing.
*  **Chrome Side Panel Integration** – Seamlessly accessible on any tab, without cluttering your browsing experience.
*  **Automatic Context Awareness** – The extension understands which page you’re on and keeps a per-tab conversation memory.
*  **Smart Writing Tools** – Generate drafts, comments, summaries, or rephrasings instantly.
*  **Highlight and Extract** – Find key data such as dates, names, and keywords through AI queries.

---

##  APIs Used

SmartWeb integrates directly with **Chrome’s built-in AI APIs**, specifically:

*  **Prompt API** – To interact with the Gemini Nano model for generating and understanding text.
*  **Writer API** – For writing and rewriting text intelligently.
*  **Summarizer API** – To summarize web content directly from the page.

These APIs allow all interactions to happen **on-device**, ensuring low latency and privacy by design.

---

##  Built With

* **Languages:** JavaScript (ES6+), HTML5, CSS3
* **Framework:** None (vanilla implementation for transparency and performance)
* **Platform:** Chrome Extension (Manifest V3)
* **APIs:** Prompt API, Writer API, Summarizer API (built-in Gemini Nano)
* **Styling:** Tailwind CSS (custom build)

---

##  Project Structure

```
smart-web-extension/
├── manifest.json           # Extension configuration
├── content-script.js       # Injected into web pages
├── service-worker.js       # Background worker managing AI sessions
├── sidepanel.html          # UI for the AI assistant
├── sidepanel.js            # Logic for handling AI and UI interactions
├── icons/                  # App and toolbar icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md               # This documentation
```

---

##  Installation & Testing Instructions

### **1. Clone or Download the Project**

```bash
git clone https://github.com/vivienogoun/smart-web-extension.git
```

### **2. Load the Extension in Chrome**

1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** and select the `smart-web-extension` folder
4. The SmartWeb icon (🧩) should appear in your toolbar

### **3. Activate Built-in AI Features**

1. In Chrome Canary or Dev version 128+
2. Visit: `chrome://flags/#optimization-guide-on-device-model`
3. Enable it and restart Chrome
4. Go to `chrome://components` → Update **Optimization Guide On Device Model**

### **4. Test the Extension**

* Open any article, email, or text-rich page
* Click the SmartWeb icon to open the side panel
* Ask: “Summarize this article” or “Write a response for this email”

---

##  Example Use Cases

* **Summarize:** “Summarize this article in 5 key points.”
* **Write:** “Write a LinkedIn comment agreeing with this post.”
* **Explain:** “Explain this paragraph in simple terms.”
* **Highlight:** “Highlight all company names on this page.”

---

##  Development & Debugging

* **Service Worker Logs:** `chrome://extensions` → Inspect service worker
* **Side Panel Logs:** Right-click panel → Inspect
* **Content Script:** Use browser DevTools → Console

### Live Reload

Each time you make changes:

1. Save files
2. Go to `chrome://extensions`
3. Click the **Reload (🔄)** button next to SmartWeb

---

##  Permissions

* `activeTab` – Access and analyze current page content
* `scripting` – Inject content scripts dynamically
* `sidePanel` – Display SmartWeb’s UI
* `storage` – Save settings and session memory

---

##  Technical Architecture

**Flow:**

1. User inputs a natural language request in the side panel.
2. The extension sends it to Chrome’s on-device **Prompt API** (Gemini Nano).
3. The AI response is rendered in the panel and can modify or insert content in-page.
4. Per-tab conversation context is preserved until tab closure.

All computation runs locally  no external servers or data transfers.

---

## 💡 Challenges & Learnings

* **Handling the OLD Prompt API:** We adapted a custom text-based protocol for reliability under truncation and missing schema support.
* **UI/UX:** Designed a clean, light-themed conversational interface that shows AI “thinking” and separates user prompts from responses.
* **Performance:** Achieved instant responses with chunk-based streaming for smoother updates.
* **Privacy:** Everything runs on-device, no API keys or data sharing required.

---

## 🏆 Hackathon Eligibility

SmartWeb meets all hackathon requirements:

| Requirement                   | Compliance                            |
| ----------------------------- | ------------------------------------- |
| Uses Chrome built-in AI APIs  | ✅ Prompt, Writer, Summarizer APIs     |
| Built during hackathon period | ✅ Developed and tested for submission |
| Runs on Chrome platform       | ✅ Chrome Extension (Manifest V3)      |
| Supports English              | ✅ Fully in English                    |
| Free for testing              | ✅ Public GitHub and demo available    |

---

## 🔗 Links

* **GitHub Repository:** [https://github.com/vivienogoun/smart-web-extension](https://github.com/vivienogoun/smart-web-extension)


---

## 🧾 License

MIT License – free to use and extend.

---

## 🙌 Contributors

* **Fred Agbona** – Software Engineer, AI UX & Chrome Extension Development
* **Vivien Ogoun** – Technical Designer / Frontend Engineer

---

**SmartWeb – Chat with Your Tabs.**
Built for the Chrome Built-in AI Hackathon 2025.
