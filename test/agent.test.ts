import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatWelcome } from "../src/tools/agent.js";
import type { WelcomeData } from "../src/lib/types.js";

const base: WelcomeData = { stations: [], signals: [], boards: [], tasks: [], inbox: 0, agents: [] };

describe("formatWelcome", () => {
  it("includes header line", () => {
    assert.ok(formatWelcome(base).includes("Welcome to your property"));
  });

  it("shows 'none' when no stations", () => {
    assert.ok(formatWelcome(base).includes("none"));
  });

  it("lists stations", () => {
    const result = formatWelcome({ ...base, stations: ["Desk", "Bookshelf"] });
    assert.ok(result.includes("Desk") && result.includes("Bookshelf"));
  });

  it("lists active agents", () => {
    const result = formatWelcome({ ...base, agents: [{ name: "Lain", state: "reading" }] });
    assert.ok(result.includes("Lain (reading)"));
  });

  it("shows inbox count when > 0", () => {
    assert.ok(formatWelcome({ ...base, inbox: 3 }).includes("3 message(s)"));
  });

  it("does not mention inbox when empty", () => {
    assert.ok(!formatWelcome(base).includes("Inbox"));
  });

  it("lists task stations with workflow hint", () => {
    const result = formatWelcome({ ...base, tasks: ["Task Desk"] });
    assert.ok(result.includes("Task Desk"));
    assert.ok(result.includes("work_task"));
  });

  it("does not show task section when no tasks", () => {
    assert.ok(!formatWelcome(base).includes("work_task"));
  });

  it("lists signals", () => {
    const result = formatWelcome({ ...base, signals: ["Deploy Check"] });
    assert.ok(result.includes("Deploy Check"));
  });

  it("lists boards with content", () => {
    const result = formatWelcome({ ...base, boards: ["News Board"] });
    assert.ok(result.includes("News Board"));
  });
});
