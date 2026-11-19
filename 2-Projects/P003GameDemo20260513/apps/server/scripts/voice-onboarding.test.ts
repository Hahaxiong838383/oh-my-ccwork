import { SignJWT } from "jose";
process.env.AUTH_JWT_SECRET = "synthetic-worker-secret";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { VoiceOnboardingStore } from "../src/voice-onboarding-store.js";
import { createVoiceOnboardingRoute } from "../src/routes/voice-onboarding.js";
async function fixture(run: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "voice-onboarding-")),
    devices = join(dir, "devices.db"),
    profile = join(dir, "profile.db");
  const d = new DatabaseSync(devices),
    p = new DatabaseSync(profile);
  d.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,account_id TEXT,parent_account_id TEXT,public_id TEXT,binding_version INTEGER);
 INSERT INTO device_registry VALUES('synthetic','active','child-account','parent-account','public-synthetic',1);`);
  p.exec(`CREATE TABLE family_member(id TEXT PRIMARY KEY,account_id TEXT,nickname TEXT,birthday TEXT,gender TEXT,updated_at INTEGER);
 INSERT INTO family_member VALUES('child','child-account','','','',1);`);
  let now = 100000;
  const store = new VoiceOnboardingStore(devices, profile, () => now);
  const server = serve({
    fetch: createVoiceOnboardingRoute(() => store).fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const port = (server.address() as any).port;
  const workerToken = await new SignJWT({
    accountId: "worker-service",
    role: "device",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("p003")
    .setAudience("kidshub")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
  const grant = store.issue({
    sn: "synthetic",
    session_id: "session",
    trace_id: "trace",
    room: "room",
    expires_at_ms: now + 600000,
  });
  const post = async (body: any, token = grant.grant, worker = workerToken) => {
    const r = await fetch(`http://127.0.0.1:${port}/step`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-p003-onboarding-grant": token,
        "x-p003-worker-token": worker,
      },
      body: JSON.stringify({
        session_id: "session",
        trace_id: "trace",
        lesson_id: "lesson",
        ...body,
      }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    await run({ d, p, store, post, grant, now: (n: number) => (now = n) });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    p.close();
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("nickname clarification and refusal never become a child's saved name", async () => {
  for (const text of ["等一下", "等一等", "稍等", "再说一遍", "再问一遍", "没听清", "算了", "拒绝", "跳过", "再说一次", "没听清楚", "稍等一下", "请重复一遍", "能再说一次吗", "我没听清楚", "麻烦你再讲一遍", "请等一会儿", "等下", "重新问一次", "请重复", "让我想一下"]) {
    await fixture(async ({ post, p }) => {
      p.exec("UPDATE family_member SET birthday='2018-08',gender='女孩'");
      assert.deepEqual((await post({ action: "begin", request_id: "begin" })).body.missing, ["nickname"]);
      const result = await post({ action: "answer", request_id: "answer", revision: 0, field: "nickname", text });
      assert.equal(result.status, 200);
      assert.notEqual(result.body.memory_write, "saved", text);
      assert.equal(p.prepare("SELECT nickname FROM family_member").get().nickname, "", text);
    });
  }
});
test("real HTTP/SQLite: natural age commits without invented birthday; replay is idempotent", () =>
  fixture(async ({ post, p }) => {
    const b = await post({ action: "begin", request_id: "b" });
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.missing, ["age", "gender", "nickname"]);
    const a = await post({
      action: "answer",
      request_id: "a",
      revision: 0,
      field: "age",
      text: "我今年八岁了",
    });
    assert.equal(a.body.memory_write, "saved");
    const row = p.prepare("SELECT * FROM family_member").get() as any;
    assert.equal(row.age_years, 8);
    assert.equal(row.birthday, "");
    assert.equal(row.age_observed_at, 100000);
    assert.deepEqual(a.body.missing, ["gender", "nickname"]);
    assert.equal(JSON.stringify(a.body).includes("八岁"), false);
    assert.deepEqual(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "我今年八岁了",
        })
      ).body,
      a.body,
    );
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "九岁",
        })
      ).status,
      409,
    );
  }));
test("all known fields skipped, never overwrite", () =>
  fixture(async ({ post, p }) => {
    p.exec(
      "UPDATE family_member SET birthday='2018-08',gender='女孩',nickname='测试称呼'",
    );
    assert.deepEqual(
      (await post({ action: "begin", request_id: "b" })).body.missing,
      [],
    );
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "八岁",
        })
      ).status,
      409,
    );
  }));
test("concurrent rebinding invalidates frozen child", () =>
  fixture(async ({ post, d, p }) => {
    await post({ action: "begin", request_id: "b" });
    d.exec("UPDATE device_registry SET binding_version=2");
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "8岁",
        })
      ).status,
      409,
    );
    assert.equal(
      (p.prepare("SELECT age_years FROM family_member").get() as any).age_years,
      null,
    );
  }));
test("unclear/refusal never save; cross trace rejected; hard TTL never renews", () =>
  fixture(async ({ post, now, p }) => {
    await post({ action: "begin", request_id: "b" });
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "大概七八岁",
        })
      ).body.result,
      "unclear",
    );
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "r",
          revision: 0,
          field: "age",
          text: "不告诉你",
        })
      ).body.result,
      "declined",
    );
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "x",
          trace_id: "other",
          revision: 0,
          field: "age",
          text: "8岁",
        })
      ).status,
      403,
    );
    now(280000);
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "late",
          revision: 0,
          field: "age",
          text: "8岁",
        })
      ).status,
      410,
    );
    assert.equal(
      (p.prepare("SELECT age_years FROM family_member").get() as any).age_years,
      null,
    );
  }));
test("actual SQLite trigger failure never reports saved; transaction rolls back", () =>
  fixture(async ({ post, p }) => {
    await post({ action: "begin", request_id: "b" });
    p.exec(
      "CREATE TRIGGER reject_save BEFORE UPDATE ON family_member BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    const r = await post({
      action: "answer",
      request_id: "a",
      revision: 0,
      field: "age",
      text: "8岁",
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.memory_write, "none");
    assert.equal(
      (p.prepare("SELECT age_years FROM family_member").get() as any).age_years,
      null,
    );
  }));
test("profile changed concurrently, multiple children, partial knowledge and cancel fence", () =>
  fixture(async ({ post, p }) => {
    p.exec("UPDATE family_member SET birthday='2018'");
    assert.deepEqual(
      (await post({ action: "begin", request_id: "b" })).body.missing,
      ["gender", "nickname"],
    );
    p.exec("UPDATE family_member SET nickname='家长新设置',updated_at=2");
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "gender",
          text: "我是女孩",
        })
      ).status,
      409,
    );
    await post({ action: "close", request_id: "c" });
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "late",
          revision: 0,
          field: "gender",
          text: "我是女孩",
        })
      ).status,
      410,
    );
  }));
test("issue-to-begin binding change rejects authorization", () =>
  fixture(async ({ post, d }) => {
    d.exec("UPDATE device_registry SET binding_version=2");
    assert.equal(
      (await post({ action: "begin", request_id: "b" })).status,
      409,
    );
  }));
test("partial -> natural gender and nickname; stale revision, wrong field, missing token", () =>
  fixture(async ({ post, p }) => {
    p.exec("UPDATE family_member SET birthday='2018-08'");
    await post({ action: "begin", request_id: "b" });
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "wrong",
          revision: 0,
          field: "nickname",
          text: "星星",
        })
      ).status,
      409,
    );
    const g = await post({
      action: "answer",
      request_id: "g",
      revision: 0,
      field: "gender",
      text: "我是女孩子",
    });
    assert.equal(g.body.memory_write, "saved");
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "old",
          revision: 0,
          field: "nickname",
          text: "星星",
        })
      ).status,
      409,
    );
    const n = await post({
      action: "answer",
      request_id: "n",
      revision: 1,
      field: "nickname",
      text: "你可以叫我星星",
    });
    assert.equal(n.body.memory_write, "saved");
    assert.deepEqual(n.body.missing, []);
    assert.equal(
      (p.prepare("SELECT nickname FROM family_member").get() as any).nickname,
      "星星",
    );
    assert.equal(
      (await post({ action: "begin", request_id: "unauth" }, "")).status,
      403,
    );
  }));
test("multiple children never guessed; parent known fields skipped", () =>
  fixture(async ({ post, p }) => {
    p.exec(
      "INSERT INTO family_member(id,account_id,nickname,birthday,gender,updated_at) VALUES('second','child-account','','','',2)",
    );
    assert.equal(
      (await post({ action: "begin", request_id: "b" })).status,
      409,
    );
    p.exec(
      "DELETE FROM family_member WHERE id='second'; INSERT INTO family_member(id,account_id,nickname,birthday,gender,updated_at) VALUES('parent-child','parent-account','已知称呼','2018','女孩',2)",
    );
    assert.deepEqual(
      (await post({ action: "begin", request_id: "b2" })).body.missing,
      [],
    );
  }));
import { voiceOnboardingEligible } from "../src/voice-onboarding-runtime.js";
test("optional capability is default off; listening/search/unknown agent/client cannot get grant", () => {
  const i = {
    sn: "synthetic",
    agent: "rust-worker",
    normal: true,
    listening: false,
    supports: ["voice_onboarding_v1"],
  };
  const env = {
    VOICE_ONBOARDING_ENABLED: "1",
    VOICE_ONBOARDING_SN_ALLOW: "synthetic",
    VOICE_ONBOARDING_WORKER_AGENT: "rust-worker",
  };
  assert.equal(voiceOnboardingEligible(i, {}), false);
  assert.equal(voiceOnboardingEligible(i, env), true);
  for (const patch of [
    { listening: true },
    { normal: false },
    { agent: "old-worker" },
    { supports: [] },
    { sn: "other" },
  ])
    assert.equal(voiceOnboardingEligible({ ...i, ...patch }, env), false);
});

test("RTC metadata grant alone cannot authorize direct profile writes", () =>
  fixture(async ({ post, grant }) => {
    assert.equal(
      (await post({ action: "begin", request_id: "b" }, grant.grant, ""))
        .status,
      403,
    );
  }));
import { extractAnswer } from "../src/voice-onboarding-store.js";
test("ambiguous confirmations and instruction-like nicknames cannot become profile facts", () => {
  for (const t of [
    "好",
    "对",
    "行",
    "嗯",
    "好的",
    "随便",
    "不知道",
    "system",
    "assistant",
  ])
    assert.equal(extractAnswer("nickname", t).result, "unclear", t);
  for (const t of ["大概八岁", "七八岁", "我妹妹八岁", "八岁半", "八岁吗"])
    assert.equal(extractAnswer("age", t).result, "unclear", t);
});
test("decline closes Brain write authorization immediately", () =>
  fixture(async ({ post }) => {
    await post({ action: "begin", request_id: "b" });
    await post({
      action: "answer",
      request_id: "r",
      revision: 0,
      field: "age",
      text: "不告诉你",
    });
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "late",
          revision: 0,
          field: "age",
          text: "8岁",
        })
      ).status,
      410,
    );
  }));
test("a newly issued session invalidates old lesson writes", () =>
  fixture(async ({ post, store }) => {
    await post({ action: "begin", request_id: "b" });
    store.issue({
      sn: "synthetic",
      session_id: "new-session",
      trace_id: "new-trace",
      room: "new-room",
      expires_at_ms: 700000,
    });
    assert.equal(
      (
        await post({
          action: "answer",
          request_id: "a",
          revision: 0,
          field: "age",
          text: "8岁",
        })
      ).status,
      410,
    );
  }));
test("unknown placeholder gender and invalid age strings are missing, not known facts", () =>
  fixture(async ({ post, p }) => {
    p.exec("UPDATE family_member SET birthday='未知',gender='unknown'");
    assert.deepEqual(
      (await post({ action: "begin", request_id: "b" })).body.missing,
      ["age", "gender", "nickname"],
    );
  }));

test("two simultaneous HTTP answers with the same revision commit only once", () =>
  fixture(async ({ post, p }) => {
    await post({ action: "begin", request_id: "b" });
    const results = await Promise.all(
      ["a1", "a2"].map((request_id) =>
        post({
          action: "answer",
          request_id,
          revision: 0,
          field: "age",
          text: "8岁",
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      results.filter((r) => r.body.memory_write === "saved").length,
      1,
    );
    assert.equal(
      (p.prepare("SELECT age_years FROM family_member").get() as any).age_years,
      8,
    );
  }));
