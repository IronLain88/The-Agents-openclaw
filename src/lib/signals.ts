import WebSocket from "ws";
import type { AgentIdentity, SignalMessage } from "./types.js";

export function connectSignalWs(identity: AgentIdentity, hubUrl: string): void {
  const wsUrl = hubUrl.replace(/^http/, "ws");
  identity.signalWs = new WebSocket(wsUrl);
  identity.signalWs.on("message", (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "signal" && msg.station === identity.subscribedStation) {
        if (identity.pendingResolve) {
          const r = identity.pendingResolve; identity.pendingResolve = null; r(msg);
        } else {
          identity.signalQueue.push(msg);
          if (identity.signalQueue.length > 50) identity.signalQueue.shift();
        }
      }
    } catch {}
  });
  identity.signalWs.on("close", () => {
    identity.signalWs = null;
    if (identity.subscribedStation) setTimeout(() => connectSignalWs(identity, hubUrl), 3_000);
  });
  identity.signalWs.on("error", () => {});
}

export function formatSignalEvent(msg: SignalMessage, identity: AgentIdentity): string {
  return JSON.stringify({
    timestamp: msg.timestamp,
    time: new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    trigger: msg.trigger,
    station: identity.subscribedStation,
    payload: msg.payload,
    queueSize: identity.signalQueue.length,
  }, null, 2);
}
