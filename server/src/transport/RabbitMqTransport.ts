/**
 * server/src/transport/RabbitMqTransport.ts
 * ---------------------------------------------------------------------------
 * The Phase 2 implementation of `Transport`, backed by RabbitMQ instead of
 * WebSockets. This is the engine's connection to the nervous system.
 *
 * The pure `WorldEngine` is unchanged — exactly as Phase 1 promised, swapping
 * the transport touched not a single line of the engine. This class:
 *
 *   INBOUND  — subscribes to the `user.commands` and `villager.intents` exchanges
 *              and translates each envelope into a transport-agnostic
 *              `ClientCommand` fed to `engine.dispatchCommand`.
 *
 *   OUTBOUND — listens to the engine's `init`/`tick` events and publishes them
 *              to `world.events` as `world.init` / `world.map_updated`.
 *
 *   SYNC     — answers a gateway's `user.sync` request by (re)publishing the
 *              current init + latest state, so a browser that connects to a
 *              freshly-booted gateway still gets the full world.
 *
 * The WebSocket server now lives in the separate Ingress Gateway service; the
 * engine no longer speaks WebSocket at all.
 * ---------------------------------------------------------------------------
 */

import type {
  VillagerIntentEvent,
  SupervisorCommandEvent,
  UserCommandEvent,
  WorldInitPayload,
  WorldMapUpdatedPayload,
} from '../../../shared/events';
import { EXCHANGES } from '../../../shared/events';
import type { BuildingEvent, WeatherKind, WorldInitMessage, WorldStateUpdate } from '../../../shared/types';
import type { EventBus } from '../../../bus/EventBus';
import { makeEvent } from '../../../bus/EventBus';
import type { WorldEngine } from '../WorldEngine';
import type { Transport } from './Transport';

/** Durable queue names so commands/intents buffer across an engine restart. */
const USER_QUEUE = 'engine.user.commands';
const VILLAGER_QUEUE = 'engine.villager.intents';
const SUPERVISOR_QUEUE = 'engine.supervisor.commands';

export class RabbitMqTransport implements Transport {
  /** Publishes the one-time static world whenever the engine (re)announces it. */
  private readonly onInit = (message: WorldInitMessage): void => {
    this.publishInit(message);
  };

  /** Publishes the per-tick movement result to `world.events`. */
  private readonly onTick = (update: WorldStateUpdate): void => {
    this.publishState(update);
  };

  /** Publishes a God-Villager weather change to `world.events`. */
  private readonly onWeather = (weather: WeatherKind): void => {
    this.bus.publish(EXCHANGES.worldEvents, makeEvent('world.weather_changed', { weather }));
  };

  /** Publishes a building activity event to `world.events` (→ gateway + minds). */
  private readonly onBuildingEvent = (event: BuildingEvent): void => {
    this.bus.publish(EXCHANGES.worldEvents, makeEvent('world.building_event', event));
  };

  constructor(
    private readonly engine: WorldEngine,
    private readonly bus: EventBus,
  ) {}

  async start(): Promise<void> {
    // INBOUND: human interventions relayed by the gateway.
    await this.bus.subscribe<UserCommandEvent>(
      EXCHANGES.userCommands,
      'user.*',
      (event) => this.handleUserCommand(event),
      { queue: USER_QUEUE, durable: true },
    );

    // INBOUND: autonomous villagers' own intents.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.*',
      (event) => this.handleVillagerIntent(event),
      { queue: VILLAGER_QUEUE, durable: true },
    );

    // INBOUND: the God Agent's macro interventions. We bind `supervisor.*` and
    // ignore `supervisor.plant_idea` here — that one is for the villagers (it has
    // its own queues on this same exchange), not the engine.
    await this.bus.subscribe<SupervisorCommandEvent>(
      EXCHANGES.supervisorCommands,
      'supervisor.*',
      (event) => this.handleSupervisorCommand(event),
      { queue: SUPERVISOR_QUEUE, durable: true },
    );

    // OUTBOUND: fan the engine's lifecycle out onto the bus.
    this.engine.on('init', this.onInit);
    this.engine.on('tick', this.onTick);
    this.engine.on('weather', this.onWeather);
    this.engine.on('buildingEvent', this.onBuildingEvent);

    console.log(
      '[rabbit] engine transport ready (consuming user.commands + villager.intents + supervisor.commands)',
    );
  }

  async stop(): Promise<void> {
    this.engine.off('init', this.onInit);
    this.engine.off('tick', this.onTick);
    this.engine.off('weather', this.onWeather);
    this.engine.off('buildingEvent', this.onBuildingEvent);
    await this.bus.close();
  }

  // -------------------------------------------------------------------------
  // Inbound translation: bus envelope -> engine command
  // -------------------------------------------------------------------------

  private handleUserCommand(event: UserCommandEvent): void {
    switch (event.type) {
      case 'user.force_move': {
        const { targetId, x, y } = event.payload;
        this.engine.dispatchCommand({ command: 'force_move', targetId, x, y });
        return;
      }
      case 'user.sync':
        // A new gateway is asking for the world; replay the current picture.
        this.publishInit(this.engine.getInitMessage());
        this.publishState(this.engine.getStateUpdate());
        return;
      case 'user.set_weather':
        this.engine.dispatchCommand({ command: 'set_weather', weather: event.payload.weather });
        return;
      case 'user.spawn_entity': {
        const { entityType, x, y } = event.payload;
        this.engine.dispatchCommand({ command: 'spawn_entity', entityType, x, y });
        return;
      }
      case 'user.bless':
        this.engine.dispatchCommand({ command: 'bless_villager', villagerId: event.payload.villagerId });
        return;
      case 'user.smite':
        this.engine.dispatchCommand({ command: 'smite_villager', villagerId: event.payload.villagerId });
        return;
    }
  }

  private handleVillagerIntent(event: VillagerIntentEvent): void {
    switch (event.type) {
      case 'villager.move': {
        const { villagerId, x, y } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_move', villagerId, x, y });
        return;
      }
      case 'villager.work': {
        const { villagerId, buildingId } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_work', villagerId, buildingId });
        return;
      }
      case 'villager.take': {
        const { villagerId, buildingId, resource } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_take', villagerId, buildingId, resource });
        return;
      }
      case 'villager.give': {
        const { villagerId, buildingId, resource } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_give', villagerId, buildingId, resource });
        return;
      }
      case 'villager.pray': {
        const { villagerId, buildingId, message } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_pray', villagerId, buildingId, message });
        return;
      }
      case 'villager.propose_build': {
        // The engine opens the construction site; the GroupCoordinator (a separate
        // consumer of this same intent) opens the matching village build plan.
        const { villagerId, structure, name, x, y } = event.payload;
        this.engine.dispatchCommand({ command: 'villager_start_build', villagerId, structure, name, x, y });
        return;
      }
      case 'villager.command_cart': {
        const { villagerId, cartId, resource, fromBuildingId, toBuildingId } = event.payload;
        this.engine.dispatchCommand({
          command: 'villager_command_cart',
          villagerId,
          cartId,
          resource,
          fromBuildingId,
          toBuildingId,
        });
        return;
      }
      // villager.speak / villager.interact ride this exchange for observers; the
      // engine has no state change to make for them today.
    }
  }

  private handleSupervisorCommand(event: SupervisorCommandEvent): void {
    switch (event.type) {
      case 'supervisor.spawn_entity': {
        const { entityType, x, y } = event.payload;
        this.engine.dispatchCommand({ command: 'spawn_entity', entityType, x, y });
        return;
      }
      case 'supervisor.change_weather': {
        this.engine.dispatchCommand({ command: 'set_weather', weather: event.payload.weather });
        return;
      }
      case 'supervisor.plant_idea':
        // Not for the engine — the villagers consume this from the same exchange.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound translation: engine message -> bus envelope
  // -------------------------------------------------------------------------

  private publishInit(message: WorldInitMessage): void {
    const payload: WorldInitPayload = {
      width: message.width,
      height: message.height,
      tickRate: message.tickRate,
      trees: message.trees,
      buildings: message.buildings,
      weather: message.weather,
    };
    this.bus.publish(EXCHANGES.worldEvents, makeEvent('world.init', payload));
  }

  private publishState(update: WorldStateUpdate): void {
    const payload: WorldMapUpdatedPayload = {
      tick: update.tick,
      villagers: update.villagers,
      carts: update.carts,
      gatherings: update.gatherings,
      buildingStocks: update.buildingStocks,
    };
    this.bus.publish(EXCHANGES.worldEvents, makeEvent('world.map_updated', payload));
  }
}
