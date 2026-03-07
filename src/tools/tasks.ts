import WebSocket from "ws";
import type { Ctx, SignalMessage } from "../lib/types.js";
import { connectSignalWs } from "../lib/signals.js";

export function register(ctx: Ctx, api: any): void {
  api.registerTool({
    name: "read_task",
    label: "Read Task",
    description: "Read a task station's instructions and current status.",
    parameters: {
      type: "object",
      properties: { station: { type: "string" } },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const p = await ctx.fetchProperty();
        const asset = (p.assets || []).find((a: any) => a.station === params.station && a.task);
        if (!asset) return ctx.ok(`No task station "${params.station}" found`);
        const parts: string[] = [`# Task: ${params.station}\n`];
        const instructions = (asset as any).instructions;
        if (instructions) parts.push(`## Instructions\n${instructions}\n`);
        let state = { status: "idle", result: null as string | null };
        try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
        parts.push(`## Status: ${state.status}`);
        if (state.status === "pending") {
          parts.push(`\n## What to do`);
          parts.push(`1. Call update_state before EVERY step so viewers see you working. This is mandatory.`);
          parts.push(`2. Do the work described above`);
          parts.push(`3. Call answer_task("${params.station}", "<h2>Result</h2><p>your HTML result</p>")`);
          parts.push(`4. answer_task will instruct you to call work_task again — you MUST do so`);
        } else if (state.status === "done") {
          parts.push("\nResult already posted.");
        } else {
          parts.push("\nIdle. Call work_task to wait for visitors.");
        }
        return ctx.ok(parts.join("\n"));
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "answer_task",
    label: "Answer Task",
    description: "Post your result (HTML) to a task station after completing the work. IMPORTANT: After this call returns, you MUST immediately call work_task() again to wait for the next visitor. Never stop the loop.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string" },
        result: { type: "string", description: "HTML result to display" },
      },
      required: ["station", "result"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const station = params.station as string;
        const res = await fetch(`${ctx.hubUrl}/api/task/${encodeURIComponent(station)}/result`, {
          method: "POST", headers: ctx.authHeaders(), body: JSON.stringify({ result: params.result }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Task result failed: ${(e as any).error}`); }

        let isOpenclawTask = false;
        try {
          const p = await ctx.fetchProperty();
          const asset = (p.assets || []).find((a: any) => a.station === station && a.task);
          if ((asset as any)?.openclaw_task) isOpenclawTask = true;
        } catch {}

        if (isOpenclawTask)
          return ctx.ok(`Result posted to "${station}".\n\nYour work is done. This is an openclaw_task station — no need to loop. You may exit or go idle.`);
        return ctx.ok(`Result posted to "${station}".\n\nREQUIRED NEXT STEP: Call work_task("${station}") now to wait for the next visitor. Do not stop — the task loop must continue.`);
      } catch (err) { return ctx.ok(`Task result failed: ${err}`); }
    },
  });

  api.registerTool(
    (tool: any) => {
      const identity = ctx.getIdentity(tool?.agentId);
      return {
        name: "work_task",
        label: "Work Task",
        description: "Wait for a visitor to trigger a task. Blocks until someone clicks Run, then returns the instructions. After doing the work, call answer_task with your HTML result, then call work_task again.",
        parameters: {
          type: "object",
          properties: { station: { type: "string", description: "The task station name" } },
          required: ["station"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const station = params.station as string;
          try {
            await ctx.reportToHub(station, `Waiting at ${station}`, identity);
            const p = await ctx.fetchProperty();
            const asset = (p.assets || []).find((a: any) => a.station === station && a.task);
            if (!asset) return ctx.ok(`No task station "${station}" found`);
            if ((asset as any).openclaw_task) return ctx.ok(`"${station}" is an openclaw_task station — do NOT call work_task on these.`);
            if (!asset.trigger) return ctx.ok(`Task station "${station}" has no trigger`);

            let state = { status: "idle" } as Record<string, unknown>;
            try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}

            if (state.status !== "pending") {
              identity.subscribedStation = station;
              if (!identity.signalWs || identity.signalWs.readyState !== WebSocket.OPEN) connectSignalWs(identity, ctx.hubUrl);
              const keepalive = setInterval(() => ctx.reportToHub(station, `Waiting at ${station}`, identity).catch(() => {}), 120_000);
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
                return ctx.ok(`Timeout waiting for visitor on "${station}". Call work_task again to keep waiting.`);
              } finally { clearInterval(keepalive); }
            }

            const freshP = await ctx.fetchProperty();
            const freshAsset = (freshP.assets || []).find((a: any) => a.station === station && a.task);
            const parts: string[] = [`# Task: ${station}\n`];
            const instructions = (freshAsset as any)?.instructions;
            if (instructions) parts.push(`## Instructions\n${instructions}\n`);
            parts.push(`## Required steps`);
            parts.push(`1. Call update_state before EVERY step so viewers see you working. This is mandatory.`);
            parts.push(`2. Do the work described above`);
            parts.push(`3. Call answer_task("${station}", "<h2>Result</h2><p>your HTML</p>")`);
            parts.push(`4. answer_task will tell you to call work_task again — you MUST do so to keep the loop running`);
            return ctx.ok(parts.join("\n"));
          } catch (err) { return ctx.ok(`work_task failed: ${err}`); }
        },
      };
    },
    { names: ["work_task"] }
  );
}
