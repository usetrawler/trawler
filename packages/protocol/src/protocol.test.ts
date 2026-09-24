import { describe, expect, test } from "vitest";
import { FindingSchema, ProjectConfigSchema, RunEventSchema } from "./index.ts";

const project = {
  name: "Acme",
  targetUrl: "https://staging.acme.test",
  description: "Invoicing for freelancers.",
  allowedOrigins: ["https://staging.acme.test"],
  personas: [{ id: "solo", name: "Kwame", brief: "Builds side projects alone.", accountRef: "solo" }],
  goals: [{ id: "sign-up", instruction: "Create an account and reach the dashboard." }],
  accounts: [{ ref: "solo", username: "kwame@acme.test", password: "s3cret" }],
};

describe("ProjectConfig", () => {
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
  test("rejects an unknown stop reason", () => {
    const usage = { model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "job_finished", usage, stoppedBy: "banana" })).toThrow();
  });
  test("rejects an unknown event type", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "nope" })).toThrow();
  });
});
