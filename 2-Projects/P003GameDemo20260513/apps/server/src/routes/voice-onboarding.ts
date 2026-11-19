import { jwtVerify } from "jose";
import { Hono, type Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {stepV2Schema} from '../voice-onboarding-v2.js';
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
  const handle:Handler=async (c) => {
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
    const v2=c.req.path.endsWith('/v2/step');
    const parsed = (v2?stepV2Schema:stepSchema).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid_request", memory_write: "none" }, 400);
    const grant = c.req.header("x-p003-onboarding-grant") ?? "";
    if (!/^[a-f0-9]{64}$/.test(grant))
      return c.json({ error: "unauthorized", memory_write: "none" }, 403);
    try {
      return c.json(v2?store().stepV2(grant,stepV2Schema.parse(parsed.data)):store().step(grant,stepSchema.parse(parsed.data)));
    } catch (e) {
      return c.json(
        {
          error: e instanceof OnboardingError ? e.code : "storage_unavailable",
          memory_write: "none",
        },
        (e instanceof OnboardingError ? e.status : 503) as 409,
      );
    }
  };
  app.post('/step',handle);
  app.post('/v2/step',handle);
  return app;
}
