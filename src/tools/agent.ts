import WebSocket from "ws";
import type { AgentIdentity, Ctx, SignalMessage, WelcomeData } from "../lib/types.js";
import { connectSignalWs, formatSignalEvent } from "../lib/signals.js";

async function tryClaimTask(station: string, identity: AgentIdentity, ctx: Ctx): Promise<string | null> {
  try {
    const p = await ctx.fetchProperty();
    const asset = (p.assets || []).find((a: any) => a.station === station && a.task);
    if (!asset) return null;
    let state = { status: "idle" } as Record<string, unknown>;
    try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
    if (state.status !== "pending") return null;

    const res = await fetch(`${ctx.hubUrl}/api/task/${encodeURIComponent(station)}/claim`, {
      method: "POST", headers: ctx.authHeaders(),
      body: JSON.stringify({ agent_id: identity.name }),
    });
    if (!res.ok) return null;
    const { instructions, prompt } = await res.json() as { instructions?: string; prompt?: string; ok: boolean };

    const parts: string[] = [`# Task: ${station}\n`];
    if (instructions) parts.push(`## Instructions\n${instructions}\n`);
    if (prompt) parts.push(`## Visitor's request\n${prompt}\n`);
    parts.push(`## Required steps`);
    parts.push(`1. Call update_state before EVERY step`);
    parts.push(`2. Do the work described above`);
    parts.push(`3. Call answer_task("${station}", "<h2>Result</h2><p>your result</p>")`);
    parts.push(`4. Then call check_events() again to wait for the next task`);
    return parts.join("\n");
  } catch { return null; }
}

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
  if (w.boards?.length) lines.push(`**Boards:** ${w.boards.join(", ")}`);
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
        name: "say",
        label: "Say",
        description: "Update your speech bubble without changing state or moving. Use for status messages, thoughts, or progress updates while staying at your current station.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: 'What to say, e.g. "Almost done..." or "Found 3 results"' } },
          required: ["message"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          await ctx.reportToHub(identity.state || "idle", params.message as string, identity);
          return ctx.ok(`Said: "${params.message}"`);
        },
      };
    },
    { names: ["say"] }
  );

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "subscribe",
        label: "Subscribe",
        description: "Subscribe to station(s). With no name: subscribes to ALL task stations. With a name: subscribes to that specific signal or task station. Then call check_events() in a loop.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Station name, or omit to subscribe to all your task stations" } },
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const p = await ctx.fetchProperty();
            const name = params.name as string | undefined;

            if (!name) {
              const taskStations = (p.assets || []).filter((a: any) => a.task && !a.openclaw_task);
              if (taskStations.length === 0) return ctx.ok("No task stations available on this property.");
              identity.subscribedStations = taskStations.map(a => a.station!).filter(Boolean);
              identity.subscribedStation = identity.subscribedStations[0];
              if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);
              return ctx.ok(`Subscribed to ${identity.subscribedStations.length} task station(s): ${identity.subscribedStations.join(", ")}. Call check_events() to wait for work.`);
            }

            const asset = (p.assets || []).find(a => a.station === name && (a.trigger || (a as any).task));
            if (!asset) return ctx.ok(`No signal or task station "${name}" found`);
            identity.subscribedStation = name;
            identity.subscribedStations = [name];
            if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);
            if ((asset as any).task) {
              await ctx.reportToHub(name, `On duty at ${name}`, identity);
              return ctx.ok(`Subscribed to task station "${name}". Call check_events() to wait for work.`);
            }
            await ctx.reportToHub(name, `Listening for ${asset.trigger} signal`, identity);
            return ctx.ok(`Subscribed to "${name}" (${asset.trigger} every ${asset.trigger_interval || 1} min)`);
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
        description: "Wait for the next event on your subscribed station(s) (up to 10 min). For task stations, automatically claims the task and returns instructions. Call subscribe first.",
        parameters: { type: "object", properties: {} },
        async execute() {
          if (!identity.subscribedStation) return ctx.ok("Not subscribed. Call subscribe first.");
          if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);

          // Check for already-pending tasks on all subscribed stations
          const stations = identity.subscribedStations || [identity.subscribedStation];
          for (const station of stations) {
            const claimed = await tryClaimTask(station, identity, ctx);
            if (claimed) return ctx.ok(claimed);
          }

          const waitMsg = stations.length > 1 ? `On duty (${stations.length} stations)` : `Waiting at ${stations[0]}`;
          const keepAlive = setInterval(() => ctx.reportToHub(stations[0], waitMsg, identity), 120_000);
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

            // After signal, try to claim any pending task
            for (const station of stations) {
              const claimed = await tryClaimTask(station, identity, ctx);
              if (claimed) return ctx.ok(claimed);
            }

            return ctx.ok(event + "\n\nRemember to call update_state for your next activity.");
          } catch { return ctx.ok("No events (timeout). Call check_events() again to keep waiting."); }
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
            const res = await fetch(`${ctx.hubUrl}/api/queue/${encodeURIComponent(target)}`, {
              method: "POST", headers: ctx.authHeaders(),
              body: JSON.stringify({ by: identity.name, data: params.text as string }),
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
