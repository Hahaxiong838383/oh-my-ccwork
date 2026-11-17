// Spawned only by Rust tests: real Hono HTTP and isolated SQLite, never src/index.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { VoiceOnboardingStore } from "../src/voice-onboarding-store.js";
import { createVoiceOnboardingRoute } from "../src/routes/voice-onboarding.js";
const dir = mkdtempSync(join(tmpdir(), "onboarding-worker-http-"));
process.env.AUTH_JWT_SECRET = "synthetic-worker-fixture-only";
const devices = join(dir, "devices.db"),
  profile = join(dir, "profile.db");
const d = new DatabaseSync(devices),
  p = new DatabaseSync(profile);
d.exec(
  `CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,account_id TEXT,parent_account_id TEXT,public_id TEXT,binding_version INTEGER);INSERT INTO device_registry VALUES('synthetic','active','child','parent','public',1)`,
);
p.exec(
  `CREATE TABLE family_member(id TEXT PRIMARY KEY,account_id TEXT,nickname TEXT,birthday TEXT,gender TEXT,updated_at INTEGER);INSERT INTO family_member VALUES('child-id','child','','','',1)`,
);
const store = new VoiceOnboardingStore(devices, profile);
const metadata = store.issue({
  sn: "synthetic",
  session_id: "session",
  trace_id: "trace",
  room: "room",
  expires_at_ms: Date.now() + 300000,
});
const token = await new SignJWT({ accountId: "worker-service", role: "device" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer("p003")
  .setAudience("kidshub")
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
let answerReceived = 0;
const app = new Hono();
app.use("/v1/internal/voice-onboarding/step", async (c, next) => {
  const body = await c.req.json();
  if (body.action === "answer") {
    answerReceived++;
    const delay = Number(process.env.SYNTHETIC_ANSWER_DELAY_MS ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  await next();
});
app.route(
  "/v1/internal/voice-onboarding",
  createVoiceOnboardingRoute(() => store),
);
app.get("/synthetic-observation", (c) =>
  c.json({
    ...p
      .prepare(
        "SELECT birthday,age_years,age_observed_at,gender,nickname FROM family_member",
      )
      .get(),
    answerReceived,
  }),
);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) =>
  server.listening ? r() : server.once("listening", r),
);
// Pipe is consumed by Rust only. It contains synthetic credentials, never a real device token.
process.stdout.write(
  JSON.stringify({
    base: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    metadata,
    query: `token=${token}`,
  }) + "\n",
);
let ending = false;
function end() {
  if (ending) return;
  ending = true;
  server.close(() => {
    store.close();
    p.close();
    d.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
}
process.stdin.resume();
process.stdin.on("end", end);
process.on("SIGTERM", end);
