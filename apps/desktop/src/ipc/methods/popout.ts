import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DesktopPopoutWindowCloseInputSchema,
  DesktopPopoutWindowInputSchema,
} from "@t3tools/contracts";

import * as PopoutWindows from "../../window/PopoutWindows.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const openPopoutWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.POPOUT_WINDOW_OPEN_CHANNEL,
  payload: DesktopPopoutWindowInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.popout.open")(function* (input) {
    const popoutWindows = yield* PopoutWindows.PopoutWindows;
    yield* popoutWindows.open(input);
  }),
});

export const closePopoutWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.POPOUT_WINDOW_CLOSE_CHANNEL,
  payload: DesktopPopoutWindowCloseInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.popout.close")(function* ({ key }) {
    const popoutWindows = yield* PopoutWindows.PopoutWindows;
    yield* popoutWindows.close(key);
  }),
});

export const listPopoutWindows = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.POPOUT_WINDOW_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.popout.list")(function* () {
    const popoutWindows = yield* PopoutWindows.PopoutWindows;
    return yield* popoutWindows.keys;
  }),
});

export const methods = [openPopoutWindow, closePopoutWindow, listPopoutWindows] as const;
