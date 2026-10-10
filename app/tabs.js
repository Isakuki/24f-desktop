// Title-bar tabs: checks for what the site sends. The site may ask for two tabs (one each side of
// the centred name), each its own page of the app's own site, and a menu for the right one. Each tab
// names the pages that belong to it (`routes`): such a page opened from the other tab opens in its
// own tab instead. A tab may also give the text for the centre of the bar while it is shown
// (`title`). The shell knows nothing else about them: no tab exists unless the signed-in account's
// policy answer names it, and every value is checked here first. Pure functions (no Electron), so
// they are tested on their own.

const LABEL_MAX = 40, TITLE_MAX = 80, PATH_MAX = 200, MENU_MAX = 200, MENU_LABEL_MAX = 60;
const ROUTES_MAX = 16, ROUTE_MAX = 64;
// "/a" or "/a/b-c": plain path segments, never the whole site.
const ROUTE = /^(?:\/[A-Za-z0-9_-]+)+$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One line of plain text, or null.
function label(value, max = LABEL_MAX) {
  if (typeof value !== "string" || value.length > 400) return null;
  const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// A path on the app's own site ("/x/y?z"), as a full URL on that origin; anything else is null.
function pageUrl(value, origin) {
  if (typeof value !== "string" || value.length < 1 || value.length > PATH_MAX) return null;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// A tab's pages: missing is none; anything malformed is null (and then there are no tabs at all).
function readRoutes(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > ROUTES_MAX) return null;
  const out = [];
  for (const route of value) {
    if (typeof route !== "string" || route.length > ROUTE_MAX || !ROUTE.test(route)) return null;
    if (!out.includes(route)) out.push(route);
  }
  return Object.freeze(out);
}

// The bar's centre text for a tab: missing or unusable is none (the app's usual title then).
const readTitle = (value) => (value === undefined ? null : label(value, TITLE_MAX));

// { left: { label, url, routes?, title? }, right: { label, url, menuUrl, routes?, title? } } ->
// frozen copy, or null (no tabs).
function readTabs(value, origin) {
  if (!plainObject(value) || !plainObject(value.left) || !plainObject(value.right)) return null;
  const left = { label: label(value.left.label), url: pageUrl(value.left.url, origin), routes: readRoutes(value.left.routes), title: readTitle(value.left.title) };
  const right = { label: label(value.right.label), url: pageUrl(value.right.url, origin), menuUrl: pageUrl(value.right.menuUrl, origin), routes: readRoutes(value.right.routes), title: readTitle(value.right.title) };
  if (!left.label || !left.url || !left.routes || !right.label || !right.url || !right.menuUrl || !right.routes) return null;
  // A page cannot belong to both tabs.
  if (left.routes.some((a) => right.routes.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))) return null;
  return Object.freeze({ left: Object.freeze(left), right: Object.freeze(right) });
}

// Whether a page of the app's own site is one of these routes (the route itself or below it).
function inRoutes(routes, url, origin) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== origin || u.username || u.password) return false;
  return routes.some((r) => u.pathname === r || u.pathname.startsWith(`${r}/`));
}

// The tab a page opened in tab `from` ("left" or "right") belongs to when that is the other tab,
// else null (it stays where it is). Only pages of the app's own site ever move.
function otherTabFor(tabs, from, url, origin) {
  if (!tabs || (from !== "left" && from !== "right")) return null;
  const other = from === "left" ? "right" : "left";
  return inRoutes(tabs[other].routes, url, origin) && !inRoutes(tabs[from].routes, url, origin) ? other : null;
}

// { items: [{ id, label }], current } -> the same, checked, or null.
function readMenu(value) {
  if (!plainObject(value) || !Array.isArray(value.items) || value.items.length > MENU_MAX) return null;
  const items = [], seen = new Set();
  for (const entry of value.items) {
    if (!plainObject(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || seen.has(entry.id)) continue;
    const text = label(entry.label, MENU_LABEL_MAX);
    if (!text) continue;
    seen.add(entry.id);
    items.push({ id: entry.id, label: text });
  }
  const current = typeof value.current === "string" && seen.has(value.current) ? value.current : null;
  return { items, current };
}

// The answer to choosing a menu entry: { url } on the app's own site, or null.
function readChoice(value, origin) {
  return plainObject(value) ? pageUrl(value.url, origin) : null;
}

const sameTabs = (a, b) => (!a && !b) || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

module.exports = { readTabs, readMenu, readChoice, otherTabFor, pageUrl, label, sameTabs, MENU_MAX };
