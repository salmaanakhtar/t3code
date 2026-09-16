import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { isElectron } from "./env";
import { POPOUT_KEY_PARAM, POPOUT_KIND_PARAM, POPOUT_SURFACE_PARAM } from "./popoutParams";
import { useRightPanelStore, type RightPanelSurface } from "./rightPanelStore";

/**
 * Panels moved out of this window into a window of their own.
 *
 * A popout window is the app itself, loaded at the URL this window already
 * routes for the panel, plus three search parameters: which surface to render
 * (`popout`), which panel kind it is (`popoutKind`, so the desktop shell can
 * remember placement per kind), and the surface payload itself so the fresh
 * renderer can rebuild it. The renderer owns the handover; the desktop shell
 * only owns the OS window.
 *
 * Two runtimes: under Electron the desktop shell opens a real OS window and
 * reports the open keys back, so a panel moves back in when its window closes.
 * In a plain browser (and on remote web) the same URL opens through
 * `window.open` — no OS window, but the same move-in, move-out behavior.
 *
 * A moved panel is moved, not mirrored: it leaves this window's panel store,
 * which is what keeps one preview guest to one window.
 */

export interface PopoutWindowRequest {
  /** The surface id, which doubles as the popout's identity. */
  readonly key: string;
  /** Panel kind, used for placement memory on the desktop shell side. */
  readonly kind: string;
  readonly encodedSurface: string | null;
}

interface MovedSurface {
  readonly ref: ScopedThreadRef;
  readonly surface: RightPanelSurface;
}

/** Surfaces this window handed to a popout and expects back. */
const movedSurfaces = new Map<string, MovedSurface>();
/** Popout keys the desktop shell reports; survives a renderer reload. */
let shellOpenKeys: ReadonlySet<string> = new Set();
/** Browser fallback: the windows this renderer opened itself. */
const browserPopoutWindows = new Map<string, Window>();
let browserPollTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
// Cached so `useSyncExternalStore` sees a stable snapshot between changes.
let openKeysSnapshot: ReadonlySet<string> = new Set();

function refreshOpenKeys(): void {
  // A popout window is itself a moved panel: without counting its own key the
  // window would offer to pop that panel out again instead of moving it back.
  const ownRequest = readPopoutWindowRequest();
  openKeysSnapshot = new Set([
    ...shellOpenKeys,
    ...browserPopoutWindows.keys(),
    ...movedSurfaces.keys(),
    ...(ownRequest === null ? [] : [ownRequest.key]),
  ]);
  for (const listener of listeners) listener();
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodePopoutSurface(surface: RightPanelSurface): string {
  return base64UrlEncode(JSON.stringify(surface));
}

/**
 * The payload is written by this app into its own window URL, so it is trusted
 * as far as shape goes — but a hand-edited or truncated URL must not crash the
 * panel, hence the minimum-structure check.
 */
export function decodePopoutSurface(encoded: string | null): RightPanelSurface | null {
  if (encoded === null || encoded.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(encoded));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { readonly id?: unknown; readonly kind?: unknown };
    if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
    if (typeof candidate.kind !== "string" || candidate.kind.length === 0) return null;
    return parsed as RightPanelSurface;
  } catch {
    return null;
  }
}

export function readPopoutWindowRequest(search?: string): PopoutWindowRequest | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(search ?? window.location.search);
  const key = params.get(POPOUT_KEY_PARAM);
  const kind = params.get(POPOUT_KIND_PARAM);
  if (key === null || key.length === 0 || kind === null || kind.length === 0) return null;
  return { key, kind, encodedSurface: params.get(POPOUT_SURFACE_PARAM) };
}

export function isPopoutWindow(): boolean {
  return readPopoutWindowRequest() !== null;
}

export function buildPopoutUrl(input: {
  readonly href: string;
  readonly key: string;
  readonly kind: string;
  readonly surface: RightPanelSurface;
}): string {
  const url = new URL(input.href);
  url.searchParams.set(POPOUT_KEY_PARAM, input.key);
  url.searchParams.set(POPOUT_KIND_PARAM, input.kind);
  url.searchParams.set(POPOUT_SURFACE_PARAM, encodePopoutSurface(input.surface));
  return url.toString();
}

function restoreMovedSurface(key: string): void {
  const moved = movedSurfaces.get(key);
  if (moved === undefined) return;
  movedSurfaces.delete(key);
  useRightPanelStore.getState().restoreSurface(moved.ref, moved.surface);
}

function applyShellOpenKeys(next: ReadonlySet<string>): void {
  const previous = openKeysSnapshot;
  shellOpenKeys = next;
  refreshOpenKeys();
  for (const key of previous) {
    // A popout that is gone hands its panel back, whichever way it closed: the
    // "move back" control, the window's own close button, or a crash.
    if (!next.has(key)) restoreMovedSurface(key);
  }
}

function startBrowserPopoutPoll(): void {
  if (browserPollTimer !== null) return;
  browserPollTimer = setInterval(() => {
    let closedWindows = false;
    for (const [key, window] of browserPopoutWindows) {
      if (!window.closed) continue;
      browserPopoutWindows.delete(key);
      closedWindows = true;
      restoreMovedSurface(key);
    }
    if (browserPopoutWindows.size === 0 && browserPollTimer !== null) {
      clearInterval(browserPollTimer);
      browserPollTimer = null;
    }
    if (closedWindows) refreshOpenKeys();
  }, 1_000);
}

let shellSubscription: (() => void) | null = null;

function ensureShellSubscription(): void {
  if (!isElectron || shellSubscription !== null) return;
  const bridge = window.desktopBridge?.popout;
  if (bridge === undefined) return;
  shellSubscription = bridge.onWindowsChange((keys) => applyShellOpenKeys(new Set(keys)));
  // Windows opened before this renderer booted: a reload leaves popouts alive,
  // and this window still has to know not to render their panels.
  void bridge
    .list()
    .then((keys) => applyShellOpenKeys(new Set(keys)))
    .catch(() => undefined);
}

export function subscribePopoutKeys(listener: () => void): () => void {
  ensureShellSubscription();
  listeners.add(listener);
  refreshOpenKeys();
  return () => {
    listeners.delete(listener);
  };
}

/** Surface ids currently living in a popout window. */
export function getOpenPopoutKeys(): ReadonlySet<string> {
  return openKeysSnapshot;
}

export function useOpenPopoutKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribePopoutKeys, getOpenPopoutKeys, getOpenPopoutKeys);
}

/** This window's popout request, when it is itself a popout window. */
export function usePopoutRequest(): PopoutWindowRequest | null {
  return useMemo(() => readPopoutWindowRequest(), []);
}

/** Moves a panel into its own window. Resolves once the window exists. */
export async function openPanelPopout(input: {
  readonly ref: ScopedThreadRef;
  readonly surface: RightPanelSurface;
  readonly title: string;
}): Promise<void> {
  const key = input.surface.id;
  const kind = input.surface.kind;
  const url = buildPopoutUrl({
    href: window.location.href,
    key,
    kind,
    surface: input.surface,
  });
  movedSurfaces.set(key, { ref: input.ref, surface: input.surface });
  refreshOpenKeys();

  const leaveThisWindow = () => {
    useRightPanelStore.getState().closeSurface(input.ref, key);
  };

  if (!isElectron) {
    // Not awaited before the open call, so the popup still counts as a user
    // gesture rather than being blocked.
    const opened = window.open(url, `t3code-popout-${key}`, "popup,width=760,height=560");
    if (opened === null) {
      movedSurfaces.delete(key);
      refreshOpenKeys();
      throw new Error("The browser blocked this popout window.");
    }
    browserPopoutWindows.set(key, opened);
    startBrowserPopoutPoll();
    refreshOpenKeys();
    leaveThisWindow();
    return;
  }

  const bridge = window.desktopBridge?.popout;
  if (bridge === undefined) {
    movedSurfaces.delete(key);
    refreshOpenKeys();
    throw new Error("This desktop build cannot move panels into their own window.");
  }
  try {
    await bridge.open({ key, kind, title: input.title, url });
  } catch (error) {
    movedSurfaces.delete(key);
    refreshOpenKeys();
    throw error instanceof Error ? error : new Error(String(error));
  }
  leaveThisWindow();
}

/** Moves a panel back out of its popout window. */
export async function closePanelPopout(key: string): Promise<void> {
  const bridge = window.desktopBridge?.popout;
  if (bridge === undefined) {
    window.close();
    return;
  }
  await bridge.close(key);
}
