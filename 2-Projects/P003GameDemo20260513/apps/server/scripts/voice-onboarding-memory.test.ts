import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const dir = mkdtempSync(join(tmpdir(), "onboarding-memory-"));
process.env.PROFILE_DB_PATH = join(dir, "profile.db");
process.env.CONFIG_DB_PATH = join(dir, "config.db");
process.env.PERSONA_DB_PATH = join(dir, "persona.db");
process.env.CONVERSATION_DB_PATH = join(dir, "conversation.db");
process.env.DEVICES_DB_PATH = join(dir, "devices.db");
test("saved age remains year-precision through existing memory reader", async () => {
  const { profileStore } = await import("../src/profile-store.js");
  const p = profileStore.upsertProfile("synthetic", {
    nickname: "星星",
    birthday: "",
    gender: "女孩",
  });
  const db = new DatabaseSync(process.env.PROFILE_DB_PATH!);
  const cols = db.prepare("PRAGMA table_info(family_member)").all() as any[];
  assert.ok(cols.some((c) => c.name === "age_years"));
  db.prepare(
    "UPDATE family_member SET age_years=8,age_observed_at=100000 WHERE id=?",
  ).run(p.id);
  const read = profileStore.getProfile("synthetic") as any;
  assert.equal(read.age_years, 8);
  assert.equal(read.birthday, "");
  db.close();
});
test("ordinary chat reads observed age and does not demand a fabricated birthday", async () => {
  const { profileStore } = await import("../src/profile-store.js");
  const { buildOnboardingGuide, assembleSystemPrompt } = await import(
    "../src/prompt-orchestrator.js"
  );
  const p = profileStore.getProfile("synthetic")!;
  assert.equal(buildOnboardingGuide(p), null);
  const prompt = assembleSystemPrompt(
    "synthetic",
    null,
    { accountId: "synthetic", role: "device" },
    null,
    null,
    null,
    null,
    null,
    { skipInjectReceipt: true },
  );
  assert.match(prompt, /8岁/);
  assert.match(prompt, /自述/);
  assert.match(prompt, /出生年月未知/);
});

test("ordinary basic-field enrichment preserves known age; copying a child profile clears old age", async () => {
  const { profileStore } = await import("../src/profile-store.js");
  const updated = profileStore.upsertBasics("synthetic", {
    nickname: "星星同学",
  });
  assert.equal(updated.age_years, 8);
  profileStore.upsertProfile("synthetic-other", {
    nickname: "另一个孩子",
    birthday: "",
    gender: "",
  });
  const copied = profileStore.copyProfile("synthetic-other", "synthetic");
  assert.equal(copied?.age_years, null);
});
