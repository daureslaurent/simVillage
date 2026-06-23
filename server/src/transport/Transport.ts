/**
 * server/src/transport/Transport.ts
 * ---------------------------------------------------------------------------
 * THE seam that makes the networking layer swappable.
 *
 * A Transport is whatever carries world state OUT to observers and carries
 * commands IN from them. In Phase 1 that's a `WebSocketTransport`. In Phase 2
 * it becomes a `RabbitMqTransport` — and because the engine only ever talks to
 * this interface (via events + `dispatchCommand`), nothing in WorldEngine.ts
 * has to change.
 *
 * A Transport is constructed with a reference to the engine, subscribes to its
 * `tick`/`init` events, and forwards inbound commands to `engine.dispatchCommand`.
 * ---------------------------------------------------------------------------
 */

export interface Transport {
  /**
   * Begin accepting connections / consuming the queue and broadcasting state.
   * May be async (the RabbitMQ transport awaits queue declaration + binding).
   */
  start(): Promise<void> | void;
  /** Tear down cleanly (close sockets / channels, remove listeners). */
  stop(): Promise<void> | void;
}
