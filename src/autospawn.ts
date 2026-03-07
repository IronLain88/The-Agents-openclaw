import { exec } from "child_process";
import type { Ctx } from "./lib/types.js";

interface Worker {
  agentId: string;
  hubId: string;
  name: string;
  sprite: string;
  busy: boolean;
  completedAt: number;
}

const WORKER_COOLDOWN_MS = 60_000;

function reportWorkerState(ctx: Ctx, w: Worker, state: string, detail: string): void {
  fetch(`${ctx.hubUrl}/api/state`, {
    method: "POST", headers: ctx.authHeaders(),
    body: JSON.stringify({
      agent_id: w.hubId, agent_name: w.name, state, detail,
      group: state === "idle" ? "idle" : "creating", sprite: w.sprite,
      owner_id: ctx.ownerId, owner_name: ctx.ownerName,
    }),
  }).catch(() => {});
}

export function startAutoSpawn(ctx: Ctx, config: Record<string, any>): void {
  const autoSpawnAgents = (config.autoSpawnAgents as string[]) || [];
  const autoSpawnInterval = ((config.autoSpawnInterval as number) || 15) * 1000;
  const workerIdleStation = (config.workerIdleStation as string) || "idle";

  const workers: Worker[] = autoSpawnAgents.map(id => {
    const ac = ctx.agentsConfig?.[id];
    return { agentId: id, hubId: ac?.hubId || id, name: ac?.name || id, sprite: ac?.sprite || ctx.defaultSprite, busy: false, completedAt: 0 };
  });

  // Register all workers at idle station
  for (const w of workers) reportWorkerState(ctx, w, workerIdleStation, "Waiting for tasks");

  // Keep idle workers alive (hub removes after 5 min)
  setInterval(() => {
    for (const w of workers) {
      if (!w.busy) reportWorkerState(ctx, w, workerIdleStation, "Waiting for tasks");
    }
  }, 120_000);

  ctx.logger.info(`[the-agents] Auto-spawn: ${workers.map(w => w.name).join(", ")} — idle at "${workerIdleStation}", polling every ${autoSpawnInterval / 1000}s`);

  setInterval(async () => {
    const now = Date.now();
    const freeWorkers = workers.filter(w => !w.busy && (now - w.completedAt) >= WORKER_COOLDOWN_MS);
    if (freeWorkers.length === 0) return;

    try {
      const property = await ctx.fetchProperty();
      for (const asset of (property.assets || []).filter((a: any) => a.openclaw_task)) {
        const station = asset.station as string;
        let state = { status: "idle" } as Record<string, unknown>;
        try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
        if (state.status !== "pending" || state.claimedBy) continue;

        const assignedTo = (asset as any).assigned_to as string | undefined;
        const freeWorker = assignedTo
          ? freeWorkers.find(w => w.name.toLowerCase().startsWith(assignedTo.toLowerCase()) || w.hubId.toLowerCase().startsWith(assignedTo.toLowerCase()))
          : freeWorkers[0];
        if (!freeWorker) continue;

        const claimRes = await fetch(`${ctx.hubUrl}/api/task/${encodeURIComponent(station)}/claim`, {
          method: "POST", headers: ctx.authHeaders(),
          body: JSON.stringify({ agent_id: freeWorker.hubId }),
        });
        if (!claimRes.ok) continue;
        const claimData = await claimRes.json() as { instructions?: string; prompt?: string };

        freeWorker.busy = true;
        ctx.logger.info(`[the-agents] ${freeWorker.name} claimed task "${station}"`);
        reportWorkerState(ctx, freeWorker, station, "Starting task...");

        const promptParts = [`A visitor triggered task station "${station}". Here are the instructions:`, "", claimData.instructions || "No instructions provided"];
        if (claimData.prompt) promptParts.push("", "The visitor also wrote:", "", claimData.prompt);
        promptParts.push("", "Do the work, then call answer_task with your HTML result.", "Call update_state before every step so viewers see you working.");

        const escaped = promptParts.join("\n").replace(/'/g, "'\\''");
        exec(
          `openclaw agent --agent ${freeWorker.agentId} --message '${escaped}' --timeout 300`,
          { cwd: process.cwd() },
          (err) => {
            freeWorker.busy = false;
            freeWorker.completedAt = Date.now();
            reportWorkerState(ctx, freeWorker, workerIdleStation, "Waiting for tasks");
            if (err) {
              ctx.logger.error(`[the-agents] ${freeWorker.name} failed "${station}": ${err.message}`);
              fetch(`${ctx.hubUrl}/api/task/${encodeURIComponent(station)}/clear`, { method: "POST", headers: ctx.authHeaders() }).catch(() => {});
            } else {
              ctx.logger.info(`[the-agents] ${freeWorker.name} completed "${station}"`);
            }
          }
        );
        break; // One task per poll cycle
      }
    } catch (err) { ctx.logger.error(`[the-agents] Auto-spawn poll error: ${err}`); }
  }, autoSpawnInterval);
}
