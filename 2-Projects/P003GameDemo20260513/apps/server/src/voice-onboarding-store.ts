import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const stepSchema = z
  .object({
    session_id: id,
    trace_id: id,
    lesson_id: id,
    request_id: id,
    action: z.enum(["begin", "answer", "close"]),
    revision: z.number().int().min(0).max(1000000).optional(),
    field: z.enum(["age", "gender", "nickname"]).optional(),
    text: z.string().max(120).optional(),
  })
  .strict();
type Step = z.infer<typeof stepSchema>;
type Field = "age" | "gender" | "nickname";
export class OnboardingError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fields: Field[] = ["age", "gender", "nickname"];

/** Conservative local extraction. Ambiguous/third-party/qualified statements remain unconfirmed. */
export function extractAnswer(
  field: Field,
  text: string,
):
  | { result: "value"; value: string | number }
  | { result: "unclear" | "declined" } {
  const s = text.trim().replace(/[，。！？!?\s]/g, "");
  if (
    /^(我)?(不想说|不告诉你|不说|不要问|保密|不愿意|不想回答)(了|啦|呀)?$/.test(
      s,
    )
  )
    return { result: "declined" };
  if (field === "age") {
    const m =
      /^(?:我)?(?:今年|现在)?([0-9]{1,2}|[一二三四五六七八九十两]{1,3})(?:周)?岁(?:了|半|啦)?$/.exec(
        s,
      );
    if (!m || s.endsWith("半")) return { result: "unclear" };
    const cn: Record<string, number> = {
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const n = /^\d+$/.test(m[1])
      ? Number(m[1])
      : m[1] === "十"
        ? 10
        : /^[一二]?十[一二三四五六七八九]?$/.test(m[1])
          ? (cn[m[1][0]] ?? 1) * 10 + (cn[m[1].split("十")[1]] ?? 0)
          : cn[m[1]];
    return n >= 1 && n <= 25
      ? { result: "value", value: n }
      : { result: "unclear" };
  }
  if (field === "gender") {
    const m =
      /^(?:我(?:是|是个)?)?(男孩|女孩|男生|女生|男孩子|女孩子)(?:呀|啊|啦)?$/.exec(
        s,
      );
    return m
      ? { result: "value", value: m[1].startsWith("男") ? "男孩" : "女孩" }
      : { result: "unclear" };
  }
  const m =
    /^(?:你可以叫我|你叫我|叫我|我的名字是|我叫)([\p{Script=Han}A-Za-z·]{1,20})(?:吧)?$/u.exec(
      s,
    );
  // A bare name is accepted only without statement/question markers or refusal/control phrases.
  const value = m?.[1]?.replace(/吧$/, "") ?? s;
  if (
    /^(好|对|行|嗯|是的|对的|行吧|谢谢|不用|不了|yes|no|ok|system|assistant|user|ignore|prompt)$/i.test(
      value,
    )
  )
    return { result: "unclear" };
  if (
    !/^[\p{Script=Han}A-Za-z·]{1,12}$/u.test(value) ||
    /不|什么|知道|随便|都行|可以|退下|聊|男孩|女孩|岁|叫|名字|小可|是|你|我|他|她|保密|忘了|嗯|好的|好吧/u.test(
      value,
    )
  )
    return { result: "unclear" };
  return { result: "value", value };
}

/** Main DB owns binding/session fencing; attached profile DB is locked in the SAME synchronous write transaction. */
export class VoiceOnboardingStore {
  private db: DatabaseSync;
  constructor(
    devicesPath: string,
    profilePath: string,
    private now = Date.now,
  ) {
    this.db = new DatabaseSync(devicesPath);
    this.db.exec("PRAGMA busy_timeout=250");
    this.db.prepare("ATTACH DATABASE ? AS profile").run(profilePath);
    const cols = this.db
      .prepare("PRAGMA profile.table_info(family_member)")
      .all() as any[];
    for (const [name, type] of [
      ["age_years", "INTEGER"],
      ["age_observed_at", "INTEGER"],
    ])
      if (!cols.some((c) => c.name === name))
        this.db.exec(
          `ALTER TABLE profile.family_member ADD COLUMN ${name} ${type}`,
        );
    this.db.exec(`CREATE TABLE IF NOT EXISTS voice_onboarding_session(
   session_id TEXT PRIMARY KEY,trace_id TEXT NOT NULL,room TEXT NOT NULL,sn TEXT NOT NULL,grant_hash TEXT NOT NULL,
   expires INTEGER NOT NULL,lesson_id TEXT,deadline INTEGER,revision INTEGER NOT NULL DEFAULT 0,
   snapshot TEXT,closed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS voice_onboarding_receipt(session_id TEXT,request_id TEXT,hash TEXT NOT NULL,reply TEXT NOT NULL,
   PRIMARY KEY(session_id,request_id));`);
  }
  close() {
    this.db.close();
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private snapshot(sn: string) {
    const d = this.db
      .prepare(
        "SELECT sn,status,account_id,parent_account_id,public_id,binding_version FROM device_registry WHERE sn=?",
      )
      .get(sn) as any;
    if (
      !d ||
      d.status !== "active" ||
      !d.account_id ||
      !d.parent_account_id ||
      !d.public_id
    )
      throw new OnboardingError("binding_unavailable");
    if (
      (
        this.db
          .prepare("SELECT count(*) n FROM device_registry WHERE account_id=?")
          .get(d.account_id) as any
      ).n !== 1
    )
      throw new OnboardingError("ambiguous_child");
    const query =
      "SELECT id,account_id,nickname,birthday,gender,age_years,age_observed_at,updated_at FROM profile.family_member WHERE account_id=? ORDER BY id";
    const children = this.db.prepare(query).all(d.account_id) as any[],
      parents = this.db.prepare(query).all(d.parent_account_id) as any[];
    if (children.length !== 1 || parents.length > 1)
      throw new OnboardingError("ambiguous_child");
    return { binding: d, child: children[0], parent: parents[0] ?? null };
  }
  private missing(s: ReturnType<VoiceOnboardingStore["snapshot"]>): Field[] {
    const rows = [s.child, s.parent].filter(Boolean);
    const known = (field: Field) =>
      rows.some((r) =>
        field === "age"
          ? /^(?:19|20)\d{2}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(
              r.birthday?.trim() ?? "",
            ) ||
            (Number.isInteger(r.age_years) &&
              r.age_years >= 1 &&
              r.age_years <= 25)
          : field === "gender"
            ? /^(男孩|女孩|男|女|男生|女生)$/.test(r.gender?.trim() ?? "")
            : Boolean(r.nickname?.trim()),
      );
    return fields.filter((f) => !known(f));
  }
  issue(input: {
    sn: string;
    session_id: string;
    trace_id: string;
    room: string;
    expires_at_ms: number;
  }) {
    const grant = randomBytes(32).toString("hex");
    this.tx(() => {
      const snapshot = this.snapshot(input.sn);
      this.db
        .prepare("UPDATE voice_onboarding_session SET closed=1 WHERE sn=?")
        .run(input.sn);
      this.db
        .prepare(
          "INSERT INTO voice_onboarding_session(session_id,trace_id,room,sn,grant_hash,expires,snapshot) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          input.session_id,
          input.trace_id,
          input.room,
          input.sn,
          digest(grant),
          input.expires_at_ms,
          JSON.stringify(snapshot),
        );
    });
    return { version: 1, grant, expires_at_ms: input.expires_at_ms };
  }
  step(grant: string, input: Step) {
    return this.tx(() => {
      const s = this.db
        .prepare("SELECT * FROM voice_onboarding_session WHERE session_id=?")
        .get(input.session_id) as any;
      if (!s || s.grant_hash !== digest(grant) || s.trace_id !== input.trace_id)
        throw new OnboardingError("unauthorized", 403);
      const now = this.now();
      if (now >= s.expires || (s.deadline !== null && now >= s.deadline))
        throw new OnboardingError("expired", 410);
      if (s.lesson_id !== null && s.lesson_id !== input.lesson_id)
        throw new OnboardingError("lesson_mismatch");
      const prior = this.db
        .prepare(
          "SELECT * FROM voice_onboarding_receipt WHERE session_id=? AND request_id=?",
        )
        .get(input.session_id, input.request_id) as any;
      if (prior) {
        if (prior.hash !== digest(input))
          throw new OnboardingError("request_conflict");
        return JSON.parse(prior.reply);
      }
      if (s.closed) throw new OnboardingError("closed", 410);
      if (
        (
          this.db
            .prepare(
              "SELECT count(*) n FROM voice_onboarding_receipt WHERE session_id=?",
            )
            .get(input.session_id) as any
        ).n >= 128
      )
        throw new OnboardingError("request_limit");
      let reply: any;
      if (input.action === "close") {
        this.db
          .prepare(
            "UPDATE voice_onboarding_session SET closed=1 WHERE session_id=?",
          )
          .run(input.session_id);
        reply = {
          revision: s.revision,
          memory_write: "skipped",
          result: "closed",
          missing: [],
        };
      } else {
        const snap = this.snapshot(s.sn);
        if (input.action === "begin") {
          if (s.lesson_id !== null)
            throw new OnboardingError("already_started");
          if (
            JSON.stringify(snap.binding) !==
            JSON.stringify(JSON.parse(s.snapshot).binding)
          )
            throw new OnboardingError("binding_changed");
          this.db
            .prepare(
              "UPDATE voice_onboarding_session SET lesson_id=?,deadline=?,snapshot=? WHERE session_id=?",
            )
            .run(
              input.lesson_id,
              Math.min(now + 180000, s.expires),
              JSON.stringify(snap),
              input.session_id,
            );
          reply = {
            revision: 0,
            memory_write: "none",
            result: "ready",
            missing: this.missing(snap),
          };
        } else {
          if (
            !s.lesson_id ||
            input.revision !== s.revision ||
            JSON.stringify(snap) !== s.snapshot
          )
            throw new OnboardingError("stale_snapshot");
          if (
            !input.field ||
            input.field !== this.missing(snap)[0] ||
            !input.text
          )
            throw new OnboardingError("unexpected_answer");
          const parsed = extractAnswer(input.field, input.text);
          if (parsed.result === "declined")
            this.db
              .prepare(
                "UPDATE voice_onboarding_session SET closed=1 WHERE session_id=?",
              )
              .run(input.session_id);
          if (parsed.result !== "value")
            reply = {
              revision: s.revision,
              memory_write: parsed.result === "declined" ? "skipped" : "none",
              result: parsed.result,
              missing: this.missing(snap),
            };
          else {
            if (input.field === "age")
              this.db
                .prepare(
                  "UPDATE profile.family_member SET age_years=?,age_observed_at=?,updated_at=? WHERE id=?",
                )
                .run(parsed.value, now, now, snap.child.id);
            else
              this.db
                .prepare(
                  `UPDATE profile.family_member SET ${input.field}=?,updated_at=? WHERE id=?`,
                )
                .run(parsed.value, now, snap.child.id);
            const next = this.snapshot(s.sn);
            this.db
              .prepare(
                "UPDATE voice_onboarding_session SET snapshot=?,revision=revision+1 WHERE session_id=?",
              )
              .run(JSON.stringify(next), input.session_id);
            reply = {
              revision: s.revision + 1,
              memory_write: "saved",
              result: "saved",
              missing: this.missing(next),
            };
          }
        }
      }
      this.db
        .prepare("INSERT INTO voice_onboarding_receipt VALUES(?,?,?,?)")
        .run(
          input.session_id,
          input.request_id,
          digest(input),
          JSON.stringify(reply),
        );
      return reply;
    });
  }
}
