import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DynamicBorder,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  SelectList,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

type CompletionSnapshot = {
  provider: AutocompleteProvider;
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  suggestions: AutocompleteSuggestions;
};

type PathSource = { items: AutocompleteItem[]; query: string };
type ParsedPath = {
  directory: string;
  displayBase: string;
  query: string;
  quoted: boolean;
};
type FzfIndex = { items: AutocompleteItem[]; input: Buffer };
type CachedPaths = {
  paths: string[];
  refreshedAt: number;
  refresh?: Promise<void>;
};

// ponytail: bounded buffering; stream fd into a persistent matcher if 100k paths is too small.
const MAX_PATHS = 100_000;
const MAX_MATCHES = 1_000;
const MAX_CACHED_DIRECTORIES = 16;
const PATH_CACHE_TTL_MS = 1_000;
const pathCache = new Map<string, CachedPaths>();
const pathItemsCache = new WeakMap<string[], Map<string, AutocompleteItem[]>>();
const fzfIndexCache = new WeakMap<AutocompleteItem[], FzfIndex>();

async function scanPaths(
  directory: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);

    const child = spawn(
      "fd",
      [
        "--base-directory",
        directory,
        "--type",
        "f",
        "--type",
        "d",
        "--color",
        "never",
        "--max-results",
        String(MAX_PATHS),
        ".",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    let settled = false;
    const finish = (paths?: string[]): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(paths);
    };
    const abort = (): void => {
      child.kill();
      finish();
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.on("error", () => finish());
    child.on("close", (code) => {
      if (code !== 0 || signal?.aborted) return finish();
      const paths = output.split("\n");
      if (paths.at(-1) === "") paths.pop();
      finish(paths);
    });
  });
}

async function walkPaths(
  directory: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (signal?.aborted) return undefined;

  const cached = pathCache.get(directory);
  if (cached) {
    pathCache.delete(directory);
    pathCache.set(directory, cached);
    if (
      Date.now() - cached.refreshedAt > PATH_CACHE_TTL_MS &&
      !cached.refresh
    ) {
      cached.refresh = scanPaths(directory)
        .then((paths) => {
          if (paths) cachePaths(directory, paths);
        })
        .finally(() => {
          delete cached.refresh;
        });
    }
    return cached.paths;
  }

  const paths = await scanPaths(directory, signal);
  if (paths) cachePaths(directory, paths);
  return paths;
}

export async function readPathSource(
  prefix: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<PathSource | undefined> {
  const parsed = parsePath(prefix, cwd);
  if (!parsed) return undefined;

  const { directory, displayBase, query, quoted } = parsed;
  const paths = await walkPaths(directory, signal);
  if (!paths) return undefined;

  const cacheKey = `${quoted ? "quoted" : "plain"}:${displayBase}`;
  let items = pathItemsCache.get(paths)?.get(cacheKey);
  if (!items) {
    items = paths.map((relativePath) => {
      const path = `${displayBase}${relativePath}`;
      return {
        value: quoted || path.includes(" ") ? `@"${path}"` : `@${path}`,
        label: relativePath,
      };
    });
    const cache =
      pathItemsCache.get(paths) ?? new Map<string, AutocompleteItem[]>();
    cache.set(cacheKey, items);
    pathItemsCache.set(paths, cache);
  }
  return { query, items };
}

function searchableItem(item: AutocompleteItem, index: number): string {
  const clean = (value: string): string => value.replace(/[\t\r\n]/g, " ");
  return [index, clean(item.label), clean(item.description ?? "")].join("\t");
}

function indexForFzf(items: AutocompleteItem[]): FzfIndex {
  let index = fzfIndexCache.get(items);
  if (!index) {
    index = { items, input: Buffer.from(items.map(searchableItem).join("\n")) };
    fzfIndexCache.set(items, index);
  }
  return index;
}

export async function rankWithFzf(
  itemsOrIndex: AutocompleteItem[] | FzfIndex,
  query: string,
  signal?: AbortSignal,
): Promise<AutocompleteItem[] | undefined> {
  const index = Array.isArray(itemsOrIndex)
    ? indexForFzf(itemsOrIndex)
    : itemsOrIndex;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }

    const child = spawn(
      "fzf",
      ["--filter", query, "--delimiter", "\t", "--nth", "2.."],
      {
        env: { ...process.env, FZF_DEFAULT_OPTS: "" },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = "";
    const matches: AutocompleteItem[] = [];
    let settled = false;
    const finish = (result: AutocompleteItem[] | undefined): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill();
      finish(undefined);
    };

    signal?.addEventListener("abort", abort, { once: true });
    const collect = (lines: string[]): void => {
      matches.push(
        ...lines
          .slice(0, MAX_MATCHES - matches.length)
          .map((line) => index.items[Number.parseInt(line, 10)])
          .filter((item): item is AutocompleteItem => item !== undefined),
      );
      if (matches.length === MAX_MATCHES) {
        child.kill();
        finish(matches);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = `${output}${chunk}`.split("\n");
      output = lines.pop() ?? "";
      collect(lines);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (
        signal?.aborted ||
        (code !== 0 && code !== 1 && matches.length < MAX_MATCHES)
      ) {
        finish(undefined);
        return;
      }
      if (output) collect([output]);
      finish(matches);
    });
    child.stdin.end(index.input);
  });
}

export async function readCompletionSnapshot(
  provider: AutocompleteProvider,
  text: string,
  signal: AbortSignal,
): Promise<CompletionSnapshot | undefined> {
  const lines = text.split("\n");
  const cursorLine = lines.length - 1;
  const cursorCol = lines[cursorLine]?.length ?? 0;
  const suggestions = await provider.getSuggestions(
    lines,
    cursorLine,
    cursorCol,
    {
      signal,
      force: false,
    },
  );
  return suggestions
    ? { provider, lines, cursorLine, cursorCol, suggestions }
    : undefined;
}

export default function (pi: ExtensionAPI): void {
  let provider: AutocompleteProvider | undefined;
  let available = false;

  pi.registerShortcut("ctrl+shift+r", {
    description: "Search current completions with fzf",
    async handler(ctx) {
      if (!available) {
        ctx.ui.notify("pi-fzf-completion: fzf is not installed", "error");
        return;
      }
      if (!provider) return;

      const editorText = ctx.ui.getEditorText();
      const snapshot = await readCompletionSnapshot(
        provider,
        editorText,
        new AbortController().signal,
      );
      if (!snapshot) {
        ctx.ui.notify(
          "Type an @ path or slash command before searching with fzf",
          "warning",
        );
        return;
      }

      if (ctx.ui.getEditorText() !== editorText) return;
      const loadController = new AbortController();
      const pathSource = readPathSource(
        snapshot.suggestions.prefix,
        ctx.cwd,
        loadController.signal,
      );
      const initialQuery =
        parsePath(snapshot.suggestions.prefix, ctx.cwd)?.query ?? "";
      const item = await ctx.ui.custom<AutocompleteItem | undefined>(
        (tui, theme, keybindings, done) => {
          const border = new DynamicBorder((text: string) =>
            theme.fg("accent", text),
          );
          const input = new Input({
            prompt: "",
            placeholder: "type a query",
            placeholderStyle: (text) => theme.fg("dim", text),
          });
          input.handleInput(initialQuery);
          let items = snapshot.suggestions.items;
          let index = indexForFzf(items);
          let controller: AbortController | undefined;
          let filtering = false;
          let focused = false;
          const makeList = (ranked: AutocompleteItem[]): SelectList => {
            const list = new SelectList(
              ranked.map((item, index) => ({
                value: String(index),
                label: item.label,
                description: item.description,
              })),
              Math.min(Math.max(ranked.length, 1), 10),
              {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
              },
            );
            list.onSelect = (selected) => {
              controller?.abort();
              loadController.abort();
              done(ranked[Number(selected.value)]);
            };
            return list;
          };
          let list = makeList(items.slice(0, MAX_MATCHES));
          const update = (query: string): void => {
            controller?.abort();
            if (!query) {
              filtering = false;
              list = makeList(items.slice(0, MAX_MATCHES));
              tui.requestRender();
              return;
            }
            filtering = true;
            tui.requestRender();
            const next = new AbortController();
            controller = next;
            void rankWithFzf(index, query, next.signal).then((ranked) => {
              if (!next.signal.aborted && ranked) {
                filtering = false;
                list = makeList(ranked);
                tui.requestRender();
              }
            });
          };
          void pathSource.then((source) => {
            if (!source || loadController.signal.aborted) return;
            items = source.items;
            index = indexForFzf(items);
            update(input.getValue());
          });

          return {
            get focused() {
              return focused;
            },
            set focused(value: boolean) {
              focused = value;
              input.focused = value;
            },
            render(width: number) {
              const lines = list.render(width);
              return [
                ...border.render(width),
                theme.fg("accent", truncateToWidth("fzf> ", width, "")) +
                  input.render(Math.max(0, width - 5))[0],
                ...lines,
                ...Array(11 - lines.length).fill(""),
                ...border.render(width),
              ].map((line) => truncateToWidth(line, width, ""));
            },
            handleInput(data: string) {
              if (keybindings.matches(data, "tui.select.cancel")) {
                controller?.abort();
                loadController.abort();
                done(undefined);
                return;
              }
              if (
                keybindings.matches(data, "tui.select.up") ||
                keybindings.matches(data, "tui.select.down") ||
                keybindings.matches(data, "tui.select.pageUp") ||
                keybindings.matches(data, "tui.select.pageDown") ||
                keybindings.matches(data, "tui.select.confirm")
              ) {
                if (
                  filtering &&
                  keybindings.matches(data, "tui.select.confirm")
                )
                  return;
                list.handleInput(data);
                tui.requestRender();
                return;
              }
              const previous = input.getValue();
              input.handleInput(data);
              if (input.getValue() !== previous) update(input.getValue());
              tui.requestRender();
            },
            invalidate() {
              input.invalidate();
              list.invalidate();
              border.invalidate();
            },
          };
        },
      );
      loadController.abort();
      if (!item || ctx.ui.getEditorText() !== editorText) return;

      const result = snapshot.provider.applyCompletion(
        snapshot.lines,
        snapshot.cursorLine,
        snapshot.cursorCol,
        item,
        snapshot.suggestions.prefix,
      );
      ctx.ui.setEditorText(result.lines.join("\n"));
      // ponytail: setEditorText does not redraw; clearing an invisible status requests one.
      ctx.ui.setStatus("pi-fzf-completion-redraw", undefined);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    provider = undefined;
    const result = await pi.exec("fzf", ["--version"], { timeout: 1_000 });
    available = result.code === 0;
    if (!available) {
      ctx.ui.notify("pi-fzf-completion: fzf is not installed", "error");
      return;
    }
    ctx.ui.addAutocompleteProvider((current) => {
      provider = current;
      return current;
    });
  });
}

function parsePath(prefix: string, cwd: string): ParsedPath | undefined {
  if (!prefix.startsWith("@")) return undefined;

  let rawPath = prefix.slice(1);
  const quoted = rawPath.startsWith('"');
  if (quoted) rawPath = rawPath.slice(1);
  const slash = rawPath.lastIndexOf("/");
  const displayBase = rawPath === "~" ? "~/" : rawPath.slice(0, slash + 1);
  return {
    quoted,
    displayBase,
    query: rawPath === "~" ? "" : rawPath.slice(slash + 1),
    directory: displayBase.startsWith("~/")
      ? resolve(homedir(), displayBase.slice(2))
      : resolve(cwd, displayBase),
  };
}

function cachePaths(directory: string, paths: string[]): void {
  pathCache.delete(directory);
  pathCache.set(directory, { paths, refreshedAt: Date.now() });
  if (pathCache.size > MAX_CACHED_DIRECTORIES)
    pathCache.delete(pathCache.keys().next().value!);
}
