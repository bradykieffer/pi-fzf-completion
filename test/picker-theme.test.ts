import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  visibleWidth,
} from "@earendil-works/pi-tui";

import extension from "../extensions/fzf-completion.ts";

test("picker uses live theme colors and fits narrow terminals", async () => {
  let open!: (ctx: ExtensionContext) => void | Promise<void>;
  let start!: () => Promise<void>;
  let color = "\x1b[31m";
  const theme = {
    fg: (_token: string, text: string) => `${color}${text}\x1b[39m`,
  } as Theme;
  const provider = new CombinedAutocompleteProvider(
    [{ name: "settings" }],
    "/",
  );
  const ctx = {
    cwd: "/",
    ui: {
      getEditorText: () => "/set",
      addAutocompleteProvider: (wrap) => {
        wrap(provider);
      },
      custom: async (factory) => {
        const picker = await factory(
          { requestRender() {} } as never,
          theme,
          {} as never,
          () => {},
        );
        const before = picker.render(40);
        assert.ok(before[0].includes(color));
        assert.ok(before[1].includes(`${color}fzf> `));
        assert.ok(before[1].includes(`${color}t`));
        assert.ok(before.at(-1)?.includes(color));

        color = "\x1b[32m";
        picker.invalidate();
        const after = picker.render(40);
        assert.ok(after[1].includes(`${color}fzf> `));
        assert.ok(after.every((line) => !line.includes("\x1b[31m")));
        for (const width of [1, 4, 5, 6, 40]) {
          assert.ok(
            picker.render(width).every((line) => visibleWidth(line) <= width),
          );
        }
        return undefined as never;
      },
    } satisfies Partial<ExtensionContext["ui"]>,
  } as unknown as ExtensionContext;
  const api: Partial<ExtensionAPI> = {
    registerShortcut: (_key, shortcut) => {
      open = shortcut.handler;
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    on: (_event, handler) => {
      start = async () => {
        await handler({} as never, ctx);
      };
    },
  };
  extension(api as ExtensionAPI);
  await start();
  await open(ctx);
});
