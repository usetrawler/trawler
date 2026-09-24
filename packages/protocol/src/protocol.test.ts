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
    expect(() => ProjectConfigSchema.parse({ ...project, goals: [project.goals[0], project.goals[0]] })).toThrow(/duplicate/);
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
});

describe("RunEvent", () => {
  test("parses a finding event", () => {
    const e = RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "role:solo", type: "finding", finding: { id: "f1", kind: "friction", goal: "sign-up", title: "t", observed: "o", reproduction: ["a"], severity: "low" } });
    expect(e.type).toBe("finding");
  });
  test("rejects an unknown event type", () => {
    expect(() => RunEventSchema.parse({ seq: 1, at: "2026-09-24T10:00:00.000Z", jobId: "x", type: "nope" })).toThrow();
  });
});
