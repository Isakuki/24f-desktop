// Kexlo for Windows and Mac: a native shell around the live workspace site.
// Web changes appear instantly (the app loads the live site); the shell itself updates in the background.
const { app, BrowserWindow, Menu, Notification, WebContentsView, clipboard, ipcMain, nativeTheme, net, powerMonitor, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const tabsCheck = require("./tabs");

const APP_NAME = "Kexlo";
const IS_MAC = process.platform === "darwin", IS_WIN = process.platform === "win32";
const ORIGIN = process.env.F24_ORIGIN || "https://app.kexlo.io";
const HOME = `${ORIGIN}/dashboard`;
const DARK = "#0d0a0c", LIGHT = "#f7f8fb";
// Custom title bar height (the Kexlo mark on a 60% black glass strip; Windows draws the caption
// buttons on its right, macOS the traffic lights on its left).
const BAR_HEIGHT = 32;
// macOS traffic lights (14 x 16 pt buttons): 12 pt in from the left, centred in the 32 pt bar.
const TRAFFIC_LIGHTS = { x: 12, y: (BAR_HEIGHT - 16) / 2 };
// The splash is a light chip that leaves as soon as the workspace has loaded (a short floor so it never just flickers).
const SPLASH_MIN_MS = 450, SPLASH_MAX_MS = 20000;
// Other sites that open inside the app (sign-in and store-connection flows that must finish here so
// the session cookie lands in the app) come from the site for the signed-in account: see
// refreshPolicy below. Until that answers, or when it cannot be read, only the app's own sites open
// inside; everything else opens in the system browser.
// The current sites first, then the previous ones (old links and bookmarks redirect from there).
const BASE_SUFFIXES = ["kexlo.io", "app.kexlo.io", "24f.site", "24fulfillr.com"];
const POLICY_URL = `${ORIGIN}/api/desktop/policy`;
const POLICY_MAX_HOSTS = 64, POLICY_MAX_BYTES = 16 * 1024, POLICY_REFRESH_MS = 10 * 60_000;
// Title-bar tabs (only when the policy answer names them, see tabs.js): each tab is its own page
// view, kept alive, so switching is instant and each stays exactly where it was. Requests from the
// right tab's view to the app's site carry PANE_HEADER, which tells the site which of the account's
// own views that request belongs to; it carries no authority of its own. A page that the policy
// says belongs to the other tab opens in that tab (see tabs.js otherTabFor).
const PANE_HEADER = "X-24F-Pane", PANE_VALUE = "secondary";
const MENU_MAX_BYTES = 64 * 1024, MENU_CACHE_MS = 60_000;

// The data folder (the signed-in session, window state) is named after the product, which has been
// renamed twice (24F up to 1.0.7, 24FulfillR up to 1.1.x, Kexlo since 1.2.0). Moving it would sign
// everyone out, so installed apps keep their first folder. Must run before anything reads userData
// (including the single-instance lock, which is keyed on it).
// Windows: always %APPDATA%\24F (installs update in place).
// macOS: a Mac that ran 1.1.x keeps ~/Library/Application Support/24FulfillR, and the app keeps that
// internal name so the Keychain entry that encrypts its cookies ("<name> Safe Storage") is found
// again. A new Mac install uses the default "Kexlo" folder. Neither name is shown anywhere.
if (IS_WIN) app.setPath("userData", path.join(app.getPath("appData"), "24F"));
if (IS_MAC) {
  const legacyData = path.join(app.getPath("appData"), "24FulfillR");
  if (fs.existsSync(legacyData)) {
    app.setName("24FulfillR");
    app.setPath("userData", legacyData);
  }
}

if (IS_WIN) app.setAppUserModelId("site.24f.desktop");
// Bigger persistent cache, smooth scrolling and GPU raster for a native feel.
app.commandLine.appendSwitch("disk-cache-size", String(768 * 1024 * 1024));
app.commandLine.appendSwitch("enable-smooth-scrolling");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

if (!app.requestSingleInstanceLock()) app.quit();

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch })); } catch { /* not critical */ }
}
const isAppUrl = (url) => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };

// The in-app site list. `exact` hosts match only themselves, `suffixes` also every subdomain.
const BASE_POLICY = Object.freeze({ exact: new Set(), suffixes: BASE_SUFFIXES, tabs: null });
let policy = BASE_POLICY;
// Plain lower-case DNS names with at least two labels and a letter-led last label: no IP
// addresses, ports, wildcards, schemes or paths.
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const validHosts = (list) => {
  if (!Array.isArray(list) || list.length > POLICY_MAX_HOSTS) return null;
  return list.filter((h) => typeof h === "string" && h.length >= 4 && h.length <= 253 && HOSTNAME.test(h));
};
// { version: 1, inApp: [host], inAppSuffixes: [host], tabs? }; any other shape counts as no answer.
// Tabs that do not pass every check are simply left out.
function readPolicy(json) {
  if (!json || typeof json !== "object" || Array.isArray(json) || json.version !== 1) return null;
  const exact = validHosts(json.inApp), suffixes = validHosts(json.inAppSuffixes);
  if (!exact || !suffixes) return null;
  return Object.freeze({ exact: new Set(exact), suffixes: [...new Set([...BASE_SUFFIXES, ...suffixes])], tabs: tabsCheck.readTabs(json.tabs, ORIGIN) });
}
const inAppHost = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return policy.exact.has(host) || policy.suffixes.some((s) => host === s || host.endsWith(`.${s}`));
  } catch { return false; }
};

// Asked with the app's own session (so the answer fits the signed-in account) at launch, after
// sign-in or sign-out, every few minutes and after the computer wakes. A failed or malformed answer
// falls back to the app's own sites only.
let policySeq = 0, policyTimer = null, policyCookies = null;
const APP_HOST = (() => { try { return new URL(ORIGIN).hostname; } catch { return ""; } })();
const AUTH_PATH = /^\/(?:login|forgot-password|reset-password|api\/auth)(?:\/|$)/;
async function fetchPolicy() {
  const res = await session.defaultSession.fetch(POLICY_URL, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" });
  if (!res.ok || !/^application\/json\b/i.test(res.headers.get("content-type") || "")) return null;
  const text = await res.text();
  return text.length > POLICY_MAX_BYTES ? null : readPolicy(JSON.parse(text));
}
function refreshPolicy() {
  clearTimeout(policyTimer);
  policyTimer = null;
  const seq = ++policySeq;
  // A failed check keeps the tabs as they were (a network blip must not close one); only an answer
  // without tabs (signed out, another account) removes them.
  const settle = (next) => {
    if (seq !== policySeq) return;
    policy = next || Object.freeze({ ...BASE_POLICY, tabs: policy.tabs });
    applyTabs();
  };
  fetchPolicy().then(settle).catch(() => settle(null));
}
const schedulePolicy = (ms = 800) => { clearTimeout(policyTimer); policyTimer = setTimeout(refreshPolicy, ms); };
// Signing in or out adds or removes session cookies on the app's site: compare the cookie names
// (not values, which change on every token refresh) and ask again when they differ.
async function cookieNames() {
  const list = await session.defaultSession.cookies.get({ url: ORIGIN });
  return list.map((c) => c.name).sort().join("\n");
}
let cookieTimer = null;
function watchSession() {
  void cookieNames().then((names) => { policyCookies = names; }).catch(() => {});
  session.defaultSession.cookies.on("changed", (_event, cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    if (!domain || (APP_HOST !== domain && !APP_HOST.endsWith(`.${domain}`))) return;
    clearTimeout(cookieTimer);
    cookieTimer = setTimeout(() => {
      cookieNames().then((names) => {
        if (names === policyCookies) return;
        policyCookies = names;
        schedulePolicy(0);
      }).catch(() => {});
    }, 500);
  });
  setInterval(refreshPolicy, POLICY_REFRESH_MS);
  powerMonitor.on("resume", () => schedulePolicy(5_000));
  refreshPolicy();
}
// Leaving or reaching a sign-in page also asks again (an account switch can keep the same cookies).
let lastAppPath = null;
function policyOnNavigate(url) {
  let page = null;
  try { const u = new URL(url); if (u.origin === ORIGIN) page = u.pathname; } catch { /* not a page of the app */ }
  if (page === lastAppPath) return;
  if ((page && AUTH_PATH.test(page)) || (lastAppPath && AUTH_PATH.test(lastAppPath))) schedulePolicy();
  lastAppPath = page;
}

// `site` is the main page view (the left tab when there are tabs), `pane` the right tab's view.
let splash = null, win = null, site = null, pane = null, revealed = false, activeTab = "left";
// The right tab's page and the windows it opened: their requests to the app's site carry PANE_HEADER.
const paneIds = new Set();
const activeView = () => (activeTab === "right" && pane ? pane : site);
const activeWc = () => { const view = activeView(); return view && !view.webContents.isDestroyed() ? view.webContents : null; };

function createSplash() {
  splash = new BrowserWindow({
    width: 300, height: 210, frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    show: false, center: true, backgroundColor: "#00000000", icon: path.join(__dirname, "icon.png"), title: APP_NAME,
    // macOS would draw a square shadow around the transparent window; the chip has its own.
    ...(IS_MAC ? { hasShadow: false } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, "splash.html"), { query: { v: app.getVersion() } });
  splash.once("ready-to-show", () => splash && splash.show());
  splash.on("closed", () => { splash = null; });
}
const splashCall = (js) => { if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(js).catch(() => {}); };

function onScreen(bounds) {
  if (!bounds || !bounds.width) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => bounds.x < a.x + a.width - 80 && bounds.x + bounds.width > a.x + 80 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 80);
}

// Windows: the native caption buttons sit on the same 60% black glass as the bar.
const barOverlay = () => ({ color: "#00000099", symbolColor: "#ffffff", height: BAR_HEIGHT });
// The window chrome per platform. Both hide the system title bar and draw the local bar page
// instead; Windows keeps its caption buttons (snap layouts work), macOS its traffic lights,
// placed in the bar. The glass under the bar: acrylic on Windows, vibrancy on macOS.
const chrome = () => (IS_MAC
  ? { titleBarStyle: "hidden", trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: "under-window", visualEffectState: "followWindow" }
  : { backgroundMaterial: "acrylic", autoHideMenuBar: true, titleBarStyle: "hidden", titleBarOverlay: barOverlay() });

function createMain() {
  const state = readState();
  const bounds = onScreen(state.bounds) ? state.bounds : { width: 1440, height: 900 };
  revealed = false;
  // The window's own webContents is the local title bar page; the system still draws its own
  // window buttons over it (Windows: min / maximise / close; macOS: the traffic lights).
  win = new BrowserWindow({
    ...bounds, minWidth: 980, minHeight: 640, show: false, title: APP_NAME,
    backgroundColor: "#00000000", icon: path.join(__dirname, "icon.png"),
    ...chrome(),
    webPreferences: { preload: path.join(__dirname, "bar-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (!IS_MAC) win.setMenuBarVisibility(false);
  win.on("page-title-updated", (event) => event.preventDefault());
  if (!bounds.x && bounds.x !== 0) win.center();

  // The live site lives in its own view under the bar (the whole window in fullscreen).
  site = createSiteView();
  win.contentView.addChildView(site);
  const bar = win.webContents;
  // macOS hides the traffic lights in fullscreen: the bar's mark moves back to the left edge
  // (told only when it changes, not on every live-resize step).
  let barFull = null;
  const syncBarFullScreen = (force = false) => {
    if (!IS_MAC || !win) return;
    const full = win.isFullScreen();
    if (!force && full === barFull) return;
    barFull = full;
    bar.executeJavaScript(`window.setFullScreen && window.setFullScreen(${full})`).catch(() => {});
  };
  const layout = () => {
    if (!win || !site) return;
    layoutViews();
    syncBarFullScreen();
  };
  layout();
  for (const ev of ["resize", "maximize", "unmaximize", "restore", "enter-full-screen", "leave-full-screen"]) win.on(ev, layout);

  const wc = site.webContents;
  if (state.zoom) wc.setZoomFactor(state.zoom);

  // Title bar: a static local page (the Kexlo mark on a glass strip); the site keeps the focus.
  bar.loadFile(path.join(__dirname, "titlebar.html"));
  bar.on("did-finish-load", () => { applyBarTitle(); applyBarUpdate(); applyBarTabs(); syncBarFullScreen(true); });
  bar.on("will-navigate", (event) => event.preventDefault());
  bar.setWindowOpenHandler(() => ({ action: "deny" }));
  bar.on("before-input-event", (event, input) => { const target = activeWc(); if (target) handleShortcut(event, input, win, target); });
  win.on("focus", () => { const target = activeWc(); if (target) target.focus(); });

  const started = Date.now();
  const reveal = () => {
    if (revealed || !win) return;
    revealed = true;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - started));
    setTimeout(() => {
      splashCall("window.finish && window.finish()");
      setTimeout(() => {
        if (!win) return;
        // Shown transparent, then faded in over ~150 ms: the workspace glides in instead of popping.
        win.setOpacity(0);
        if (state.maximized ?? true) win.maximize();
        win.show();
        win.focus();
        let opacity = 0;
        const fade = setInterval(() => {
          if (!win || win.isDestroyed()) return clearInterval(fade);
          opacity = Math.min(1, opacity + 0.125);
          win.setOpacity(opacity);
          if (opacity >= 1) clearInterval(fade);
        }, 16);
        setTimeout(() => splash && !splash.isDestroyed() && splash.close(), 160);
      }, 200);
    }, wait);
  };
  setTimeout(reveal, SPLASH_MAX_MS);

  wc.on("did-start-loading", () => splashCall("window.setStatus && window.setStatus('Connecting')"));
  wc.on("dom-ready", () => splashCall("window.setStatus && window.setStatus('Loading your workspace')"));
  for (const ev of ["did-navigate", "did-navigate-in-page", "did-finish-load"]) wc.on(ev, () => refreshBarTitle(wc));
  win.on("focus", () => refreshBarTitle(wc));
  wc.on("did-finish-load", () => { splashCall("window.setStatus && window.setStatus('Ready')"); reveal(); });
  wc.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) reveal(); });

  win.on("app-command", (_e, cmd) => {
    const target = activeWc();
    if (!target) return;
    if (cmd === "browser-backward") goBack(target);
    if (cmd === "browser-forward") goForward(target);
  });

  win.on("close", () => {
    if (!win) return;
    writeState({ maximized: win.isMaximized(), bounds: win.isMaximized() || win.isMinimized() || win.isFullScreen() ? readState().bounds : win.getBounds() });
  });
  win.on("closed", () => {
    if (!wc.isDestroyed()) wc.close();
    if (pane && !pane.webContents.isDestroyed()) pane.webContents.close();
    paneIds.clear();
    win = null;
    site = null;
    pane = null;
    activeTab = "left";
  });

  // Opening the app starts on the overview. Only a restart for an update comes back to the exact
  // page and scroll position it left (saved by installUpdate below, used once).
  const resume = readState().resume;
  writeState({ resume: null, lastUrl: null });
  if (resume && isAppUrl(resume.url) && Date.now() - resume.at < 15 * 60_000) {
    wc.once("did-finish-load", () => restoreScroll(wc, resume.scroll));
    wc.loadURL(resume.url);
  } else {
    wc.loadURL(HOME);
  }
}

// Every page view (the site, and the right tab's when there are tabs) is made here: the same
// locked-down settings and the same navigation, new-window, shortcut and menu handling.
function createSiteView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true,
      additionalArguments: [`--f24-version=${app.getVersion()}`],
    },
  });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK : LIGHT);
  const wc = view.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} 24FDesktop/${app.getVersion()}`);
  for (const ev of ["did-navigate", "did-navigate-in-page"]) wc.on(ev, () => policyOnNavigate(wc.getURL()));
  wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */) return;
    wc.loadFile(path.join(__dirname, "offline.html"), { query: { to: isAppUrl(url) ? url : HOME } });
  });

  // New windows: app pages and the sites on the in-app list stay inside; everything else opens in
  // the browser.
  wc.setWindowOpenHandler(({ url }) => {
    // A page of the other title-bar tab opens in that tab, not in a new window.
    const to = otherTab(wc, url);
    if (to) { setImmediate(() => openInTab(to, url)); return { action: "deny" }; }
    if (isAppUrl(url) || inAppHost(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? DARK : LIGHT, icon: path.join(__dirname, "icon.png"), webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    }
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url) || url.startsWith("file:")) { moveIfOtherTab(event, wc, url); return; }
    event.preventDefault();
    if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
  });
  // A redirect into the other tab's pages stops here and opens there (this view stays where it was).
  wc.on("will-redirect", (event, url) => {
    if (event.isMainFrame === false) return;
    moveIfOtherTab(event, wc, event.url || url);
  });
  // An in-page move (the site's own client-side routing) into the other tab's pages: opened there,
  // and this view steps back to where it was.
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    const to = otherTab(wc, url);
    if (!to) return;
    setImmediate(() => {
      openInTab(to, url);
      if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });
  });

  wc.on("before-input-event", (event, input) => handleShortcut(event, input, win, wc));
  wc.on("context-menu", (_e, params) => contextMenu(win, wc, params));
  wc.on("zoom-changed", (_e, dir) => setZoom(wc, dir === "in" ? 0.1 : -0.1));
  return view;
}

// Both page views fill the window under the bar (the whole window in fullscreen). They stay the same
// size and only their order changes, so switching tabs never reloads or repaints a page.
function layoutViews() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const top = win.isFullScreen() ? 0 : BAR_HEIGHT;
  const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
  for (const view of [site, pane]) if (view) view.setBounds(bounds);
}

// The right tab's view, made on first use (and only while the policy has tabs).
function ensurePane(url) {
  if (pane) return pane;
  if (!win || win.isDestroyed() || !site || !policy.tabs) return null;
  pane = createSiteView();
  const wc = pane.webContents;
  paneIds.add(wc.id);
  // What this tab shows can change from inside it (another workspace chosen there): every full page
  // load in it asks the policy again, so its label and the bar's title follow.
  wc.on("did-navigate", () => { if (pane && pane.webContents === wc) schedulePolicy(300); });
  // Windows it opens belong to it too (their requests carry the same header).
  wc.on("did-create-window", (child) => {
    const id = child.webContents.id;
    paneIds.add(id);
    child.once("closed", () => paneIds.delete(id));
  });
  // Added under the main view; showTab brings it to the top.
  win.contentView.addChildView(pane, 0);
  layoutViews();
  wc.loadURL(url || policy.tabs.right.url);
  return pane;
}

// Removes the right tab's view and every window it opened (the tabs are gone from the policy).
function dropPane() {
  const view = pane;
  pane = null;
  activeTab = "left";
  if (!view) return;
  const ids = new Set(paneIds);
  paneIds.clear();
  for (const child of BrowserWindow.getAllWindows()) if (child !== win && child !== splash && ids.has(child.webContents.id)) child.close();
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* already gone */ }
    if (site && !site.webContents.isDestroyed()) site.webContents.focus();
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

// Shows a tab: brings its view to the top (the other stays alive underneath, exactly as it was).
function showTab(which) {
  if (!win || win.isDestroyed() || !site) return;
  if (which === "right" && !ensurePane()) return;
  const view = which === "right" ? pane : site;
  activeTab = which;
  win.contentView.addChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.focus();
  applyBarTabs();
  applyBarTitle();
}

// Which tab a page view is ("left" or "right"), or null (a window it opened, the bar).
function tabOf(wc) {
  if (site && !site.webContents.isDestroyed() && wc === site.webContents) return "left";
  if (pane && !pane.webContents.isDestroyed() && wc === pane.webContents) return "right";
  return null;
}
// The other tab when this page belongs to it (the policy's routes for each tab), else null.
const otherTab = (wc, url) => (policy.tabs ? tabsCheck.otherTabFor(policy.tabs, tabOf(wc), url, ORIGIN) : null);
function moveIfOtherTab(event, wc, url) {
  // Only from a page of the app's own site (a retry from the offline page reopens its own page).
  if (!isAppUrl(wc.getURL())) return false;
  const to = otherTab(wc, url);
  if (!to) return false;
  event.preventDefault();
  setImmediate(() => openInTab(to, url));
  return true;
}
// Opens a page in a tab and shows that tab. The tab's own start page only shows the tab as it is
// (it is already there, or somewhere within it), so a tab is never reloaded for nothing.
function openInTab(which, url) {
  const t = policy.tabs;
  if (!t || !win || win.isDestroyed() || !site) return;
  if (which === "right") {
    if (!pane) { if (!ensurePane(url)) return; }
    else if (url !== t.right.url && !pane.webContents.isDestroyed()) pane.webContents.loadURL(url);
  } else if (url !== t.left.url && !site.webContents.isDestroyed()) {
    site.webContents.loadURL(url);
  }
  showTab(which);
}

// The bar's two tabs (labels from the policy, the active one highlighted), or none.
function applyBarTabs() {
  if (!win || win.isDestroyed()) return;
  const t = policy.tabs;
  const state = t ? { left: { label: t.left.label, active: activeTab !== "right" }, right: { label: t.right.label, active: activeTab === "right" } } : null;
  win.webContents.executeJavaScript(`window.setTabs && window.setTabs(${JSON.stringify(state)})`).catch(() => {});
}

// After every policy answer: tabs gone -> back to the single view at once; tabs there -> bar labels
// updated and the right tab's menu fetched ahead, so a right-click opens it without waiting.
let menuCache = null;
function applyTabs() {
  if (!policy.tabs) { menuCache = null; dropPane(); }
  else if (!menuCache || menuCache.url !== policy.tabs.right.menuUrl || Date.now() - menuCache.at > MENU_CACHE_MS) void fetchMenu().catch(() => {});
  applyBarTabs();
  applyBarTitle();
}

async function fetchJson(url, init) {
  const res = await session.defaultSession.fetch(url, { credentials: "include", cache: "no-store", redirect: "error", ...init });
  if (!res.ok || !/^application\/json\b/i.test(res.headers.get("content-type") || "")) return null;
  const text = await res.text();
  return text.length > MENU_MAX_BYTES ? null : JSON.parse(text);
}

async function fetchMenu() {
  const url = policy.tabs && policy.tabs.right.menuUrl;
  if (!url) return null;
  const menu = tabsCheck.readMenu(await fetchJson(url, { method: "GET" }));
  if (menu && policy.tabs && policy.tabs.right.menuUrl === url) menuCache = { url, at: Date.now(), menu };
  return menu;
}

// Right-click on the right tab: the list the site gives, as a native menu; choosing an entry asks the
// site to switch the tab to it and opens the page it answers in that tab.
let menuOpen = false;
async function showTabMenu() {
  const t = policy.tabs;
  if (!t || !win || menuOpen) return;
  menuOpen = true;
  try {
    const cached = menuCache && menuCache.url === t.right.menuUrl && Date.now() - menuCache.at < MENU_CACHE_MS ? menuCache.menu : null;
    const menu = cached || (await fetchMenu().catch(() => null));
    if (!menu || !win || win.isDestroyed() || !policy.tabs) return;
    // Windows reads "&" in a menu label as a shortcut marker.
    const text = (s) => (IS_WIN ? s.replace(/&/g, "&&") : s);
    const items = menu.items.length
      ? menu.items.map((item) => ({ label: text(item.label), type: "radio", checked: item.id === menu.current, click: () => void chooseMenuItem(item.id) }))
      : [{ label: "Nothing to show", enabled: false }];
    Menu.buildFromTemplate(items).popup({ window: win });
  } finally {
    menuOpen = false;
  }
}

async function chooseMenuItem(id) {
  const t = policy.tabs;
  if (!t) return;
  let from = null;
  if (pane && !pane.webContents.isDestroyed()) {
    try { const u = new URL(pane.webContents.getURL()); if (u.origin === ORIGIN) from = u.pathname.slice(0, 200); } catch { /* not a page of the app */ }
  }
  let url = null;
  try {
    url = tabsCheck.readChoice(await fetchJson(t.right.menuUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(from ? { id, from } : { id }),
    }), ORIGIN);
  } catch { url = null; }
  if (!url || !policy.tabs) return;
  menuCache = null;
  if (pane) pane.webContents.loadURL(url);
  else if (!ensurePane(url)) return;
  showTab("right");
  schedulePolicy(0);
}

// Centre of the title bar: "Kexlo" signed out, the store name on the workspace pages (ORIGIN),
// and "Kexlo - <store>" on the public landing site (PUBLIC_HOSTS). The name comes from the
// site's own tiny /api/desktop/identity, fetched here with the app session's ORIGIN cookie (the
// landing is another origin, so an in-page fetch could not carry it). The signed-in account only.
const PUBLIC_HOSTS = /^(?:www\.)?(?:kexlo\.io|24fulfil{1,2}r\.com)$/i;
const LANDING_EXACT_ONLY = /^\/(?:about|company|compare|contact|dashboard-features|integrations|pilot-orders|privacy-policy|services|shipping|shipping-calculator|terms)?\/?$/;
const isPublicSite = (url) => { try { return PUBLIC_HOSTS.test(new URL(url).hostname); } catch { return false; } };
let storeName = null, titleSeq = 0;
function applyBarTitle(url) {
  let onLanding = false;
  try {
    const u = new URL(url || (site && site.webContents.getURL()) || "");
    onLanding = PUBLIC_HOSTS.test(u.hostname) || (u.origin === ORIGIN && LANDING_EXACT_ONLY.test(u.pathname));
  } catch { /* keep workspace wording */ }
  let title = storeName ? (onLanding ? `${APP_NAME} - ${storeName}` : storeName) : APP_NAME;
  // A tab's own title from the policy while it is shown; the right tab never shows the left's.
  if (activeTab === "right" && pane && policy.tabs) title = policy.tabs.right.title || APP_NAME;
  else if (activeTab !== "right" && policy.tabs && policy.tabs.left.title) title = policy.tabs.left.title;
  if (!win || win.isDestroyed()) return;
  win.setTitle(title);
  win.webContents.executeJavaScript(`window.setTitle && window.setTitle(${JSON.stringify(title)})`).catch(() => {});
}
function refreshBarTitle(wc) {
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!isAppUrl(url) && !isPublicSite(url)) { storeName = null; return applyBarTitle(url); }
  applyBarTitle(url);
  const seq = ++titleSeq;
  wc.session.fetch(`${ORIGIN}/api/desktop/identity`, { method: "GET", credentials: "include", cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (seq !== titleSeq) return;
      const name = j && typeof j.name === "string" ? j.name : "";
      storeName = name.trim() ? name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : null;
      applyBarTitle();
    })
    .catch(() => { if (seq === titleSeq) { storeName = null; applyBarTitle(); } });
}

// Follow the system light / dark for the site's background (the glass bar stays the same in both).
function applyTheme() {
  if (!win || win.isDestroyed()) return;
  for (const view of [site, pane]) if (view) view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK : LIGHT);
}

function setZoom(wc, delta) {
  const next = delta === 0 ? 1 : Math.min(2, Math.max(0.6, Math.round((wc.getZoomFactor() + delta) * 10) / 10));
  wc.setZoomFactor(next);
  writeState({ zoom: next });
}

const goBack = (wc) => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); };
const goForward = (wc) => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); };

// `target` is the window (fullscreen), `wc` the site's webContents (everything else).
// Ctrl on Windows and Cmd on macOS (both accepted everywhere); handled shortcuts never reach
// the page or the macOS menu, so nothing runs twice.
function handleShortcut(event, input, target, wc) {
  if (input.type !== "keyDown") return;
  const ctrl = input.control || input.meta, key = input.key.toLowerCase();
  const act = (fn) => { event.preventDefault(); fn(); };
  if (key === "f5" || (ctrl && key === "r")) return act(() => (input.shift ? wc.reloadIgnoringCache() : wc.reload()));
  if (ctrl && (key === "=" || key === "+")) return act(() => setZoom(wc, 0.1));
  if (ctrl && key === "-") return act(() => setZoom(wc, -0.1));
  if (ctrl && key === "0") return act(() => setZoom(wc, 0));
  if (key === "f11") return act(() => target.setFullScreen(!target.isFullScreen()));
  if (input.alt && key === "arrowleft" && wc.navigationHistory.canGoBack()) return act(() => wc.navigationHistory.goBack());
  if (input.alt && key === "arrowright" && wc.navigationHistory.canGoForward()) return act(() => wc.navigationHistory.goForward());
  // macOS: Cmd+[ and Cmd+] go back and forward, as in Safari and Finder.
  if (IS_MAC && input.meta && !input.shift && key === "[") return act(() => goBack(wc));
  if (IS_MAC && input.meta && !input.shift && key === "]") return act(() => goForward(wc));
  if (ctrl && input.shift && key === "i") return act(() => wc.toggleDevTools());
  // Ctrl/Cmd+1 and Ctrl/Cmd+2: the left and right title-bar tabs (only when there are tabs).
  if (ctrl && !input.shift && !input.alt && (key === "1" || key === "2") && policy.tabs) return act(() => showTab(key === "1" ? "left" : "right"));
  if (input.alt && key === "home") return act(() => wc.loadURL(HOME));
}

function contextMenu(target, wc, params) {
  const items = [];
  for (const word of params.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
  if (params.misspelledWord) items.push({ label: "Add to dictionary", click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
  if (params.linkURL) {
    // Only web, mail and phone links open outside: another scheme (file:, ms-msdt:, a custom protocol) could start a local program.
    if (/^(https?|mailto|tel):/i.test(params.linkURL)) items.push({ label: "Open link in browser", click: () => shell.openExternal(params.linkURL) });
    items.push({ label: "Copy link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
  }
  if (params.isEditable) items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
  else if (params.selectionText.trim()) items.push({ role: "copy" });
  if (!params.isEditable) {
    if (items.length) items.push({ type: "separator" });
    items.push(
      { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "Reload", click: () => wc.reload() },
    );
  }
  Menu.buildFromTemplate(items).popup({ window: target });
}

// macOS: the menu bar every Mac app has. The Edit menu is what makes Cmd+C / Cmd+V / Cmd+A work
// in the page; View, History and Window act on the workspace (the site view), never the bar.
// Windows has no menu bar (the shortcuts above cover the same actions).
function macMenu() {
  // The page in front: the site, or the right tab's page while that tab is shown.
  const onSite = (fn) => () => { const wc = activeWc(); if (wc) fn(wc); };
  const showMain = () => { if (!win) createMain(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } };
  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `About ${APP_NAME}` },
        { label: "Check for Updates…", click: () => { showMain(); if (updates.status === "ready") void installUpdate(); else checkForUpdates(); } },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${APP_NAME}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${APP_NAME}` },
      ],
    },
    { label: "File", submenu: [{ label: "New Window", accelerator: "Cmd+N", click: showMain }, { type: "separator" }, { role: "close" }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "Cmd+R", click: onSite((wc) => wc.reload()) },
        { label: "Force Reload", accelerator: "Shift+Cmd+R", click: onSite((wc) => wc.reloadIgnoringCache()) },
        { type: "separator" },
        { label: "Actual Size", accelerator: "Cmd+0", click: onSite((wc) => setZoom(wc, 0)) },
        { label: "Zoom In", accelerator: "Cmd+Plus", click: onSite((wc) => setZoom(wc, 0.1)) },
        { label: "Zoom Out", accelerator: "Cmd+-", click: onSite((wc) => setZoom(wc, -0.1)) },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { label: "Developer Tools", accelerator: "Alt+Cmd+I", click: onSite((wc) => wc.toggleDevTools()) },
      ],
    },
    {
      label: "History",
      submenu: [
        { label: "Back", accelerator: "Cmd+[", click: onSite(goBack) },
        { label: "Forward", accelerator: "Cmd+]", click: onSite(goForward) },
        { type: "separator" },
        { label: "Home", accelerator: "Shift+Cmd+H", click: onSite((wc) => wc.loadURL(HOME)) },
      ],
    },
    { role: "windowMenu" },
  ]);
}

// Scroll positions on the page: the window's and every scrolled box's, each found again by its
// path from <body>. Restored after the restart, retried while the page's data is still arriving.
const CAPTURE_SCROLL = `(() => {
  const path = (el) => { const parts = []; while (el && el !== document.body && parts.length < 30) { const parent = el.parentElement; if (!parent) break; parts.unshift(Array.prototype.indexOf.call(parent.children, el)); el = parent; } return parts.join("/"); };
  const boxes = [];
  for (const el of document.querySelectorAll("body *")) { if (el.scrollTop > 0 || el.scrollLeft > 0) boxes.push({ path: path(el), top: el.scrollTop, left: el.scrollLeft }); if (boxes.length >= 25) break; }
  return { x: window.scrollX, y: window.scrollY, boxes };
})()`;
function restoreScroll(wc, scroll) {
  if (!scroll || wc.isDestroyed()) return;
  const js = `((s) => {
    const find = (p) => { let el = document.body; for (const i of p ? p.split("/") : []) { el = el && el.children[Number(i)]; } return el; };
    let tries = 0;
    const apply = () => {
      window.scrollTo(s.x, s.y);
      let done = Math.abs(window.scrollY - s.y) < 2;
      for (const b of s.boxes) { const el = find(b.path); if (el) { el.scrollTop = b.top; el.scrollLeft = b.left; done = done && Math.abs(el.scrollTop - b.top) < 2; } else done = false; }
      if (!done && ++tries < 30) setTimeout(apply, 150);
    };
    apply();
  })(${JSON.stringify(scroll)})`;
  wc.executeJavaScript(js).catch(() => {});
}

// Updates: checked automatically (unless turned off in Settings > Check for Updates) and on demand
// from that page. The page sees only this state, never the updater.
// Windows: an update found is downloaded in the background, then "Install & update" restarts into
// the new version on the same page.
// macOS: the app is not signed by Apple, so it cannot replace itself (Squirrel.Mac refuses unsigned
// updates). It reads the version in the Mac feed (latest-mac.yml) and, when a newer one exists,
// offers it as "Update available - Download", which opens the new .dmg in the browser
// (`manual: true` in the state tells the page to word it that way).
const MAC_FEED = "https://24f.site/desktop/mac/latest-mac.yml";
const MAC_DOWNLOAD = "https://24f.site/download/mac";
const updates = { status: "idle", version: app.getVersion(), latest: null, percent: null, checkedAt: null, auto: readState().autoUpdate !== false, error: null, manual: false };
let updater = null, macFeed = false;
// The title bar shows a small pill while an update waits: "Update ready - Restart" (Windows) or
// "Update available - Download" (macOS).
const applyBarUpdate = () => {
  if (!win || win.isDestroyed()) return;
  const ready = updates.status === "ready" ? updates.latest || "new" : null;
  win.webContents.executeJavaScript(`window.setUpdateReady && window.setUpdateReady(${JSON.stringify(ready)}, ${updates.manual ? "true" : "false"})`).catch(() => {});
};
const sendUpdates = () => {
  for (const view of [site, pane]) if (view && !view.webContents.isDestroyed()) view.webContents.send("updates:state", { ...updates });
  applyBarUpdate();
};
const setUpdates = (patch) => { Object.assign(updates, patch); sendUpdates(); };
const OFFLINE = "Couldn't reach the update server. Check your connection and try again.";

// "1.2.10" > "1.2.9"; anything unparsable counts as 0.
const isNewer = (a, b) => {
  const parts = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

let macNotified = false;
async function checkMacFeed() {
  setUpdates({ status: "checking", error: null });
  try {
    const res = await net.fetch(MAC_FEED, { cache: "no-store" });
    // No Mac build in the newest release yet (it is built after the Windows one): nothing to offer.
    if (res.status === 404) return setUpdates({ status: "current", latest: null, checkedAt: Date.now() });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const match = /^version:\s*['"]?v?(\d+\.\d+\.\d+)/m.exec(await res.text());
    if (!match) throw new Error("feed without a version");
    if (!isNewer(match[1], app.getVersion())) return setUpdates({ status: "current", latest: null, checkedAt: Date.now() });
    setUpdates({ status: "ready", latest: match[1], percent: null, manual: true, checkedAt: Date.now() });
    if (macNotified || !Notification.isSupported()) return;
    macNotified = true;
    const note = new Notification({ title: `${APP_NAME} update available`, body: `Version ${match[1]} is available. Click to download it.` });
    note.on("click", () => void installUpdate());
    note.show();
  } catch {
    setUpdates({ status: "error", error: OFFLINE, checkedAt: Date.now() });
  }
}

function checkForUpdates() {
  if (!updater && !macFeed) { setUpdates({ status: "unsupported", checkedAt: Date.now() }); return; }
  if (["checking", "downloading", "ready"].includes(updates.status)) return;
  if (macFeed) { void checkMacFeed(); return; }
  setUpdates({ status: "checking", error: null });
  updater.checkForUpdates().catch(() => setUpdates({ status: "error", error: OFFLINE, checkedAt: Date.now() }));
}

async function installUpdate() {
  if (updates.status !== "ready") return;
  // macOS: the newest .dmg opens in the browser; the user drags it over the installed app.
  if (updates.manual) { void shell.openExternal(MAC_DOWNLOAD); return; }
  if (!updater) return;
  // Remember exactly where the user is, so the restart opens there again.
  let scroll = null;
  try { scroll = await site.webContents.executeJavaScript(CAPTURE_SCROLL); } catch { /* the page still reopens */ }
  const url = site && site.webContents.getURL();
  if (url && isAppUrl(url)) writeState({ resume: { url, scroll, at: Date.now() } });
  if (win && !win.isDestroyed()) writeState({ maximized: win.isMaximized(), bounds: win.isMaximized() || win.isMinimized() ? readState().bounds : win.getBounds() });
  setImmediate(() => updater.quitAndInstall(true, true));
}

function setupUpdates() {
  // Only the page from the app's own site may ask (never another site opened inside the app).
  const fromApp = (event) => [site, pane].some((view) => !!view && event.sender === view.webContents) && isAppUrl((event.senderFrame && event.senderFrame.url) || "");
  ipcMain.handle("updates:get", (event) => (fromApp(event) ? { ...updates } : null));
  ipcMain.handle("updates:check", (event) => { if (fromApp(event)) checkForUpdates(); return { ...updates }; });
  ipcMain.handle("updates:install", (event) => { if (fromApp(event)) void installUpdate(); return true; });
  ipcMain.handle("updates:auto", (event, on) => { if (fromApp(event)) { writeState({ autoUpdate: !!on }); setUpdates({ auto: !!on }); } return { ...updates }; });
  // The title bar's pill (bar-preload.js); only the window's own local bar page may ask.
  ipcMain.on("bar:install-update", (event) => { if (win && event.sender === win.webContents) void installUpdate(); });
  // The title-bar tabs (bar-preload.js): a click shows a tab, a right-click opens the right tab's menu.
  ipcMain.on("bar:tab", (event, which) => { if (win && event.sender === win.webContents && policy.tabs && (which === "left" || which === "right")) showTab(which); });
  ipcMain.on("bar:tab-menu", (event, which) => { if (win && event.sender === win.webContents && policy.tabs && which === "right") void showTabMenu(); });

  if (!app.isPackaged) return;
  if (IS_MAC) {
    macFeed = true;
  } else {
    try { ({ autoUpdater: updater } = require("electron-updater")); } catch { updater = null; return; }
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = null;
    updater.on("checking-for-update", () => setUpdates({ status: "checking" }));
    updater.on("update-not-available", () => setUpdates({ status: "current", latest: null, checkedAt: Date.now() }));
    updater.on("update-available", (info) => setUpdates({ status: "downloading", latest: info.version, percent: 0, checkedAt: Date.now() }));
    updater.on("download-progress", (p) => setUpdates({ status: "downloading", percent: Math.round(p.percent) }));
    let notified = false;
    updater.on("update-downloaded", (info) => {
      setUpdates({ status: "ready", latest: info.version, percent: 100 });
      if (notified || !Notification.isSupported()) return;
      notified = true;
      const note = new Notification({ title: `${APP_NAME} update ready`, body: `Version ${info.version} is ready. Click to install; you'll be back on the same page.`, icon: path.join(__dirname, "icon.png") });
      note.on("click", () => void installUpdate());
      note.show();
    });
    updater.on("error", () => { if (updates.status !== "ready") setUpdates({ status: "error", error: OFFLINE, checkedAt: Date.now() }); });
  }
  // Checked shortly after launch, every hour, and after the computer wakes up (the feed is a tiny .yml).
  const auto = () => { if (updates.auto) checkForUpdates(); };
  setTimeout(auto, 15_000);
  setInterval(auto, 60 * 60 * 1000);
  powerMonitor.on("resume", () => setTimeout(auto, 30_000));
}

app.on("second-instance", () => {
  if (!win) { if (app.isReady()) createMain(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Downloads (order exports and any other file the site hands over) save straight to Downloads
// under a free name instead of asking where. When finished, documents open in their default app
// (an order export appears at once); any other kind of file is only shown in its folder
// (Explorer on Windows, Finder on macOS).
const OPEN_AFTER_DOWNLOAD = new Set([".pdf", ".csv", ".xlsx", ".xls", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
function freeDownloadPath(dir, name) {
  const safe = String(name || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "") || "download";
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}
function handleDownloads(ses) {
  ses.on("will-download", (_event, item) => {
    const target = freeDownloadPath(app.getPath("downloads"), item.getFilename());
    item.setSavePath(target);
    item.once("done", (_e, state) => {
      if (state !== "completed") return;
      if (!OPEN_AFTER_DOWNLOAD.has(path.extname(target).toLowerCase())) return shell.showItemInFolder(target);
      shell.openPath(target).then((error) => { if (error) shell.showItemInFolder(target); }).catch(() => shell.showItemInFolder(target));
    });
  });
}

// Requests from the right tab's pages to the app's own site carry PANE_HEADER; no other request
// does (a page cannot set it for itself: it is removed from every other request).
function markPaneRequests(ses) {
  const lower = PANE_HEADER.toLowerCase();
  ses.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, done) => {
    const fromPane = paneIds.has(details.webContentsId);
    const headers = details.requestHeaders;
    const present = Object.keys(headers).filter((name) => name.toLowerCase() === lower);
    if (!fromPane && !present.length) return done({});
    for (const name of present) delete headers[name];
    if (fromPane) headers[PANE_HEADER] = PANE_VALUE;
    done({ requestHeaders: headers });
  });
}

app.whenReady().then(() => {
  if (IS_MAC) {
    Menu.setApplicationMenu(macMenu());
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: "Kexlo" });
    // `npm start` runs the bare Electron binary: show the app's icon in the Dock instead of Electron's.
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, "icon.png"));
  } else {
    Menu.setApplicationMenu(null);
  }
  nativeTheme.themeSource = "system";
  nativeTheme.on("updated", applyTheme);
  // Never let a page ask for camera, location, etc. Notifications and clipboard are fine.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(["notifications", "clipboard-sanitized-write", "clipboard-read", "fullscreen"].includes(permission)));
  handleDownloads(session.defaultSession);
  markPaneRequests(session.defaultSession);
  watchSession();
  createSplash();
  createMain();
  setupUpdates();
});

// macOS keeps the app in the Dock with no window open (Cmd+Q quits); clicking the Dock icon opens
// the workspace again. Windows quits with its last window, as before.
app.on("window-all-closed", () => { if (!IS_MAC) app.quit(); });
app.on("activate", () => {
  if (!app.isReady()) return;
  if (!win) createMain();
  else if (!win.isVisible() && revealed) win.show();
});
