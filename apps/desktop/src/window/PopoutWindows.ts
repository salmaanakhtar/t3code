import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import type { DesktopPopoutWindowInput } from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { POPOUT_WINDOW_KEYS_CHANNEL } from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

/**
 * Panels moved out of the main window into windows of their own.
 *
 * The renderer owns what a window shows: it hands us the app URL it already
 * routes for that panel (a `popout` search parameter tells the renderer to
 * render the panel alone), so this service owns only the OS-level half — the
 * window, where it sits, and remembering that placement per panel kind so the
 * next popout of the same kind reopens on the same monitor.
 *
 * Deliberately not modelled on the preview picture-in-picture window, which
 * mirrors one guest as JPEG frames. A popout hosts the real app window, which
 * is what makes it work for every panel kind.
 */

const BOUNDS_PERSIST_DEBOUNCE_MS = 500;

export const DEFAULT_POPOUT_WINDOW_SIZE = { width: 760, height: 560 } as const;

export type PopoutWindowRect = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

interface PopoutWindowSession {
  readonly window: Electron.BrowserWindow;
  readonly kind: string;
  boundsFiber: Fiber.Fiber<void, never> | undefined;
}

export class PopoutWindowError extends Schema.TaggedError<PopoutWindowError>()(
  "PopoutWindowError",
  {
    operation: Schema.Literals(["open", "close", "create", "load"]),
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop popout window ${this.operation} failed for ${JSON.stringify(this.key)}.`;
  }
}

export class PopoutWindows extends Context.Service<
  PopoutWindows,
  {
    readonly open: (input: DesktopPopoutWindowInput) => Effect.Effect<void, PopoutWindowError>;
    readonly close: (key: string) => Effect.Effect<void>;
    readonly closeAll: Effect.Effect<void>;
    readonly keys: Effect.Effect<readonly string[]>;
  }
>()("@t3tools/desktop/window/PopoutWindows") {}

type PopoutWindowsRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAppSettings.DesktopAppSettings
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | PreviewManager.PreviewManager;

const { logWarning: logWindowWarning } = makeComponentLogger("desktop-popout-window");

function rectFitsWithinDisplay(rect: PopoutWindowRect, display: PopoutWindowRect): boolean {
  return (
    rect.x >= display.x &&
    rect.y >= display.y &&
    rect.x + rect.width <= display.x + display.width &&
    rect.y + rect.height <= display.y + display.height
  );
}

/**
 * Placement for a popout window.
 *
 * A remembered rect wins only while it still lands on a connected display — an
 * unplugged monitor must not strand the window off-screen. With nothing
 * remembered (or nothing usable) the window opens centered on the display the
 * cursor is on, so the panel appears where the user is looking, and its size is
 * clamped to that display so a small screen cannot push it off the edges.
 */
export function resolvePopoutWindowBounds(input: {
  readonly persisted: DesktopAppSettings.DesktopPopoutWindowBounds | null;
  readonly displays: readonly PopoutWindowRect[];
  readonly cursorDisplay: PopoutWindowRect | null;
}): Partial<PopoutWindowRect> {
  const { persisted, cursorDisplay, displays } = input;
  if (persisted !== null && displays.some((display) => rectFitsWithinDisplay(persisted, display))) {
    return persisted;
  }

  const target = cursorDisplay ?? (displays.length === 1 ? (displays[0] ?? null) : null);
  if (target === null) {
    // No display to center on: let Chromium place it, keeping our default size.
    return { ...DEFAULT_POPOUT_WINDOW_SIZE };
  }

  const width = Math.max(
    DesktopAppSettings.MIN_POPOUT_WINDOW_SIZE.width,
    Math.min(DEFAULT_POPOUT_WINDOW_SIZE.width, target.width - 80),
  );
  const height = Math.max(
    DesktopAppSettings.MIN_POPOUT_WINDOW_SIZE.height,
    Math.min(DEFAULT_POPOUT_WINDOW_SIZE.height, target.height - 80),
  );
  return {
    x: Math.round(target.x + (target.width - width) / 2),
    y: Math.round(target.y + (target.height - height) / 2),
    width,
    height,
  };
}

/**
 * A popout loads the app with the app's own preload, so its URL must stay on
 * the application origin — never a URL panel content could influence.
 */
export function isApplicationPopoutUrl(input: {
  readonly applicationUrl: string;
  readonly popoutUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.popoutUrl).origin;
  } catch {
    return false;
  }
}

/** Keeps a renderer-supplied panel kind usable as a settings key. */
export function normalizePopoutKind(rawKind: string): string {
  return rawKind.replace(/[^a-z0-9-]/gi, "").slice(0, 32) || "panel";
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const context = yield* Effect.context<PopoutWindowsRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const sessions = new Map<string, PopoutWindowSession>();
  const applicationUrl = getDesktopUrl(environment.isDevelopment);

  const attempt = (operation: PopoutWindowError["operation"], key: string, run: () => unknown) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        new PopoutWindowError({
          operation,
          key,
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
    });

  const readDisplayRects = (): readonly PopoutWindowRect[] => {
    try {
      return Electron.screen.getAllDisplays().map((display) => display.bounds);
    } catch {
      return [];
    }
  };

  // The work area, not the full bounds: a window centered in the strip a dock or
  // taskbar reserves would open behind it.
  const readCursorDisplayRect = (): PopoutWindowRect | null => {
    try {
      const point = Electron.screen.getCursorScreenPoint();
      return Electron.screen.getDisplayNearestPoint(point).workArea;
    } catch {
      return null;
    }
  };

  const openExternalUrl = (url: string) => {
    if (Option.isNone(ElectronShell.parseSafeExternalUrl(url))) return;
    runFork(electronShell.openExternal(url).pipe(Effect.ignore));
  };

  const broadcastKeys = () =>
    electronWindow
      .sendAll(POPOUT_WINDOW_KEYS_CHANNEL, Array.from(sessions.keys()))
      .pipe(Effect.ignore);

  const persistBounds = (key: string, session: PopoutWindowSession) =>
    Effect.gen(function* () {
      if (session.window.isDestroyed()) return;
      const raw = session.window.getNormalBounds();
      const bounds = DesktopAppSettings.normalizePopoutWindowBounds({
        x: Math.round(raw.x),
        y: Math.round(raw.y),
        width: Math.round(raw.width),
        height: Math.round(raw.height),
      });
      if (bounds === null) return;
      yield* desktopSettings.setPopoutWindowBounds(session.kind, bounds).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          logWindowWarning("failed to persist popout window bounds", {
            key,
            message: error.message,
          }),
        ),
      );
    });

  const flushBoundsPersist = (key: string, session: PopoutWindowSession) =>
    Effect.gen(function* () {
      if (session.boundsFiber === undefined) return;
      const fiber = session.boundsFiber;
      session.boundsFiber = undefined;
      yield* Fiber.interrupt(fiber);
      yield* persistBounds(key, session);
    });

  const scheduleBoundsPersist = (key: string, session: PopoutWindowSession) => {
    if (session.boundsFiber !== undefined) {
      const fiber = session.boundsFiber;
      session.boundsFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    }
    session.boundsFiber = runFork(
      Effect.sleep(BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            session.boundsFiber = undefined;
            return persistBounds(key, session);
          }),
        ),
      ),
    );
  };

  const forgetSession = (key: string, session: PopoutWindowSession, closeWindow: boolean) =>
    Effect.gen(function* () {
      if (sessions.get(key) !== session) return;
      yield* flushBoundsPersist(key, session);
      sessions.delete(key);
      yield* previewManager.removeHostWindow(session.window).pipe(Effect.ignore);
      if (closeWindow && !session.window.isDestroyed()) {
        yield* attempt("close", key, () => session.window.close()).pipe(Effect.ignore);
      }
      yield* broadcastKeys();
    });

  const closeAll = Effect.gen(function* () {
    const entries = Array.from(sessions.entries());
    for (const [key, session] of entries) {
      yield* forgetSession(key, session, true);
    }
  });

  const open = Effect.fn("desktop.popout.open")(function* (input: DesktopPopoutWindowInput) {
    const existing = sessions.get(input.key);
    if (existing !== undefined) {
      if (existing.window.isDestroyed()) {
        yield* forgetSession(input.key, existing, false);
      } else {
        // Already popped out: bring it forward instead of opening a second one.
        yield* attempt("open", input.key, () => {
          existing.window.show();
          existing.window.focus();
        }).pipe(Effect.ignore);
        return;
      }
    }

    if (!isApplicationPopoutUrl({ applicationUrl, popoutUrl: input.url })) {
      return yield* new PopoutWindowError({
        operation: "open",
        key: input.key,
        cause: new Error(
          `Refusing to open a popout window for a non-application URL: ${input.url}`,
        ),
      });
    }

    const kind = normalizePopoutKind(input.kind);
    const settings = yield* desktopSettings.get;
    const bounds = resolvePopoutWindowBounds({
      persisted: settings.popoutWindowBounds[kind] ?? null,
      displays: readDisplayRects(),
      cursorDisplay: readCursorDisplayRect(),
    });
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;

    const window = yield* electronWindow
      .create({
        ...bounds,
        minWidth: DesktopAppSettings.MIN_POPOUT_WINDOW_SIZE.width,
        minHeight: DesktopAppSettings.MIN_POPOUT_WINDOW_SIZE.height,
        show: false,
        autoHideMenuBar: true,
        title: input.title,
        backgroundColor: shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
        webPreferences: {
          preload: environment.preloadPath,
          // The window boots hidden and Chromium throttles hidden renderers,
          // which stalls the panel's first paint. Boot unthrottled, then hand
          // the window back to normal throttling once it has been shown.
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: true,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PopoutWindowError({
              operation: "create",
              key: input.key,
              cause: cause instanceof Error ? cause : new Error(String(cause)),
            }),
        ),
      );

    const session: PopoutWindowSession = { window, kind, boundsFiber: undefined };
    sessions.set(input.key, session);

    // A popped-out panel is not a browser: keep external links external, and
    // never let panel content navigate this window off the application origin.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isApplicationPopoutUrl({ applicationUrl, popoutUrl: url })) return;
      event.preventDefault();
      openExternalUrl(url);
    });
    // The same hardening the main window applies to embedded guests: a popout
    // is another place a webview can attach, and it must be a preview partition
    // keeping the preferences the preview flow depends on.
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      if (!window.isDestroyed()) window.setTitle(input.title);
    });

    window.once("ready-to-show", () => {
      if (window.isDestroyed()) return;
      window.webContents.setBackgroundThrottling(true);
      window.show();
    });

    window.on("resize", () => scheduleBoundsPersist(input.key, session));
    window.on("move", () => scheduleBoundsPersist(input.key, session));
    window.on("closed", () => {
      void runPromise(forgetSession(input.key, session, false));
    });

    // A preview guest hosted here must be accepted by the preview manager, which
    // otherwise only trusts guests inside the main window.
    yield* previewManager.addHostWindow(window);
    yield* broadcastKeys();

    yield* attempt("load", input.key, () => {
      void window.loadURL(input.url).catch((cause: unknown) => {
        void runPromise(
          logWindowWarning("popout window failed to load", {
            key: input.key,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      });
    });
  });

  const close = (key: string) =>
    Effect.gen(function* () {
      const session = sessions.get(key);
      if (session === undefined) return;
      yield* forgetSession(key, session, true);
    });

  return PopoutWindows.of({
    open,
    close,
    closeAll,
    keys: Effect.sync(() => Array.from(sessions.keys())),
  });
});

export const layer = Layer.effect(PopoutWindows, make);
