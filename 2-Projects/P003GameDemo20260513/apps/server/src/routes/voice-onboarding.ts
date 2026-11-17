import { jwtVerify } from "jose";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  OnboardingError,
  stepSchema,
  type VoiceOnboardingStore,
} from "../voice-onboarding-store.js";
export function createVoiceOnboardingRoute(store: () => VoiceOnboardingStore) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json({ error: "request_too_large", memory_write: "none" }, 413),
    }),
  );
  app.post("/step", async (c) => {
    // RTC JWT metadata is readable by the device. A scoped grant is NOT worker authentication.
    try {
      const secret = process.env.AUTH_JWT_SECRET;
      if (!secret) throw new Error();
      const { payload } = await jwtVerify(
        c.req.header("x-p003-worker-token") ?? "",
        new TextEncoder().encode(secret),
        { issuer: "p003", audience: "kidshub", algorithms: ["HS256"] },
      );
      const allowed = (
        process.env.VOICE_ONBOARDING_WORKER_ACCOUNTS ?? "worker-service"
      )
        .split(",")
        .map((v) => v.trim());
      if (
        payload.role !== "device" ||
        typeof payload.accountId !== "string" ||
        !allowed.includes(payload.accountId)
      )
        throw new Error();
    } catch {
      return c.json(
        { error: "worker_unauthorized", memory_write: "none" },
        403,
      );
    }
    const parsed = stepSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid_request", memory_write: "none" }, 400);
    const grant = c.req.header("x-p003-onboarding-grant") ?? "";
    if (!/^[a-f0-9]{64}$/.test(grant))
      return c.json({ error: "unauthorized", memory_write: "none" }, 403);
    try {
      return c.json(store().step(grant, parsed.data));
    } catch (e) {
      return c.json(
        {
          error: e instanceof OnboardingError ? e.code : "storage_unavailable",
          memory_write: "none",
        },
        (e instanceof OnboardingError ? e.status : 503) as 409,
      );
    }
  });
  return app;
}
