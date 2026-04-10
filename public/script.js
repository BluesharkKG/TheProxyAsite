const PROXY_BASE = "https://easy-learn-io.onrender.com";
const MAX_HISTORY_ITEMS = 100;
const LOAD_TIMEOUT_MS = 25000;

const state = {
  stack: [],
  index: -1,
  isLoading: false,
  loadTimer: null,
  progressTimer: null,
  currentTarget: "",
  historyOpen: true
};

const el = {
  frame: document.getElementById("proxyFrame"),
  home: document.getElementById("homeView"),
  error: document.getElementById("errorView"),
  errorMessage: document.getElementById("errorMessage"),
  urlInput: document.getElementById("urlInput"),
  urlForm: document.getElementById("urlForm"),
  backBtn: document.getElementById("backBtn"),
  forwardBtn: document.getElementById("forwardBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  progressBar: document.getElementById("progressBar"),
  statusText: document.getElementById("statusText"),
  historyBtn: document.getElementById("historyBtn"),
  historyDrawer: document.getElementById("historyDrawer"),
  historyList: document.getElementById("historyList"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  retryBtn: document.getElementById("retryBtn")
};

function proxiedUrl(targetUrl) {
  return `${PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function normalizeInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function setStatus(msg) {
  el.statusText.textContent = msg;
}

function showHome() {
  el.home.classList.remove("hidden");
  el.frame.classList.add("hidden");
  el.error.classList.add("hidden");
  setStatus("Ready");
}

function showError(message) {
  el.errorMessage.textContent = message || "Proxy request failed";
  el.error.classList.remove("hidden");
  el.home.classList.add("hidden");
  el.frame.classList.add("hidden");
}

function showFrame() {
  el.error.classList.add("hidden");
  el.home.classList.add("hidden");
  el.frame.classList.remove("hidden");
}

function startProgress() {
  clearInterval(state.progressTimer);
  let value = 8;
  el.progressBar.style.width = `${value}%`;
  state.progressTimer = setInterval(() => {
    if (!state.isLoading) return;
    value += Math.random() * 11;
    if (value > 92) value = 92;
    el.progressBar.style.width = `${value}%`;
  }, 180);
}

function stopProgress() {
  clearInterval(state.progressTimer);
  el.progressBar.style.width = "100%";
  setTimeout(() => {
    if (!state.isLoading) el.progressBar.style.width = "0%";
  }, 150);
}

function renderHistory() {
  const entries = [...state.stack].reverse();
  el.historyList.innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-item";
    item.dataset.url = entry.url;

    const u = document.createElement("span");
    u.className = "history-url";
    u.textContent = entry.url;

    const t = document.createElement("span");
    t.className = "history-time";
    t.textContent = new Date(entry.at).toLocaleString();

    item.append(u, t);
    item.addEventListener("click", () => {
      navigateTo(entry.url, true);
    });
    el.historyList.appendChild(item);
  }
}

function updateButtons() {
  el.backBtn.disabled = state.index <= 0;
  el.forwardBtn.disabled = state.index >= state.stack.length - 1;
}

function pushHistory(url) {
  if (state.index < state.stack.length - 1) {
    state.stack = state.stack.slice(0, state.index + 1);
  }

  state.stack.push({ url, at: Date.now() });
  if (state.stack.length > MAX_HISTORY_ITEMS) {
    state.stack.shift();
  }
  state.index = state.stack.length - 1;

  renderHistory();
  updateButtons();
}

function finishLoad() {
  state.isLoading = false;
  clearTimeout(state.loadTimer);
  stopProgress();
  setStatus("Loaded");

  try {
    const frameLocation = el.frame.contentWindow?.location?.href;
    if (frameLocation) {
      const parsed = new URL(frameLocation);
      if (parsed.pathname === "/proxy" && parsed.searchParams.get("url")) {
        el.urlInput.value = parsed.searchParams.get("url");
      }
    }
  } catch {
    // Cross-origin access can fail depending on page restrictions.
  }
}

function cancelLoad() {
  if (!state.isLoading) return;
  clearTimeout(state.loadTimer);
  state.isLoading = false;
  el.frame.src = "about:blank";
  stopProgress();
  setStatus("Load canceled");
}

function navigateTo(rawInput, fromHistory = false) {
  const targetUrl = normalizeInput(rawInput);
  if (!targetUrl) return;

  state.currentTarget = targetUrl;
  showFrame();
  state.isLoading = true;

  setStatus(`Loading ${targetUrl}`);
  startProgress();

  clearTimeout(state.loadTimer);
  state.loadTimer = setTimeout(() => {
    state.isLoading = false;
    showError("Timed out after 25 seconds. The target might be blocking framing or proxying.");
    stopProgress();
    setStatus("Timed out");
  }, LOAD_TIMEOUT_MS);

  const frameUrl = proxiedUrl(targetUrl);
  el.frame.src = frameUrl;
  el.urlInput.value = targetUrl;

  if (!fromHistory) {
    pushHistory(targetUrl);
  }
}

function goBack() {
  if (state.index <= 0) return;
  state.index -= 1;
  const entry = state.stack[state.index];
  updateButtons();
  navigateTo(entry.url, true);
}

function goForward() {
  if (state.index >= state.stack.length - 1) return;
  state.index += 1;
  const entry = state.stack[state.index];
  updateButtons();
  navigateTo(entry.url, true);
}

function reload() {
  if (!state.currentTarget) return;
  if (state.isLoading) {
    cancelLoad();
    return;
  }
  navigateTo(state.currentTarget, true);
}

el.urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  navigateTo(el.urlInput.value);
});

el.backBtn.addEventListener("click", goBack);
el.forwardBtn.addEventListener("click", goForward);
el.reloadBtn.addEventListener("click", reload);

el.frame.addEventListener("load", () => {
  if (!state.isLoading) return;

  try {
    const doc = el.frame.contentDocument;
    const bodyText = doc?.body?.innerText || "";
    const maybeError = bodyText.toLowerCase().includes("proxy error") || bodyText.toLowerCase().includes("failed to fetch");
    if (maybeError) {
      throw new Error("Proxy error response returned");
    }
  } catch {
    // Ignore inspection failures; complete as loaded.
  }

  finishLoad();
});

el.retryBtn.addEventListener("click", () => {
  if (!state.currentTarget) return;
  navigateTo(state.currentTarget, true);
});

document.querySelectorAll(".quick-link").forEach((button) => {
  button.addEventListener("click", () => navigateTo(button.dataset.url));
});

el.historyBtn.addEventListener("click", () => {
  state.historyOpen = !state.historyOpen;
  el.historyDrawer.classList.toggle("closed", !state.historyOpen);
});

el.clearHistoryBtn.addEventListener("click", () => {
  state.stack = [];
  state.index = -1;
  renderHistory();
  updateButtons();
  state.currentTarget = "";
  el.urlInput.value = "";
  el.frame.src = "about:blank";
  showHome();
});

document.addEventListener("keydown", (event) => {
  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    goBack();
  }

  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    goForward();
  }

  if (event.key === "F5") {
    event.preventDefault();
    reload();
  }

  if (event.ctrlKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    el.urlInput.focus();
    el.urlInput.select();
  }
});

renderHistory();
updateButtons();
showHome();
