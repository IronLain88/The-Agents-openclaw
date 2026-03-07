import WebSocket from "ws";
import type { Ctx, SignalMessage, WelcomeData } from "../lib/types.js";
import { connectSignalWs, formatSignalEvent } from "../lib/signals.js";

export function formatWelcome(w: WelcomeData): string {
  const lines: string[] = ["## Welcome to your property\n"];
  if (w.agents.length > 0) lines.push(`**Active:** ${w.agents.map(a => `${a.name} (${a.state})`).join(", ")}`);
  lines.push(`**Stations:** ${w.stations.join(", ") || "none"}`);
  if (w.inbox > 0) lines.push(`**Inbox:** ${w.inbox} message(s)`);
  if (w.tasks?.length > 0) {
    lines.push(`**Task stations (interactive — visitors trigger these, you do the work):**`);
    for (const t of w.tasks) lines.push(`  - ${t}`);
    lines.push(`*Workflow: work_task({station}) -> do work (call update_state at each step!) -> answer_task({station, result}) -> work_task again*`);
  }
  if (w.signals.length > 0) lines.push(`**Signals:** ${w.signals.join(", ")}`);
  if (w.boards.length > 0) lines.push(`**Boards with content:** ${w.boards.join(", ")}`);
  return lines.join("\n");
}

export function register(ctx: Ctx, api: any): void {
  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "update_state",
        label: "Update State",
        description: "Update the agent visualization state. States: thinking/planning/reflecting (reasoning); searching/reading/querying/browsing (gathering); writing_code/writing_text/generating (creating); talking (communicating); idle.",
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
          const welcome = await ctx.reportToHub(params.state as string, params.detail as string, identity, undefined, undefined, null, undefined, params.note as string | undefined);
          const msg = `State updated to "${params.state}"`;
          return ctx.ok(welcome ? `${msg}\n\n${formatWelcome(welcome)}` : msg);
        },
      };
    },
    { names: ["update_state"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
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
          await ctx.reportToHub(state, detail, identity, `${identity.hubId}:${subagent_id}`, subagent_name, identity.hubId, sprite);
          return ctx.ok(`Subagent "${subagent_name}" (${subagent_id}) state: "${state}" - ${detail}`);
        },
      };
    },
    { names: ["update_subagent_state"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
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
          await ctx.reportToHub("idle", `Renamed to ${identity.name}`, identity);
          return ctx.ok(`Agent name set to "${identity.name}"`);
        },
      };
    },
    { names: ["set_name"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "subscribe",
        label: "Subscribe to Signal",
        description: "Subscribe to a signal or task station. For tasks: subscribe -> check_events (returns instructions) -> do work -> answer_task.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Signal station name" } },
          required: ["name"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const p = await ctx.fetchProperty();
            const asset = (p.assets || []).find(a => a.station === (params.name as string) && a.trigger);
            if (!asset) return ctx.ok(`No signal named "${params.name}" found`);
            identity.subscribedStation = params.name as string;
            if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);
            await ctx.reportToHub(identity.subscribedStation, `Listening for ${asset.trigger} signal`, identity);
            return ctx.ok(`Subscribed to "${params.name}" (${asset.trigger} every ${asset.trigger_interval || 1} min)`);
          } catch (err) { return ctx.ok(`Subscribe failed: ${err}`); }
        },
      };
    },
    { names: ["subscribe"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "check_events",
        label: "Check Events",
        description: "Wait for the next event on your subscribed station (up to 10 min). For tasks, the event payload contains instructions.",
        parameters: { type: "object", properties: {} },
        async execute() {
          if (!identity.subscribedStation) return ctx.ok("Not subscribed. Call subscribe first.");
          if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);
          const keepAlive = setInterval(() => ctx.reportToHub(identity.subscribedStation!, "Listening for signal", identity), 120_000);
          try {
            let event: string;
            if (identity.signalQueue.length > 0) {
              event = formatSignalEvent(identity.signalQueue.shift()!, identity);
            } else {
              const msg = await new Promise<SignalMessage>((resolve, reject) => {
                identity.pendingResolve = resolve;
                setTimeout(() => { if (identity.pendingResolve === resolve) { identity.pendingResolve = null; reject(new Error("timeout")); } }, 10 * 60_000);
              });
              event = formatSignalEvent(msg, identity);
            }
            const inboxRes = await fetch(`${ctx.hubUrl}/api/board/inbox`, { headers: ctx.authHeaders() }).catch(() => null);
            if (inboxRes?.ok) {
              const board = await inboxRes.json() as any;
              try {
                const msgs = board?.content?.data ? JSON.parse(board.content.data) : [];
                if (Array.isArray(msgs) && msgs.length > 0)
                  event += `\n\nYou have ${msgs.length} unread message${msgs.length > 1 ? "s" : ""}. Call check_inbox to read them.`;
              } catch {}
            }
            return ctx.ok(event + "\n\nRemember to call update_state for your next activity.");
          } catch { return ctx.ok("No events (timeout). Remember to call update_state for your next activity."); }
          finally { clearInterval(keepAlive); }
        },
      };
    },
    { names: ["check_events"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "send_message",
        label: "Send Message",
        description: "Send a message to an inbox. Your agent name is used as the sender.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Message text" },
            inbox: { type: "string", description: "Target inbox name (default: inbox)." },
          },
          required: ["text"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const target = (params.inbox as string) || "inbox";
          try {
            const res = await fetch(`${ctx.hubUrl}/api/inbox/${encodeURIComponent(target)}`, {
              method: "POST", headers: ctx.authHeaders(),
              body: JSON.stringify({ from: identity.name, text: params.text }),
            });
            if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Send failed: ${(e as any).error}`); }
            const { count } = await res.json() as { count: number };
            return ctx.ok(`Message sent to ${target} (${count} total)`);
          } catch (err) { return ctx.ok(`Send failed: ${err}`); }
        },
      };
    },
    { names: ["send_message"] }
  );
}
