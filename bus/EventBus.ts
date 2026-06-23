/**
 * bus/EventBus.ts
 * ---------------------------------------------------------------------------
 * The bus seam, transport-neutral.
 *
 * The whole backend now runs in ONE process, so the "nervous system" no longer
 * needs a broker between services — it is an in-process event bus
 * (`InProcessBus`) that every backend service (engine bridge, gateway,
 * villagers, supervisor, aggregator) shares. This file keeps the original
 * surface the services were written against — `EventBus` (now an interface),
 * `makeEvent`, and the handler/subscribe types — so none of them had to change
 * when RabbitMQ was dropped.
 *
 * Topology is unchanged conceptually: the same Topic Exchanges from
 * `shared/events`, the same dotted routing keys, the same publish/subscribe
 * verbs — only the wire underneath is gone.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';

import type { EventEnvelope, ExchangeName } from '../shared/events';

/** A handler receives the already-parsed, typed envelope. */
export type EventHandler<E extends EventEnvelope = EventEnvelope> = (
  envelope: E,
) => void | Promise<void>;

export interface SubscribeOptions {
  /**
   * A stable queue name. With a real broker this buffers across restarts; in
   * the in-process bus it is accepted (for API compatibility) but ignored —
   * everything lives and dies with the one process.
   */
  queue?: string;
  /** Whether a named queue survives a broker restart. Ignored in-process. */
  durable?: boolean;
}

/**
 * The bus contract every service depends on. `EventBus` is an INTERFACE now, so
 * services keep `import type { EventBus }` and accept whichever implementation
 * the composition root injects (today: {@link InProcessBus}).
 */
export interface EventBus {
  /** Ready the bus. A no-op for the in-process implementation. */
  connect(): Promise<void>;
  /** Tear the bus down and drop all subscriptions. */
  close(): Promise<void>;
  /**
   * Publish an envelope to an exchange, routed by its `type`. Returns false if
   * the bus is unavailable (the in-process bus always accepts).
   */
  publish(exchange: ExchangeName, envelope: EventEnvelope): boolean;
  /**
   * Subscribe to events on `exchange` whose routing key matches the topic
   * `pattern` (e.g. `world.*`, `villager.#`). The handler receives the typed
   * envelope.
   */
  subscribe<E extends EventEnvelope>(
    exchange: ExchangeName,
    pattern: string,
    handler: EventHandler<E>,
    options?: SubscribeOptions,
  ): Promise<void>;
}

/** Build a fully-formed envelope (stamps `eventId` + `timestamp`). */
export function makeEvent<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): EventEnvelope<TType, TPayload> {
  return { eventId: randomUUID(), timestamp: Date.now(), type, payload };
}

export { InProcessBus } from './InProcessBus';
