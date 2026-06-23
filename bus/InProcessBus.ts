/**
 * bus/InProcessBus.ts
 * ---------------------------------------------------------------------------
 * The in-process implementation of the {@link EventBus} seam.
 *
 * Now that the entire backend is a single process, the bus is just an in-memory
 * fan-out: `publish` walks the subscriptions and delivers a copy of the
 * envelope to every handler whose topic pattern matches the routing key. It
 * speaks the exact same AMQP topic grammar the services were written for
 * (`*` = one word, `#` = zero-or-more words), so the engine bridge, gateway,
 * villagers, and supervisor keep working unchanged.
 *
 * Delivery is deferred to a microtask so a handler that publishes in response
 * (engine -> villager -> intent -> engine) never re-enters synchronously, and a
 * throwing handler is logged without taking down the publisher.
 * ---------------------------------------------------------------------------
 */

import type { EventEnvelope, ExchangeName } from '../shared/events';
import type { EventBus, EventHandler, SubscribeOptions } from './EventBus';

interface Subscription {
  exchange: ExchangeName;
  pattern: string;
  handler: EventHandler;
}

export interface InProcessBusOptions {
  /** Logical name used in logs. */
  name?: string;
}

export class InProcessBus implements EventBus {
  private readonly subscriptions: Subscription[] = [];
  private readonly name: string;

  constructor(options: InProcessBusOptions = {}) {
    this.name = options.name ?? 'bus';
  }

  async connect(): Promise<void> {
    // Nothing to connect to — the bus IS the process.
    console.log(`[${this.name}] in-process bus ready`);
  }

  async close(): Promise<void> {
    this.subscriptions.length = 0;
  }

  publish(exchange: ExchangeName, envelope: EventEnvelope): boolean {
    for (const sub of this.subscriptions) {
      if (sub.exchange !== exchange) continue;
      if (!topicMatch(sub.pattern, envelope.type)) continue;
      // Defer + isolate: never re-enter the publisher synchronously, and never
      // let one handler's failure stop delivery to the others.
      queueMicrotask(() => {
        Promise.resolve(sub.handler(envelope)).catch((err) =>
          console.warn(`[${this.name}] handler for "${envelope.type}" threw:`, errMsg(err)),
        );
      });
    }
    return true;
  }

  async subscribe<E extends EventEnvelope>(
    exchange: ExchangeName,
    pattern: string,
    handler: EventHandler<E>,
    _options: SubscribeOptions = {},
  ): Promise<void> {
    void _options; // queue/durable are meaningless in-process
    this.subscriptions.push({ exchange, pattern, handler: handler as EventHandler });
  }
}

/**
 * AMQP topic match: dotted words, `*` matches exactly one word, `#` matches
 * zero or more words. Small recursive matcher — correct and easier to trust
 * than a hand-rolled regex for the `#` (zero-word) edge cases.
 */
function topicMatch(pattern: string, key: string): boolean {
  return match(pattern.split('.'), 0, key.split('.'), 0);
}

function match(p: string[], i: number, k: string[], j: number): boolean {
  if (i === p.length) return j === k.length;
  if (p[i] === '#') {
    for (let x = j; x <= k.length; x++) {
      if (match(p, i + 1, k, x)) return true;
    }
    return false;
  }
  if (j === k.length) return false;
  if (p[i] === '*' || p[i] === k[j]) return match(p, i + 1, k, j + 1);
  return false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
