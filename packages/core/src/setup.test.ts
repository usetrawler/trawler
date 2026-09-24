import { describe, expect, test } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Budget } from "./llm.ts";
import { pageText, proposeProject } from "./setup.ts";
import { scriptedModel, text } from "./testing.ts";

describe("pageText", () => {
  test("keeps readable text, the title and the description, and drops code", () => {
    const out = pageText(
      `<html><head><title>Acme</title><meta name="description" content="Invoices for freelancers"><style>a{}</style><script>evil()</script></head>
       <body><!-- a > b hidden --><h1>Invoices</h1><a href='/p'>Pricing</a><noscript>nojs</noscript><svg><text>logo</text></svg><template>tpl</template></body></html>`,
      1000,
    );
    for (const kept of ["Acme", "Invoices for freelancers", "Invoices", "Pricing"]) expect(out).toContain(kept);
    for (const dropped of ["evil", "a{}", "hidden", "nojs", "logo", "tpl", "<"]) expect(out).not.toContain(dropped);
  });

  test("decodes entities and collapses whitespace", () => {
    expect(pageText("<p>Fish &amp; chips&nbsp;&lt;3 &quot;hot&quot; &#39;now&#39; &#x263A;</p>\n\n<p>two</p>", 1000)).toBe(`Fish & chips <3 "hot" 'now' ☺ two`);
  });

  test("truncates", () => {
    expect(pageText(`<p>${"a ".repeat(5000)}</p>`, 100).length).toBeLessThanOrEqual(100);
  });
});

const proposal = {
  name: "Acme",
  description: "Invoicing for freelancers.",
  personas: [
    { id: "freelancer", name: "Ana", brief: "You send ten invoices a month." },
    { id: "Accountant Tom", name: "Tom", brief: "You check numbers for clients." },
    { id: "freelancer", name: "Lee", brief: "You are switching from spreadsheets." },
    { id: "", name: "Mo", brief: "You run a small studio." },
    { id: "fifth", name: "Extra", brief: "You should be dropped." },
  ],
  goals: [
    { id: "sign-up", instruction: "Get into the product." },
    { id: "first invoice!", instruction: "Send a first invoice." },
    { id: "get-paid", instruction: "Know when a client has paid." },
    { id: "export", instruction: "Give your accountant last month's numbers." },
  ],
};

function propose(model: ReturnType<typeof scriptedModel> | MockLanguageModelV4, over: Partial<Parameters<typeof proposeProject>[0]> = {}) {
  const fetched: string[] = [];
  const promise = proposeProject({
    model, modelId: "mock", url: "https://app.acme.test/", docsUrl: "https://docs.acme.test/start", budget: new Budget(10),
    fetchText: async (u) => (fetched.push(u), `<h1>Acme at ${u}</h1>`), ...over,
  });
  return { fetched, promise };
}

describe("proposeProject", () => {
  test("builds a valid project from the model's proposal", async () => {
    const model = scriptedModel([text(JSON.stringify(proposal))]);
    const { promise, fetched } = propose(model);
    const { project, usage } = await promise;
    expect(fetched).toEqual(["https://app.acme.test/", "https://docs.acme.test/start"]);
    expect(project).toMatchObject({ name: "Acme", description: "Invoicing for freelancers.", targetUrl: "https://app.acme.test/", docsUrl: "https://docs.acme.test/start", accounts: [] });
    expect(project.allowedOrigins).toEqual(["https://app.acme.test", "https://docs.acme.test"]);
    expect(project.personas.map((p) => p.id)).toEqual(["freelancer", "accountant-tom", "freelancer-2", "persona-4"]);
    expect(project.personas.every((p) => p.accountRef === undefined)).toBe(true);
    expect(project.goals.map((g) => g.id)).toEqual(["sign-up", "first-invoice", "get-paid", "export"]);
    expect(usage.steps).toBe(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("Acme at https://app.acme.test/");
    expect(prompt).toContain("Acme at https://docs.acme.test/start");
  });

  test("goes on without the docs when they cannot be read", async () => {
    const model = scriptedModel([text(JSON.stringify(proposal))]);
    const { project } = await propose(model, { fetchText: async (u) => { if (u.includes("docs")) throw new Error("404"); return "<h1>Acme</h1>"; } }).promise;
    expect(project.docsUrl).toBe("https://docs.acme.test/start");
  });

  test("says clearly when the product page cannot be read", async () => {
    const model = scriptedModel([text(JSON.stringify(proposal))]);
    await expect(propose(model, { fetchText: async () => { throw new Error("ECONNREFUSED"); } }).promise).rejects.toThrow(/could not read https:\/\/app\.acme\.test\/: ECONNREFUSED/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("refuses addresses that are not plain http(s)", async () => {
    const model = scriptedModel([]);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@acme.test/", "not a url"]) {
      const { promise, fetched } = propose(model, { url, docsUrl: undefined });
      await expect(promise).rejects.toThrow(/http\(s\)/);
      expect(fetched).toEqual([]);
    }
    const { promise, fetched } = propose(model, { docsUrl: "file:///etc/passwd" });
    await expect(promise).rejects.toThrow(/http\(s\)/);
    expect(fetched).toEqual([]);
  });

  test("fails with a readable reason when the proposal has no personas or goals", async () => {
    const model = scriptedModel([text(JSON.stringify({ ...proposal, goals: [] }))]);
    await expect(propose(model).promise).rejects.toThrow(/no goals/);
  });

  test("fails with a readable reason when the model answers with garbage", async () => {
    await expect(propose(scriptedModel([text("not json")])).promise).rejects.toThrow(/could not propose a project/);
  });

  test("spends nothing once the budget is gone", async () => {
    const budget = new Budget(0.1);
    budget.add(0.2);
    const model = scriptedModel([text(JSON.stringify(proposal))]);
    await expect(propose(model, { budget }).promise).rejects.toThrow(/budget/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
