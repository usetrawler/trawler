import { describe, expect, test } from "vitest";
import { accountFields, accountFromStory, accountNote, parseAccountNote } from "./account-note.ts";

const field = (label: string, value: string, over: Partial<{ type: string; autocomplete: string; name: string }> = {}) => ({ label, value, type: "text", autocomplete: "", name: "", ...over });

describe("account notes", () => {
  test("a record survives being written and read back, whatever the values contain", () => {
    const record = { page: "https://acme.test/join", fields: [{ label: "Username", value: 'ma"ya, the 2nd' }, { label: "Email", value: "m@example.com" }] };
    expect(parseAccountNote(accountNote(record))).toEqual(record);
    expect(parseAccountNote(accountNote({ fields: record.fields }))).toEqual({ fields: record.fields });
  });

  test("text that is not a record, or was cut off, reads as nothing", () => {
    expect(parseAccountNote("Signed up as maya")).toBeNull();
    expect(parseAccountNote(accountNote({ fields: [{ label: "Username", value: "maya" }] }).slice(0, -3))).toBeNull();
  });

  test("the username comes before the email, and other fields are kept only when there is neither", () => {
    expect(accountFields({ fields: [field("Full name", "Maya Chen"), field("Email", "m@example.com", { type: "email" }), field("Pick a username", "maya")] })).toEqual([
      { label: "Pick a username", value: "maya" },
      { label: "Email", value: "m@example.com" },
    ]);
    expect(accountFields({ fields: [field("Full name", "Maya Chen")] })).toEqual([{ label: "Full name", value: "Maya Chen" }]);
  });

  test("labels and values are cut to a size that fits in a story entry", () => {
    const [only] = accountFields({ fields: [field("Username, which is shown to other \"people\" in the app", "x".repeat(200))] });
    expect(only!.label.length).toBeLessThanOrEqual(24);
    expect(only!.label).not.toMatch(/["',:]/);
    expect(only!.value).toHaveLength(60);
  });

  test("the latest record of that person wins, and other people's records are ignored", () => {
    const note = (name: string) => accountNote({ fields: [{ label: "Username", value: name }] });
    const story = [
      { personaId: "maya", name: "Maya", text: note("old") },
      { personaId: "ravi", name: "Ravi", text: note("ravi") },
      { personaId: "maya", name: "Maya", text: note("new") },
      { personaId: "maya", name: "Maya", goal: "Join.", status: "reached" as const, text: note("goal-note") },
    ];
    expect(accountFromStory(story, "maya")?.fields[0]?.value).toBe("new");
    expect(accountFromStory(story, "nobody")).toBeNull();
  });
});
