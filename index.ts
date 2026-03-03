import WebSocket from "ws";
import { readFile } from "fs/promises";
import { resolve, sep } from "path";

// --- State -> Group mapping ---

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

// --- Asset lookup helper ---

interface Asset {
  id: string;
  name?: string;
  position: { x: number; y: number } | null;
  station?: string;
  content?: { type: string; data: string; source?: string; publishedAt?: string };
  trigger?: string;
  trigger_interval?: number;
}

function findAsset(assets: Asset[], query: string): Asset | undefined {
  return assets.find(a => a.id === query)
    || assets.find(a => (a.name || a.id).toLowerCase().includes(query.toLowerCase()));
}

interface SignalMessage {
  type: string;
  station: string;
  trigger: string;
  timestamp: number;
  payload?: unknown;
}

// --- Per-agent identity & state ---

interface AgentIdentity {
  hubId: string;   // ID on the hub (e.g. "lain-main", "yuki")
  name: string;    // Display name (e.g. "Lain", "Yuki")
  sprite: string;  // Sprite name
  state: string;
  detail: string;
  subscribedStation: string | null;
  signalWs: WebSocket | null;
  signalQueue: SignalMessage[];
  pendingResolve: ((msg: SignalMessage) => void) | null;
}

// --- Plugin entry point ---

export default function register(api: any) {
  const config = (api.pluginConfig || {}) as Record<string, any>;
  const hubUrl = config.hubUrl || "http://localhost:4242";

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

  const apiKey = config.apiKey as string | undefined;
  const ownerId = config.ownerId || "default";
  const ownerName = config.ownerName || "Default";

  // Per-agent identity map: openclaw agentId -> hub identity
  const agentMap = new Map<string, AgentIdentity>();
  const agentsConfig = config.agents as Record<string, { name?: string; sprite?: string; hubId?: string }> | undefined;
  if (agentsConfig) api.logger.info(`[the-agents] Agent map: ${Object.keys(agentsConfig).join(", ")}`);

  // Legacy flat config fallback
  const defaultName = config.agentName || "Agent";
  const defaultSprite = config.agentSprite || "";
  const defaultHubId = config.agentId || `openclaw-${Math.random().toString(36).slice(2, 6)}`;

  function getIdentity(openclawAgentId?: string): AgentIdentity {
    const key = openclawAgentId || "main";
    let identity = agentMap.get(key);
    if (identity) return identity;

    // Create new identity from agents config or legacy fallback
    const ac = agentsConfig?.[key];
    identity = {
      hubId: ac?.hubId || (agentsConfig ? key : defaultHubId),
      name: ac?.name || (agentsConfig ? key : defaultName),
      sprite: ac?.sprite || defaultSprite,
      state: "idle",
      detail: "Agent connected",
      subscribedStation: null,
      signalWs: null,
      signalQueue: [],
      pendingResolve: null,
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

  interface WelcomeData {
    stations: string[];
    signals: string[];
    boards: string[];
    tasks: string[];
    inbox: number;
    agents: { name: string; state: string }[];
  }

  function formatWelcome(w: WelcomeData): string {
    const lines: string[] = ["## Welcome to your property\n"];
    if (w.agents.length > 0) {
      const others = w.agents.map(a => `${a.name} (${a.state})`).join(", ");
      lines.push(`**Active:** ${others}`);
    }
    lines.push(`**Stations:** ${w.stations.join(", ") || "none"}`);
    if (w.inbox > 0) lines.push(`**Inbox:** ${w.inbox} message(s)`);
    if (w.tasks?.length > 0) {
      lines.push(`**Task stations (interactive — visitors trigger these, you do the work):**`);
      for (const t of w.tasks) lines.push(`  - ${t}`);
      lines.push(`*Workflow: work_task({station}) → do the work (call update_state at each step!) → answer_task({station, result}) → work_task again*`);
    }
    if (w.signals.length > 0) lines.push(`**Signals:** ${w.signals.join(", ")}`);
    if (w.boards.length > 0) lines.push(`**Boards with content:** ${w.boards.join(", ")}`);
    return lines.join("\n");
  }

  async function reportToHub(
    state: string, detail: string, identity: AgentIdentity,
    idOverride?: string, nameOverride?: string,
    parentAgentId: string | null = null,
    spriteOverride?: string, note?: string
  ): Promise<WelcomeData | null> {
    const id = idOverride || identity.hubId;
    const name = nameOverride || identity.name;
    const sprite = spriteOverride || identity.sprite;
    if (id === identity.hubId) { identity.state = state; identity.detail = detail; }
    try {
      const res = await fetch(`${hubUrl}/api/state`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: id, agent_name: name, state, detail,
          group: getGroup(state), sprite,
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

  async function fetchProperty(): Promise<{ assets: Asset[]; [key: string]: unknown }> {
    const res = await fetch(`${hubUrl}/api/property`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`Hub returned ${res.status}`);
    return await res.json();
  }

  // --- Signal WebSocket per agent ---

  function connectSignalWs(identity: AgentIdentity) {
    const wsUrl = hubUrl.replace(/^http/, "ws");
    identity.signalWs = new WebSocket(wsUrl);
    identity.signalWs.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "signal" && msg.station === identity.subscribedStation) {
          if (identity.pendingResolve) { const r = identity.pendingResolve; identity.pendingResolve = null; r(msg); }
          else { identity.signalQueue.push(msg); if (identity.signalQueue.length > 50) identity.signalQueue.shift(); }
        }
      } catch {}
    });
    identity.signalWs.on("close", () => { identity.signalWs = null; if (identity.subscribedStation) setTimeout(() => connectSignalWs(identity), 3_000); });
    identity.signalWs.on("error", () => {});
  }

  function formatSignalEvent(msg: SignalMessage, identity: AgentIdentity): string {
    return JSON.stringify({
      timestamp: msg.timestamp,
      time: new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      trigger: msg.trigger, station: identity.subscribedStation,
      payload: msg.payload, queueSize: identity.signalQueue.length,
    }, null, 2);
  }

  async function readInbox(name = "inbox"): Promise<{ from: string; text: string; timestamp: string }[]> {
    try {
      const res = await fetch(`${hubUrl}/api/board/${encodeURIComponent(name)}`, { headers: authHeaders() });
      if (!res.ok) return [];
      const board = await res.json() as any;
      if (!board.content?.data) return [];
      return JSON.parse(board.content.data);
    } catch { return []; }
  }

  // --- Identity-aware tools (factories with ctx.agentId) ---

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "update_state",
        label: "Update State",
        description:
          "Update the agent visualization state. Built-in states: thinking, planning, reflecting (reasoning); " +
          "searching, reading, querying, browsing (gathering); writing_code, writing_text, generating (creating); " +
          "talking (communicating); idle. Custom states work if matching station exists on property.",
        parameters: {
          type: "object",
          properties: {
            state: { type: "string", description: "The agent activity state" },
            detail: { type: "string", description: "Concise description of what the agent is doing" },
            note: { type: "string", description: "Optional reflection note for the previous station" },
          },
          required: ["state", "detail"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const state = params.state as string;
          const detail = params.detail as string;
          const note = params.note as string | undefined;
          const welcome = await reportToHub(state, detail, identity, undefined, undefined, null, undefined, note);
          const msg = `State updated to "${state}" (${getGroup(state)}): ${detail}`;
          return ok(welcome ? `${msg}\n\n${formatWelcome(welcome)}` : msg);
        },
      };
    },
    { names: ["update_state"] }
  );

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "update_subagent_state",
        label: "Update Subagent State",
        description: "Report a subagent activity state. Subagents render smaller with cyan labels, linked to parent agent.",
        parameters: {
          type: "object",
          properties: {
            subagent_id: { type: "string", description: "Unique ID for the subagent" },
            subagent_name: { type: "string", description: "Display name for the subagent" },
            state: { type: "string", description: "The subagent activity state" },
            detail: { type: "string", description: "What the subagent is doing" },
            sprite: { type: "string", description: "Character sprite name. Defaults to parent sprite." },
          },
          required: ["subagent_id", "subagent_name", "state", "detail"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const { subagent_id, subagent_name, state, detail, sprite } = params as any;
          await reportToHub(state, detail, identity, `${identity.hubId}:${subagent_id}`, subagent_name, identity.hubId, sprite);
          return ok(`Subagent "${subagent_name}" (${subagent_id}) state: "${state}" - ${detail}`);
        },
      };
    },
    { names: ["update_subagent_state"] }
  );

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "set_name",
        label: "Set Name",
        description: "Set this agent display name at runtime.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The display name" } },
          required: ["name"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          identity.name = params.name as string;
          await reportToHub("idle", `Renamed to ${identity.name}`, identity);
          return ok(`Agent name set to "${identity.name}"`);
        },
      };
    },
    { names: ["set_name"] }
  );

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "subscribe",
        label: "Subscribe to Signal",
        description: "Subscribe to a signal or task station. For tasks: subscribe → check_events (returns instructions) → do work → answer_task.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Signal station name" } },
          required: ["name"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const p = await fetchProperty();
            const asset = (p.assets || []).find((a: Asset) => a.station === (params.name as string) && a.trigger);
            if (!asset) return ok(`No signal named "${params.name}" found`);
            identity.subscribedStation = params.name as string;
            if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity);
            await reportToHub(identity.subscribedStation, `Listening for ${asset.trigger} signal`, identity);
            return ok(`Subscribed to "${params.name}" (${asset.trigger} every ${asset.trigger_interval || 1} min)`);
          } catch (err) { return ok(`Subscribe failed: ${err}`); }
        },
      };
    },
    { names: ["subscribe"] }
  );

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "check_events",
        label: "Check Events",
        description: "Wait for the next event on your subscribed station (up to 10 min). For tasks, the event payload contains {station, instructions} telling you what to do.",
        parameters: { type: "object", properties: {} },
        async execute() {
          if (!identity.subscribedStation) return ok("Not subscribed. Call subscribe first.");
          if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity);
          const keepAlive = setInterval(() => { reportToHub(identity.subscribedStation!, "Listening for signal", identity); }, 30_000);
          try {
            let event: string;
            if (identity.signalQueue.length > 0) { event = formatSignalEvent(identity.signalQueue.shift()!, identity); }
            else {
              const msg = await new Promise<SignalMessage>((resolve, reject) => {
                identity.pendingResolve = resolve;
                setTimeout(() => { if (identity.pendingResolve === resolve) { identity.pendingResolve = null; reject(new Error("timeout")); } }, 10 * 60_000);
              });
              event = formatSignalEvent(msg, identity);
            }
            const inbox = await readInbox();
            if (inbox.length > 0) event += `\n\n📬 You have ${inbox.length} unread message${inbox.length > 1 ? "s" : ""}. Call check_inbox to read them.`;
            return ok(event + "\n\nRemember to call update_state for your next activity.");
          } catch { return ok("No events (timeout). Remember to call update_state for your next activity."); }
          finally { clearInterval(keepAlive); }
        },
      };
    },
    { names: ["check_events"] }
  );

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "send_message",
        label: "Send Message",
        description: "Send a message to an inbox. Your agent name is used as the sender.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Message text" },
            inbox: { type: "string", description: 'Target inbox name (default: "inbox").' },
          },
          required: ["text"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const target = (params.inbox as string) || "inbox";
          try {
            const res = await fetch(`${hubUrl}/api/inbox/${encodeURIComponent(target)}`, {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ from: identity.name, text: params.text }),
            });
            if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Send failed: ${(e as any).error}`); }
            const { count } = await res.json() as { count: number };
            return ok(`Message sent to ${target} (${count} total)`);
          } catch (err) { return ok(`Send failed: ${err}`); }
        },
      };
    },
    { names: ["send_message"] }
  );

  // --- Static tools (no per-agent identity needed) ---

  api.registerTool({
    name: "get_village_info",
    label: "Get Village Info",
    description: "Get a summary of your property: available stations, signals, boards, and inbox.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const lines = [
        "# The Agents",
        "",
        "You have a property — a tile grid with furniture. Each furniture piece can be tagged with a **station** name.",
        "When you call `update_state({ state, detail })`, your character walks to the matching station.",
        "Update state at EVERY transition. Set idle when done.",
        "",
      ];
      try {
        const p = await fetchProperty();
        const assets = p.assets || [];
        const stations: string[] = [];
        const signals: string[] = [];
        const tasks: string[] = [];
        const boards: string[] = [];
        let inboxCount = 0;
        for (const a of assets) {
          if (!a.station) continue;
          if ((a as any).task) {
            tasks.push(`${a.station} — ${(a as any).instructions || "(no instructions)"}`);
            continue;
          }
          if (a.trigger) {
            signals.push(`${a.name || a.station} (${a.trigger}, every ${a.trigger_interval || 1} min)`);
          } else if (a.station === "inbox" && a.content?.data) {
            try { const msgs = JSON.parse(a.content.data); if (Array.isArray(msgs)) inboxCount += msgs.length; } catch {}
            if (!stations.includes(a.station)) stations.push(a.station);
          } else {
            if (!stations.includes(a.station)) stations.push(a.station);
            if (a.content?.data) boards.push(a.name || a.station);
          }
        }
        lines.push("## Your Property");
        lines.push(`**Stations:** ${stations.join(", ") || "none"}`);
        if (inboxCount > 0) lines.push(`**Inbox:** ${inboxCount} message(s)`);
        if (tasks.length > 0) {
          lines.push(`**Task stations (interactive — visitors trigger these, you do the work):**`);
          for (const t of tasks) lines.push(`  - ${t}`);
          lines.push(`*Workflow: work_task({station}) → do the work (call update_state at each step!) → answer_task({station, result}) → work_task again*`);
        }
        if (signals.length > 0) lines.push(`**Signals:** ${signals.join(", ")}`);
        if (boards.length > 0) lines.push(`**Boards with content:** ${boards.join(", ")}`);
        lines.push(`**Total assets:** ${assets.length}`);
      } catch {
        lines.push("*(Could not fetch property)*");
      }
      return ok(lines.join("\n"));
    },
  });

  api.registerTool({
    name: "sync_property",
    label: "Sync Property",
    description: "Sync property to hub after making changes",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const p = await fetchProperty();
        return ok(`Property synced (${(p.assets || []).length} assets)`);
      } catch (err) { return ok(`Sync failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "list_assets",
    label: "List Assets",
    description: "List all assets on your property",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const p = await fetchProperty();
        const assets = p.assets || [];
        if (!assets.length) return ok("No assets on property");
        return ok(assets.map((a: Asset) => {
          const pos = a.position ? `(${a.position.x}, ${a.position.y})` : "inventory";
          const sta = a.station ? ` [station: ${a.station}]` : "";
          return `- ${a.name || a.id} - ${pos}${sta}`;
        }).join("\n"));
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "add_asset",
    label: "Add Asset",
    description: "Add a new asset to your property",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name" },
        tileset: { type: "string", description: "Tileset name" },
        tx: { type: "number", description: "Tile X in tileset" },
        ty: { type: "number", description: "Tile Y in tileset" },
        x: { type: "number", description: "X position (omit for inventory)" },
        y: { type: "number", description: "Y position (omit for inventory)" },
        station: { type: "string", description: "Agent state when at this asset" },
        approach: { type: "string", enum: ["above", "below", "left", "right"], description: "Approach direction" },
        collision: { type: "boolean", description: "Block movement" },
        remote_url: { type: "string", description: "Remote hub URL to read a board from another property" },
        remote_station: { type: "string", description: "Station name on the remote hub" },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const body: Record<string, unknown> = { name: params.name };
        for (const k of ["tileset", "tx", "ty", "x", "y", "station", "approach", "collision", "remote_url", "remote_station"])
          if (params[k] !== undefined) body[k] = params[k];
        const res = await fetch(`${hubUrl}/api/assets`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ok(`Added "${params.name}" (${asset.id}) ${asset.position ? `at (${asset.position.x}, ${asset.position.y})` : "in inventory"}`);
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "remove_asset",
    label: "Remove Asset",
    description: "Remove an asset from your property",
    parameters: {
      type: "object",
      properties: { asset_id: { type: "string", description: "ID of asset to remove" } },
      required: ["asset_id"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, { method: "DELETE", headers: authHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Failed: ${(e as any).error}`); }
        const { removed } = await res.json() as { removed: Asset };
        return ok(`Removed "${removed.name || removed.id}"`);
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "move_asset",
    label: "Move Asset",
    description: "Move an asset to a new position",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "ID of asset to move" },
        x: { type: "number", description: "New X position" },
        y: { type: "number", description: "New Y position" },
      },
      required: ["asset_id", "x", "y"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, {
          method: "PATCH", headers: authHeaders(), body: JSON.stringify({ position: { x: params.x, y: params.y } }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ok(`Moved "${asset.name || asset.id}" to (${params.x}, ${params.y})`);
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "attach_content",
    label: "Attach Content",
    description: "Attach content to an asset from a local file",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "ID of asset" },
        file_path: { type: "string", description: "Path to file" },
      },
      required: ["asset_id", "file_path"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const fp = params.file_path as string;
        const projectRoot = resolve(process.cwd());
        const resolved = resolve(fp);
        if (!resolved.startsWith(projectRoot + sep) && resolved !== projectRoot) {
          return ok("Error: path must be within project directory");
        }
        const data = await readFile(fp, "utf-8");
        const ext = fp.split(".").pop() || "txt";
        const type = ext === "md" ? "markdown" : ext === "json" ? "json" : "text";
        const res = await fetch(`${hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ content: { type, data, source: fp, publishedAt: new Date().toISOString() } }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ok(`Attached ${fp} to "${asset.name || asset.id}"`);
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "read_asset_content",
    label: "Read Asset Content",
    description: "Read content attached to an asset by name or ID",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Asset name or ID (fuzzy match)" } },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const p = await fetchProperty();
        const asset = findAsset(p.assets || [], params.name as string);
        if (!asset) return ok(`Asset "${params.name}" not found. Use list_assets to see available assets.`);
        if (!asset.content) return ok(`Asset "${asset.name || asset.id}" has no content.`);
        const footer = asset.content.source ? `\n\n---\n*Source: ${asset.content.source}*` : "";
        return ok(`# ${asset.name || asset.id}\n\n${asset.content.data}${footer}`);
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  // --- Bulletin Board ---

  api.registerTool({
    name: "post_to_board",
    label: "Post to Board",
    description: "Post content to a station bulletin board",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station name" },
        data: { type: "string", description: "Content to post (max 10KB)" },
        type: { type: "string", enum: ["text", "markdown", "json"], description: "Content type" },
      },
      required: ["station", "data"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const body: Record<string, unknown> = { data: params.data };
        if (params.type) body.type = params.type;
        const res = await fetch(`${hubUrl}/api/board/${encodeURIComponent(params.station as string)}`, {
          method: "POST", headers: authHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Post failed: ${(e as any).error}`); }
        return ok(`Posted to "${params.station}" (${(params.data as string).length} chars)`);
      } catch (err) { return ok(`Post failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "read_board",
    label: "Read Board",
    description: "Read a bulletin board from any hub",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station name" },
        url: { type: "string", description: "Hub URL (defaults to local)" },
      },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const target = (params.url as string) || hubUrl;
      try { const p = new URL(target); if (!["http:", "https:"].includes(p.protocol)) return ok("Error: URL must use http or https"); }
      catch { return ok(`Error: Invalid URL "${target}"`); }
      try {
        const res = await fetch(`${target}/api/board/${encodeURIComponent(params.station as string)}`);
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Read failed: ${(e as any).error}`); }
        const board = await res.json() as any;
        const parts: string[] = [`# Board: ${board.station}`];
        if (board.content) {
          parts.push("", `## Content (${board.content.type})`, board.content.data);
          if (board.content.publishedAt) parts.push(`\n*Published: ${board.content.publishedAt}*`);
        } else { parts.push("", "*No content posted yet.*"); }
        if (board.log) parts.push("", "## Activity Log", board.log);
        return ok(parts.join("\n"));
      } catch (err) { return ok(`Read failed: ${err}`); }
    },
  });

  // --- Inbox ---

  api.registerTool({
    name: "check_inbox",
    label: "Check Inbox",
    description: "Check your inbox for messages from humans or other agents.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Inbox name (default: "inbox").' },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const inbox = (params.name as string) || "inbox";
      try {
        const messages = await readInbox(inbox);
        if (!messages.length) return ok(`${inbox} is empty.`);
        const lines = messages.map(m => {
          const time = m.timestamp
            ? new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
            : "";
          return `- ${m.from}${time ? ` (${time})` : ""}: ${m.text}`;
        });
        return ok(`${messages.length} message(s):\n${lines.join("\n")}`);
      } catch (err) { return ok(`Check failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "clear_inbox",
    label: "Clear Inbox",
    description: "Clear all messages from the inbox.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Inbox name to clear (default: "inbox").' },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const target = (params.name as string) || "inbox";
      try {
        const res = await fetch(`${hubUrl}/api/inbox/${encodeURIComponent(target)}`, { method: "DELETE", headers: authHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Clear failed: ${(e as any).error}`); }
        return ok(`${target} cleared`);
      } catch (err) { return ok(`Clear failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "get_status",
    label: "Get Status",
    description: "Get a quick status overview: active agents, inbox messages, and recent activity.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const res = await fetch(`${hubUrl}/api/status`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
        if (!res.ok) throw new Error(`Hub returned ${res.status}`);
        const status = await res.json() as {
          agents: { name: string; state: string; detail: string; idle: boolean; sub?: boolean }[];
          inbox: { count: number; latest: string | null };
          activity: { agent: string; state: string; detail: string; t: number }[];
          stations: string[];
        };
        const lines: string[] = [`## Property Status\n`];
        lines.push(`**Agents (${status.agents.length}):**`);
        for (const a of status.agents) {
          const tag = a.sub ? " (sub)" : "";
          lines.push(`- ${a.name}${tag}: ${a.state} — ${a.detail || "idle"}`);
        }
        lines.push(status.inbox.count > 0 ? `\n**Inbox: ${status.inbox.count} message(s)**` : `\n**Inbox: empty**`);
        if (status.activity.length > 0) {
          lines.push(`\n**Recent Activity:**`);
          for (const e of status.activity) lines.push(`- ${e.agent}: ${e.detail}`);
        }
        lines.push(`\n**Active Stations:** ${status.stations.join(", ") || "none"}`);
        return ok(lines.join("\n"));
      } catch (err) { return ok(`Status check failed: ${err}`); }
    },
  });

  // --- Signals ---

  api.registerTool({
    name: "fire_signal",
    label: "Fire Signal",
    description: "Fire a signal on the property",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Signal station name" },
        payload: { description: "Optional payload data" },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const body: Record<string, unknown> = { station: params.name };
        if (params.payload !== undefined) body.payload = params.payload;
        const res = await fetch(`${hubUrl}/api/signals/fire`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
        if (!res.ok) return ok(`Fire failed: ${res.statusText}`);
        return ok(`Fired signal "${params.name}"`);
      } catch (err) { return ok(`Fire failed: ${err}`); }
    },
  });

  // --- Reception ---

  api.registerTool({
    name: "read_reception",
    label: "Read Reception",
    description: "Read a reception station's private instructions and current Q&A state.",
    parameters: {
      type: "object",
      properties: { station: { type: "string", description: "Reception station name" } },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const p = await fetchProperty();
        const asset = (p.assets || []).find((a: any) => a.station === params.station && a.reception);
        if (!asset) return ok(`No reception station "${params.station}" found`);
        const parts: string[] = [`# Reception: ${params.station}\n`];
        const instructions = (asset as any).instructions;
        if (instructions) parts.push(`## Instructions\n${instructions}\n`);
        let state = { status: "idle", question: null as string | null, answer: null as string | null };
        try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
        parts.push(`## Status: ${state.status}`);
        if (state.status === "pending" && state.question) parts.push(`\n## Question\n${state.question}`);
        else if (state.status === "answered") { parts.push(`\nQuestion: ${state.question}`); parts.push("Answer already posted."); }
        else parts.push("\nNo pending questions. Subscribe and wait for visitors.");
        return ok(parts.join("\n"));
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "answer_reception",
    label: "Answer Reception",
    description: "Post an HTML answer to a pending reception question.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Reception station name" },
        answer: { type: "string", description: "HTML answer to display" },
      },
      required: ["station", "answer"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${hubUrl}/api/reception/${encodeURIComponent(params.station as string)}/answer`, {
          method: "POST", headers: authHeaders(), body: JSON.stringify({ answer: params.answer }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Answer failed: ${(e as any).error}`); }
        return ok(`Answer posted to "${params.station}"`);
      } catch (err) { return ok(`Answer failed: ${err}`); }
    },
  });

  // --- Task ---

  api.registerTool({
    name: "read_task",
    label: "Read Task",
    description: "Read a task station's instructions and current status.",
    parameters: {
      type: "object",
      properties: { station: { type: "string", description: "Task station name" } },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const p = await fetchProperty();
        const asset = (p.assets || []).find((a: any) => a.station === params.station && a.task);
        if (!asset) return ok(`No task station "${params.station}" found`);
        const parts: string[] = [`# Task: ${params.station}\n`];
        const instructions = (asset as any).instructions;
        if (instructions) parts.push(`## Instructions\n${instructions}\n`);
        let state = { status: "idle", result: null as string | null };
        try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
        parts.push(`## Status: ${state.status}`);
        if (state.status === "pending") {
          parts.push(`\n## What to do`);
          parts.push(`1. Call update_state before EVERY step so viewers see you working (e.g. searching, reading, writing_code, thinking). This is mandatory — the user watches your character move around.`);
          parts.push(`2. Do the work described above`);
          parts.push(`3. Call answer_task("${params.station}", "<h2>Result</h2><p>your HTML result</p>")`);
          parts.push(`4. answer_task will instruct you to call work_task again — you MUST do so`);
        } else if (state.status === "done") {
          parts.push("\nResult already posted.");
        } else {
          parts.push("\nIdle. Call work_task to wait for visitors.");
        }
        return ok(parts.join("\n"));
      } catch (err) { return ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "answer_task",
    label: "Answer Task",
    description: "Post your result (HTML) to a task station after completing the work from work_task. " +
      "IMPORTANT: After this call returns, you MUST immediately call work_task() again to wait for the next visitor. Never stop the loop.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Task station name" },
        result: { type: "string", description: "HTML result to display" },
      },
      required: ["station", "result"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${hubUrl}/api/task/${encodeURIComponent(params.station as string)}/result`, {
          method: "POST", headers: authHeaders(), body: JSON.stringify({ result: params.result }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ok(`Task result failed: ${(e as any).error}`); }
        return ok(`Result posted to "${params.station}".\n\n⚠️ REQUIRED NEXT STEP: Call work_task("${params.station}") now to wait for the next visitor. Do not stop — the task loop must continue.`);
      } catch (err) { return ok(`Task result failed: ${err}`); }
    },
  });

  api.registerTool(
    (ctx: any) => {
      const identity = getIdentity(ctx?.agentId);
      return {
        name: "work_task",
        label: "Work Task",
        description: "Wait for a visitor to trigger a task. Blocks until someone clicks Run, then returns the instructions. " +
          "After doing the work, call answer_task with your HTML result, then call work_task again to wait for the next visitor.",
        parameters: {
          type: "object",
          properties: { station: { type: "string", description: 'The task station name, e.g. "Task_Table"' } },
          required: ["station"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const station = params.station as string;
          try {
            // Walk to the task station
            await reportToHub(station, `Waiting at ${station}`, identity);

            const p = await fetchProperty();
            const asset = (p.assets || []).find((a: any) => a.station === station && a.task);
            if (!asset) return ok(`No task station "${station}" found`);
            if (!asset.trigger) return ok(`Task station "${station}" has no trigger`);

            // Check if already pending
            let state = { status: "idle" } as Record<string, unknown>;
            try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}

            if (state.status !== "pending") {
              // Subscribe and wait for visitor with keepalive heartbeats
              identity.subscribedStation = station;
              if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity);
              const keepalive = setInterval(() => reportToHub(station, `Waiting at ${station}`, identity).catch(() => {}), 120_000);
              try {
                if (identity.signalQueue.length > 0) {
                  identity.signalQueue.shift();
                } else {
                  await new Promise<SignalMessage>((resolve, reject) => {
                    identity.pendingResolve = resolve;
                    setTimeout(() => { if (identity.pendingResolve === resolve) { identity.pendingResolve = null; reject(new Error("timeout")); } }, 10 * 60_000);
                  });
                }
              } catch {
                return ok(`Timeout waiting for visitor on "${station}". Call work_task again to keep waiting.`);
              } finally {
                clearInterval(keepalive);
              }
            }

            // Read the now-pending task
            const freshP = await fetchProperty();
            const freshAsset = (freshP.assets || []).find((a: any) => a.station === station && a.task);
            let freshState = { status: "idle" } as Record<string, unknown>;
            try { if (freshAsset?.content?.data) freshState = JSON.parse(freshAsset.content.data); } catch {}

            const parts: string[] = [`# Task: ${station}\n`];
            const instructions = (freshAsset as any)?.instructions;
            if (instructions) parts.push(`## Instructions\n${instructions}\n`);
            parts.push(`## Required steps`);
            parts.push(`1. Call update_state before EVERY step so viewers see you working (e.g. searching, reading, writing_code, thinking). This is mandatory — the user watches your character move around.`);
            parts.push(`2. Do the work described above`);
            parts.push(`3. Call answer_task("${station}", "<h2>Result</h2><p>your HTML</p>")`);
            parts.push(`4. answer_task will tell you to call work_task again — you MUST do so to keep the loop running`);

            return ok(parts.join("\n"));
          } catch (err) { return ok(`work_task failed: ${err}`); }
        },
      };
    },
    { names: ["work_task"] }
  );

  // --- Startup: register default agent and start heartbeat ---
  const defaultIdentity = getIdentity("main");
  reportToHub("idle", "Agent connected", defaultIdentity);

  // Heartbeat: keep all registered agents alive
  setInterval(() => {
    for (const identity of agentMap.values()) {
      reportToHub(identity.state, identity.detail, identity);
    }
  }, 30_000);

  // Graceful shutdown: remove all agents from hub
  async function cleanup() {
    const removals = [...agentMap.values()].map(identity =>
      fetch(`${hubUrl}/api/agents/${encodeURIComponent(identity.hubId)}`, {
        method: "DELETE",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }).catch(() => {})
    );
    await Promise.all(removals);
    api.logger.info(`[the-agents] Removed ${removals.length} agent(s) from hub`);
  }

  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

  const agentNames = agentsConfig
    ? Object.entries(agentsConfig).map(([k, v]) => `${v.name || k} (${k})`).join(", ")
    : `${defaultName} (${defaultHubId})`;
  api.logger.info(`[the-agents] Reporting to ${hubUrl} — agents: ${agentNames}`);
}
