/**
 * allowlist.test.ts — 通过 `tsx --test src/knowledge/allowlist.test.ts` 运行。
 *
 * 依赖 Node 22 内置 node:test + node:assert，无外部测试框架。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllowlist,
  isSpaceAllowed,
  getEnabledSpaceIds,
  getSpaceEntry,
} from "./allowlist.js";
import type { Allowlist } from "./types.js";

function tmpFile(content: string): string {
  const path = join(
    tmpdir(),
    `allowlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(path, content);
  return path;
}

test("loadAllowlist returns empty when file does not exist", () => {
  const result = loadAllowlist("/nonexistent/path/to/allowlist.json");
  assert.deepEqual(result, { spaces: [] });
});

test("loadAllowlist parses valid JSON and converts snake_case → camelCase", () => {
  const path = tmpFile(
    JSON.stringify({
      spaces: [
        {
          space_id: "7627104320944622530",
          name: "Queen Brain Wiki",
          enabled: true,
          root_tokens: ["tok1", "tok2"],
        },
      ],
    }),
  );
  try {
    const result = loadAllowlist(path);
    assert.equal(result.spaces.length, 1);
    assert.equal(result.spaces[0].spaceId, "7627104320944622530");
    assert.equal(result.spaces[0].name, "Queen Brain Wiki");
    assert.equal(result.spaces[0].enabled, true);
    assert.deepEqual(result.spaces[0].rootTokens, ["tok1", "tok2"]);
  } finally {
    unlinkSync(path);
  }
});

test("loadAllowlist throws on empty space_id", () => {
  const path = tmpFile(
    JSON.stringify({
      spaces: [{ space_id: "", name: "x", enabled: true, root_tokens: [] }],
    }),
  );
  try {
    assert.throws(() => loadAllowlist(path));
  } finally {
    unlinkSync(path);
  }
});

test("loadAllowlist throws on missing required field", () => {
  const path = tmpFile(JSON.stringify({ spaces: [{ name: "x" }] }));
  try {
    assert.throws(() => loadAllowlist(path));
  } finally {
    unlinkSync(path);
  }
});

test("loadAllowlist throws on invalid JSON", () => {
  const path = tmpFile("{ not json }");
  try {
    assert.throws(() => loadAllowlist(path));
  } finally {
    unlinkSync(path);
  }
});

test("isSpaceAllowed matches only enabled entries", () => {
  const allowlist: Allowlist = {
    spaces: [
      { spaceId: "a", name: "A", enabled: true, rootTokens: [] },
      { spaceId: "b", name: "B", enabled: false, rootTokens: [] },
    ],
  };
  assert.equal(isSpaceAllowed(allowlist, "a"), true);
  assert.equal(isSpaceAllowed(allowlist, "b"), false, "disabled space blocked");
  assert.equal(isSpaceAllowed(allowlist, "c"), false, "unknown space blocked");
});

test("getEnabledSpaceIds returns only enabled space_ids", () => {
  const allowlist: Allowlist = {
    spaces: [
      { spaceId: "a", name: "A", enabled: true, rootTokens: [] },
      { spaceId: "b", name: "B", enabled: false, rootTokens: [] },
      { spaceId: "c", name: "C", enabled: true, rootTokens: ["t1"] },
    ],
  };
  assert.deepEqual(getEnabledSpaceIds(allowlist), ["a", "c"]);
});

test("getSpaceEntry returns entry regardless of enabled state", () => {
  const allowlist: Allowlist = {
    spaces: [
      { spaceId: "a", name: "A", enabled: true, rootTokens: [] },
      { spaceId: "b", name: "B", enabled: false, rootTokens: [] },
    ],
  };
  assert.equal(getSpaceEntry(allowlist, "a")?.name, "A");
  assert.equal(getSpaceEntry(allowlist, "b")?.name, "B");
  assert.equal(getSpaceEntry(allowlist, "c"), undefined);
});
