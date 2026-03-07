import type { AgentIdentity, Ctx, WelcomeData } from "./src/lib/types.js";
import * as agentTools from "./src/tools/agent.js";
import * as propertyTools from "./src/tools/property.js";
import * as boardTools from "./src/tools/boards.js";
import * as receptionTools from "./src/tools/reception.js";
import * as taskTools from "./src/tools/tasks.js";
import { startAutoSpawn } from "./src/autospawn.js";

function getGroup(state: string): string {
  switch (state) {
    case "thinking": case "planning": case "reflecting": return "reasoning";
    case "searching": case "reading": case "querying": case "browsing": return "gathering";
    case "writing_code": case "writing_text": case "generating": return "creating";
    case "talking": return "communicating";
    case "idle": return "idle";
    default: return "custom";
  }
}

export default function register(api: any) {
  const config = (api.pluginConfig || {}) as Record<string, any>;
  const hubUrl = (config.hubUrl || "http://localhost:4242").replace(/\/+$/, "");

  try {
    const parsed = new URL(hubUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      api.logger.error(`[the-agents] FATAL: hubUrl must use http or https, got ${parsed.protocol}`); return;
    }
  } catch {
    api.logger.error(`[the-agents] FATAL: Invalid hubUrl: ${hubUrl}`); return;
  }

  const apiKey = config.apiKey as string | undefined;
  const ownerId = config.ownerId || "default";
  const ownerName = config.ownerName || "Default";
  const agentsConfig = config.agents as Record<string, { name?: string; sprite?: string; hubId?: string }> | undefined;
  const defaultName = config.agentName || "Agent";
  const defaultSprite = config.agentSprite || "";
  const defaultHubId = config.agentId || `openclaw-${Math.random().toString(36).slice(2, 6)}`;
  const agentMap = new Map<string, AgentIdentity>();

  if (agentsConfig) api.logger.info(`[the-agents] Agent map: ${Object.keys(agentsConfig).join(", ")}`);

  function getIdentity(openclawAgentId?: string): AgentIdentity {
    const key = openclawAgentId || "main";
    let identity = agentMap.get(key);
    if (identity) return identity;
    const ac = agentsConfig?.[key];
    identity = {
      hubId: ac?.hubId || (agentsConfig ? key : defaultHubId),
      name: ac?.name || (agentsConfig ? key : defaultName),
      sprite: ac?.sprite || defaultSprite,
      state: "idle", detail: "Agent connected",
      subscribedStation: null, signalWs: null, signalQueue: [], pendingResolve: null,
    };
    agentMap.set(key, identity);
    return identity;
  }

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
    return h;
  }

  function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
  }

  async function reportToHub(
    state: string, detail: string, identity: AgentIdentity,
    idOverride?: string, nameOverride?: string,
    parentAgentId: string | null = null, spriteOverride?: string, note?: string
  ): Promise<WelcomeData | null> {
    const id = idOverride || identity.hubId;
    const name = nameOverride || identity.name;
    if (id === identity.hubId) { identity.state = state; identity.detail = detail; }
    try {
      const res = await fetch(`${hubUrl}/api/state`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          agent_id: id, agent_name: name, state, detail,
          group: getGroup(state), sprite: spriteOverride || identity.sprite,
          owner_id: ownerId, owner_name: ownerName,
          parent_agent_id: parentAgentId,
          ...(note && { note }),
        }),
      });
      const body = await res.json() as { ok: boolean; welcome?: WelcomeData };
      return body.welcome || null;
    } catch (err) {
      api.logger.error("[the-agents] Failed to report to hub:", err);
      return null;
    }
  }

  async function fetchProperty(): Promise<{ assets: import("./src/lib/types.js").Asset[]; [key: string]: unknown }> {
    const res = await fetch(`${hubUrl}/api/property`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) throw new Error(`Hub returned ${res.status}`);
    return res.json();
  }

  const ctx: Ctx = { hubUrl, apiKey, ownerId, ownerName, agentMap, agentsConfig, defaultSprite, logger: api.logger, getIdentity, authHeaders, ok, reportToHub, fetchProperty };

  agentTools.register(ctx, api);
  propertyTools.register(ctx, api);
  boardTools.register(ctx, api);
  receptionTools.register(ctx, api);
  taskTools.register(ctx, api);

  // Gateway detection: first plugin load = gateway, spawned agents = subsequent loads
  const isGateway = !(globalThis as any).__theAgentsInitialized__;
  (globalThis as any).__theAgentsInitialized__ = true;

  if (isGateway) {
    const defaultIdentity = getIdentity("main");
    reportToHub("idle", "Agent connected", defaultIdentity);

    // Heartbeat: keep all non-worker agents alive (hub removes after 5 min)
    const workerHubIds = new Set(
      (config.autoSpawnAgents as string[] | undefined || []).map(id => agentsConfig?.[id]?.hubId || id)
    );
    setInterval(() => {
      for (const identity of agentMap.values()) {
        if (!workerHubIds.has(identity.hubId)) reportToHub(identity.state, identity.detail, identity);
      }
    }, 120_000);

    // Graceful shutdown
    async function cleanup() {
      const removals = [...agentMap.values()].map(identity =>
        fetch(`${hubUrl}/api/agents/${encodeURIComponent(identity.hubId)}`, {
          method: "DELETE", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        }).catch(() => {})
      );
      await Promise.all(removals);
      api.logger.info(`[the-agents] Removed ${removals.length} agent(s) from hub`);
    }
    process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

    if (config.autoSpawn === true && (config.autoSpawnAgents as string[] | undefined)?.length) {
      startAutoSpawn(ctx, config);
    }
  }

  const agentNames = agentsConfig
    ? Object.entries(agentsConfig).map(([k, v]) => `${v.name || k} (${k})`).join(", ")
    : `${defaultName} (${defaultHubId})`;
  api.logger.info(`[the-agents] Reporting to ${hubUrl} — agents: ${agentNames}${isGateway ? "" : " (agent mode)"}`);
}
