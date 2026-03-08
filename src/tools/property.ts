import { readFile } from "fs/promises";
import { resolve, sep } from "path";
import type { Ctx, Asset } from "../lib/types.js";

function findAsset(assets: Asset[], query: string): Asset | undefined {
  return assets.find(a => a.id === query)
    || assets.find(a => (a.name || a.id).toLowerCase().includes(query.toLowerCase()));
}

export function register(ctx: Ctx, api: any): void {
  api.registerTool({
    name: "sync_property",
    label: "Sync Property",
    description: "Refresh your local view of the property from the hub.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const p = await ctx.fetchProperty();
        return ctx.ok(`Property synced (${(p.assets || []).length} assets)`);
      } catch (err) { return ctx.ok(`Sync failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "get_village_info",
    label: "Get Village Info",
    description: "Get a summary of your property: available stations, signals, boards, and inbox.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const lines = [
        "# The Agents", "",
        "You have a property — a tile grid with furniture. Each furniture piece can be tagged with a **station** name.",
        "When you call `update_state({ state, detail })`, your character walks to the matching station.",
        "Update state at EVERY transition. Set idle when done.", "",
      ];
      try {
        const p = await ctx.fetchProperty();
        const assets = p.assets || [];
        const stations: string[] = [], signals: string[] = [], tasks: string[] = [], openclawTasks: string[] = [], boards: string[] = [];
        let inboxCount = 0;
        for (const a of assets) {
          if (!a.station) continue;
          if ((a as any).task) {
            const entry = `${a.station} — ${(a as any).instructions || "(no instructions)"}`;
            if ((a as any).openclaw_task) openclawTasks.push(entry); else tasks.push(entry);
            continue;
          }
          if (a.trigger) {
            signals.push(`${a.name || a.station} (${a.trigger}, every ${a.trigger_interval || 1} min)`);
          } else if (a.station === "inbox" && a.content?.data) {
            try { const msgs = JSON.parse(a.content.data); if (Array.isArray(msgs)) inboxCount += msgs.length; } catch {}
            if (!stations.includes(a.station)) stations.push(a.station);
          } else {
            if (!stations.includes(a.station)) stations.push(a.station);
            if (a.content?.data) boards.push(a.name || a.station || "");
          }
        }
        lines.push("## Your Property");
        lines.push(`**Stations:** ${stations.join(", ") || "none"}`);
        if (inboxCount > 0) lines.push(`**Inbox:** ${inboxCount} message(s)`);
        if (tasks.length > 0) {
          lines.push(`**Task stations (interactive — visitors trigger these, you do the work):**`);
          for (const t of tasks) lines.push(`  - ${t}`);
          lines.push(`*Workflow: work_task({station}) -> do work (call update_state at each step!) -> answer_task({station, result}) -> work_task again*`);
        }
        if (openclawTasks.length > 0) {
          lines.push(`**OpenClaw task stations (auto-spawn — do NOT call work_task on these):**`);
          for (const t of openclawTasks) lines.push(`  - ${t}`);
        }
        if (signals.length > 0) lines.push(`**Signals:** ${signals.join(", ")}`);
        if (boards.length > 0) lines.push(`**Boards with content:** ${boards.join(", ")}`);
        lines.push(`**Total assets:** ${assets.length}`);
      } catch { lines.push("*(Could not fetch property)*"); }
      return ctx.ok(lines.join("\n"));
    },
  });

  api.registerTool({
    name: "list_assets",
    label: "List Assets",
    description: "List all assets on your property",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const p = await ctx.fetchProperty();
        const assets = p.assets || [];
        if (!assets.length) return ctx.ok("No assets on property");
        return ctx.ok(assets.map((a: Asset) => {
          const pos = a.position ? `(${a.position.x}, ${a.position.y})` : "inventory";
          const sta = a.station ? ` [station: ${a.station}]` : "";
          return `- ${a.name || a.id} - ${pos}${sta}`;
        }).join("\n"));
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
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
        tileset: { type: "string" }, tx: { type: "number" }, ty: { type: "number" },
        x: { type: "number" }, y: { type: "number" },
        station: { type: "string", description: "Agent state when at this asset" },
        approach: { type: "string", enum: ["above", "below", "left", "right"] },
        collision: { type: "boolean" },
        remote_url: { type: "string" }, remote_station: { type: "string" },
        openclaw_task: { type: "boolean", description: "Mark as an OpenClaw auto-spawn task station" },
        archive: { type: "boolean", description: "Mark as an archive station" },
        welcome: { type: "boolean", description: "Mark as a welcome board" },
      },
      required: ["name"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const body: Record<string, unknown> = { name: params.name };
        for (const k of ["tileset", "tx", "ty", "x", "y", "station", "approach", "collision", "remote_url", "remote_station", "openclaw_task", "archive", "welcome"])
          if (params[k] !== undefined) body[k] = params[k];
        const res = await fetch(`${ctx.hubUrl}/api/assets`, { method: "POST", headers: ctx.authHeaders(), body: JSON.stringify(body) });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ctx.ok(`Added "${params.name}" (${asset.id}) ${asset.position ? `at (${asset.position.x}, ${asset.position.y})` : "in inventory"}`);
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
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
        const res = await fetch(`${ctx.hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, { method: "DELETE", headers: ctx.authHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Failed: ${(e as any).error}`); }
        const { removed } = await res.json() as { removed: Asset };
        return ctx.ok(`Removed "${removed.name || removed.id}"`);
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "move_asset",
    label: "Move Asset",
    description: "Move an asset to a new position",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        x: { type: "number" }, y: { type: "number" },
      },
      required: ["asset_id", "x", "y"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const res = await fetch(`${ctx.hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, {
          method: "PATCH", headers: ctx.authHeaders(), body: JSON.stringify({ position: { x: params.x, y: params.y } }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ctx.ok(`Moved "${asset.name || asset.id}" to (${params.x}, ${params.y})`);
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
    },
  });

  api.registerTool({
    name: "attach_content",
    label: "Attach Content",
    description: "Attach content to an asset from a local file",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        file_path: { type: "string", description: "Path to file" },
      },
      required: ["asset_id", "file_path"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const fp = params.file_path as string;
        const projectRoot = resolve(process.cwd());
        const resolved = resolve(fp);
        if (!resolved.startsWith(projectRoot + sep) && resolved !== projectRoot)
          return ctx.ok("Error: path must be within project directory");
        const data = await readFile(fp, "utf-8");
        const ext = fp.split(".").pop() || "txt";
        const type = ext === "md" ? "markdown" : ext === "json" ? "json" : "text";
        const res = await fetch(`${ctx.hubUrl}/api/assets/${encodeURIComponent(params.asset_id as string)}`, {
          method: "PATCH", headers: ctx.authHeaders(),
          body: JSON.stringify({ content: { type, data, source: fp, publishedAt: new Date().toISOString() } }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); return ctx.ok(`Failed: ${(e as any).error}`); }
        const { asset } = await res.json() as { asset: Asset };
        return ctx.ok(`Attached ${fp} to "${asset.name || asset.id}"`);
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
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
        const p = await ctx.fetchProperty();
        const asset = findAsset(p.assets || [], params.name as string);
        if (!asset) return ctx.ok(`Asset "${params.name}" not found. Use list_assets to see available assets.`);
        if (!asset.content) return ctx.ok(`Asset "${asset.name || asset.id}" has no content.`);
        const footer = asset.content.source ? `\n\n---\n*Source: ${asset.content.source}*` : "";
        return ctx.ok(`# ${asset.name || asset.id}\n\n${asset.content.data}${footer}`);
      } catch (err) { return ctx.ok(`Failed: ${err}`); }
    },
  });
}
