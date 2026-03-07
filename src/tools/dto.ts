import type { Ctx } from "../lib/types.js";

interface DtoTrailEntry {
  station: string;
  by: string;
  at: string;
  data: string;
}

interface Dto {
  id: string;
  type: string;
  created_at: string;
  trail: DtoTrailEntry[];
}

export function register(ctx: Ctx, api: any): void {
  api.registerTool({
    name: "create_dto",
    label: "Create DTO",
    description:
      "Create a DTO (data transfer object) at a station queue. " +
      "DTOs travel through stations, each stop appending to a trail of results. " +
      "Use forward_dto to send it to the next station.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station to place the DTO at" },
        data: { type: "string", description: "Initial payload data" },
        type: { type: "string", description: 'DTO type (default: "message")' },
      },
      required: ["station", "data"],
    },
    async execute(_id: string, params: Record<string, unknown>, agentId?: string) {
      const identity = ctx.getIdentity(agentId);
      try {
        const res = await fetch(`${ctx.hubUrl}/api/queue/${encodeURIComponent(params.station as string)}`, {
          method: "POST",
          headers: ctx.authHeaders(),
          body: JSON.stringify({ type: (params.type as string) || "message", by: identity.name, data: params.data }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          return ctx.ok(`Failed to create DTO: ${(e as any).error}`);
        }
        const { dto } = await res.json() as { dto: Dto };
        return ctx.ok(`DTO ${dto.id} created at "${params.station}"`);
      } catch (err) {
        return ctx.ok(`Failed to create DTO: ${err}`);
      }
    },
  });

  api.registerTool({
    name: "receive_dto",
    label: "Receive DTO",
    description:
      "Receive (pop) the next DTO from a station queue. Returns the DTO with its full trail. " +
      "After processing, call forward_dto to send it to the next station.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station to receive from" },
      },
      required: ["station"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const station = params.station as string;
      try {
        const res = await fetch(`${ctx.hubUrl}/api/queue/${encodeURIComponent(station)}`, {
          headers: ctx.authHeaders(),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          return ctx.ok(`Failed: ${(e as any).error}`);
        }
        const { dtos } = await res.json() as { dtos: Dto[] };
        if (dtos.length === 0) return ctx.ok(`No DTOs waiting at "${station}"`);

        const dto = dtos[0];
        const trail = dto.trail.map((e: DtoTrailEntry) => `  - ${e.station} (${e.by}): ${e.data}`).join("\n");
        return ctx.ok(`DTO ${dto.id} (type: ${dto.type}) at "${station}"\nTrail:\n${trail}\n\nCall forward_dto to move it to the next station, or delete it to end the pipeline.`);
      } catch (err) {
        return ctx.ok(`Failed: ${err}`);
      }
    },
  });

  api.registerTool({
    name: "forward_dto",
    label: "Forward DTO",
    description:
      "Append your result to a DTO's trail and send it to the next station. " +
      "Call receive_dto first to get the DTO id and from_station.",
    parameters: {
      type: "object",
      properties: {
        dto_id: { type: "string", description: "The DTO id (from receive_dto)" },
        from_station: { type: "string", description: "The station the DTO was received from" },
        target_station: { type: "string", description: "The station to forward to" },
        result: { type: "string", description: "Your result/contribution to append to the trail" },
      },
      required: ["dto_id", "from_station", "target_station", "result"],
    },
    async execute(_id: string, params: Record<string, unknown>, agentId?: string) {
      const identity = ctx.getIdentity(agentId);
      try {
        const res = await fetch(
          `${ctx.hubUrl}/api/queue/${encodeURIComponent(params.from_station as string)}/${params.dto_id}/forward`,
          {
            method: "POST",
            headers: ctx.authHeaders(),
            body: JSON.stringify({ target_station: params.target_station, by: identity.name, data: params.result }),
          }
        );
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          return ctx.ok(`Forward failed: ${(e as any).error}`);
        }
        return ctx.ok(`DTO ${params.dto_id} forwarded to "${params.target_station}"`);
      } catch (err) {
        return ctx.ok(`Forward failed: ${err}`);
      }
    },
  });
}
