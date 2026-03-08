import WebSocket from "ws";

export interface Asset {
  id: string;
  name?: string;
  position: { x: number; y: number } | null;
  station?: string;
  content?: { type: string; data: string; source?: string; publishedAt?: string };
  trigger?: string;
  trigger_interval?: number;
}

export interface SignalMessage {
  type: string;
  station: string;
  trigger: string;
  timestamp: number;
  payload?: unknown;
}

export interface AgentIdentity {
  hubId: string;
  name: string;
  sprite: string;
  state: string;
  detail: string;
  subscribedStation: string | null;
  subscribedStations?: string[];
  signalWs: WebSocket | null;
  signalQueue: SignalMessage[];
  pendingResolve: ((msg: SignalMessage) => void) | null;
}

export interface WelcomeData {
  stations: string[];
  signals: string[];
  tasks: string[];
  inbox: number;
  agents: { name: string; state: string }[];
}

export type OkResult = { content: { type: "text"; text: string }[]; details: {} };

export interface Ctx {
  hubUrl: string;
  apiKey: string | undefined;
  ownerId: string;
  ownerName: string;
  agentMap: Map<string, AgentIdentity>;
  agentsConfig: Record<string, { name?: string; sprite?: string; hubId?: string }> | undefined;
  defaultSprite: string;
  logger: any;
  getIdentity(openclawAgentId?: string): AgentIdentity;
  authHeaders(): Record<string, string>;
  ok(text: string): OkResult;
  reportToHub(
    state: string, detail: string, identity: AgentIdentity,
    idOverride?: string, nameOverride?: string,
    parentAgentId?: string | null, spriteOverride?: string, note?: string
  ): Promise<WelcomeData | null>;
  fetchProperty(): Promise<{ assets: Asset[]; [key: string]: unknown }>;
}
