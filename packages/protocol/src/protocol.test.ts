import { describe, expect, test } from "vitest";
import { FindingSchema, goalsFor, MAX_STORY_CHARS, parseAccountsFile, ProjectConfigSchema, RunEventSchema, StartRunRequestSchema, trimStory, turnsOf } from "./index.ts";

const project = {
  name: "Acme",
  targetUrl: "https://staging.acme.test",
  description: "Invoicing for freelancers.",
  allowedOrigins: ["https://staging.acme.test"],
  personas: [{ id: "solo", name: "Kwame", brief: "Builds side projects alone.", accountRef: "solo" }],
  goals: [{ id: "sign-up", instruction: "Create an account and reach the dashboard." }],
  accounts: [{ ref: "solo", username: "kwame@acme.test", password: "s3cret-pass" }],
};

describe("ProjectConfig", () => {
  test("gives each person their own goals and the shared ones", () => {
    const admin = { id: "admin", name: "Dana", brief: "You review pitches." };
    const cfg = ProjectConfigSchema.parse({
      ...project,
      personas: [project.personas[0], admin],
      goals: [...project.goals, { id: "submit", instruction: "Submit a pitch.", personaId: "solo" }, { id: "review", instruction: "Review a pitch.", personaId: "admin" }],
    });
    expect(goalsFor(cfg.goals, "solo").map((g) => g.id)).toEqual(["sign-up", "submit"]);
    expect(goalsFor(cfg.goals, "admin").map((g) => g.id)).toEqual(["sign-up", "review"]);
  });

  test("refuses a goal for an unknown person and a person with no goals", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, goals: [{ ...project.goals[0], personaId: "ghost" }] })).toThrow(/unknown persona ghost/);
    const admin = { id: "admin", name: "Dana", brief: "You review pitches." };
    expect(() => ProjectConfigSchema.parse({ ...project, personas: [project.personas[0], admin], goals: [{ ...project.goals[0], personaId: "solo" }] })).toThrow(/persona admin has no goals/);
  });

  test("accepts a complete config", () => {
    expect(ProjectConfigSchema.parse(project).personas).toHaveLength(1);
  });
  test("accounts are optional", () => {
    const { accounts, ...rest } = project;
    expect(ProjectConfigSchema.parse({ ...rest, personas: [{ ...project.personas[0], accountRef: undefined }] }).accounts).toEqual([]);
  });
  test("rejects a persona pointing at an unknown account", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, accounts: [] })).toThrow(/unknown account/);
  });
  test("rejects duplicate goal ids", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, goals: [project.goals[0], project.goals[0]] })).toThrow(/duplicate goal id/);
  });
  test("rejects duplicate persona ids", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, personas: [project.personas[0], project.personas[0]] })).toThrow(/duplicate persona id/);
  });
  test("rejects duplicate account refs", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, accounts: [project.accounts[0], project.accounts[0]] })).toThrow(/duplicate account ref/);
  });
  test.each(["javascript:alert(1)", "file:///etc/passwd", "localhost:3000", "ftp://acme.test"])("rejects target url %s", (targetUrl) => {
    expect(() => ProjectConfigSchema.parse({ ...project, targetUrl })).toThrow();
  });
  test.each(["not a url", "", "http://"])("reports an invalid URL %j as a validation issue", (targetUrl) => {
    expect(ProjectConfigSchema.safeParse({ ...project, targetUrl }).success).toBe(false);
  });
  test("rejects credentials embedded in a URL", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, targetUrl: "https://user:pw@staging.acme.test" })).toThrow(/credentials/);
  });
  test("accepts local http targets", () => {
    const cfg = ProjectConfigSchema.parse({ ...project, targetUrl: "http://localhost:3000/app", allowedOrigins: ["http://127.0.0.1:5173/"] });
    expect(cfg.targetUrl).toBe("http://localhost:3000/app");
  });
  test("normalises allowed origins and always allows the target's own origin", () => {
    const cfg = ProjectConfigSchema.parse({ ...project, targetUrl: "https://app.acme.test/login", allowedOrigins: ["https://docs.acme.test/start/here", "https://docs.acme.test"] });
    expect(cfg.allowedOrigins).toEqual(["https://app.acme.test", "https://docs.acme.test"]);
  });
  test("rejects a misspelt key instead of dropping it", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, httpCredential: { username: "u", password: "p" } })).toThrow();
  });
  test("allowed origins default to the target's origin", () => {
    const { allowedOrigins, ...rest } = project;
    expect(ProjectConfigSchema.parse(rest).allowedOrigins).toEqual(["https://staging.acme.test"]);
  });
  test("reports an unknown account on the persona's accountRef", () => {
    const result = ProjectConfigSchema.safeParse({ ...project, accounts: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["personas", 0, "accountRef"]);
  });
  test("rejects an unknown key inside httpCredentials", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, httpCredentials: { username: "u", password: "long-enough", realm: "staging" } })).toThrow(/realm/);
  });
  test("rejects empty basic-auth credentials", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, httpCredentials: { username: "u", password: "" } })).toThrow();
  });
  test("accepts account and basic-auth passwords of 1 to 1000 characters", () => {
    const account = (password: string) => ProjectConfigSchema.safeParse({ ...project, accounts: [{ ...project.accounts[0], password }] }).success;
    expect([account("a"), account("abc1234"), account("x".repeat(1000))]).toEqual([true, true, true]);
    expect([account(""), account("x".repeat(1001))]).toEqual([false, false]);
    const basic = (password: string) => ProjectConfigSchema.safeParse({ ...project, httpCredentials: { username: "u", password } }).success;
    expect([basic("p"), basic("x".repeat(1000)), basic(""), basic("x".repeat(1001))]).toEqual([true, true, false, false]);
  });
  test("secret headers must be long enough to scrub, plain headers need not", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, secretHeaders: { "x-key": "k7Qz9aP" } })).toThrow();
    const headers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`x-secret-${i}`, `secret-value-${i}`]));
    expect(Object.keys(ProjectConfigSchema.parse({ ...project, secretHeaders: headers(20) }).secretHeaders)).toHaveLength(20);
    expect(() => ProjectConfigSchema.parse({ ...project, secretHeaders: headers(21) })).toThrow(/at most 20 secret headers/);
    expect(ProjectConfigSchema.parse({ ...project, extraHeaders: { "x-env": "stg" } }).extraHeaders).toEqual({ "x-env": "stg" });
  });
  test("rejects an empty accountRef", () => {
    expect(() => ProjectConfigSchema.parse({ ...project, personas: [{ ...project.personas[0], accountRef: "" }] })).toThrow();
  });
});

describe("Finding", () => {
  const base = { id: "f1", kind: "defect", goal: "sign-up", title: "500 on submit", observed: "Expected a dashboard, got a 500.", reproduction: ["Open /signup", "Submit the form"], severity: "high" } as const;
  test("accepts a defect with two steps", () => {
    expect(FindingSchema.parse(base).kind).toBe("defect");
  });
  test("rejects a defect with one step", () => {
    expect(() => FindingSchema.parse({ ...base, reproduction: ["Submit"] })).toThrow(/two reproduction steps/);
  });
  test("accepts friction with one step", () => {
    expect(FindingSchema.parse({ ...base, kind: "friction", reproduction: ["Looked for billing"] }).kind).toBe("friction");
  });
  test("a whitespace-only step does not count towards a defect's two steps", () => {
    expect(() => FindingSchema.parse({ ...base, reproduction: ["Open /signup", "  "] })).toThrow();
  });
  test("rejects friction with no steps", () => {
    expect(() => FindingSchema.parse({ ...base, kind: "friction", reproduction: [] })).toThrow();
  });
  test("rejects a defect with nothing observed", () => {
    expect(() => FindingSchema.parse({ ...base, observed: "" })).toThrow();
  });
});

describe("RunEvent", () => {
  test("parses a finding event", () => {
    const e = RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "role:solo", type: "finding", finding: { id: "f1", kind: "friction", goal: "sign-up", title: "t", observed: "o", reproduction: ["a"], severity: "low" } });
    expect(e.type).toBe("finding");
  });
  test("rejects a date without time", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24", jobId: "x", type: "note", text: "t" })).toThrow();
  });
  test("rejects a finding event carrying an invalid finding", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "finding", finding: { id: "f1", kind: "defect", goal: "g", title: "t", observed: "o", reproduction: ["one"], severity: "low" } })).toThrow(/two reproduction steps/);
  });
  test("numbers steps from one", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "step", step: 0, tool: null, costUsd: 0 })).toThrow();
  });
  test("rejects an unknown stop reason", () => {
    const usage = { model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "job_finished", usage, stoppedBy: "banana" })).toThrow();
  });
  test("rejects an unknown event type", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "nope" })).toThrow();
  });
});

describe("turnsOf", () => {
  const people = [{ id: "priya" }, { id: "marco" }];
  test("consecutive goals of one person make a turn, in the plan's order across people", () => {
    const goals = [
      { id: "sign-in", personaId: "priya" }, { id: "submit", personaId: "priya" },
      { id: "review", personaId: "marco" },
      { id: "decision", personaId: "priya" },
    ];
    expect(turnsOf({ personas: people, goals })).toEqual([
      { personaId: "priya", goalIds: ["sign-in", "submit"] },
      { personaId: "marco", goalIds: ["review"] },
      { personaId: "priya", goalIds: ["decision"] },
    ]);
  });

  test("a plan grouped by person, or with goals for everyone, is one turn per person as before", () => {
    expect(turnsOf({ personas: people, goals: [{ id: "a", personaId: "priya" }, { id: "b", personaId: "marco" }] })).toEqual([
      { personaId: "priya", goalIds: ["a"] }, { personaId: "marco", goalIds: ["b"] },
    ]);
    expect(turnsOf({ personas: people, goals: [{ id: "shared" }, { id: "own", personaId: "marco" }] })).toEqual([
      { personaId: "priya", goalIds: ["shared"] }, { personaId: "marco", goalIds: ["shared", "own"] },
    ]);
  });
});

test("the story keeps the newest entries within its size, each cut short if long", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ personaId: "p", name: "P", text: `${i} ${"x".repeat(900)}` }));
  const kept = trimStory(entries);
  expect(kept.at(-1)!.text.startsWith("99 ")).toBe(true);
  expect(kept.every((e) => e.text.length <= 500)).toBe(true);
  expect(kept.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(MAX_STORY_CHARS);
  expect(trimStory([{ personaId: "p", name: "P", text: "short" }])).toEqual([{ personaId: "p", name: "P", text: "short" }]);
});

describe("accounts from the CI job", () => {
  test("a file maps each person's name to a username and a password", () => {
    expect(parseAccountsFile(JSON.stringify({ Daniel: { username: "daniel@ci.test", password: "pw-123456" }, Priya: { username: "priya", password: "pw-abcdef", note: "ignored" } }))).toEqual({
      Daniel: { username: "daniel@ci.test", password: "pw-123456" }, Priya: { username: "priya", password: "pw-abcdef" },
    });
  });

  test.each([
    ["not json", "not valid JSON"],
    ["{}", "between 1 and"],
    ["[]", "must map each person"],
    [JSON.stringify({ Daniel: { username: "", password: "pw-123456" } }), "Daniel.username"],
    [JSON.stringify({ Daniel: { username: "d" } }), "Daniel.password"],
    [JSON.stringify({ Daniel: "pw-123456" }), "must map each person"],
    [JSON.stringify({ Daniel: { username: "d", password: "x".repeat(70_000) } }), "larger than"],
  ])("refuses %s without echoing it", (text, message) => {
    expect(() => parseAccountsFile(text)).toThrow(message);
    try {
      parseAccountsFile(text);
    } catch (err) {
      expect((err as Error).message).not.toContain("pw-123456");
    }
  });

  test("a run request names the people but has no place for a password", () => {
    expect(StartRunRequestSchema.parse({ project: "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10", execution: "own", accounts: ["Daniel"] }).accounts).toEqual(["Daniel"]);
    expect(() => StartRunRequestSchema.parse({ project: "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10", accounts: [""] })).toThrow();
  });
});
