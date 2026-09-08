import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

import {
  rankWithFzf,
  readCompletionSnapshot,
  readPathSource,
} from "../extensions/fzf-completion.ts";

test("searches completion labels and descriptions with a multi-word fzf query", async () => {
  const settings = {
    value: "settings",
    label: "settings",
    description: "Open user preferences",
  };
  const ranked = await rankWithFzf(
    [
      settings,
      {
        value: "session",
        label: "session",
        description: "Show session details",
      },
    ],
    "settings preferences",
  );

  assert.deepEqual(ranked, [settings]);
});

test("keeps only the best thousand matches", async () => {
  const items = Array.from({ length: 1_001 }, (_, index) => ({
    value: String(index),
    label: `match-${index}`,
  }));

  assert.equal((await rankWithFzf(items, "match"))?.length, 1_000);
});

test("reads slash commands without forcing path completion", async () => {
  const provider = new CombinedAutocompleteProvider(
    [{ name: "settings" }],
    "/",
  );
  const snapshot = await readCompletionSnapshot(
    provider,
    "/set",
    new AbortController().signal,
  );

  assert.deepEqual(snapshot?.suggestions.items, [
    { value: "settings", label: "settings" },
  ]);
});

test("preserves whitespace in path names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fzf-completion-"));
  try {
    await writeFile(join(directory, " leading "), "");

    const source = await readPathSource(`@${directory}/`, "/");

    assert.equal(source?.items[0]?.label, " leading ");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("searches an @ path directory recursively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fzf-completion-"));
  try {
    await Promise.all([
      mkdir(join(directory, "alpha")),
      mkdir(join(directory, "src", "github.com"), { recursive: true }),
      mkdir(join(directory, "zeta")),
      writeFile(join(directory, "bravo.txt"), ""),
    ]);

    const source = await readPathSource(`@${directory}/`, "/");
    assert.ok(source);
    const ranked = await rankWithFzf(source.items, "src/gith");

    assert.deepEqual(
      ranked?.map((item) => item.label),
      ["src/github.com/"],
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
