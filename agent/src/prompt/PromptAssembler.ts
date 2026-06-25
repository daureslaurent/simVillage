/**
 * agent/src/prompt/PromptAssembler.ts
 * ---------------------------------------------------------------------------
 * The PROMPT ASSEMBLER — one object per villager that composes its LLM requests
 * from the pure {@link blocks}. It owns the two stable inputs (the shared world
 * bible and this villager's persona) so the per-turn call sites stay small: hand
 * it a perception (plus the live conversation and today's plan) and it returns the
 * finished system + user messages.
 *
 * Why a class and not loose functions: the SYSTEM half (bible + persona + action
 * contract) is fixed for a villager's whole life, so it is built ONCE here and
 * reused every turn — only recalled memories are appended per turn. That keeps the
 * long shared prefix identical turn after turn (and across villagers, for the
 * bible), which is exactly what prompt caching rewards.
 * ---------------------------------------------------------------------------
 */

import type { AgendaEvent, AgendaNote, BuildingEvent, GroupPlan, Relationship, VillageVision } from '../../../shared/types';
import type { CharacterProfile } from '../profile';
import type { MapEntry, Perception } from '../sensory';
import type { PlanBlock } from '../planning/DailyPlanner';
import {
  buildPerceptionMessage,
  buildSituationQuery,
  buildSystemPrompt,
  buildVillageMapMessage,
  composeSystemWithMemories,
  relationshipsBlock,
  type HeardUtterance,
  type SocialHub,
} from './blocks';

/** Everything that varies turn to turn, beyond the perception itself. */
export interface TurnInputs {
  /** The short-term earshot buffer to render as the running conversation. */
  recentSpeech?: HeardUtterance[];
  /** The plan block governing this part of day, if a plan exists. */
  planBlock?: PlanBlock | null;
  /** The day's overall theme, if a plan exists. */
  planTheme?: string | null;
  /** The village's shared gathering place, named as a fact when the villager is alone. */
  socialHub?: SocialHub | null;
  /** The whole-village layout, so the per-turn prompt can name where every place is. */
  villageMap?: MapEntry[];
  /** Recent activity of buildings in sensing range, keyed by building id. */
  buildingActivity?: Record<string, BuildingEvent[]>;
  /**
   * Why last turn's action could not be carried out (no audience, redundant move,
   * malformed call), if anything. Surfaced so the mind self-corrects this turn.
   */
  lastSkippedReason?: string | null;
  /** The shared plan this villager is already a member of, if any. */
  groupPlan?: GroupPlan | null;
  /** A plan its current company is forming that it could join, if any. */
  joinablePlan?: GroupPlan | null;
  /** Scheduled events this villager is attending (personal or shared), soonest first. */
  agendaEvents?: AgendaEvent[];
  /** Events this villager has been invited to but not yet accepted, soonest first. */
  agendaInvited?: AgendaEvent[];
  /** This villager's untimed agenda notes, newest first. */
  agendaNotes?: AgendaNote[];
  /** The village's shared vision (ambition + named stage + milestones), if known. */
  villageVision?: VillageVision | null;
  /** Salient things that happened around the villager since it last acted, newest last. */
  recentEvents?: string[];
}

export class PromptAssembler {
  /** The stable system prompt (bible + persona + action contract), built once. */
  private readonly baseSystem: string;

  constructor(profile: CharacterProfile, bible = '') {
    this.baseSystem = buildSystemPrompt(profile, bible);
  }

  /**
   * The system message for a turn: the stable base, then the villager's standing
   * view of its neighbours (changes only nightly), then any recalled memories
   * (change every turn). Pass [] / [] for the no-memory, no-relations case.
   */
  system(memories: string[] = [], relationships: Relationship[] = []): string {
    let system = this.baseSystem + relationshipsBlock(relationships);
    if (memories.length > 0) system = composeSystemWithMemories(system, memories);
    return system;
  }

  /** The per-turn user message: body, plan, conversation, and what is sensed now. */
  user(perception: Perception, inputs: TurnInputs = {}): string {
    return buildPerceptionMessage(perception, {
      recentSpeech: inputs.recentSpeech ?? [],
      planBlock: inputs.planBlock ?? null,
      planTheme: inputs.planTheme ?? null,
      socialHub: inputs.socialHub ?? null,
      villageMap: inputs.villageMap ?? [],
      buildingActivity: inputs.buildingActivity ?? {},
      lastSkippedReason: inputs.lastSkippedReason ?? null,
      groupPlan: inputs.groupPlan ?? null,
      joinablePlan: inputs.joinablePlan ?? null,
      agendaEvents: inputs.agendaEvents ?? [],
      agendaInvited: inputs.agendaInvited ?? [],
      agendaNotes: inputs.agendaNotes ?? [],
      villageVision: inputs.villageVision ?? null,
      recentEvents: inputs.recentEvents ?? [],
    });
  }

  /** The embeddable "what is happening to me" string used as the memory-recall query. */
  situationQuery(perception: Perception): string {
    return buildSituationQuery(perception);
  }

  /** The map reference handed back when a mind calls consult_map. */
  villageMap(entries: MapEntry[]): string {
    return buildVillageMapMessage(entries);
  }
}
