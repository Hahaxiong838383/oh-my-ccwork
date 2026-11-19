import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { VoiceOnboardingStore } from "./voice-onboarding-store.js";
let store: VoiceOnboardingStore | undefined;
export function voiceOnboardingVersion(supports:string[],env=process.env):1|2|null{
  if(env.VOICE_ONBOARDING_V2_ENABLED==='1'&&supports.includes('voice_onboarding_v2'))return 2;
  return supports.includes('voice_onboarding_v1')?1:null;
}
export function getVoiceOnboardingStore() {
  return (store ??= new VoiceOnboardingStore(
    resolve(process.env.DEVICES_DB_PATH?.trim() || "./data/devices.db"),
    resolve(process.env.PROFILE_DB_PATH?.trim() || "./data/profile.db"),
  ));
}
export function voiceOnboardingEligible(
  input: {
    sn: string;
    agent: string;
    supports: string[];
    normal: boolean;
    listening: boolean;
  },
  env = process.env,
) {
  return (
    env.VOICE_ONBOARDING_ENABLED === "1" &&
    input.normal &&
    !input.listening &&
    voiceOnboardingVersion(input.supports,env)!==null &&
    Boolean(env.VOICE_ONBOARDING_WORKER_AGENT) &&
    input.agent === env.VOICE_ONBOARDING_WORKER_AGENT &&
    (env.VOICE_ONBOARDING_SN_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(input.sn)
  );
}
export function issueVoiceOnboarding(input: {
  sn: string;
  agent: string;
  supports: string[];
  normal: boolean;
  listening: boolean;
  session_id: string;
  trace_id: string;
  room: string;
  expires_at_ms: number;
}) {
  // Every new real session revokes previous authority, including old clients and other pools.
  // Do not initialize profile/migrations on the default-off path. Reopen the existing devices
  // database so revocation also works after a Brain restart with persisted grants.
  const path = resolve(
    process.env.DEVICES_DB_PATH?.trim() || "./data/devices.db",
  );
  if (existsSync(path)) {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=250");
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_onboarding_session'",
          )
          .get()
      )
        db.prepare(
          "UPDATE voice_onboarding_session SET closed=1 WHERE sn=? AND closed=0",
        ).run(input.sn);
    } finally {
      db.close();
    }
  }
  if (!voiceOnboardingEligible(input)) return null;
  try {
    return getVoiceOnboardingStore().issue({...input,version:voiceOnboardingVersion(input.supports)!});
  } catch {
    return null;
  }
}
