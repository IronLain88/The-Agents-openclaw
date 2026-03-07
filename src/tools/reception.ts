import type { Ctx } from "../lib/types.js";

export function register(ctx: Ctx, api: any): void {
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
        const p = await ctx.fetchProperty();
        const asset = (p.assets || []).find((a: any) => a.station === params.station && a.reception);
        if (!asset) return ctx.ok(`No reception station "${params.station}" found`);
        const parts: string[] = [`# Reception: ${params.station}\n`];
        const instructions = (asset as any).instructions;
        if (instructions) parts.push(`## Instructions\n${instructions}\n`);
        let state = { status: "idle", question: null as string | null, answer: null as string | null };
        try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
        parts.push(`## Status: ${state.status}`);
        if (state.status === "pending" && state.question) parts.push(`\n## Question\n${state.question}`);
        else if (state.status === "answered") { parts.push(`\nQuestion: ${state.question}`); parts.push("Answer already posted."); }
        else parts.push("\nNo pending questions. Subscribe and wait for visitors.");
        return ctx.ok(parts.join("\n"));
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "answer_reception",
    label: "Answer Reception",
    description: "Post an HTML answer to a pending reception question.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string" },
        answer: { type: "string", description: "HTML answer to display" },
      },
      required: ["station", "answer"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${ctx.hubUrl}/api/reception/${encodeURIComponent(params.station as string)}/answer`, {
          method: "POST", headers: ctx.authHeaders(), body: JSON.stringify({ answer: params.answer }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Answer failed: ${(e as any).error}`); }
        return ctx.ok(`Answer posted to "${params.station}"`);
      } catch (err) { return ctx.ok(`Answer failed: ${err}`); }
    },
  });
}
