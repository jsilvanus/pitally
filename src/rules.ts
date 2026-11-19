import {
  type CameraCueDirection,
  type RGB,
  TALLY_COLORS,
} from './types.js';

export type TallyColorName = keyof typeof TALLY_COLORS;

/**
 * Continuous state conditions evaluated against the latest Gateway telemetry snapshot.
 */
export type TallyCondition =
  | { type: 'youtube-live'; state?: 'live' | 'offline' | 'unknown' | undefined }
  | { type: 'encoder-active'; encoder?: 1 | 2 | 'any' | undefined; state?: string | undefined }
  | { type: 'atem-program'; input: number }
  | { type: 'atem-preview'; input: number }
  | { type: 'atem-input'; input: number; mode?: 'pgm' | 'prv' | 'any' | undefined }
  | { type: 'atem-ftb' }
  | { type: 'atem-dsk'; dsk: number }
  | { type: 'atem-connected' }
  | { type: 'matrix-route'; output?: number | undefined; input?: number | undefined }
  | { type: 'matrix-locked' }
  | { type: 'camera-active'; cameraId: string; streaming?: boolean | undefined; privacyBlur?: boolean | undefined }
  | { type: 'voice-speaking'; classification?: string | undefined }
  | { type: 'sound-active'; channel?: number | undefined }
  | { type: 'spatial-zone'; zoneId: string }
  | { type: 'rundown-cue'; cueId?: string | undefined; titleIncludes?: string | undefined; speakerIncludes?: string | undefined }
  | { type: 'ecosystem-online'; component: string }
  | { type: 'all'; conditions: TallyCondition[] }
  | { type: 'any'; conditions: TallyCondition[] }
  | { type: 'not'; condition: TallyCondition };

/**
 * Transient trigger evaluated when a matching PiGateway SSE event arrives.
 */
export interface TallyEventTrigger {
  /** Gateway event type (e.g. "action", "camera", "spatial-zone", "youtube", "atem", "encoder", or "*"). */
  eventType: string;
  /** Optional partial key/value match against event.data. */
  match?: Record<string, unknown> | undefined;
}

/**
 * Action to execute on a tally light when a rule matches.
 */
export type TallyRuleAction =
  | { mode: 'pgm' }
  | { mode: 'prv' }
  | { mode: 'off' }
  | { mode: 'color'; rgb?: RGB | undefined; color?: TallyColorName | string | undefined }
  | {
      mode: 'flash';
      rgb?: RGB | undefined;
      color?: TallyColorName | string | undefined;
      durationMs?: number | undefined;
      intervalMs?: number | undefined;
    }
  | { mode: 'call' }
  | { mode: 'cue'; direction: CameraCueDirection; durationMs?: number | undefined }
  | { mode: 'rainbow'; durationSec?: number | undefined; fps?: number | undefined };

/**
 * A per-light conditional or event-triggered rule.
 */
export interface TallyRule {
  id: string;
  name?: string | undefined;
  enabled?: boolean | undefined;
  /** Higher priority rules win when multiple state rules match; ties break by array order. */
  priority?: number | undefined;
  /** Continuous state condition (e.g. while YouTube is live, while cam1 is on program). */
  when?: TallyCondition | undefined;
  /** Transient event trigger (e.g. when event Z arrives, flash white). */
  onEvent?: TallyEventTrigger | undefined;
  /** Action to apply when the rule matches or fires. */
  action: TallyRuleAction;
}

/**
 * Telemetry snapshot maintained by FacetCoordinator from PiGateway events.
 */
export interface SystemStatusSnapshot {
  atem?: {
    connected?: boolean | undefined;
    programInput: number | null;
    previewInput: number | null;
    fadeToBlack?: { fullyBlack: boolean; inTransition: boolean } | undefined;
    downstreamKeyers?: Array<{ dsk: number; onAir: boolean; tie?: boolean | undefined }> | undefined;
  } | undefined;
  youtube?: {
    live: boolean;
    state?: 'live' | 'offline' | 'unknown' | undefined;
    status?: string | undefined;
    detail?: string | undefined;
  } | undefined;
  matrox?: {
    connected?: boolean | undefined;
    encoder1Live: boolean;
    encoder2Live: boolean;
    encoder1State?: string | undefined;
    encoder2State?: string | undefined;
  } | undefined;
  atemStreamRecord?: {
    streaming: boolean;
    recording: boolean;
  } | undefined;
  projectors?: {
    projector1On: boolean;
    projector2On: boolean;
    warmingOrCooling?: boolean | undefined;
  } | undefined;
  atlona?: {
    locked?: boolean | undefined;
    output1Input?: number | undefined;
    output2Input?: number | undefined;
    output5Input?: number | undefined;
    routes?: Record<number, number | null> | undefined;
  } | undefined;
  cameras?: Record<string, {
    action?: string | undefined;
    streaming?: boolean | undefined;
    privacyBlur?: boolean | undefined;
    presetId?: number | undefined;
  }> | undefined;
  pivoice?: {
    isSpeaking: boolean;
    classification?: string | undefined;
    vadProbability?: number | null | undefined;
  } | undefined;
  pisound?: {
    activeChannels: number[];
    activeChannelsCount: number;
  } | undefined;
  spatial?: {
    activeZones: string[];
  } | undefined;
  rundown?: {
    loaded: boolean;
    title?: string | undefined;
    currentCueId?: string | undefined;
    currentCueTitle?: string | undefined;
    assignedSpeaker?: string | undefined;
  } | undefined;
  ecosystem?: Record<string, {
    available: boolean;
    active: boolean;
  }> | undefined;
  stt?: {
    busy?: boolean | undefined;
    voiceDetected?: boolean | undefined;
  } | undefined;
  captions?: {
    flowing?: boolean | undefined;
  } | undefined;
  piOutputs?: {
    output1Active?: boolean | undefined;
    output2Active?: boolean | undefined;
  } | undefined;
}

const ACTIVE_ENCODER_STATES = new Set([
  'live',
  'on',
  'running',
  'recording',
  'streaming',
  'active',
  'started',
  'starting',
]);

function isEncoderStateActive(state?: string): boolean {
  if (!state) return false;
  return ACTIVE_ENCODER_STATES.has(state.trim().toLowerCase());
}

/**
 * Resolves a color from an explicit RGB tuple, a named TALLY_COLORS key, or a #RRGGBB hex string.
 */
export function resolveActionColor(rgb?: RGB, color?: string, fallback: RGB = [...TALLY_COLORS.white]): RGB {
  if (rgb && Array.isArray(rgb) && rgb.length === 3) {
    return [rgb[0], rgb[1], rgb[2]];
  }
  if (color) {
    if (color in TALLY_COLORS) {
      const c = TALLY_COLORS[color as TallyColorName];
      return [c[0], c[1], c[2]];
    }
    const hex = color.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  return [...fallback];
}

/**
 * Evaluates a continuous state condition against the current Gateway telemetry snapshot.
 */
export function evaluateCondition(condition: TallyCondition, snapshot: SystemStatusSnapshot): boolean {
  switch (condition.type) {
    case 'youtube-live': {
      const targetState = condition.state ?? 'live';
      const currentState = snapshot.youtube?.state ?? (snapshot.youtube?.live ? 'live' : 'offline');
      if (targetState === 'live') {
        return Boolean(snapshot.youtube?.live || currentState === 'live');
      }
      return currentState === targetState;
    }

    case 'encoder-active': {
      const enc = condition.encoder ?? 'any';
      const checkOne = (live?: boolean, state?: string): boolean => {
        if (condition.state) {
          return state?.trim().toLowerCase() === condition.state.trim().toLowerCase();
        }
        return Boolean(live || isEncoderStateActive(state));
      };
      if (enc === 1) return checkOne(snapshot.matrox?.encoder1Live, snapshot.matrox?.encoder1State);
      if (enc === 2) return checkOne(snapshot.matrox?.encoder2Live, snapshot.matrox?.encoder2State);
      return (
        checkOne(snapshot.matrox?.encoder1Live, snapshot.matrox?.encoder1State) ||
        checkOne(snapshot.matrox?.encoder2Live, snapshot.matrox?.encoder2State)
      );
    }

    case 'atem-program':
      return snapshot.atem?.programInput === condition.input;

    case 'atem-preview':
      return snapshot.atem?.previewInput === condition.input;

    case 'atem-input': {
      const mode = condition.mode ?? 'any';
      const isPgm = snapshot.atem?.programInput === condition.input;
      const isPrv = snapshot.atem?.previewInput === condition.input;
      if (mode === 'pgm') return isPgm;
      if (mode === 'prv') return isPrv;
      return isPgm || isPrv;
    }

    case 'atem-ftb':
      return Boolean(snapshot.atem?.fadeToBlack?.fullyBlack || snapshot.atem?.fadeToBlack?.inTransition);

    case 'atem-dsk':
      return Boolean(snapshot.atem?.downstreamKeyers?.some((d) => d.dsk === condition.dsk && d.onAir));

    case 'atem-connected':
      return Boolean(snapshot.atem?.connected);

    case 'matrix-route': {
      const routes = snapshot.atlona?.routes;
      if (!routes) return false;
      if (condition.output !== undefined && condition.input !== undefined) {
        return routes[condition.output] === condition.input;
      }
      if (condition.output !== undefined) {
        const val = routes[condition.output];
        return val !== null && val !== undefined;
      }
      if (condition.input !== undefined) {
        return Object.values(routes).some((v) => v === condition.input);
      }
      return false;
    }

    case 'matrix-locked':
      return Boolean(snapshot.atlona?.locked);

    case 'camera-active': {
      const cam = snapshot.cameras?.[condition.cameraId];
      // Also support matching "cam1" against ATEM programInput 1 if camera telemetry wasn't explicitly sent
      const m = condition.cameraId.match(/^(?:cam|camera)?0*(\d+)$/i);
      const atemActive = m && m[1] ? snapshot.atem?.programInput === parseInt(m[1], 10) : false;

      if (condition.privacyBlur !== undefined) {
        return cam?.privacyBlur === condition.privacyBlur;
      }
      if (condition.streaming !== undefined) {
        return cam?.streaming === condition.streaming;
      }
      return Boolean(cam?.streaming || atemActive);
    }

    case 'voice-speaking': {
      if (!snapshot.pivoice?.isSpeaking) return false;
      if (condition.classification) {
        return snapshot.pivoice.classification?.toLowerCase() === condition.classification.toLowerCase();
      }
      return true;
    }

    case 'sound-active': {
      if (!snapshot.pisound) return false;
      if (condition.channel !== undefined) {
        return snapshot.pisound.activeChannels.includes(condition.channel);
      }
      return snapshot.pisound.activeChannelsCount > 0;
    }

    case 'spatial-zone':
      return Boolean(snapshot.spatial?.activeZones?.includes(condition.zoneId));

    case 'rundown-cue': {
      if (!snapshot.rundown?.loaded) return false;
      if (condition.cueId && snapshot.rundown.currentCueId !== condition.cueId) return false;
      if (
        condition.titleIncludes &&
        !snapshot.rundown.currentCueTitle?.toLowerCase().includes(condition.titleIncludes.toLowerCase())
      ) {
        return false;
      }
      if (
        condition.speakerIncludes &&
        !snapshot.rundown.assignedSpeaker?.toLowerCase().includes(condition.speakerIncludes.toLowerCase())
      ) {
        return false;
      }
      return true;
    }

    case 'ecosystem-online': {
      const comp = snapshot.ecosystem?.[condition.component];
      return Boolean(comp?.available);
    }

    case 'all':
      return condition.conditions.every((c) => evaluateCondition(c, snapshot));

    case 'any':
      return condition.conditions.some((c) => evaluateCondition(c, snapshot));

    case 'not':
      return !evaluateCondition(condition.condition, snapshot);

    default:
      return false;
  }
}

function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    return false;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((v, i) => partialMatch(v, actual[i]));
  }
  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;
  return Object.entries(expObj).every(([key, val]) => partialMatch(val, actObj[key]));
}

/**
 * Checks if an incoming PiGateway SSE event matches an event trigger.
 */
export function matchesEventTrigger(
  trigger: TallyEventTrigger,
  event: { type: string; data?: unknown }
): boolean {
  if (trigger.eventType !== '*' && trigger.eventType !== event.type) {
    return false;
  }
  if (!trigger.match || Object.keys(trigger.match).length === 0) {
    return true;
  }
  return partialMatch(trigger.match, event.data);
}

/**
 * Returns the highest-priority enabled state rule whose `when` condition matches the snapshot.
 */
export function selectMatchingStateRule(
  rules: TallyRule[],
  snapshot: SystemStatusSnapshot
): TallyRule | undefined {
  const candidates = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled !== false && rule.when !== undefined);

  candidates.sort((a, b) => {
    const prioDiff = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
    return prioDiff !== 0 ? prioDiff : a.index - b.index;
  });

  for (const { rule } of candidates) {
    if (rule.when && evaluateCondition(rule.when, snapshot)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Machine-readable catalog of supported conditionals, gateway events, and tally actions.
 */
export const CONDITIONALS_CATALOG = {
  conditions: [
    {
      type: 'youtube-live',
      description: 'True while YouTube stream is in the target state (default: "live")',
      params: { state: ['live', 'offline', 'unknown'] },
      gatewayEvent: 'youtube',
    },
    {
      type: 'encoder-active',
      description: 'True while Matrox Monarch encoder 1, 2, or either is live/recording/streaming',
      params: { encoder: [1, 2, 'any'], state: 'optional exact state string' },
      gatewayEvent: 'encoder',
    },
    {
      type: 'atem-program',
      description: 'True while the given ATEM input is on Program (live)',
      params: { input: 'number' },
      gatewayEvent: 'atem',
    },
    {
      type: 'atem-preview',
      description: 'True while the given ATEM input is on Preview (cued)',
      params: { input: 'number' },
      gatewayEvent: 'atem',
    },
    {
      type: 'atem-input',
      description: 'True while the given ATEM input is on Program, Preview, or either',
      params: { input: 'number', mode: ['pgm', 'prv', 'any'] },
      gatewayEvent: 'atem',
    },
    {
      type: 'atem-ftb',
      description: 'True while ATEM Fade to Black is active or transitioning',
      params: {},
      gatewayEvent: 'atem',
    },
    {
      type: 'atem-dsk',
      description: 'True while ATEM Downstream Keyer is on air',
      params: { dsk: 'number' },
      gatewayEvent: 'atem',
    },
    {
      type: 'atem-connected',
      description: 'True while ATEM switcher is connected',
      params: {},
      gatewayEvent: 'atem',
    },
    {
      type: 'matrix-route',
      description: 'True while Atlona matrix has a matching input/output route',
      params: { output: 'optional number', input: 'optional number' },
      gatewayEvent: 'matrix',
    },
    {
      type: 'matrix-locked',
      description: 'True while Atlona matrix front-panel lock is enabled',
      params: {},
      gatewayEvent: 'matrix',
    },
    {
      type: 'camera-active',
      description: 'True while a camera is active/streaming (or privacyBlur matches)',
      params: { cameraId: 'string', streaming: 'optional boolean', privacyBlur: 'optional boolean' },
      gatewayEvent: 'camera / atem',
    },
    {
      type: 'voice-speaking',
      description: 'True while PiVoice detects active speech',
      params: { classification: 'optional string (e.g. speech, singing)' },
      gatewayEvent: 'pivoice / pivoice-activity',
    },
    {
      type: 'sound-active',
      description: 'True while PiSound detects active audio signal on any or a specific channel',
      params: { channel: 'optional number' },
      gatewayEvent: 'pisound',
    },
    {
      type: 'spatial-zone',
      description: 'True while a tracked person is inside the given spatial zone',
      params: { zoneId: 'string' },
      gatewayEvent: 'spatial / spatial-zone',
    },
    {
      type: 'rundown-cue',
      description: 'True while rundown is loaded and optionally matches cueId, title, or speaker',
      params: { cueId: 'optional string', titleIncludes: 'optional string', speakerIncludes: 'optional string' },
      gatewayEvent: 'rundown',
    },
    {
      type: 'ecosystem-online',
      description: 'True while a Pi ecosystem component is available/online',
      params: { component: 'string (e.g. pitube, pivoice, atem)' },
      gatewayEvent: 'ecosystem',
    },
    {
      type: 'all',
      description: 'Logical AND over an array of sub-conditions',
      params: { conditions: 'TallyCondition[]' },
    },
    {
      type: 'any',
      description: 'Logical OR over an array of sub-conditions',
      params: { conditions: 'TallyCondition[]' },
    },
    {
      type: 'not',
      description: 'Logical NOT of a sub-condition',
      params: { condition: 'TallyCondition' },
    },
  ],
  eventTriggers: [
    'atem',
    'youtube',
    'encoder',
    'matrix',
    'camera',
    'pivoice',
    'pivoice-activity',
    'pisound',
    'spatial',
    'spatial-zone',
    'rundown',
    'action',
    'transcript',
    'ecosystem',
    'world-state',
    '*',
  ],
  actions: [
    { mode: 'pgm', description: 'Solid Program (Red)' },
    { mode: 'prv', description: 'Solid Preview (Green)' },
    { mode: 'off', description: 'Off (Black)' },
    { mode: 'color', description: 'Solid custom RGB, named color, or #RRGGBB hex' },
    { mode: 'flash', description: 'Flash a color (default white) for durationMs, then restore state' },
    { mode: 'call', description: 'Trigger HTTP /CALL white flash alert' },
    { mode: 'cue', description: 'Play directional or operator-call UDP animation, then restore state' },
    { mode: 'rainbow', description: 'Play moving rainbow UDP animation' },
  ],
  colors: Object.keys(TALLY_COLORS),
} as const;
