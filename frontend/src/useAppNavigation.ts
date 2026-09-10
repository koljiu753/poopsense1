import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type View = "home" | "result" | "doctor" | "health" | "social" | "settings";
export type HealthSection = "records" | "actions" | "trends";
export type AppRoute = {
  view: View;
  memberId: string;
  section: HealthSection;
  sessionId: string;
  sourceId: string;
  trendDays: number;
  chat: boolean;
};
const emptyRoute: AppRoute = { view: "home", memberId: "", section: "records", sessionId: "", sourceId: "", trendDays: 30, chat: false };
type Entry = { key: string; parent?: string; origin?: AppRoute; scroll: number };
const stateKey = "poopsenseNavigationV1";
let sequence = 0;
function newKey() { return `${Date.now()}-${++sequence}`; }

export function readRoute(hash = window.location.hash): AppRoute {
  const [path, search = ""] = hash.replace(/^#/, "").split("?");
  const query = new URLSearchParams(search);
  const route = { ...emptyRoute, memberId: query.get("member") ?? "" };
  if (path === "/chat") return { ...route, view: "doctor", chat: true };
  if (path === "/report") return { ...route, view: "doctor", sessionId: query.get("record") ?? "" };
  if (path === "/social" || path === "/settings" || path === "/home") return { ...route, view: path.slice(1) as View };
  const section = path?.match(/^\/health(?:\/(records|actions|trends))?$/)?.[1];
  if (path === "/health" || section) return { ...route, view: "health", section: (section || "records") as HealthSection, sourceId: query.get("source") ?? "", trendDays: query.get("days") === "90" ? 90 : 30 };
  return { ...emptyRoute };
}

export function routeHash(route: AppRoute) {
  const query = new URLSearchParams();
  if (route.memberId) query.set("member", route.memberId);
  const path = route.view === "doctor" && route.chat ? "/chat" : route.view === "doctor" || route.view === "result" ? "/report" : route.view === "health" ? `/health/${route.section}` : `/${route.view}`;
  if ((route.view === "doctor" || route.view === "result") && route.sessionId) query.set("record", route.sessionId);
  if (route.view === "health" && route.section === "actions" && route.sourceId) query.set("source", route.sourceId);
  if (route.view === "health" && route.section === "trends" && route.trendDays === 90) query.set("days", "90");
  return `#${path}${query.size ? `?${query}` : ""}`;
}

function readEntry(): Entry | undefined {
  const value = window.history.state?.[stateKey];
  return value && typeof value.key === "string" && typeof value.scroll === "number" ? value as Entry : undefined;
}
function writeEntry(entry: Entry, route: AppRoute, replace: boolean) {
  window.history[replace ? "replaceState" : "pushState"]({ ...window.history.state, [stateKey]: entry }, "", routeHash(route));
}

/** The URL contains identifiers only. Reports, drafts and connection credentials stay out of history. */
export function useAppNavigation() {
  const [state, setState] = useState(() => ({ route: readRoute(), entry: readEntry() ?? { key: newKey(), scroll: 0 } }));
  const current = useRef(state);
  current.current = state;
  const focusByEntry = useRef(new Map<string, HTMLElement>());
  const scrollByEntry = useRef(new Map<string, number>());
  const restore = useRef<{ scroll: number; focus?: HTMLElement; focusHeading: boolean } | null>({ scroll: state.entry.scroll, focusHeading: false });
  const savePosition = useCallback(() => {
    const snapshot = current.current;
    // An open modal fixes the body at its original page position.
    const scroll = document.body.style.position === "fixed" ? -(Number.parseFloat(document.body.style.top) || 0) : window.scrollY;
    const entry = { ...snapshot.entry, scroll };
    scrollByEntry.current.set(entry.key, scroll);
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) focusByEntry.current.set(entry.key, document.activeElement);
    window.history.replaceState({ ...window.history.state, [stateKey]: entry }, "");
    current.current = { ...snapshot, entry };
    return current.current;
  }, []);
  const navigate = useCallback((patch: Partial<AppRoute>, options: { replace?: boolean; preservePosition?: boolean } = {}) => {
    const previous = savePosition();
    const route = { ...previous.route, ...patch };
    if (patch.sessionId) route.chat = false;
    if (JSON.stringify(route) === JSON.stringify(previous.route)) return;
    const replace = Boolean(options.replace);
    const enteringReport = ["doctor", "result"].includes(route.view);
    const origin = enteringReport ? (["doctor", "result"].includes(previous.route.view) ? previous.entry.origin : previous.route) : undefined;
    const entry: Entry = replace ? { ...previous.entry, origin: origin ?? previous.entry.origin } : { key: newKey(), parent: previous.entry.key, origin, scroll: 0 };
    entry.scroll = options.preservePosition ? previous.entry.scroll : 0;
    writeEntry(entry, route, replace);
    scrollByEntry.current.set(entry.key, entry.scroll);
    restore.current = options.preservePosition ? null : { scroll: 0, focusHeading: previous.route.view !== route.view };
    current.current = { route, entry };
    setState(current.current);
  }, [savePosition]);
  const back = useCallback((fallback: Partial<AppRoute>) => {
    // A parent is recorded only when this app pushes an entry. Keep that
    // relationship across reloads instead of relying on an in-memory key set.
    if (current.current.entry.parent) {
      savePosition();
      window.history.back();
    } else navigate(fallback, { replace: true });
  }, [navigate, savePosition]);

  useEffect(() => {
    writeEntry(current.current.entry, current.current.route, true);
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    let scrollTimer: number | undefined;
    const onLocation = () => {
      const route = readRoute();
      const saved = readEntry() ?? { key: newKey(), scroll: 0 };
      const entry = { ...saved, scroll: scrollByEntry.current.get(saved.key) ?? saved.scroll };
      // popstate and hashchange can describe the same traversal.
      if (current.current.entry.key === entry.key && routeHash(current.current.route) === routeHash(route)) return;
      writeEntry(entry, route, true);
      restore.current = { scroll: entry.scroll, focus: focusByEntry.current.get(entry.key), focusHeading: true };
      current.current = { route, entry };
      setState(current.current);
    };
    const onScroll = () => {
      if (!restore.current && document.body.style.position !== "fixed") {
        scrollByEntry.current.set(current.current.entry.key, window.scrollY);
        // Keep fast scrolling in memory; avoid a history mutation for every pixel.
        if (scrollTimer === undefined) scrollTimer = window.setTimeout(() => {
          scrollTimer = undefined;
          if (restore.current || document.body.style.position === "fixed") return;
          const entry = { ...current.current.entry, scroll: scrollByEntry.current.get(current.current.entry.key) ?? window.scrollY };
          current.current = { ...current.current, entry };
          window.history.replaceState({ ...window.history.state, [stateKey]: entry }, "");
        }, 600);
      }
    };
    window.addEventListener("popstate", onLocation);
    window.addEventListener("hashchange", onLocation);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      window.clearTimeout(scrollTimer);
      window.history.scrollRestoration = previousRestoration;
      window.removeEventListener("popstate", onLocation);
      window.removeEventListener("hashchange", onLocation);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", savePosition);
    };
  }, [savePosition]);

  // Async records can grow the page after a refresh. Retry position restoration
  // while it grows, but stop as soon as the user starts scrolling or typing.
  useLayoutEffect(() => {
    const target = restore.current;
    if (!target) return;
    let focused = false;
    const apply = () => {
      if (!restore.current) return;
      document.documentElement.scrollTop = target.scroll;
      document.body.scrollTop = target.scroll;
      if (!focused) {
        const oldFocus = target.focus?.isConnected && !target.focus.closest("[hidden]") ? target.focus : null;
        const heading = [...document.querySelectorAll<HTMLElement>("main h1, main h2")].find(item => !item.closest("[hidden]")) ?? document.querySelector<HTMLElement>("main");
        const focus = oldFocus ?? (target.focusHeading ? heading : null);
        if (focus) { if (focus === heading) focus.tabIndex = -1; focus.focus({ preventScroll: true }); focused = true; }
      }
      if (document.documentElement.scrollHeight - window.innerHeight >= target.scroll) restore.current = null;
    };
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    if (observer) observer.observe(document.body);
    const stop = () => { restore.current = null; observer?.disconnect(); };
    const timeout = window.setTimeout(stop, 5000);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return () => { observer?.disconnect(); window.clearTimeout(timeout); window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); window.removeEventListener("keydown", stop); };
  }, [state]);

  return { route: state.route, entryKey: state.entry.key, origin: state.entry.origin, navigate, back };
}
