/**
 * server/src/persistence/RuntimeStateStore.ts
 * ---------------------------------------------------------------------------
 * A tiny generic KEY/VALUE persistence seam, mirroring {@link WorldStore} and
 * {@link RelationshipStore}. It is the home for the bits of LIVE service state
 * that aren't part of the world snapshot but must still survive a restart so the
 * simulation resumes seamlessly:
 *
 *   - the Supervisor's cooldown / pending prayers / last summary  (key "supervisor")
 *   - each villager's last-reflected day                          (key "reflection:<id>")
 *   - the village's shared group plans                            (key "group-plans")
 *
 * Values are arbitrary JSON-serialisable blobs, keyed by a stable string. Only
 * the concrete Mongo implementation imports the driver, keeping the services
 * datastore-agnostic.
 * ---------------------------------------------------------------------------
 */

export interface RuntimeStateStore {
  /** Open the underlying connection. */
  connect(): Promise<void>;

  /** Read a stored value by key, or null if nothing was ever written for it. */
  get<T>(key: string): Promise<T | null>;

  /** Write (replace) the value stored under a key. */
  set<T>(key: string, value: T): Promise<void>;

  /** Close the underlying connection. */
  close(): Promise<void>;
}
