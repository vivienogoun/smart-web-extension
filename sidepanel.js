
const promptInput = document.getElementById("prompt-input");
const processButton = document.getElementById("process-button");
const statusDiv = document.getElementById("status");
const contextChips = document.getElementById('context-chips');
const tabsDropdown = document.getElementById('tabs-dropdown');
const pendingDiv = null; // pending-selection UI removed; keep for legacy but null
const clearBtn = document.getElementById('clear-contexts');
const modal = null; const modalText = null; const modalTitle = null; const modalCancel = null; const modalSave = null;

let selectedTabContexts = []; // { tabId, title, url }
let selectedTextContexts = []; // { tabId, text }
let pendingSelection = null; // kept for modal editing but not used for auto-add
let autoAddSelection = true; // always true by design

// 1. Check AI Model status when the side panel is opened.
document.addEventListener("DOMContentLoaded", () => {
  statusDiv.textContent = "Checking AI model status...";
  chrome.runtime.sendMessage({ action: "checkAIModelStatus" });
  // Ensure content scripts are injected into tabs so selection listeners are active
  chrome.runtime.sendMessage({ action: 'injectContentScripts' }, (res) => { /* noop */ });

  // Auto-select the active tab as context by default
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    if (t) {
      selectedTabContexts.push({ tabId: t.id, title: t.title, url: t.url });
      const marker = `[PAGE: ${t.title || t.url}] `;
      promptInput.value = (promptInput.value ? promptInput.value + ' ' : '') + marker;
      renderContextChips();
    }
  });

  // Listen for external selection updates (auto-add selections)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'selectionUpdate' && msg.text && msg.text.trim()) {
      // always auto-add selection and insert into prompt
      selectedTextContexts.unshift({ tabId: msg.tabId, text: msg.text });
      renderContextChips();
      insertIntoPrompt(msg.text);
      // show a small toast
      try { showToast('Selection added to context'); } catch (e) { /* noop */ }
    } else if (msg?.action === "ai-status-update") {
      updateStatus(msg.status, msg.error);
    }
  });

  // wire up simple controls
  clearBtn.addEventListener('click', () => { selectedTabContexts = []; selectedTextContexts = []; pendingSelection = null; renderContextChips(); renderPendingSelection(); });
  // toast element for user feedback
  const toast = document.getElementById('toast');
  function showToast(text, ms = 1800) {
    if (!toast) return;
    toast.textContent = text; toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.classList.remove('visible'); }, ms);
  }
});

// Click listener for processing
processButton.addEventListener("click", () => {
  const userPrompt = promptInput.value;
  if (!userPrompt) { statusDiv.textContent = "Please enter a command."; return; }
  processButton.disabled = true; processButton.textContent = "Processing..."; statusDiv.textContent = "Sending content to AI model...";
  gatherContexts().then((contexts) => {
    chrome.runtime.sendMessage({ action: 'processPage', prompt: userPrompt, contexts });
    try { showToast('Sent to AI'); } catch (e) {}
  });
});

// Enter to send (Enter = send, Shift+Enter = newline)
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    processButton.click();
  }
});

// Update status UI
function updateStatus(status, error = "") {
  switch (status) {
    case "ready": statusDiv.textContent = "AI Model is ready."; processButton.disabled = false; processButton.textContent = "Process Page"; break;
    case "downloading": statusDiv.textContent = "AI model is downloading. This may take a moment..."; processButton.disabled = true; processButton.textContent = "Model Downloading..."; break;
    case "unavailable": statusDiv.textContent = `Error: AI is unavailable. ${error || "Check console for details."}`; processButton.disabled = true; processButton.textContent = "AI Unavailable"; break;
    case "processing": statusDiv.textContent = "AI is processing your request..."; processButton.disabled = true; processButton.textContent = "Processing..."; break;
    default: statusDiv.textContent = "Status unknown."; processButton.disabled = true;
  }
}

// ---- Context / @ mention UI ----
async function listTabs() {
  return new Promise((resolve) => { chrome.runtime.sendMessage({ action: 'listTabs' }, (res) => { resolve(res?.tabs || []); }); });
}

function renderTabsDropdown(tabs) {
  tabsDropdown.innerHTML = '';
  // search row
  const searchRow = document.createElement('div'); searchRow.className = 'search';
  const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.placeholder = 'Find tab...';
  searchRow.appendChild(searchInput);
  tabsDropdown.appendChild(searchRow);

  const list = document.createElement('div'); list.className = 'list';
  function renderList(filtered) {
    list.innerHTML = '';
    filtered.forEach(t => {
      const item = document.createElement('div'); item.className = 'item'; item.textContent = t.title || t.url;
      item.onclick = () => {
        selectedTabContexts.push({ tabId: t.id, title: t.title, url: t.url });
        renderContextChips();
        const marker = `[PAGE: ${t.title || t.url}] `;
        promptInput.value = (promptInput.value ? promptInput.value + ' ' : '') + marker;
        hideTabsDropdown();
      };
      list.appendChild(item);
    });
  }

  renderList(tabs);
  searchInput.addEventListener('input', (e) => {
    const q = (e.target.value || '').toLowerCase();
    const filtered = tabs.filter(t => ((t.title||'') + ' ' + (t.url||'')).toLowerCase().includes(q));
    renderList(filtered);
  });

  tabsDropdown.appendChild(list);
  if (tabs.length) { tabsDropdown.style.display = 'block'; } else { hideTabsDropdown(); }
}
function hideTabsDropdown() { tabsDropdown.style.display = 'none'; }

function renderContextChips() {
  contextChips.innerHTML = '';
  // tabs
  selectedTabContexts.forEach((c, i) => {
    const chip = document.createElement('span'); chip.className = 'chip';
    const label = document.createElement('span'); label.textContent = c.title || c.url || `Tab ${c.tabId}`;
    const btn = document.createElement('button'); btn.textContent = '×'; btn.onclick = () => { selectedTabContexts.splice(i,1); renderContextChips(); };
    chip.appendChild(label); chip.appendChild(btn); contextChips.appendChild(chip);
  });
  // selections
  selectedTextContexts.forEach((s, i) => {
    const chip = document.createElement('span'); chip.className = 'chip';
    const label = document.createElement('span'); const textPreview = s.text.length > 80 ? s.text.slice(0,77)+'...' : s.text; label.textContent = textPreview;
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.onclick = () => openModal('Edit selection', s.text, (newText)=>{ s.text = newText; });
    const btn = document.createElement('button'); btn.textContent = '×'; btn.onclick = () => { selectedTextContexts.splice(i,1); renderContextChips(); };
    chip.appendChild(label); chip.appendChild(edit); chip.appendChild(btn); contextChips.appendChild(chip);
  });
}

function renderPendingSelection() {
  if (!pendingSelection) { pendingDiv.style.display = 'none'; pendingDiv.innerHTML = ''; return; }
  pendingDiv.style.display = 'block'; pendingDiv.innerHTML = '';
  const preview = document.createElement('div'); preview.className = 'preview'; preview.textContent = pendingSelection.text.length > 200 ? pendingSelection.text.slice(0,200)+'...' : pendingSelection.text;
  const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='6px';
  const addBtn = document.createElement('button'); addBtn.className='primary-btn'; addBtn.textContent='Add as context'; addBtn.onclick = () => { selectedTextContexts.unshift(pendingSelection); insertIntoPrompt(pendingSelection.text); pendingSelection = null; renderContextChips(); renderPendingSelection(); };
  const editBtn = document.createElement('button'); editBtn.className='muted-btn'; editBtn.textContent='Edit'; editBtn.onclick = () => { openModal('Edit selection', pendingSelection.text, (newText)=>{ pendingSelection.text = newText; renderPendingSelection(); }); };
  const dismiss = document.createElement('button'); dismiss.className='muted-btn'; dismiss.textContent='Dismiss'; dismiss.onclick = () => { pendingSelection = null; renderPendingSelection(); };
  actions.appendChild(addBtn); actions.appendChild(editBtn); actions.appendChild(dismiss);
  pendingDiv.appendChild(preview); pendingDiv.appendChild(actions);
}

function openModal(title, text, onSave) {
  modalTitle.textContent = title; modalText.value = text || '';
  modal.style.display = 'flex';
  modal._onSave = onSave;
  // add insert button if not present
  if (!modal._insertBtn) {
    const insertBtn = document.createElement('button'); insertBtn.className='muted-btn'; insertBtn.textContent='Insert into prompt';
    insertBtn.style.marginRight = '8px';
    insertBtn.onclick = () => { promptInput.value = (promptInput.value ? promptInput.value + '\n' : '') + modalText.value; modal.style.display='none'; };
    modal.querySelector('.actions').insertBefore(insertBtn, modalSave);
    modal._insertBtn = insertBtn;
  }
}

// Detect @ key in the prompt input to show tab list
promptInput.addEventListener('keyup', async (e) => {
  const val = promptInput.value; const pos = promptInput.selectionStart; const charBefore = val[pos-1];
  if (charBefore === '@') { const tabs = await listTabs(); renderTabsDropdown(tabs); }
});

// Click outside to hide dropdown
document.addEventListener('click', (e) => { if (!tabsDropdown.contains(e.target) && e.target !== promptInput) hideTabsDropdown(); });

// Gather contexts: tabs first, then selected texts
async function gatherContexts() {
  const contexts = [];
  for (const t of selectedTabContexts) { contexts.push({ type: 'tab', tabId: t.tabId, title: t.title, url: t.url }); }
  for (const s of selectedTextContexts) { contexts.push({ type: 'selection', tabId: s.tabId, text: s.text }); }
  return contexts;
}

// Expose a small helper to add a selection programmatically (used by tests or future UI)
function addSelectionContext(tabId, text) { selectedTextContexts.unshift({ tabId, text }); renderContextChips(); }

function insertIntoPrompt(text) { promptInput.value = (promptInput.value ? promptInput.value + '\n' : '') + text; }

window.addSelectionContext = addSelectionContext;
