import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { SignJWT, decodeJwt } from "jose";
const dir = mkdtempSync(join(tmpdir(), "onboarding-signing-"));
for (const key of ["PROFILE", "DEVICES", "CONFIG", "ACCOUNTS", "CONVERSATION"])
  process.env[key + "_DB_PATH"] = join(dir, key + ".db");
process.env.AUTH_JWT_SECRET = "synthetic-secret";
process.env.LIVEKIT_API_KEY = "synthetic-key";
process.env.LIVEKIT_API_SECRET = "synthetic-test-secret-at-least-32bytes";
process.env.DEVICE_SESSION_RPM = "100";
const sn = "BJP00326060100200003";
process.env.DEVICE_SN_ALLOW = sn;
const { deviceRegistryStore } = await import("../src/device-registry-store.js");
const { profileStore } = await import("../src/profile-store.js");
const { deviceSessionRoute } = await import("../src/routes/device-session.js");
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(process.env.DEVICES_DB_PATH!);
// Synthetic binding only; no device connection, SMS, RTC registration or production write.
db.prepare(
  `INSERT INTO device_registry(sn,status,account_id,parent_account_id,public_id,binding_version,created_at,updated_at) VALUES(?,'active','synthetic-child','synthetic-parent','synthetic-public',1,1,1)`,
).run(sn);
profileStore.upsertProfile("synthetic-child", {
  nickname: "",
  birthday: "",
  gender: "",
});
const credential = await new SignJWT({ kind: "p003-device" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(sn)
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
test("actual session HTTP negotiates v398, preserves old path and signs same trusted session metadata", async () => {
  const app = new Hono().route("/v1/device", deviceSessionRoute);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) =>
    server.listening ? r() : server.once("listening", r),
  );
  const post = async (supports: string[]) => {
    const r = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/v1/device/session`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_sn: sn,
          trace_id: "synthetic-trace",
          supports,
        }),
      },
    );
    assert.equal(r.status, 200);
    return (await r.json()) as any;
  };
  try {
    const old = await post(["voice_onboarding_v1"]);
    assert.equal(old.voice_onboarding_contract, undefined);
    process.env.VOICE_ONBOARDING_ENABLED = "1";
    process.env.VOICE_ONBOARDING_SN_ALLOW = sn;
    process.env.VOICE_ONBOARDING_WORKER_AGENT = "rust-worker";
    const active = await post(["voice_onboarding_v1"]);
    assert.deepEqual(active.voice_onboarding_contract, {
      version: 1,
      capability: "voice_onboarding_v1",
    });
    const meta = JSON.parse(
      (decodeJwt(active.token).roomConfig as any).agents[0].metadata,
    );
    assert.equal(meta.session_id, active.session_id);
    assert.equal(meta.trace_id, "synthetic-trace");
    assert.equal(meta.voice_onboarding.version, 1);
    assert.match(meta.voice_onboarding.grant, /^[a-f0-9]{64}$/);
    assert.equal(active.grant, undefined);
    assert.equal((await post(["voice_onboarding_v2"])).voice_onboarding_contract, undefined);
    process.env.VOICE_ONBOARDING_V2_ENABLED="1";
    for(const supports of [["voice_onboarding_v2"],["voice_onboarding_v1","voice_onboarding_v2"]]){
      const v2=await post(supports);
      assert.deepEqual(v2.voice_onboarding_contract,{version:2,capability:"voice_onboarding_v2"});
      const m=JSON.parse((decodeJwt(v2.token).roomConfig as any).agents[0].metadata);
      assert.equal(m.voice_onboarding.version,2);
      assert.equal((db.prepare('SELECT protocol_version FROM voice_onboarding_session WHERE session_id=?').get(v2.session_id) as any).protocol_version,2);
    }
    delete process.env.VOICE_ONBOARDING_V2_ENABLED;
    assert.equal((await post([])).voice_onboarding_contract, undefined);
    assert.equal(
      (
        db
          .prepare(
            "SELECT closed FROM voice_onboarding_session WHERE session_id=?",
          )
          .get(active.session_id) as any
      ).closed,
      1,
      "ordinary new session revokes previous lesson",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});
