import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

const primaryDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const secondaryDisplay = {
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  screen: {
    getAllDisplays: vi.fn(() => [primaryDisplay, secondaryDisplay]),
    getCursorScreenPoint: vi.fn(() => ({ x: 2400, y: 300 })),
    getDisplayNearestPoint: vi.fn(() => secondaryDisplay),
  },
}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as PopoutWindows from "./PopoutWindows.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const desktopEnvironmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const electronShellLayer = Layer.succeed(ElectronShell.ElectronShell, {
  openExternal: () => Effect.succeed(true),
  openSystemSettings: () => Effect.succeed(true),
  copyText: () => Effect.void,
} satisfies ElectronShell.ElectronShell["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

interface FakeWindow {
  readonly window: Electron.BrowserWindow;
  readonly listeners: Map<string, (...args: readonly unknown[]) => void>;
  readonly webContentsListeners: Map<string, (...args: readonly unknown[]) => void>;
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn>;
  readonly title: ReturnType<typeof vi.fn>;
  readonly shown: ReturnType<typeof vi.fn>;
  readonly focused: ReturnType<typeof vi.fn>;
  readonly closed: ReturnType<typeof vi.fn>;
  readonly loaded: string[];
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

function makeFakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let destroyed = false;
  const shown = vi.fn();
  const focused = vi.fn();
  const closed = vi.fn();
  const title = vi.fn();
  const setBackgroundThrottling = vi.fn();
  const loaded: string[] = [];

  const webContents = {
    id: 100 + id,
    setBackgroundThrottling,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(event, listener);
    }),
    send: vi.fn(),
  };

  const window = {
    id,
    webContents,
    isDestroyed: vi.fn(() => destroyed),
    loadURL: vi.fn((url: string) => {
      loaded.push(url);
      return Promise.resolve();
    }),
    show: shown,
    focus: focused,
    close: vi.fn(() => {
      closed();
      listeners.get("closed")?.();
    }),
    setTitle: title,
    getNormalBounds: vi.fn(() => bounds),
    getBounds: vi.fn(() => bounds),
    on: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    once: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      listeners.set(event, listener);
    }),
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    get options() {
      return null;
    },
    listeners,
    webContentsListeners,
    setBackgroundThrottling,
    title,
    shown,
    focused,
    closed,
    loaded,
    setBounds: (next) => {
      bounds = next;
    },
  };
}

function makeTestLayer(input: {
  readonly settings?: DesktopAppSettings.DesktopSettings;
  readonly sentMessages?: { channel: string; args: readonly unknown[] }[];
}) {
  const created: {
    options: Electron.BrowserWindowConstructorOptions;
    fake: FakeWindow;
  }[] = [];
  let nextId = 1;

  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        const fake = makeFakeWindow(nextId++);
        fake.setBounds({
          x: options.x ?? 0,
          y: options.y ?? 0,
          width: options.width ?? 0,
          height: options.height ?? 0,
        });
        created.push({ options, fake });
        return fake.window;
      }),
    main: Effect.succeed(Option.none<Electron.BrowserWindow>()),
    currentMainOrFirst: Effect.succeed(Option.none<Electron.BrowserWindow>()),
    focusedMainOrFirst: Effect.succeed(Option.none<Electron.BrowserWindow>()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        input.sentMessages?.push({ channel, args });
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const layer = PopoutWindows.layer.pipe(
    // Merged rather than provided so the test can read the settings this
    // service writes; the rest stay private to the layer.
    Layer.provideMerge(DesktopAppSettings.layerTest(input.settings)),
    Layer.provide(
      Layer.mergeAll(
        desktopEnvironmentLayer,
        electronShellLayer,
        electronThemeLayer,
        electronWindowLayer,
        Layer.mock(PreviewManager.PreviewManager)({
          addHostWindow: () => Effect.void,
          removeHostWindow: () => Effect.void,
        }),
      ),
    ),
  );

  return { layer, created };
}

const applicationUrl = "t3code-dev://app/thread?popout=browser%3Atab_1";

describe("resolvePopoutWindowBounds", () => {
  it("restores remembered placement while it still lands on a connected display", () => {
    const remembered = { x: 2100, y: 120, width: 900, height: 700 };

    assert.deepEqual(
      PopoutWindows.resolvePopoutWindowBounds({
        persisted: remembered,
        displays: [primaryDisplay.bounds, secondaryDisplay.bounds],
        cursorDisplay: secondaryDisplay.workArea,
      }),
      remembered,
    );
  });

  it("drops remembered placement that no longer fits a display", () => {
    const onUnpluggedDisplay = { x: 4100, y: 120, width: 900, height: 700 };

    const bounds = PopoutWindows.resolvePopoutWindowBounds({
      persisted: onUnpluggedDisplay,
      displays: [primaryDisplay.bounds],
      cursorDisplay: primaryDisplay.workArea,
    });

    assert.notDeepEqual(bounds, onUnpluggedDisplay);
    assert.equal(bounds.width, PopoutWindows.DEFAULT_POPOUT_WINDOW_SIZE.width);
    const x = bounds.x ?? 0;
    const width = bounds.width ?? 0;
    assert.isTrue(x >= primaryDisplay.bounds.x);
    assert.isTrue(x + width <= primaryDisplay.bounds.x + primaryDisplay.bounds.width);
  });

  it("centers a new popout on the display the cursor is on", () => {
    const bounds = PopoutWindows.resolvePopoutWindowBounds({
      persisted: null,
      displays: [primaryDisplay.bounds, secondaryDisplay.bounds],
      cursorDisplay: secondaryDisplay.workArea,
    });

    assert.equal(bounds.width, PopoutWindows.DEFAULT_POPOUT_WINDOW_SIZE.width);
    assert.equal(bounds.height, PopoutWindows.DEFAULT_POPOUT_WINDOW_SIZE.height);
    assert.equal(bounds.x, 1920 + Math.round((2560 - 760) / 2));
    assert.equal(bounds.y, Math.round((1400 - 560) / 2));
  });

  it("clamps the window to a display smaller than the default size", () => {
    const smallDisplay = { x: 0, y: 0, width: 400, height: 320 };

    const bounds = PopoutWindows.resolvePopoutWindowBounds({
      persisted: null,
      displays: [smallDisplay],
      cursorDisplay: smallDisplay,
    });

    assert.equal(bounds.width, smallDisplay.width - 80);
    assert.equal(bounds.height, smallDisplay.height - 80);
  });

  it("keeps the default size when no display is readable", () => {
    assert.deepEqual(
      PopoutWindows.resolvePopoutWindowBounds({
        persisted: null,
        displays: [],
        cursorDisplay: null,
      }),
      { ...PopoutWindows.DEFAULT_POPOUT_WINDOW_SIZE },
    );
  });
});

describe("isApplicationPopoutUrl", () => {
  it("accepts only the application origin", () => {
    assert.isTrue(
      PopoutWindows.isApplicationPopoutUrl({
        applicationUrl: "t3code-dev://app/",
        popoutUrl: applicationUrl,
      }),
    );
    assert.isFalse(
      PopoutWindows.isApplicationPopoutUrl({
        applicationUrl: "t3code-dev://app/",
        popoutUrl: "https://example.com/",
      }),
    );
    assert.isFalse(
      PopoutWindows.isApplicationPopoutUrl({
        applicationUrl: "t3code-dev://app/",
        popoutUrl: "not a url",
      }),
    );
  });
});

describe("normalizePopoutKind", () => {
  it("keeps panel kinds usable as settings keys", () => {
    assert.equal(PopoutWindows.normalizePopoutKind("preview"), "preview");
    assert.equal(PopoutWindows.normalizePopoutKind("pull-request"), "pull-request");
    assert.equal(PopoutWindows.normalizePopoutKind("../../etc/passwd"), "etcpasswd");
    assert.equal(PopoutWindows.normalizePopoutKind(""), "panel");
  });
});

describe("PopoutWindows", () => {
  it.effect("opens a window at the given URL and reports its key", () => {
    const sent: { channel: string; args: readonly unknown[] }[] = [];
    const { layer, created } = makeTestLayer({ sentMessages: sent });

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      yield* popout.open({
        key: "browser:tab_1",
        kind: "preview",
        title: "Preview",
        url: applicationUrl,
      });

      assert.equal(created.length, 1);
      assert.equal(created[0]!.fake.loaded[0], applicationUrl);
      assert.equal(created[0]!.options.title, "Preview");
      assert.equal(created[0]!.options.show, false);
      assert.equal(created[0]!.options.width, PopoutWindows.DEFAULT_POPOUT_WINDOW_SIZE.width);
      assert.equal(created[0]!.options.webPreferences?.sandbox, true);
      assert.equal(created[0]!.options.webPreferences?.contextIsolation, true);
      assert.deepEqual(yield* popout.keys, ["browser:tab_1"]);
      assert.isTrue(sent.some((message) => message.channel === "desktop:popout-window-keys"));

      // The window reveals itself and stops being throttled once it has painted.
      created[0]!.fake.listeners.get("ready-to-show")?.();
      assert.equal(created[0]!.fake.shown.mock.calls.length, 1);
      assert.equal(created[0]!.fake.setBackgroundThrottling.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("brings an existing popout forward instead of opening a second window", () => {
    const { layer, created } = makeTestLayer({});

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      const input = {
        key: "diff",
        kind: "diff",
        title: "Diff",
        url: "t3code-dev://app/thread?popout=diff",
      };
      yield* popout.open(input);
      yield* popout.open(input);

      assert.equal(created.length, 1);
      assert.equal(created[0]!.fake.focused.mock.calls.length, 1);
      assert.deepEqual(yield* popout.keys, ["diff"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to load anything but the application origin", () => {
    const { layer, created } = makeTestLayer({});

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      const error = yield* Effect.flip(
        popout.open({
          key: "diff",
          kind: "diff",
          title: "Diff",
          url: "https://example.com/",
        }),
      );

      assert.equal(error.operation, "open");
      assert.equal(created.length, 0);
      assert.deepEqual(yield* popout.keys, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("remembers placement per panel kind after a move", () => {
    const { layer, created } = makeTestLayer({});

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* popout.open({
        key: "browser:tab_1",
        kind: "preview",
        title: "Preview",
        url: applicationUrl,
      });
      created[0]!.fake.setBounds({ x: 2000, y: 100, width: 800, height: 600 });
      created[0]!.fake.listeners.get("move")?.();

      // The write is debounced; the window closing flushes what is pending.
      yield* popout.close("browser:tab_1");

      const persisted = (yield* settings.get).popoutWindowBounds["preview"];
      assert.deepEqual(persisted, { x: 2000, y: 100, width: 800, height: 600 });
      assert.equal(created[0]!.fake.closed.mock.calls.length, 1);
      assert.deepEqual(yield* popout.keys, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("closes every popout", () => {
    const { layer, created } = makeTestLayer({});

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      yield* popout.open({
        key: "browser:tab_1",
        kind: "preview",
        title: "Preview",
        url: applicationUrl,
      });
      yield* popout.open({
        key: "diff",
        kind: "diff",
        title: "Diff",
        url: "t3code-dev://app/thread?popout=diff",
      });

      yield* popout.closeAll;

      assert.equal(created.length, 2);
      for (const entry of created) {
        assert.equal(entry.fake.closed.mock.calls.length, 1);
      }
      assert.deepEqual(yield* popout.keys, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("forgets a popout the user closed", () => {
    const { layer, created } = makeTestLayer({});

    return Effect.gen(function* () {
      const popout = yield* PopoutWindows.PopoutWindows;
      yield* popout.open({
        key: "browser:tab_1",
        kind: "preview",
        title: "Preview",
        url: applicationUrl,
      });

      created[0]!.fake.listeners.get("closed")?.();

      // Electron's close event reaches the service outside this test's fiber,
      // so the release is awaited rather than asserted synchronously. A real
      // timer, because `it.effect` runs on a virtual clock.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          }),
      );
      assert.deepEqual(yield* popout.keys, []);
    }).pipe(Effect.provide(layer));
  });
});
