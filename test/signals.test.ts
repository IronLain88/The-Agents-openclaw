import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSignalEvent } from "../src/lib/signals.js";
import type { AgentIdentity, SignalMessage } from "../src/lib/types.js";

const mockIdentity = (overrides?: Partial<AgentIdentity>): AgentIdentity => ({
  hubId: "test-agent",
  name: "Test",
  sprite: "cat",
  state: "idle",
  detail: "",
  subscribedStation: "my-signal",
  signalWs: null,
  signalQueue: [],
  pendingResolve: null,
  ...overrides,
});

const mockMsg = (overrides?: Partial<SignalMessage>): SignalMessage => ({
  type: "signal",
  station: "my-signal",
  trigger: "cron",
  timestamp: 1700000000000,
  ...overrides,
});

describe("formatSignalEvent", () => {
  it("includes timestamp, trigger, station, queueSize", () => {
    const result = JSON.parse(formatSignalEvent(mockMsg(), mockIdentity()));
    assert.equal(result.timestamp, 1700000000000);
    assert.equal(result.trigger, "cron");
    assert.equal(result.station, "my-signal");
    assert.equal(result.queueSize, 0);
  });

  it("reflects current queue size", () => {
    const identity = mockIdentity({ signalQueue: [mockMsg(), mockMsg()] });
    const result = JSON.parse(formatSignalEvent(mockMsg(), identity));
    assert.equal(result.queueSize, 2);
  });

  it("includes payload when present", () => {
    const result = JSON.parse(formatSignalEvent(mockMsg({ payload: { value: 42 } }), mockIdentity()));
    assert.deepEqual(result.payload, { value: 42 });
  });

  it("omits payload key when absent", () => {
    const result = JSON.parse(formatSignalEvent(mockMsg(), mockIdentity()));
    assert.equal("payload" in result, false);
  });

  it("uses subscribedStation from identity, not message station", () => {
    const identity = mockIdentity({ subscribedStation: "override-station" });
    const msg = mockMsg({ station: "original-station" });
    const result = JSON.parse(formatSignalEvent(msg, identity));
    assert.equal(result.station, "override-station");
  });

  it("includes human-readable time string", () => {
    const result = JSON.parse(formatSignalEvent(mockMsg(), mockIdentity()));
    assert.ok(typeof result.time === "string" && result.time.length > 0);
  });
});
