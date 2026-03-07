import type { Ctx } from "../lib/types.js";

export function register(ctx: Ctx, api: any): void {
  api.registerTool({
    name: "post_to_board",
    label: "Post to Board",
    description: "Post content to a station bulletin board",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string" },
        data: { type: "string", description: "Content to post (max 10KB)" },
        type: { type: "string", enum: ["text", "markdown", "json"] },
      },
      required: ["station", "data"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const body: Record<string, unknown> = { data: params.data };
        if (params.type) body.type = params.type;
        const res = await fetch(`${ctx.hubUrl}/api/board/${encodeURIComponent(params.station as string)}`, {
          method: "POST", headers: ctx.authHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Post failed: ${(e as any).error}`); }
        return ctx.ok(`Posted to "${params.station}" (${(params.data as string).length} chars)`);
      } catch (err) { return ctx.ok(`Post failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "read_board",
    label: "Read Board",
    description: "Read a bulletin board from any hub",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string" },
        url: { type: "string", description: "Hub URL (defaults to local)" },
      },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const target = (params.url as string) || ctx.hubUrl;
      try { const p = new URL(target); if (!["http:", "https:"].includes(p.protocol)) return ctx.ok("Error: URL must use http or https"); }
      catch { return ctx.ok(`Error: Invalid URL "${target}"`); }
      try {
        const res = await fetch(`${target}/api/board/${encodeURIComponent(params.station as string)}`);
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Read failed: ${(e as any).error}`); }
        const board = await res.json() as any;
        const parts: string[] = [`# Board: ${board.station}`];
        if (board.content) {
          parts.push("", `## Content (${board.content.type})`, board.content.data);
          if (board.content.publishedAt) parts.push(`\n*Published: ${board.content.publishedAt}*`);
        } else { parts.push("", "*No content posted yet.*"); }
        if (board.log) parts.push("", "## Activity Log", board.log);
        return ctx.ok(parts.join("\n"));
      } catch (err) { return ctx.ok(`Read failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "check_inbox",
    label: "Check Inbox",
    description: "Check your inbox for messages from humans or other agents.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Inbox name (default: inbox)." } },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const inbox = (params.name as string) || "inbox";
      try {
        const res = await fetch(`${ctx.hubUrl}/api/board/${encodeURIComponent(inbox)}`, { headers: ctx.authHeaders() });
        if (!res.ok) return ctx.ok(`${inbox} is empty.`);
        const board = await res.json() as any;
        const messages: { from: string; text: string; timestamp?: string }[] = board?.content?.data
          ? (() => { try { const m = JSON.parse(board.content.data); return Array.isArray(m) ? m : []; } catch { return []; } })()
          : [];
        if (!messages.length) return ctx.ok(`${inbox} is empty.`);
        const lines = messages.map(m => {
          const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "";
          return `- ${m.from}${time ? ` (${time})` : ""}: ${m.text}`;
        });
        return ctx.ok(`${messages.length} message(s):\n${lines.join("\n")}`);
      } catch (err) { return ctx.ok(`Check failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "clear_inbox",
    label: "Clear Inbox",
    description: "Clear all messages from the inbox.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Inbox name to clear (default: inbox)." } },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const target = (params.name as string) || "inbox";
      try {
        const res = await fetch(`${ctx.hubUrl}/api/inbox/${encodeURIComponent(target)}`, { method: "DELETE", headers: ctx.authHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Clear failed: ${(e as any).error}`); }
        return ctx.ok(`${target} cleared`);
      } catch (err) { return ctx.ok(`Clear failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "get_status",
    label: "Get Status",
    description: "Get a quick status overview: active agents, inbox messages, and recent activity.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const res = await fetch(`${ctx.hubUrl}/api/status`, { headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {} });
        if (!res.ok) throw new Error(`Hub returned ${res.status}`);
        const status = await res.json() as {
          agents: { name: string; state: string; detail: string; idle: boolean; sub?: boolean }[];
          inbox: { count: number; latest: string | null };
          activity: { agent: string; state: string; detail: string; t: number }[];
          stations: string[];
        };
        const lines: string[] = [`## Property Status\n`, `**Agents (${status.agents.length}):**`];
        for (const a of status.agents) lines.push(`- ${a.name}${a.sub ? " (sub)" : ""}: ${a.state} — ${a.detail || "idle"}`);
        lines.push(status.inbox.count > 0 ? `\n**Inbox: ${status.inbox.count} message(s)**` : `\n**Inbox: empty**`);
        if (status.activity.length > 0) {
          lines.push(`\n**Recent Activity:**`);
          for (const e of status.activity) lines.push(`- ${e.agent}: ${e.detail}`);
        }
        lines.push(`\n**Active Stations:** ${status.stations.join(", ") || "none"}`);
        return ctx.ok(lines.join("\n"));
      } catch (err) { return ctx.ok(`Status check failed: ${err}`); }
    },
  });

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
        const res = await fetch(`${ctx.hubUrl}/api/signals/fire`, { method: "POST", headers: ctx.authHeaders(), body: JSON.stringify(body) });
        if (!res.ok) return ctx.ok(`Fire failed: ${res.statusText}`);
        return ctx.ok(`Fired signal "${params.name}"`);
      } catch (err) { return ctx.ok(`Fire failed: ${err}`); }
    },
  });
}
