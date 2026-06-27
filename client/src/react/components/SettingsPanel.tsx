/**
 * client/src/react/components/SettingsPanel.tsx
 * ---------------------------------------------------------------------------
 * Operator controls for the LLM engine: the chat MODEL every mind/god thinks
 * with, the per-purpose REASONING EFFORT, and a guarded "new village" wipe. The
 * backend owns the truth — each pick is sent up and the live config streams back
 * (useModel / useEffortSettings), so the controls always mirror the server.
 * ---------------------------------------------------------------------------
 */

import { useState } from 'react';
import {
  EFFORT_PURPOSES,
  REASONING_EFFORT_LABELS,
  type EffortPurpose,
  type ReasoningEffort,
} from '../../../../shared/types';
import { useEffortSettings, useModel, useNet } from '../NetworkProvider';
import { cx } from './ui';

const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const PURPOSE_META: Record<EffortPurpose, { title: string; icon: string; hint: string }> = {
  decide: { title: 'Villager minds', icon: '🧍', hint: "Each villager's moment-to-moment choice." },
  supervisor: { title: 'The God (Supervisor)', icon: '⛪', hint: "The god's judgement over the village." },
  reflect: { title: 'Nightly reflection', icon: '🌙', hint: 'How a villager reasons over its day.' },
  plan: { title: 'Daily planning', icon: '📜', hint: "Each villager's morning agenda." },
};

export function SettingsPanel(): React.JSX.Element {
  const net = useNet();
  const effort = useEffortSettings();
  const model = useModel();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      {/* Engine model */}
      <section className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Engine model</div>
        <div className="flex items-center gap-2 rounded-lg bg-card/50 p-2">
          <span className={cx('h-2 w-2 rounded-full', model ? 'bg-ok' : 'animate-pulse bg-warn')} />
          <div className="flex flex-col">
            <span className="text-[10px] text-faint">Currently thinking with</span>
            <span className="font-semibold text-text">{model?.current || '…'}</span>
          </div>
          <button
            onClick={() => net.refreshLlmModels()}
            title="Re-scan the engine for available models"
            className="ml-auto rounded-md border border-soft bg-card px-2 py-1 text-muted hover:text-text"
          >
            ⟲
          </button>
        </div>
        {model && (
          <select
            value={model.current}
            disabled={model.available.length <= 1}
            onChange={(e) => net.setLlmModel(e.target.value)}
            className="w-full rounded-md border border-soft bg-surface-2 px-2 py-1 text-text disabled:opacity-50"
          >
            {(model.available.includes(model.current) ? model.available : [model.current, ...model.available]).map(
              (id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ),
            )}
          </select>
        )}
      </section>

      {/* Reasoning effort */}
      <section className="space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Reasoning effort</div>
        {!effort ? (
          <div className="text-faint">Connecting to the engine…</div>
        ) : (
          EFFORT_PURPOSES.map((purpose) => {
            const meta = PURPOSE_META[purpose];
            return (
              <div key={purpose} className="space-y-1 rounded-lg bg-card/30 p-2">
                <div className="flex items-center gap-1.5 font-medium text-text">
                  <span>{meta.icon}</span>
                  {meta.title}
                </div>
                <div className="text-[10px] text-faint">{meta.hint}</div>
                <div className="flex gap-1">
                  {LEVELS.map((level) => (
                    <button
                      key={level}
                      onClick={() => net.setReasoningEffort(purpose, level)}
                      className={cx(
                        'flex-1 rounded-md border px-2 py-1 capitalize',
                        effort[purpose] === level
                          ? 'border-accent/60 bg-accent/15 text-text'
                          : 'border-soft bg-card text-muted hover:text-text',
                      )}
                    >
                      {REASONING_EFFORT_LABELS[level]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* New village (danger) */}
      <section className="mt-auto space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">New village</div>
        <div className="text-[10px] text-faint">
          Start over from the setup screen. This permanently deletes the current world.
        </div>
        {!confirmReset ? (
          <button
            onClick={() => setConfirmReset(true)}
            className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-danger hover:bg-danger/20"
          >
            🌱 New village…
          </button>
        ) : (
          <div className="space-y-1.5 rounded-lg border border-danger/40 bg-danger/5 p-2">
            <div className="text-text">Delete this village and start fresh?</div>
            <div className="flex gap-1">
              <button
                onClick={() => net.resetWorld()}
                className="rounded-md border border-danger/50 bg-danger/15 px-2 py-1 text-danger"
              >
                Yes, wipe it
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                className="rounded-md border border-soft bg-card px-2 py-1 text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
