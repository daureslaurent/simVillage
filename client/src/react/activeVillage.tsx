/**
 * client/src/react/activeVillage.tsx
 * ---------------------------------------------------------------------------
 * Shared selection state for which village the operator is currently focused on.
 * The topbar switcher and the god console both read + write it, so picking a
 * village in one place focuses it everywhere. Defaults to the leading village
 * once the model arrives.
 * ---------------------------------------------------------------------------
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useVillages } from './NetworkProvider';

interface ActiveVillageValue {
  /** The focused village id, or null before any village is known. */
  activeId: string | null;
  setActiveId: (id: string) => void;
}

const Ctx = createContext<ActiveVillageValue | null>(null);

export function ActiveVillageProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const villages = useVillages();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Adopt the leader once villages exist; keep the choice valid if a village vanishes.
  useEffect(() => {
    if (villages.length === 0) return;
    if (activeId === null || !villages.some((v) => v.id === activeId)) {
      setActiveId(villages[0]!.id);
    }
  }, [villages, activeId]);

  const value = useMemo<ActiveVillageValue>(() => ({ activeId, setActiveId }), [activeId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveVillage(): ActiveVillageValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActiveVillage must be used within <ActiveVillageProvider>');
  return ctx;
}
