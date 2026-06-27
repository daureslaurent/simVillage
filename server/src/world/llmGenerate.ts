/**
 * server/src/world/llmGenerate.ts
 * ---------------------------------------------------------------------------
 * LLM WORLD GENERATION (opt-in via GENERATE_LLM=on).
 *
 * On a FIRST boot with no persisted world, this builds a fresh village with the
 * shared LLM engine instead of the hand-authored seed: a themed map, a roster of
 * distinct villagers, and a themed world bible. It is deliberately defensive — a
 * local model is asked for strict JSON and small spatial layouts it is not great
 * at, so every model output is validated, clamped and repaired, and the whole
 * thing retries then FALLS BACK to the classic deterministic seed if it cannot
 * produce something playable. A generated village is themed only in NAMES, FLAVOUR
 * and layout; the ECONOMY (building kinds, chains, tools) is fixed, so the minds'
 * tools always work and the survival loop always closes.
 *
 * Three call shapes, smallest schema each so a local model can satisfy them:
 *   1. one OVERVIEW call  -> theme, map size, building plan, villager count
 *   2. one call PER VILLAGER -> a distinct persona (name/traits/goal/backstory)
 *   3. one BIBLE call -> themed flavour intro + place glossary (mechanics fixed)
 * ---------------------------------------------------------------------------
 */

import type { BuildingKind, TerrainPalette, VillageSize, WorldSeed } from '../../../shared/types';
import { DEFAULT_TERRAIN_PALETTE } from '../../../shared/types';
import {
  BUILDING_FUNCTIONS,
  GENERATABLE_KINDS,
  REQUIRED_KINDS,
} from '../../../shared/buildings';
import type { CharacterProfile } from '../../../agent/src/profile';
import { defaultProfile } from '../../../agent/src/profile';
import {
  ACCENT_STYLES,
  BODY_SHAPES,
  HAIR_STYLES,
  HAT_STYLES,
  coerceAppearance,
  deriveAppearance,
} from '../../../shared/appearance';
import {
  buildSeedFromPlan,
  buildRivalSeedFromPlans,
  type BuildingPlanItem,
  type WorldPlan,
} from './seed';
import { DEFAULT_VILLAGE_ID, RIVAL_VILLAGE_ID } from '../../../shared/types';

/** Render an option vocabulary as a quoted list for a generation prompt. */
function listFor(opts: readonly string[]): string {
  return opts.map((o) => `"${o}"`).join(', ');
}

/**
 * Fold a side's STYLE together with the shared MAP backdrop into one theme line for
 * the generator. The style leads (it themes the side fully); the backdrop is a wider
 * setting hint. Either may be empty — with neither, the model invents a style.
 */
function combineTheme(style: string, backdrop: string): string {
  const s = style.trim();
  const b = backdrop.trim();
  if (s && b) return `${s}, set within a wider valley of ${b}`;
  return s || b;
}

/**
 * The minimal LLM seam the generator needs: one free-text completion. Satisfied by
 * the backend's {@link HttpLLMClient} (its `synthesize`); kept narrow so this module
 * doesn't depend on the whole client. `purpose: 'plan'` reuses the planning lane.
 */
export interface GenerationLLM {
  synthesize(req: {
    system: string;
    user: string;
    purpose: 'plan';
    agent?: string;
    /** Raise the token budget so a THINKING model can reason AND still emit the JSON. */
    maxTokens?: number;
  }): Promise<string>;
}

/**
 * Token budgets for the generation calls. Generous on purpose: the local chat model
 * is a THINKING model that reasons in prose before it writes, and with too tight a
 * cap it spends the whole budget deliberating and never reaches the JSON (the bug
 * this guards against). The overview/bible carry the most structure.
 */
const OVERVIEW_TOKENS = 6000;
const VILLAGER_TOKENS = 2500;
const BIBLE_TOKENS = 4000;

/**
 * A short, blunt directive appended to every generation prompt to curb a thinking
 * model's deliberation and push it to emit the answer. The strict-JSON shape is
 * spelled out in each call's own system prompt.
 */
const JSON_ONLY_STEER =
  'Think briefly, then STOP and output the JSON. Do not narrate your plan, do not ' +
  'list options, do not write anything before or after the JSON. Your reply must be ' +
  'the single JSON object and nothing else.';

/** A fully generated world, ready to seed the engine and give the minds. */
export interface GeneratedWorld {
  seed: WorldSeed;
  profiles: CharacterProfile[];
  bible: string;
  theme: string;
  setting: string;
}

/**
 * One generated village's CONTENT, before it is committed to map coordinates: the
 * building plan, the roster, the themed bible and the resolved theme/setting. Kept
 * separate from the seed so the same generation can feed either a single-village
 * {@link buildSeedFromPlan} or a two-village {@link buildRivalSeedFromPlans}.
 */
export interface GeneratedVillageContent {
  plan: WorldPlan;
  profiles: CharacterProfile[];
  bible: string;
  theme: string;
  setting: string;
}

/**
 * A fully generated TWO-village world (the LLM counterpart of the fixed-blueprint
 * rival seed): one shared wide map, each side with its own themed roster + bible.
 */
export interface GeneratedRivalWorld {
  seed: WorldSeed;
  home: { profiles: CharacterProfile[]; bible: string; theme: string; setting: string };
  rival: { profiles: CharacterProfile[]; bible: string; theme: string; setting: string };
}

/**
 * One step of generation progress, reported as the build advances so a UI can show
 * a live loading overlay. `step`/`total` are set for the per-villager phase.
 */
export interface GenerationProgressStep {
  phase: 'map' | 'villagers' | 'bible' | 'assembling';
  label: string;
  step?: number;
  total?: number;
}

/** A sink for generation progress (e.g. publishes a `world.generating` event). */
export type GenerationProgress = (step: GenerationProgressStep) => void;

/** Map dimension, inter-building gap and tree cover per {@link VillageSize}. */
export const VILLAGE_SIZES: Record<VillageSize, { map: number; margin: number; trees: number; villagers: number }> = {
  small: { map: 180, margin: 1, trees: 120, villagers: 3 },
  medium: { map: 260, margin: 2, trees: 280, villagers: 5 },
  large: { map: 360, margin: 2, trees: 520, villagers: 8 },
};

export interface GenerateWorldOptions {
  /**
   * The village STYLE — a free-text string the player typed (e.g. "a desert oasis",
   * "an alien crystalline hive", "a fishing village on stilts"). Read verbatim by the
   * model; empty/undefined lets it invent a setting.
   */
  theme?: string;
  /** Hard ceiling on villagers; the model picks the actual count in [1, max] unless `villagers` is set. */
  maxVillagers: number;
  /** Exact villager count the player asked for (slider). Overrides the model's choice; clamped to [1, max]. */
  villagers?: number;
  /** Village size/density (map + packing + tree cover). Defaults to 'medium'. */
  size?: VillageSize;
  /** How many times to retry the overview/bible calls before giving up. Default 2. */
  retries?: number;
  /** Optional progress sink, called as each phase begins (for a loading overlay). */
  onProgress?: GenerationProgress;
}

/** Typical footprint per kind — a default when the model omits/garbles a size. */
const DEFAULT_FOOTPRINT: Record<BuildingKind, { w: number; h: number }> = {
  water_source: { w: 3, h: 3 },
  greenfield: { w: 13, h: 9 },
  lumber_source: { w: 9, h: 9 },
  workshop: { w: 7, h: 6 },
  hall_town: { w: 8, h: 6 },
  tavern: { w: 7, h: 5 },
  temple: { w: 6, h: 9 },
  quarry: { w: 7, h: 7 },
  house: { w: 4, h: 4 },
  // Runtime-only kinds — never generated, but the table must be total.
  construction_site: { w: 4, h: 4 },
  monument: { w: 2, h: 2 },
  lamp: { w: 1, h: 1 },
  landmark: { w: 3, h: 3 },
  depot: { w: 3, h: 3 },
  // Fortifications — placed by a god during the war, never by the generator, but the
  // table must be total. Mirrors FORT_FOOTPRINT in shared/fortifications.ts.
  wall: { w: 1, h: 1 },
  gate: { w: 1, h: 1 },
  watchtower: { w: 2, h: 2 },
  barracks: { w: 3, h: 3 },
  war_camp: { w: 3, h: 3 },
  siege_ram: { w: 2, h: 2 },
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete world with the LLM. THROWS if it cannot produce a valid
 * overview after the configured retries — the caller is expected to fall back to
 * the classic seed. Per-villager and bible failures degrade softly (a default
 * persona / a fixed-flavour bible) rather than dooming the whole generation.
 */
export async function generateWorldWithLLM(
  llm: GenerationLLM,
  villagerIdFor: (i: number) => string,
  opts: GenerateWorldOptions,
): Promise<GeneratedWorld> {
  const retries = opts.retries ?? 2;
  const theme = (opts.theme ?? '').trim();
  const report = opts.onProgress ?? (() => {});
  const size = VILLAGE_SIZES[opts.size ?? 'medium'];
  // The player's slider wins over the model; otherwise the size's default count,
  // both clamped to the hard ceiling.
  const villagerCount = clampInt(opts.villagers ?? size.villagers, 1, opts.maxVillagers);

  const content = await generateVillageContent(llm, villagerIdFor, {
    theme,
    villagerCount,
    size,
    retries,
    report,
  });

  report({ phase: 'assembling', label: 'Raising the village' });
  const seed = buildSeedFromPlan(content.plan, content.profiles.map((p) => p.id));
  stampAppearances(seed, content.profiles);
  return {
    seed,
    profiles: content.profiles,
    bible: content.bible,
    theme: content.theme,
    setting: content.setting,
  };
}

/**
 * Generate the CONTENT of one village (map plan, roster, themed bible) without
 * committing it to map coordinates. The overview is retried then THROWS on total
 * failure (the caller falls back); per-villager and bible failures degrade softly.
 * The optional `labelPrefix` tags progress labels so a two-village build can show
 * which side it is on.
 */
async function generateVillageContent(
  llm: GenerationLLM,
  villagerIdFor: (i: number) => string,
  opts: {
    theme: string;
    villagerCount: number;
    size: { map: number; margin: number; trees: number };
    retries: number;
    report: GenerationProgress;
    labelPrefix?: string;
  },
): Promise<GeneratedVillageContent> {
  const { theme, villagerCount, size, retries, report } = opts;
  const tag = opts.labelPrefix ?? '';

  // 1. Overview — the map, the buildings. Retried; on total failure this throws.
  report({ phase: 'map', label: `${tag}Drawing up the lay of the land` });
  const overview = await withRetry(retries, 'overview', () =>
    generateOverview(llm, theme, villagerCount),
  );
  const resolvedTheme = overview.theme;
  const setting = overview.setting;

  // 2. The building plan, validated + augmented so the economy always closes. The
  //    size choice fixes the map, packing gap and tree cover.
  const plan = buildPlan(overview, { villagerCount, size });
  const buildingSummary = plan.buildings.map((b) => `${b.name} (${b.kind})`).join(', ');

  // 3. One persona per villager, in sequence so each can see its peers and stay
  //    distinct. A failed villager falls back to a themed default.
  const profiles: CharacterProfile[] = [];
  for (let i = 0; i < villagerCount; i++) {
    const id = villagerIdFor(i);
    report({
      phase: 'villagers',
      label: `${tag}Breathing life into the villagers`,
      step: i + 1,
      total: villagerCount,
    });
    let profile: CharacterProfile;
    try {
      profile = await withRetry(1, `villager ${i + 1}`, () =>
        generateVillager(llm, id, resolvedTheme, setting, buildingSummary, profiles),
      );
    } catch (err) {
      console.warn(`[generate] villager ${i + 1} failed (${errMsg(err)}); using a default persona`);
      profile = {
        ...defaultProfile(id),
        status: 'newly arrived, looking around',
        appearance: deriveAppearance(id),
      };
    }
    profiles.push(profile);
  }

  // 4. The themed world bible. Soft fallback to a fixed-flavour bible on failure.
  report({ phase: 'bible', label: `${tag}Writing the village’s story` });
  let bible: string;
  try {
    bible = await withRetry(retries, 'bible', () =>
      generateBible(llm, resolvedTheme, setting, plan.buildings),
    );
  } catch (err) {
    console.warn(`[generate] bible failed (${errMsg(err)}); using a neutral themed bible`);
    bible = composeBible(`You live in ${setting}`, '', plan.buildings);
  }

  return { plan, profiles, bible, theme: resolvedTheme, setting };
}

/**
 * Stamp each generated LOOK onto its matching villager body so the browser draws the
 * figure the persona was given, keeping the map colour in step with it.
 */
function stampAppearances(seed: WorldSeed, profiles: CharacterProfile[]): void {
  for (const villager of seed.villagers) {
    const appearance = profiles.find((p) => p.id === villager.id)?.appearance;
    if (appearance) {
      villager.appearance = appearance;
      villager.color = appearance.bodyColor;
    }
  }
}

// ---------------------------------------------------------------------------
// Two-village (rival) generation — the LLM counterpart of `generateRivalSeed`.
// ---------------------------------------------------------------------------

/** One side's independent generation parameters in a two-village build. */
export interface RivalSideOptions {
  /** This side's STYLE — fully themes its roster, building names and ground palette. */
  style?: string;
  /** This side's villager count; clamped to [1, maxVillagers]. Defaults to the size's count. */
  villagers?: number;
  /** This side's size/density (map packing + tree cover). Defaults to 'medium'. */
  size?: VillageSize;
}

export interface GenerateRivalWorldOptions {
  /**
   * The shared MAP/valley backdrop — a loose mood hint folded into BOTH sides' themes
   * so the two settlements read as one valley. Each side still themes itself fully.
   */
  mapTheme?: string;
  /** Hard ceiling on villagers per side. */
  maxVillagers: number;
  /** Retries for the overview/bible calls per side. Default 2. */
  retries?: number;
  /** Progress sink (labels are prefixed "Home village — " / "Rival village — "). */
  onProgress?: GenerationProgress;
  /** The HOME (west) settlement's parameters. */
  home: RivalSideOptions;
  /** The RIVAL (east) settlement's parameters. */
  rival: RivalSideOptions;
}

/**
 * Generate a complete TWO-village world with the LLM: a home settlement themed by the
 * player's style and a RIVAL settlement themed as its contrasting neighbour across the
 * valley, laid out on one wide shared map. Each side is generated independently (its
 * own buildings, roster and bible). THROWS if either side's overview fails after its
 * retries — the caller falls back to the fixed-blueprint rival seed.
 */
export async function generateRivalWorldWithLLM(
  llm: GenerationLLM,
  homeIdFor: (i: number) => string,
  rivalIdFor: (i: number) => string,
  opts: GenerateRivalWorldOptions,
): Promise<GeneratedRivalWorld> {
  const retries = opts.retries ?? 2;
  const report = opts.onProgress ?? (() => {});
  const backdrop = (opts.mapTheme ?? '').trim();
  const homeSize = VILLAGE_SIZES[opts.home.size ?? 'medium'];
  const rivalSize = VILLAGE_SIZES[opts.rival.size ?? 'medium'];
  const homeCount = clampInt(opts.home.villagers ?? homeSize.villagers, 1, opts.maxVillagers);
  const rivalCount = clampInt(opts.rival.villagers ?? rivalSize.villagers, 1, opts.maxVillagers);

  const homeStyle = (opts.home.style ?? '').trim();
  const rivalStyle = (opts.rival.style ?? '').trim();
  const homeTheme = combineTheme(homeStyle, backdrop);
  // The rival uses its OWN style if the player gave one; otherwise it is themed as the
  // home's contrasting neighbour, so the two still read as one valley's two sides.
  const rivalTheme = rivalStyle
    ? combineTheme(rivalStyle, backdrop)
    : combineTheme(
        homeStyle
          ? `a rival settlement that contrasts with and competes against "${homeStyle}" across the same valley`
          : '',
        backdrop,
      );

  const home = await generateVillageContent(llm, homeIdFor, {
    theme: homeTheme,
    villagerCount: homeCount,
    size: homeSize,
    retries,
    report,
    labelPrefix: 'Home village — ',
  });
  const rival = await generateVillageContent(llm, rivalIdFor, {
    theme: rivalTheme,
    villagerCount: rivalCount,
    size: rivalSize,
    retries,
    report,
    labelPrefix: 'Rival village — ',
  });

  report({ phase: 'assembling', label: 'Raising the two villages' });
  // Stamp ownership onto each side's profiles so the minds heed only their own god.
  for (const p of home.profiles) p.villageId = DEFAULT_VILLAGE_ID;
  for (const p of rival.profiles) p.villageId = RIVAL_VILLAGE_ID;

  const seed = buildRivalSeedFromPlans(
    { plan: home.plan, villagerIds: home.profiles.map((p) => p.id) },
    { plan: rival.plan, villagerIds: rival.profiles.map((p) => p.id) },
  );
  stampAppearances(seed, [...home.profiles, ...rival.profiles]);

  return {
    seed,
    home: { profiles: home.profiles, bible: home.bible, theme: home.theme, setting: home.setting },
    rival: { profiles: rival.profiles, bible: rival.bible, theme: rival.theme, setting: rival.setting },
  };
}

// ---------------------------------------------------------------------------
// Style preview — a FAST, cheap call for the setup screen's live colour swatch.
// ---------------------------------------------------------------------------

/** A quick read on a style: its theme label + ground palette, for a live preview. */
export interface StylePreview {
  theme: string;
  palette: TerrainPalette;
}

/**
 * Ask the model for JUST the theme label + ground colours of a style, so the setup
 * screen can show a live swatch as the player types — far cheaper than a full
 * generation. Best-effort: on any failure it returns the style as the label and the
 * default palette, so the UI always has something to show.
 */
export async function previewStyle(llm: GenerationLLM, style: string): Promise<StylePreview> {
  const trimmed = style.trim();
  const fallback: StylePreview = { theme: trimmed || 'a small village', palette: DEFAULT_TERRAIN_PALETTE };
  try {
    const system = [
      'You pick the mood and GROUND COLOURS for a village in a life-simulation game.',
      'Given a style, return a short label and three CSS hex colours that capture it at a glance:',
      '  - "ground": the base land colour, "groundAccent": a second tone for texture, "vegetation": the plants.',
      'Desert → sandy ochres; tundra → pale frost; volcano → dark ash; alien → strange teals/violets; forest → deep greens.',
      'Reply with STRICT JSON only — no prose, no fences:',
      '{ "theme": "short label", "palette": { "ground": "#3f6b34", "groundAccent": "#355a2b", "vegetation": "#2ea043" } }',
      '',
      JSON_ONLY_STEER,
    ].join('\n');
    const raw = await llm.synthesize({
      system,
      user: trimmed ? `Style: "${trimmed}".` : 'Invent a pleasant village style.',
      purpose: 'plan',
      agent: 'world-gen:preview',
      maxTokens: 1200,
    });
    const o = parseJsonObject(raw, ['palette', 'theme']);
    if (!o) return fallback;
    return {
      theme: str(o.theme) || fallback.theme,
      palette: coercePalette(o.palette),
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 1. Overview call
// ---------------------------------------------------------------------------

interface OverviewResult {
  theme: string;
  setting: string;
  buildings: BuildingPlanItem[];
  palette: TerrainPalette;
}

/** The fixed catalog block, built from the shared source of truth so it never drifts. */
function catalogBlock(): string {
  return GENERATABLE_KINDS.map((k) => {
    const fp = DEFAULT_FOOTPRINT[k];
    return `- "${k}": ${BUILDING_FUNCTIONS[k]} (typical size ~${fp.w}x${fp.h} tiles)`;
  }).join('\n');
}

async function generateOverview(
  llm: GenerationLLM,
  theme: string,
  villagerCount: number,
): Promise<OverviewResult> {
  const themeLine = theme
    ? `The village's STYLE is: "${theme}". Commit to it fully — let it shape every building name, the setting, the ground colours and the mood.`
    : `INVENT an evocative style for this village yourself (e.g. a fishing hamlet on a cold coast, a vineyard in golden hills, an alien crystal hive, a mining camp in a high pass). Commit to it.`;

  const system = [
    'You are a world-builder laying out a SMALL, TIGHT-KNIT village for a life-simulation game.',
    'You name the places, choose WHICH buildings exist, give each a rough position, and pick the',
    'theme + ground colours. The game MECHANICS are fixed — respect them exactly.',
    '',
    'THE FIXED ECONOMY (do not invent new building kinds; you may only place these):',
    catalogBlock(),
    '',
    'Your village MUST include, for the two survival chains, at least one of each:',
    '  water_source -> greenfield -> hall_town   (draw water, work it into food, store it)',
    '  lumber_source -> workshop -> tavern        (gather wood, work it into goods, enjoy them)',
    `plus at least one quarry, one temple, and EXACTLY ${villagerCount} house${villagerCount === 1 ? '' : 's'} (one per villager).`,
    '',
    'LAYOUT — this is the most important part. Lay the village out on a small 60x60 grid of tiles,',
    'gathered TIGHTLY around a central square (put the water_source/well near the middle, ~(30,30)).',
    'It must read like a real, huddled settlement — neighbours within a short walk, buildings only a',
    'tile or two apart, NOT a scatter across open country. Place each building by its top-left tile',
    '(x,y) with width w and height h. Keep every coordinate within 0..60. Buildings may be close but',
    'must NOT overlap. Think in DIRECTIONS from the square: homes ringing it, the workshop and tavern',
    'just off it, the farm/grove/quarry at the near edges (still close). Exact distances will be',
    'tightened automatically — what matters is the RELATIVE arrangement and that it is compact.',
    '',
    'Worked example of a tight core (do not copy verbatim — fit it to your style):',
    '  well at (29,29) 3x3 · town hall (33,28) 8x6 · tavern (24,30) 7x5 · workshop (33,22) 7x6 ·',
    '  temple (22,20) 6x9 · houses at (26,34),(31,35),(37,33) 4x4 · farm (16,16) 13x9 · grove (44,40) 9x9 · quarry (16,40) 7x7',
    '',
    'Also choose the GROUND COLOURS that fit the style, as CSS hex colours (e.g. "#3f6b34"):',
    '  - "ground": the base colour the land is painted with (green grass, sandy ochre, ash grey, alien teal…),',
    '  - "groundAccent": a slightly different second tone, blotched over the base for texture,',
    '  - "vegetation": the colour of the trees/plants.',
    '',
    'Reply with STRICT JSON only — no prose, no markdown fences. Shape:',
    '{',
    '  "theme": "short evocative label",',
    '  "setting": "one or two sentences describing the place and its mood",',
    '  "palette": { "ground": "#3f6b34", "groundAccent": "#355a2b", "vegetation": "#2ea043" },',
    '  "buildings": [ { "kind": "water_source", "name": "The Old Spring", "x": 29, "y": 29, "w": 3, "h": 3 } ]',
    '}',
    '',
    JSON_ONLY_STEER,
  ].join('\n');

  const raw = await llm.synthesize({
    system,
    user: themeLine,
    purpose: 'plan',
    agent: 'world-gen',
    maxTokens: OVERVIEW_TOKENS,
  });
  const obj = parseJsonObject(raw, ['buildings', 'theme', 'palette']);
  if (!obj) throw new Error(`overview was not valid JSON; reply began: "${preview(raw)}"`);

  const buildings = Array.isArray(obj.buildings) ? obj.buildings : [];
  const parsed: OverviewResult = {
    theme: str(obj.theme) || theme || 'a small village',
    setting: str(obj.setting) || 'a small village going about its days',
    buildings: buildings.map(coerceBuilding).filter((b): b is BuildingPlanItem => b !== null),
    palette: coercePalette(obj.palette),
  };
  if (parsed.buildings.length === 0) throw new Error('overview produced no valid buildings');
  return parsed;
}

/** A 3/6-digit CSS hex colour, with leading #. */
function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
}

/**
 * Coerce the model's palette into a valid {@link TerrainPalette}, keeping only
 * well-formed hex colours and filling any gap from the default — so a partial or
 * garbled palette still yields a usable, themed-where-possible result.
 */
function coercePalette(raw: unknown): TerrainPalette {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ground: isHexColor(o.ground) ? o.ground.trim() : DEFAULT_TERRAIN_PALETTE.ground,
    groundAccent: isHexColor(o.groundAccent) ? o.groundAccent.trim() : DEFAULT_TERRAIN_PALETTE.groundAccent,
    vegetation: isHexColor(o.vegetation) ? o.vegetation.trim() : DEFAULT_TERRAIN_PALETTE.vegetation,
  };
}

/** Coerce one raw building entry into a valid plan item, or null if unusable. */
function coerceBuilding(raw: unknown): BuildingPlanItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = str(o.kind) as BuildingKind;
  if (!GENERATABLE_KINDS.includes(kind)) return null; // drop invented/unknown kinds
  const fp = DEFAULT_FOOTPRINT[kind];
  return {
    kind,
    name: str(o.name) || titleFor(kind),
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: num(o.w, fp.w),
    h: num(o.h, fp.h),
  };
}

// ---------------------------------------------------------------------------
// 2. Validation + augmentation -> a survivable WorldPlan
// ---------------------------------------------------------------------------

/**
 * Turn the raw overview into a validated plan, guaranteeing the economy floor and
 * EXACTLY `villagerCount` houses. The map size, packing gap and tree cover come from
 * the player's chosen {@link VillageSize}, not the model — so the village is always a
 * tight, legible cluster sized to taste.
 */
function buildPlan(
  o: OverviewResult,
  opts: { villagerCount: number; size: { map: number; margin: number; trees: number } },
): WorldPlan {
  const width = opts.size.map;
  const height = opts.size.map;
  // The model laid its buildings out on a ~60x60 design grid; the packer only reads
  // their relative bearings, so the centre we fan placeholders around is that grid's.
  const cx = 30;
  const cy = 30;
  const buildings = [...o.buildings];

  // Guarantee every required kind exists; append a default-sized one near the
  // centre for any the model skipped (the packer settles the final placement).
  const present = new Set(buildings.map((b) => b.kind));
  let ring = 0;
  for (const kind of REQUIRED_KINDS) {
    if (present.has(kind)) continue;
    buildings.push(placeholderBuilding(kind, cx, cy, ring++));
    present.add(kind);
  }

  // Pin the house count to the villager count exactly: top up if short, drop extras
  // the model over-produced (keeping the economy + non-house buildings intact).
  const houses = buildings.filter((b) => b.kind === 'house');
  for (let i = houses.length; i < opts.villagerCount; i++) {
    buildings.push(placeholderBuilding('house', cx, cy, ring++));
  }
  let pruned = buildings;
  if (houses.length > opts.villagerCount) {
    let toDrop = houses.length - opts.villagerCount;
    pruned = buildings.filter((b) => {
      if (b.kind === 'house' && toDrop > 0) {
        toDrop--;
        return false;
      }
      return true;
    });
  }

  return {
    width,
    height,
    treeCount: opts.size.trees,
    margin: opts.size.margin,
    buildings: pruned,
    theme: o.theme,
    setting: o.setting,
    palette: o.palette,
  };
}

/** A default-sized building of `kind`, offset around the centre by a ring index. */
function placeholderBuilding(kind: BuildingKind, cx: number, cy: number, ring: number): BuildingPlanItem {
  const fp = DEFAULT_FOOTPRINT[kind];
  const angle = ring * 1.2; // fan them out so repairs start from different spots
  const r = 12 + ring * 6;
  return {
    kind,
    name: titleFor(kind),
    x: Math.round(cx + Math.cos(angle) * r),
    y: Math.round(cy + Math.sin(angle) * r),
    w: fp.w,
    h: fp.h,
  };
}

// ---------------------------------------------------------------------------
// 3. Per-villager call
// ---------------------------------------------------------------------------

async function generateVillager(
  llm: GenerationLLM,
  id: string,
  theme: string,
  setting: string,
  buildingSummary: string,
  peers: CharacterProfile[],
): Promise<CharacterProfile> {
  const peerLines = peers.length
    ? peers.map((p) => `- ${p.name}: ${p.traits.join(', ')} — ${p.goal}`).join('\n')
    : '(none yet — you are the first)';

  const system = [
    `You are creating ONE inhabitant of a village themed: "${theme}".`,
    `The village: ${setting}`,
    `Its places: ${buildingSummary}.`,
    '',
    'Give this villager a real character that FITS the theme and a role that keeps the village',
    'running: tending a building (farm, forge, hall, tavern, temple), gathering at a source',
    '(spring, grove, quarry), hauling between them, building new structures, or leading prayer.',
    'Make them DISTINCT from the villagers already created below — different name, temperament and job.',
    '',
    'Also give them a distinct LOOK as an "appearance" object, picking ONLY from these lists so they',
    'render as a little figure on the map. Make it FIT the character (a farmer in a straw hat, a',
    'preacher with a staff, a smith with a hammer) and DIFFERENT from the villagers below:',
    `  - body: one of ${listFor(BODY_SHAPES)} (the silhouette)`,
    `  - hair: one of ${listFor(HAIR_STYLES)}`,
    `  - hat: one of ${listFor(HAT_STYLES)}`,
    `  - accent: one of ${listFor(ACCENT_STYLES)} (a tool they carry)`,
    '  - bodyColor, skin, hairColor: CSS hex colours like "#c14b2a" (bodyColor is the outfit; pick a vivid, distinct one)',
    '',
    'Existing villagers:',
    peerLines,
    '',
    'Keep the NAME short — a first name, optionally a single short surname or epithet.',
    'Two words maximum (e.g. "Bram", "Bram Baker"). Never "Given Name the Role".',
    '',
    'Reply with STRICT JSON only — no prose, no fences. Shape:',
    '{ "name": "Bram Baker", "traits": ["trait", "trait", "trait"],',
    '  "goal": "what they strive to do in the village, one or two sentences",',
    '  "status": "a short line on what they are doing right now",',
    '  "backstory": "two or three sentences of history",',
    '  "appearance": { "body": "round", "bodyColor": "#c14b2a", "skin": "#e0a878",',
    '    "hair": "short", "hairColor": "#2b2b2b", "hat": "straw", "accent": "hoe" } }',
    '',
    JSON_ONLY_STEER,
  ].join('\n');

  const raw = await llm.synthesize({
    system,
    user: 'Create the villager now.',
    purpose: 'plan',
    agent: `world-gen:${id}`,
    maxTokens: VILLAGER_TOKENS,
  });
  const o = parseJsonObject(raw, ['name', 'goal', 'traits']);
  if (!o) throw new Error(`villager was not valid JSON; reply began: "${preview(raw)}"`);

  const name = shortName(str(o.name));
  const goal = str(o.goal);
  if (!name || !goal) throw new Error('villager missing name or goal');
  const traits = Array.isArray(o.traits)
    ? o.traits.map((t) => str(t)).filter(Boolean).slice(0, 6)
    : [];

  const profile: CharacterProfile = {
    id,
    name,
    traits: traits.length ? traits : ['curious', 'hardworking'],
    goal,
    status: str(o.status) || 'going about the day',
    // The model's look, validated and repaired against the part vocabulary; any
    // missing/garbled field falls back to a deterministic look for this id.
    appearance: coerceAppearance(o.appearance, id),
  };
  const backstory = str(o.backstory);
  if (backstory) profile.backstory = backstory;
  return profile;
}

// ---------------------------------------------------------------------------
// 4. World-bible call
// ---------------------------------------------------------------------------

/**
 * The MECHANICAL half of the bible — theme-neutral and identical for every
 * generated village, so the rules the minds rely on are always accurate no matter
 * what flavour the model invents. Only the intro + place glossary are themed.
 */
const MECHANICS_APPENDIX = `## How life works here

Life is local: you see and hear only what is within a few tiles of you. To reach a
neighbour, walk to them first. But you know your own town by heart — you always know
where each building stands, even when you cannot see it.

Each turn opens with the in-world date and time, e.g. "Day 3 · 14:25, afternoon".
Think in the *time of day*: work through the morning and afternoon, wind down in the
evening, sleep at night.

You have four needs, each on a 0–100 scale: **hunger**, **thirst**, **fatigue**,
**boredom**. They climb slowly through the day. You eat and drink as you go — from
your backpack first, otherwise from a stocked place you stand beside — so keep food
and water in your backpack and the store stocked. Fatigue is your power; the only
cure is to **sleep** by standing idle at a house. Let it run out and you collapse
where you stand. Boredom lifts where folk gather to enjoy goods, and in company.

The village runs on two short chains. Each draws a raw resource from an
inexhaustible **source**, hauls it to a **converter** to be worked into something
useful, then carries that to where the village keeps or enjoys it:

- **Water → food:** draw water at the spring → work it into food at the farm → store
  it at the town hall, where everyone eats and drinks.
- **Wood → goods:** gather wood at the grove → work it into goods at the workshop →
  stock the tavern, where folk shake off boredom.

A **quarry** yields stone for raising new structures together; a **temple** is where
you pray to the watching god. Your tools (take_from, give_to, work_at, and the rest)
do each step; the live prompt names each place, its stock, and where it stands.

Speak only to neighbours close enough to hear. Be a good neighbour: share what you
have, take on the work the village needs, and build it, day by day, toward a town.`;

/** Assemble the full bible from a themed intro, a place glossary, and fixed mechanics. */
function composeBible(intro: string, glossary: string, buildings: BuildingPlanItem[]): string {
  const places =
    glossary.trim() ||
    buildings.map((b) => `- **${b.name}** — ${BUILDING_FUNCTIONS[b.kind]}`).join('\n');
  return [
    '# The Village — A Shared World Bible',
    '',
    'This is what every villager knows: the world you share and how life works here.',
    'Your own name, character and goal are given to you separately.',
    '',
    '## The world',
    '',
    intro.trim(),
    '',
    '## The places of the village',
    '',
    places,
    '',
    MECHANICS_APPENDIX,
  ].join('\n');
}

async function generateBible(
  llm: GenerationLLM,
  theme: string,
  setting: string,
  buildings: BuildingPlanItem[],
): Promise<string> {
  const placeList = buildings.map((b) => `${b.name} (${b.kind})`).join(', ');
  const system = [
    `You are writing the opening flavour of a "world bible" for a village themed: "${theme}".`,
    `The village: ${setting}`,
    `Its places are: ${placeList}.`,
    '',
    'Write ONLY evocative SETTING flavour — the land, the weather, the mood of the place, how its',
    'people see their home. Do NOT explain game rules, needs, or mechanics; those are added',
    'separately. Keep it to a short paragraph or two, in second person ("You live in...").',
    '',
    'Reply with STRICT JSON only — no fences. Shape:',
    '{ "intro": "a paragraph or two of setting flavour in second person",',
    '  "places": "a markdown bullet list, one line per place: \\"- **Name** — what it is and its mood\\"" }',
    '',
    JSON_ONLY_STEER,
  ].join('\n');

  const raw = await llm.synthesize({
    system,
    user: 'Write it now.',
    purpose: 'plan',
    agent: 'world-gen:bible',
    maxTokens: BIBLE_TOKENS,
  });
  const o = parseJsonObject(raw, ['intro', 'places']);
  if (!o) throw new Error(`bible was not valid JSON; reply began: "${preview(raw)}"`);
  const intro = str(o.intro);
  if (!intro) throw new Error('bible missing intro');
  return composeBible(intro, str(o.places), buildings);
}

// ---------------------------------------------------------------------------
// Helpers: retry, JSON extraction, coercion
// ---------------------------------------------------------------------------

/** Run `fn`, retrying up to `attempts` extra times on throw, before re-throwing. */
async function withRetry<T>(attempts: number, label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[generate] ${label} attempt ${i + 1}/${attempts + 1} failed: ${errMsg(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Pull a JSON object out of a model reply, robustly. A local THINKING model often
 * wraps the answer in chain-of-thought prose that itself contains braces (it echoes
 * the requested shape while planning), so taking the FIRST `{` is wrong. Instead we
 * strip any `<think>` block and code fences, then scan EVERY balanced `{…}` span and
 * keep the best one that parses — preferring the largest that carries an expected
 * key (the real answer), since the reasoning's brace-snippets are small and keyless.
 * Returns null when nothing usable parses.
 */
function parseJsonObject(text: string, wantKeys: string[] = []): Record<string, unknown> | null {
  const cleaned = stripFences(stripThinking(text));

  // Fast path: the whole (cleaned) thing is one JSON object.
  const direct = tryParse(cleaned);
  if (isObject(direct)) return direct;

  // Otherwise gather every balanced object span and pick the best candidate.
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const span of balancedSpans(cleaned, '{', '}')) {
    const parsed = tryParse(span);
    if (!isObject(parsed)) continue;
    const hasWanted = wantKeys.length === 0 || wantKeys.some((k) => k in parsed);
    // Score: a wanted-key object always beats a keyless snippet; among equals, larger wins.
    const score = (hasWanted ? 1_000_000 : 0) + span.length;
    if (score > bestScore) {
      bestScore = score;
      best = parsed;
    }
  }

  // A complete object carrying an expected key is the real answer — return it.
  if (best && (wantKeys.length === 0 || wantKeys.some((k) => k in best!))) return best;

  // Otherwise the reply may be a TRUNCATED object: a thinking model that exhausted its
  // token budget mid-JSON, leaving an opening `{` that never closes (so no balanced
  // span exists at all). Try to repair it before giving up — this is the single most
  // common generation failure.
  const repaired = repairTruncatedJson(cleaned, wantKeys);
  if (repaired) return repaired;

  return best;
}

/**
 * Best-effort recovery of a TRUNCATED JSON object. Scans for each `{` that opens an
 * object mentioning an expected key, then shrinks that slice back to its last complete
 * value and appends the missing closing brackets so it parses. This salvages the
 * frequent case of a thinking model that wrote good JSON but ran out of budget before
 * closing it. Returns null when nothing can be salvaged.
 */
function repairTruncatedJson(text: string, wantKeys: string[]): Record<string, unknown> | null {
  for (let p = 0; p < text.length; p++) {
    if (text[p] !== '{') continue;
    const slice = text.slice(p);
    // Cheap filter: only bother with an object that actually mentions a wanted key.
    if (wantKeys.length && !wantKeys.some((k) => slice.includes(`"${k}"`))) continue;
    const obj = closeTruncatedObject(slice, wantKeys);
    if (obj) return obj;
  }
  return null;
}

/**
 * Walk `slice` back from its end to the last value-terminating character, closing any
 * still-open brackets, and return the first cut that parses into an object with a
 * wanted key. Cutting at a value boundary drops any dangling partial key/value the
 * truncation left behind (e.g. a trailing `"x":` or `, "name`).
 */
function closeTruncatedObject(slice: string, wantKeys: string[]): Record<string, unknown> | null {
  for (let end = slice.length; end > 1; end--) {
    // Only attempt a cut at the natural end or right after a complete value.
    if (end !== slice.length && !isValueEnd(slice[end - 1]!)) continue;
    const closers = neededClosers(slice.slice(0, end));
    if (closers === null) continue; // cut lands inside a string / unbalanced — shrink more
    const parsed = tryParse(slice.slice(0, end) + closers);
    if (isObject(parsed) && (wantKeys.length === 0 || wantKeys.some((k) => k in parsed))) {
      return parsed;
    }
  }
  return null;
}

/** A character that can legally end a JSON value (string, number, bool, null, object, array). */
function isValueEnd(c: string): boolean {
  return /[\]}"0-9el]/i.test(c);
}

/**
 * The closing brackets needed to balance `s`, in order, or null if `s` ends inside a
 * string or has an unbalanced closer (in which case the caller should shrink further).
 */
function neededClosers(s: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (!stack.length) return null;
      stack.pop();
    }
  }
  if (inStr) return null;
  let out = '';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

/** Type guard: a plain (non-array) object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Remove a reasoning model's `<think>…</think>` wrapper (closed or dangling). */
function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/<\/think>/i.test(out)) out = out.split(/<\/think>/i).pop()!.trim();
  else out = out.replace(/<think>[\s\S]*$/i, '').trim();
  return out;
}

/** Strip ```json … ``` fences anywhere in the text, leaving their contents. */
function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '').trim();
}

/**
 * Every top-level balanced `{…}` span in `s` (respecting strings/escapes), in order.
 * Nested objects are contained within their parent's span, so the parent (the real
 * answer) is returned and the children ride along inside it.
 */
function balancedSpans(s: string, open: string, close: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === close && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Tolerate a trailing comma before a closing } or ] — a very common model slip.
    try {
      return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** A short, single-line preview of a raw model reply, for failure logs. */
function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Clamp a generated name to AT MOST two words, so the roster stays compact even
 * when the model ignores the prompt and returns "Given Name the Role". Drops a
 * connective ("the"/"of"/"de") between the two kept words so "Bram the Baker"
 * becomes "Bram Baker" rather than "Bram the".
 */
function shortName(name: string): string {
  const words = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= 2) return words.join(' ');
  const connectives = new Set(['the', 'of', 'de', 'von', 'van', 'la', 'le']);
  const kept = words.filter((w) => !connectives.has(w.toLowerCase()));
  return (kept.length ? kept : words).slice(0, 2).join(' ');
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** A friendly default name for a building kind, used when the model omits one. */
function titleFor(kind: BuildingKind): string {
  const titles: Partial<Record<BuildingKind, string>> = {
    water_source: 'The Village Spring',
    greenfield: 'The Farmstead',
    lumber_source: 'The Grove',
    workshop: 'The Workshop',
    hall_town: 'The Town Hall',
    tavern: 'The Tavern',
    temple: 'The Temple',
    quarry: 'The Quarry',
    house: 'A Cottage',
  };
  return titles[kind] ?? 'A Building';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
