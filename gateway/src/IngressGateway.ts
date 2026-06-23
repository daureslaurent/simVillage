/**
 * gateway/src/IngressGateway.ts
 * ---------------------------------------------------------------------------
 * Phase 2 — "The Nervous System": the Ingress Gateway.
 *
 * This service is the bridge between the browser (WebSockets) and the engine
 * (RabbitMQ). It is the ONLY thing in the system that holds WebSocket
 * connections, and the ONLY thing the browser talks to.
 *
 *   DOWN  — subscribes to `world.events`, translates each envelope back into
 *           the Phase-1 `ServerMessage` wire shape, and pushes it to every
 *           connected browser. (Keeping the browser protocol identical means
 *           the client code needs no changes at all.)
 *
 *   UP    — receives `ClientCommand`s from the browser and republishes them to
 *           `user.commands` as `user.force_move` envelopes.
 *
 *   SYNC  — caches the latest init + state so a newly-connected browser is
 *           populated instantly; if the cache is cold (gateway started after
 *           the engine), it asks the engine to replay via a `user.sync` event.
 *
 * The gateway is stateless beyond that small "latest snapshot" cache — it can
 * be killed and restarted freely.
 * ---------------------------------------------------------------------------
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  EXCHANGES,
  type LlmCallFinishedEvent,
  type LlmCallStartedEvent,
  type SimTickEvent,
  type SupervisorCommandEvent,
  type VillagerConversationEvent,
  type VillagerGroupPlanEvent,
  type VillagerIntentEvent,
  type VillagerRelationshipEvent,
  type VillagerThoughtProcessEvent,
  type WorldEvent,
} from '../../shared/events';
import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import type {
  BrowserCommand,
  ServerMessage,
  WeatherKind,
  WorldInitMessage,
  WorldStateUpdate,
} from '../../shared/types';

/** The weather states a browser may set (the closed vocabulary the gateway trusts). */
const WEATHERS: readonly WeatherKind[] = ['clear', 'rain', 'storm', 'fog', 'heatwave'];

/**
 * Read-only view of the villager action log the gateway serves over HTTP. Kept
 * as a local structural interface so the gateway depends on a capability, not on
 * the server's concrete Mongo store (which satisfies it structurally).
 */
export interface ActionHistoryReader {
  listByVillager(villagerId: string, limit?: number): Promise<import('../../shared/types').VillagerActionRecord[]>;
}

/** Read-only view of the conversation log the gateway serves over HTTP. */
export interface ConversationHistoryReader {
  list(limit?: number): Promise<import('../../shared/types').Conversation[]>;
}

/** Read-only view of the per-building activity log, for the inspector endpoint. */
export interface BuildingLogReader {
  recent(buildingId: string): import('../../shared/types').BuildingEvent[];
}

/** Read-only view of villagers' social books, for the relationships endpoint. */
export interface RelationshipReader {
  all(): { villagerId: string; villagerName: string; relationships: import('../../shared/types').Relationship[] }[];
}

/** Read-only view of the village's active group plans, for the agenda endpoint. */
export interface GroupPlanReader {
  all(): import('../../shared/types').GroupPlan[];
}

/** Matches `GET /villagers/:id/actions`, capturing the (url-encoded) villager id. */
const ACTIONS_ROUTE = /^\/villagers\/([^/]+)\/actions\/?$/;
/** Matches `GET /conversations`. */
const CONVERSATIONS_ROUTE = /^\/conversations\/?$/;
/** Matches `GET /buildings/:id/log`, capturing the (url-encoded) building id. */
const BUILDING_LOG_ROUTE = /^\/buildings\/([^/]+)\/log\/?$/;
/** Matches `GET /relationships`. */
const RELATIONSHIPS_ROUTE = /^\/relationships\/?$/;
/** Matches `GET /group-plans`. */
const GROUP_PLANS_ROUTE = /^\/group-plans\/?$/;

export class IngressGateway {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;

  /** Latest static-world message, replayed to each newly-connected browser. */
  private lastInit: WorldInitMessage | null = null;
  /** Latest per-tick state, replayed so the viewport is populated immediately. */
  private lastState: WorldStateUpdate | null = null;
  /** Latest logical-tick announcement, replayed so the debug window starts in sync. */
  private lastSimTick: ServerMessage | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly port: number,
    /** Read side of the action log, for the history endpoint. Optional: omit it
     *  (e.g. in tests) and the endpoint simply 404s. */
    private readonly actions: ActionHistoryReader | null = null,
    /** Read side of the conversation log, for the conversations endpoint. */
    private readonly conversations: ConversationHistoryReader | null = null,
    /** Read side of the per-building activity log, for the inspector endpoint. */
    private readonly buildingLog: BuildingLogReader | null = null,
    /** Read side of villagers' social books, for the relationships endpoint. */
    private readonly relationships: RelationshipReader | null = null,
    /** Read side of the village's active group plans, for the agenda endpoint. */
    private readonly groupPlans: GroupPlanReader | null = null,
  ) {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http });
  }

  async start(): Promise<void> {
    // DOWN: consume the world stream. An exclusive (unnamed) queue means a
    // restarted gateway gets only fresh updates, never a backlog of stale ticks.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.*', (event) =>
      this.handleWorldEvent(event),
    );

    // DOWN: the "Inception" feed. Forward every villager's thought process to the
    // browsers so the UI inspector can stream a selected villager's mind. Exclusive
    // queue: a reconnecting gateway wants only fresh thoughts.
    await this.bus.subscribe<VillagerThoughtProcessEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.telemetry.thought_process',
      (event) => this.broadcast({ kind: 'villager.thought', ...event.payload }),
    );

    // DOWN: the conversation feed. Forward each opened/extended conversation so
    // the browser's live conversation list updates as villagers talk.
    await this.bus.subscribe<VillagerConversationEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.conversation.updated',
      (event) => this.broadcast({ kind: 'conversation.updated', conversation: event.payload }),
    );

    // DOWN: the relationship feed. Forward each villager's revised social book so
    // the browser's relationships view updates after a nightly reflection.
    await this.bus.subscribe<VillagerRelationshipEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.relationship.updated',
      (event) => this.broadcast({ kind: 'relationship.updated', ...event.payload }),
    );

    // DOWN: the group-plan feed. Forward each opened/joined shared plan so the
    // browser's agenda panel shows the village's work crews and prayer rituals.
    await this.bus.subscribe<VillagerGroupPlanEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.group_plan.updated',
      (event) => this.broadcast({ kind: 'group_plan.updated', plan: event.payload }),
    );

    // DOWN: the logical-tick clock. Forward each round's `sim.tick` so the debug
    // window can show the current tick and who is acting vs. cooling down.
    await this.bus.subscribe<SimTickEvent>(
      EXCHANGES.simulation,
      'sim.tick',
      (event) => {
        this.lastSimTick = { kind: 'sim.tick', ...event.payload };
        this.broadcast(this.lastSimTick);
      },
    );

    // DOWN: the LLM-engine activity feed. Forward each round-trip's start/finish
    // so the debug window can show what's running and what the last call returned.
    await this.bus.subscribe<LlmCallStartedEvent>(
      EXCHANGES.engineTelemetry,
      'engine.llm.started',
      (event) => this.broadcast({ kind: 'engine.llm.started', ...event.payload }),
    );
    await this.bus.subscribe<LlmCallFinishedEvent>(
      EXCHANGES.engineTelemetry,
      'engine.llm.finished',
      (event) => this.broadcast({ kind: 'engine.llm.finished', ...event.payload }),
    );

    // DOWN: the temple PRAYER feed. Each villager prayer is surfaced live to the
    // browser's Supervisor console, where the human god grants or denies it.
    // Exclusive queue: a reconnecting gateway wants only fresh petitions.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.pray',
      (event) => {
        if (event.type !== 'villager.pray') return;
        const { villagerId, message } = event.payload;
        this.broadcast({
          kind: 'supervisor.prayer',
          id: event.eventId,
          villagerId,
          villagerName: this.villagerName(villagerId),
          message,
          tick: this.lastState?.tick ?? 0,
        });
      },
    );

    // DOWN: the god's ACTS. Mirror every supervisor command to the console so a
    // force-run (or the autonomous daily deliberation) shows a visible outcome.
    await this.bus.subscribe<SupervisorCommandEvent>(
      EXCHANGES.supervisorCommands,
      'supervisor.*',
      (event) => {
        const act = this.describeSupervisorAction(event);
        if (act) this.broadcast({ kind: 'supervisor.action', action: act.action, summary: act.summary });
      },
    );

    this.wss.on('connection', (socket) => this.handleConnection(socket));
    this.http.listen(this.port, () => {
      console.log(`[gateway] WebSocket listening on :${this.port}`);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.bus.close();
  }

  // -------------------------------------------------------------------------
  // HTTP: the villager action-history endpoint (and a health root)
  // -------------------------------------------------------------------------

  /**
   * Serve `GET /villagers/:id/actions` from the action log; everything else gets
   * the plaintext health root. CORS is wide open: this is a read-only history
   * feed for the same browser that already holds the WebSocket, and the client
   * (vite dev server) lives on a different origin than this gateway.
   */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET') {
      const actionsMatch = ACTIONS_ROUTE.exec(path);
      if (actionsMatch) {
        void this.serveActions(decodeURIComponent(actionsMatch[1]), res);
        return;
      }
      if (CONVERSATIONS_ROUTE.test(path)) {
        void this.serveConversations(res);
        return;
      }
      const buildingLogMatch = BUILDING_LOG_ROUTE.exec(path);
      if (buildingLogMatch) {
        this.serveBuildingLog(decodeURIComponent(buildingLogMatch[1]), res);
        return;
      }
      if (RELATIONSHIPS_ROUTE.test(path)) {
        this.serveJson(res, this.relationships?.all() ?? []);
        return;
      }
      if (GROUP_PLANS_ROUTE.test(path)) {
        this.serveJson(res, this.groupPlans?.all() ?? []);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('simVillage ingress-gateway: ok\n');
  }

  private async serveActions(villagerId: string, res: ServerResponse): Promise<void> {
    if (!this.actions) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'action log unavailable' }));
      return;
    }
    try {
      const records = await this.actions.listByVillager(villagerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(records));
    } catch (err) {
      console.warn('[gateway] action history failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'failed to load action history' }));
    }
  }

  private async serveConversations(res: ServerResponse): Promise<void> {
    if (!this.conversations) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'conversation log unavailable' }));
      return;
    }
    try {
      const records = await this.conversations.list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(records));
    } catch (err) {
      console.warn('[gateway] conversation list failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'failed to load conversations' }));
    }
  }

  /** Serve a plain JSON body with the standard headers (used by the read endpoints). */
  private serveJson(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Serve `GET /buildings/:id/log` from the in-memory rolling activity log. */
  private serveBuildingLog(buildingId: string, res: ServerResponse): void {
    if (!this.buildingLog) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'building log unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.buildingLog.recent(buildingId)));
  }

  // -------------------------------------------------------------------------
  // DOWN: world.events -> browsers
  // -------------------------------------------------------------------------

  private handleWorldEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'world.init': {
        const { width, height, tickRate, trees, buildings, weather } = event.payload;
        this.lastInit = { kind: 'world.init', width, height, tickRate, trees, buildings, weather };
        this.broadcast(this.lastInit);
        return;
      }
      case 'world.map_updated': {
        const { tick, villagers, carts, gatherings, buildingStocks } = event.payload;
        this.lastState = { kind: 'world.state_update', tick, villagers, carts, gatherings, buildingStocks };
        this.broadcast(this.lastState);
        return;
      }
      case 'world.weather_changed': {
        this.broadcast({ kind: 'world.weather', weather: event.payload.weather });
        return;
      }
      case 'world.building_event': {
        // Forward to any open inspector panel so it appends to the building's log.
        this.broadcast({ kind: 'building.event', event: event.payload });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket connection handling
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket): void {
    console.log('[gateway] browser connected');

    if (this.lastInit) {
      // Warm cache: hand the newcomer the world immediately.
      this.send(socket, this.lastInit);
      if (this.lastState) this.send(socket, this.lastState);
    } else {
      // Cold cache (we started after the engine): ask the engine to replay.
      this.bus.publish(EXCHANGES.userCommands, makeEvent('user.sync', {}));
    }
    // The current logical tick, so the debug window isn't blank until the next round.
    if (this.lastSimTick) this.send(socket, this.lastSimTick);

    socket.on('message', (raw) => this.handleMessage(raw.toString()));
    socket.on('close', () => console.log('[gateway] browser disconnected'));
    socket.on('error', (err) => console.warn('[gateway] socket error:', err.message));
  }

  // -------------------------------------------------------------------------
  // UP: browser commands -> user.commands
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[gateway] dropped non-JSON message');
      return;
    }

    const command = this.toBrowserCommand(parsed);
    if (!command) {
      console.warn('[gateway] dropped unrecognized command:', raw);
      return;
    }

    switch (command.command) {
      case 'force_move': {
        // The human "God Hand": relay it to the engine.
        const { targetId, x, y } = command;
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.force_move', { targetId, x, y }));
        return;
      }
      case 'plant_idea': {
        // The human "Inception": a TWO-word key the engine's `user.*` binding
        // ignores, delivered straight to the target villager.
        const { targetId, memory } = command;
        this.bus.publish(
          EXCHANGES.userCommands,
          makeEvent('user.intervention.plant_idea', { villagerId: targetId, memory, source: 'user' }),
        );
        return;
      }
      case 'supervisor_verdict': {
        // The temple console's per-prayer verdict — a multi-word key only the
        // Supervisor (binding `user.supervisor.*`) receives.
        const { prayerId, villagerId, villagerName, message, verdict } = command;
        this.bus.publish(
          EXCHANGES.userCommands,
          makeEvent('user.supervisor.verdict', { prayerId, villagerId, villagerName, message, verdict }),
        );
        return;
      }
      case 'supervisor_force_run': {
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.supervisor.force_run', {}));
        return;
      }
      case 'god_set_weather': {
        // A human "Divine Power": relayed straight to the engine (single-word key).
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.set_weather', { weather: command.weather }));
        this.broadcast({ kind: 'supervisor.action', action: 'change_weather', summary: `you turned the weather to ${command.weather}` });
        return;
      }
      case 'god_spawn': {
        const { entityType, x, y } = command;
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.spawn_entity', { entityType, x, y }));
        this.broadcast({ kind: 'supervisor.action', action: 'spawn_entity', summary: `you conjured a ${entityType}` });
        return;
      }
      case 'god_bless': {
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.bless', { villagerId: command.targetId }));
        this.broadcast({ kind: 'supervisor.action', action: 'bless', summary: `you blessed ${this.villagerName(command.targetId)}` });
        return;
      }
      case 'god_smite': {
        this.bus.publish(EXCHANGES.userCommands, makeEvent('user.smite', { villagerId: command.targetId }));
        this.broadcast({ kind: 'supervisor.action', action: 'smite', summary: `you smote ${this.villagerName(command.targetId)}` });
        return;
      }
    }
  }

  /** Resolve a villager's display name from the latest cached state, or its id. */
  private villagerName(id: string): string {
    return this.lastState?.villagers.find((v) => v.id === id)?.name ?? id;
  }

  /** One-line gloss of a supervisor command for the console's "divine acts" log. */
  private describeSupervisorAction(
    event: SupervisorCommandEvent,
  ): { action: string; summary: string } | null {
    switch (event.type) {
      case 'supervisor.spawn_entity':
        return {
          action: 'spawn_entity',
          summary: `spawned a ${event.payload.entityType} at (${event.payload.x}, ${event.payload.y})`,
        };
      case 'supervisor.change_weather':
        return { action: 'change_weather', summary: `turned the weather to ${event.payload.weather}` };
      case 'supervisor.plant_idea':
        return {
          action: 'plant_idea',
          summary: `whispered to ${this.villagerName(event.payload.villagerId)}: "${event.payload.memory}"`,
        };
      default:
        return null;
    }
  }

  /**
   * Validate an unknown JSON value into a typed `BrowserCommand`, or null. This
   * is the trust boundary between the browser and the bus: never relay
   * unvalidated input onto an exchange.
   */
  private toBrowserCommand(value: unknown): BrowserCommand | null {
    if (typeof value !== 'object' || value === null) return null;
    const obj = value as Record<string, unknown>;

    if (
      obj.command === 'force_move' &&
      typeof obj.targetId === 'string' &&
      typeof obj.x === 'number' &&
      typeof obj.y === 'number'
    ) {
      return { command: 'force_move', targetId: obj.targetId, x: obj.x, y: obj.y };
    }
    if (
      obj.command === 'plant_idea' &&
      typeof obj.targetId === 'string' &&
      typeof obj.memory === 'string' &&
      obj.memory.length > 0
    ) {
      return { command: 'plant_idea', targetId: obj.targetId, memory: obj.memory };
    }
    if (
      obj.command === 'supervisor_verdict' &&
      typeof obj.prayerId === 'string' &&
      typeof obj.villagerId === 'string' &&
      typeof obj.message === 'string' &&
      (obj.verdict === 'choose' || obj.verdict === 'reject')
    ) {
      return {
        command: 'supervisor_verdict',
        prayerId: obj.prayerId,
        villagerId: obj.villagerId,
        villagerName: typeof obj.villagerName === 'string' ? obj.villagerName : obj.villagerId,
        message: obj.message,
        verdict: obj.verdict,
      };
    }
    if (obj.command === 'supervisor_force_run') {
      return { command: 'supervisor_force_run' };
    }
    if (
      obj.command === 'god_set_weather' &&
      typeof obj.weather === 'string' &&
      (WEATHERS as readonly string[]).includes(obj.weather)
    ) {
      return { command: 'god_set_weather', weather: obj.weather as WeatherKind };
    }
    if (obj.command === 'god_bless' && typeof obj.targetId === 'string') {
      return { command: 'god_bless', targetId: obj.targetId };
    }
    if (obj.command === 'god_smite' && typeof obj.targetId === 'string') {
      return { command: 'god_smite', targetId: obj.targetId };
    }
    if (
      obj.command === 'god_spawn' &&
      (obj.entityType === 'villager' || obj.entityType === 'tree') &&
      typeof obj.x === 'number' &&
      typeof obj.y === 'number'
    ) {
      return { command: 'god_spawn', entityType: obj.entityType, x: obj.x, y: obj.y };
    }
    return null;
  }

  // -------------------------------------------------------------------------

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) client.send(data); // 1 === OPEN
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }
}
