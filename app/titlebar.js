// Title bar page script (a file, not inline: the page's CSP allows no inline script).
// main.js calls setTitle with the text for the centre of the bar and setUpdateReady when a
// downloaded update is waiting; the pill asks the shell (bar-preload.js) to restart into it.
const titleEl = document.getElementById("title");
const updateEl = document.getElementById("update");
// macOS: room for the traffic lights on the left (titlebar.css `.mac`); main.js calls
// setFullScreen when macOS hides them in fullscreen.
const isMac = !!(window.bar24f && window.bar24f.platform === "mac");
document.body.classList.toggle("mac", isMac);
window.setFullScreen = (full) => document.body.classList.toggle("fullscreen", !!full);
// A changed title fades out, swaps, and fades back in; the same title (sent again on every
// navigation and focus) leaves the bar alone. Reduced motion swaps at once.
const FADE_MS = 160;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
let shown = titleEl.textContent, pending = null, swapTimer = 0;
window.setTitle = (text) => {
  const next = String(text || "Kexlo").slice(0, 120);
  if (next === (pending ?? shown)) return;
  pending = next;
  if (calm.matches) { titleEl.textContent = shown = next; pending = null; return; }
  clearTimeout(swapTimer);
  titleEl.classList.add("fading");
  swapTimer = setTimeout(() => {
    titleEl.textContent = shown = pending ?? next;
    pending = null;
    titleEl.classList.remove("fading");
  }, FADE_MS);
};
// `manual` (macOS): the app cannot replace itself, so the pill offers the download instead of a
// restart: "Update available - Download" opens the new version in the browser.
let manualUpdate = false, reopenTimer = 0;
const PILL = { restart: "Update ready · Restart", download: "Update available · Download" };
window.setUpdateReady = (version, manual) => {
  const ready = !!version;
  manualUpdate = !!manual;
  updateEl.hidden = !ready;
  document.body.classList.toggle("has-update", ready);
  if (!ready) return;
  const v = String(version).slice(0, 20);
  if (manualUpdate) {
    clearTimeout(reopenTimer);
    updateEl.disabled = false;
    updateEl.textContent = PILL.download;
    updateEl.title = "Download the new version of Kexlo. Open it and drag the app into Applications to replace this one.";
    updateEl.setAttribute("aria-label", `Version ${v} is available. Download it.`);
  } else {
    updateEl.setAttribute("aria-label", `Version ${v} is ready. Restart Kexlo to update.`);
  }
};
updateEl.addEventListener("click", () => {
  updateEl.disabled = true;
  if (manualUpdate) {
    // The browser takes over; the pill stays, ready to be used again.
    updateEl.textContent = "Opening…";
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => { updateEl.disabled = false; updateEl.textContent = PILL.download; }, 2500);
  } else {
    updateEl.textContent = "Restarting…";
  }
  if (window.bar24f) window.bar24f.installUpdate();
});
// Tabs: main.js calls setTabs with { left: { label, active }, right: { label, active } }, or null
// for none (then the bar is exactly the plain title bar). A click shows that tab (marked at once, so
// the bar answers instantly); a right-click on the right tab opens its menu.
const tabEls = { left: document.getElementById("tab-left"), right: document.getElementById("tab-right") };
const KEY_HINT = isMac ? "⌘" : "Ctrl+";
const markTab = (side) => { for (const s of ["left", "right"]) tabEls[s].setAttribute("aria-pressed", s === side ? "true" : "false"); };
window.setTabs = (state) => {
  for (const side of ["left", "right"]) {
    const el = tabEls[side], tab = state && state[side];
    el.hidden = !tab;
    if (!tab) continue;
    const text = String(tab.label || "").slice(0, 60);
    if (el.textContent !== text) el.textContent = text;
    el.title = side === "left" ? `${text} (${KEY_HINT}1)` : `${text} (${KEY_HINT}2). Right-click to choose another.`;
    el.setAttribute("aria-pressed", tab.active ? "true" : "false");
  }
};
for (const side of ["left", "right"]) {
  tabEls[side].addEventListener("click", () => {
    markTab(side);
    if (window.bar24f) window.bar24f.showTab(side);
  });
}
tabEls.right.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (window.bar24f) window.bar24f.tabMenu("right");
});
