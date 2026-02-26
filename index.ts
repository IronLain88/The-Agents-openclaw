import WebSocket from "ws";

// --- State → Group mapping (same as MCP server) ---

function getGroup(state: string): string {
  switch (state) {
    case "thinking":
    case "planning":
    case "reflecting":
      return "reasoning";
    case "searching":
    case "reading":
    case "querying":
    case "browsing":
      return "gathering";
    case "writing_code":
    case "writing_text":
    case "generating":
      return "creating";
    case "talking":
      return "communicating";
    case "idle":
      return "idle";
    default:
      return "custom";
  }
}

// --- Types ---

interface SignalMessage {
  type: string;
  station: string;
  trigger: string;
  timestamp: number;
  payload?: unknown;
}

// --- Plugin entry point ---

export default function register(api: any) {
  const config = (api.pluginConfig || {}) as Record<string, string | undefined>;
  const hubUrl = config.hubUrl || "http://localhost:3000";

  // Validate hubUrl protocol
  try {
    const parsed = new URL(hubUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      api.logger.error(`[the-agents] FATAL: hubUrl must use http or https, got ${parsed.protocol}`);
      return;
    }
  } catch {
    api.logger.error(`[the-agents] FATAL: Invalid hubUrl: ${hubUrl}`);
    return;
  }

  const apiKey = config.apiKey;
  const configAgentId = config.agentId || `openclaw-${Math.random().toString(36).slice(2, 6)}`;
  let agentName = config.agentName || "Agent";
  const agentSprite = config.agentSprite || "";
  const ownerId = config.ownerId || "default";
  const ownerName = config.ownerName || "Default";

  // Detect subagent context from environment or API context
  const sessionKey = process.env.OPENCLAW_SESSION_KEY || "";
  const isSubagent = sessionKey.includes(":subagent:") || api.isSubagent === true;
  const parentAgentId = isSubagent ? config.parentAgentId || sessionKey.split(":subagent:")[0].split(":").pop() || null : null;
  
  // Generate subagent-specific ID if in subagent context
  let agentId = configAgentId;
  let subagentLabel: string | null = null;
  if (isSubagent && parentAgentId) {
    subagentLabel = process.env.OPENCLAW_SUBAGENT_LABEL || `sub-${Math.random().toString(36).slice(2, 6)}`;
    agentId = `${parentAgentId}:${subagentLabel}`;
    // Auto-append subagent indicator to name if not already present
    if (!agentName.toLowerCase().includes("subagent")) {
      agentName = `${agentName} (subagent)`;
    }
  }

  // --- Helpers ---

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
    return h;
  }

  let currentState = "idle";
  let currentDetail = "Agent connected";

  function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
  }

  async function reportToHub(
    state: string,
    detail: string,
    id = agentId,
    name = agentName,
    parentAgentId: string | null = null,
    sprite = agentSprite
  ) {
    // Track main agent's current state for keepalive
    if (id === agentId) {
      currentState = state;
      currentDetail = detail;
    }
    try {
      await fetch(`${hubUrl}/api/state`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: id,
          agent_name: name,
          state,
          detail,
          group: getGroup(state),
          sprite,
          owner_id: ownerId,
          owner_name: ownerName,
          parent_agent_id: parentAgentId,
        }),
      });
    } catch (err) {
      api.logger.error("[the-agents] Failed to report to hub:", err);
    }
  }

  // --- Signal state ---

  let signalWs: WebSocket | null = null;
  let subscribedStation: string | null = null;
  let pendingResolve: ((msg: SignalMessage) => void) | null = null;
  const signalQueue: SignalMessage[] = [];
  const MAX_QUEUE_SIZE = 50;

  function connectSignalWs() {
    const wsUrl = hubUrl.replace(/^http/, "ws");
    signalWs = new WebSocket(wsUrl);
    signalWs.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "signal" && msg.station === subscribedStation) {
          if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(msg);
          } else {
            signalQueue.push(msg);
            if (signalQueue.length > MAX_QUEUE_SIZE) signalQueue.shift();
          }
        }
      } catch {}
    });
    signalWs.on("close", () => {
      signalWs = null;
      if (subscribedStation) setTimeout(connectSignalWs, 3_000);
    });
    signalWs.on("error", () => {});
  }

  function formatSignalEvent(msg: SignalMessage): string {
    return JSON.stringify({
      timestamp: msg.timestamp,
      time: new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      trigger: msg.trigger,
      station: subscribedStation,
      payload: msg.payload,
      queueSize: signalQueue.length,
    }, null, 2);
  }

  // --- Tools ---

  api.registerTool({
    name: "update_state",
    label: "Update State",
    description:
      "Update the agent's visualization state. Built-in states: thinking, planning, reflecting (reasoning); " +
      "searching, reading, querying, browsing (gathering); writing_code, writing_text, generating (creating); " +
      "talking (communicating); idle. Custom states work if matching station exists on property.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", description: "The agent activity state" },
        detail: { type: "string", description: "Concise description of what the agent is doing" },
        note: { type: "string", description: "Optional reflection note for the previous station (max 2 sentences)" },
      },
      required: ["state", "detail"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const state = params.state as string;
      const detail = params.detail as string;
      if (isSubagent && parentAgentId) {
        await reportToHub(state, detail, agentId, agentName, parentAgentId, agentSprite);
      } else {
        await reportToHub(state, detail);
      }
      return ok(`State updated to "${state}" (${getGroup(state)}): ${detail}`);
    },
  });

  api.registerTool({
    name: "update_subagent_state",
    label: "Update Subagent State",
    description:
      "Report a subagent's activity state. Subagents render smaller with cyan labels, linked to parent agent.",
    parameters: {
      type: "object",
      properties: {
        subagent_id: { type: "string", description: "Unique ID for the subagent" },
        subagent_name: { type: "string", description: "Display name for the subagent" },
        state: { type: "string", description: "The subagent's activity state" },
        detail: { type: "string", description: "What the subagent is doing" },
        sprite: { type: "string", description: "Character sprite name. Defaults to parent's sprite." },
      },
      required: ["subagent_id", "subagent_name", "state", "detail"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const { subagent_id, subagent_name, state, detail, sprite } = params as any;
      await reportToHub(state, detail, `${agentId}:${subagent_id}`, subagent_name, agentId, sprite);
      return ok(`Subagent "${subagent_name}" (${subagent_id}) state: "${state}" — ${detail}`);
    },
  });

  api.registerTool({
    name: "set_name",
    label: "Set Name",
    description: "Set this agent's display name at runtime.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The display name" },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const name = params.name as string;
      agentName = name;
      await reportToHub("idle", `Renamed to ${name}`);
      return ok(`Agent name set to "${name}"`);
    },
  });

  api.registerTool({
    name: "get_village_info",
    label: "Get Village Info",
    description:
      "Get a compact onboarding summary of The Agents visualization system. " +
      "Call once at the start of a session to understand available states, tools, and conventions.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const info = [
        "# The Agents — Quick Reference",
        "",
        "## Built-in States",
        "Your character walks to furniture tagged with the matching station name.",
        "",
        "| State | Group | Description |",
        "|-------|-------|-------------|",
        "| thinking | reasoning | Analyzing a problem |",
        "| planning | reasoning | Designing an approach |",
        "| reflecting | reasoning | Reviewing work |",
        "| searching | gathering | Searching for files or patterns |",
        "| reading | gathering | Reading files or docs |",
        "| querying | gathering | Querying databases or APIs |",
        "| browsing | gathering | Browsing the web |",
        "| writing_code | creating | Writing or editing code |",
        "| writing_text | creating | Writing text or docs |",
        "| generating | creating | Generating assets or output |",
        "| talking | communicating | Talking to the user |",
        "| idle | idle | Finished or waiting |",
        "",
        "## Custom States",
        "Any station name tagged on property furniture works as a state.",
        "",
        "## Conventions",
        "- Update state at EVERY transition",
        "- Use concise but descriptive detail strings",
        "- Set state to idle when done and awaiting input",
        "",
        "## Tools",
        "- **State**: update_state, update_subagent_state, set_name",
        "- **Bulletin Board**: post_to_board, read_board",
        "- **Signals**: subscribe, check_events, fire_signal",
      ].join("\n");
      return ok(info);
    },
  });

  api.registerTool({
    name: "post_to_board",
    label: "Post to Board",
    description:
      "Post content to a station's bulletin board. The station must exist as an asset on the property.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station name, e.g. \"News Desk\"" },
        data: { type: "string", description: "Content to post (max 10KB)" },
        type: { type: "string", enum: ["text", "markdown", "json"], description: "Content type (default: text)" },
      },
      required: ["station", "data"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const station = params.station as string;
      const data = params.data as string;
      const type = params.type as string | undefined;
      try {
        const body: Record<string, unknown> = { data };
        if (type) body.type = type;
        const res = await fetch(`${hubUrl}/api/board/${encodeURIComponent(station)}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          return ok(`Post failed: ${(err as any).error}`);
        }
        await reportToHub(station, `Posted to board: ${data.slice(0, 80)}`);
        return ok(`Posted to "${station}" board (${data.length} chars)`);
      } catch (err) {
        return ok(`Post failed: ${err}`);
      }
    },
  });

  api.registerTool({
    name: "read_board",
    label: "Read Board",
    description:
      "Read a bulletin board from any hub (local or remote). Returns the station's content and activity log.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station name to read" },
        url: { type: "string", description: "Hub URL (defaults to local hub). Must be http/https." },
      },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const station = params.station as string;
      const url = params.url as string | undefined;
      const target = url || hubUrl;
      try {
        const parsed = new URL(target);
        if (!["http:", "https:"].includes(parsed.protocol)) return ok("Error: URL must use http or https");
      } catch {
        return ok(`Error: Invalid URL "${target}"`);
      }
      try {
        const res = await fetch(`${target}/api/board/${encodeURIComponent(station)}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          return ok(`Read failed: ${(err as any).error}`);
        }
        const board = await res.json() as any;
        const parts: string[] = [`# Board: ${board.station}`];
        if (board.content) {
          parts.push("", `## Content (${board.content.type})`, board.content.data);
          if (board.content.publishedAt) parts.push(`\n*Published: ${board.content.publishedAt}*`);
        } else {
          parts.push("", "*No content posted yet.*");
        }
        if (board.log) parts.push("", "## Activity Log", board.log);
        if (!url || url === hubUrl) await reportToHub(station, "Reading board");
        return ok(parts.join("\n"));
      } catch (err) {
        return ok(`Read failed: ${err}`);
      }
    },
  });

  api.registerTool({
    name: "subscribe",
    label: "Subscribe to Signal",
    description:
      "Subscribe to a signal asset on the property. After subscribing, call check_events to wait for the next event.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The signal station name. Must match an asset with a trigger on the property." },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const name = params.name as string;
      try {
        const res = await fetch(`${hubUrl}/api/property`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        if (!res.ok) return ok(`Failed to fetch property: ${res.statusText}`);
        const property = await res.json() as any;
        const asset = (property.assets || []).find((a: any) => a.station === name && a.trigger);
        if (!asset) return ok(`No signal named "${name}" found on property`);
        subscribedStation = name;
        if (!signalWs || signalWs.readyState !== WebSocket.OPEN) connectSignalWs();
        await reportToHub(name, `Listening for ${asset.trigger} signal`);
        return ok(`Subscribed to "${name}" (${asset.trigger} every ${asset.trigger_interval || 1} min)`);
      } catch (err) {
        return ok(`Subscribe failed: ${err}`);
      }
    },
  });

  api.registerTool({
    name: "check_events",
    label: "Check Events",
    description:
      "Block until the subscribed signal fires (up to 10 min timeout). Buffered signals are returned immediately (FIFO). Call subscribe first.",
    parameters: { type: "object", properties: {} },
    async execute() {
      if (!subscribedStation) return ok("Not subscribed to any signal. Call subscribe first.");
      if (!signalWs || signalWs.readyState !== WebSocket.OPEN) connectSignalWs();

      const keepAlive = setInterval(() => {
        reportToHub(subscribedStation!, "Listening for signal");
      }, 30_000);

      try {
        if (signalQueue.length > 0) {
          return ok(formatSignalEvent(signalQueue.shift()!));
        }
        const msg = await new Promise<SignalMessage>((resolve, reject) => {
          pendingResolve = resolve;
          setTimeout(() => {
            if (pendingResolve === resolve) {
              pendingResolve = null;
              reject(new Error("timeout"));
            }
          }, 10 * 60_000);
        });
        return ok(formatSignalEvent(msg));
      } catch {
        return ok("No events (timeout)");
      } finally {
        clearInterval(keepAlive);
      }
    },
  });

  api.registerTool({
    name: "fire_signal",
    label: "Fire Signal",
    description:
      "Fire a signal on the property. All subscribed agents receive the event via check_events.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The signal station name to fire" },
        payload: { description: "Optional payload data (requires ALLOW_SIGNAL_PAYLOADS=true on hub)" },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const name = params.name as string;
      const payload = params.payload;
      try {
        const body: Record<string, unknown> = { station: name };
        if (payload !== undefined) body.payload = payload;
        const res = await fetch(`${hubUrl}/api/signals/fire`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        if (!res.ok) return ok(`Fire failed: ${res.statusText}`);
        return ok(`Fired signal "${name}"`);
      } catch (err) {
        return ok(`Fire failed: ${err}`);
      }
    },
  });

  // Register as idle on startup + keepalive every 30s
  if (isSubagent && parentAgentId && subagentLabel) {
    // Subagent: report with parent link
    reportToHub("idle", "Subagent connected", agentId, agentName, parentAgentId, agentSprite);
    setInterval(() => reportToHub(currentState, currentDetail, agentId, agentName, parentAgentId, agentSprite), 30_000);
    api.logger.info(`[the-agents] Reporting to ${hubUrl} as subagent "${agentName}" (${agentId}) with parent ${parentAgentId}`);
  } else {
    // Main agent: normal report
    reportToHub("idle", "Agent connected");
    setInterval(() => reportToHub(currentState, currentDetail), 30_000);
    api.logger.info(`[the-agents] Reporting to ${hubUrl} as "${agentName}" (${agentId})`);
  }
}
