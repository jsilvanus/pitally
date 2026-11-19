import { EventEmitter } from 'node:events';
import { TallyManager } from './manager.js';
import {
  type RGB,
  type SegmentFacet,
  TALLY_COLORS,
} from './types.js';
import {
  type SystemStatusSnapshot,
  type TallyRuleAction,
  matchesEventTrigger,
  resolveActionColor,
  selectMatchingStateRule,
} from './rules.js';

export type { SystemStatusSnapshot };

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

function doesDeviceMatchAction(
  state: ReturnType<import('./devices/tally-device.js').TallyDevice['getState']>,
  action: TallyRuleAction,
  ruleId: string
): boolean {
  if (state.activeRuleId !== ruleId) return false;
  switch (action.mode) {
    case 'pgm':
      return state.mode === 'pgm';
    case 'prv':
      return state.mode === 'prv';
    case 'off':
      return state.mode === 'off';
    case 'color': {
      const targetRgb = resolveActionColor(action.rgb, action.color, [...TALLY_COLORS.white]);
      return (
        state.mode === 'color' &&
        state.rgb[0] === targetRgb[0] &&
        state.rgb[1] === targetRgb[1] &&
        state.rgb[2] === targetRgb[2]
      );
    }
    default:
      return false;
  }
}

/**
 * Maps a facet and the current system telemetry snapshot to a color.
 */
export function evaluateFacetColor(facet: SegmentFacet, snapshot: SystemStatusSnapshot): RGB {
  switch (facet.type) {
    case 'atem-input': {
      if (snapshot.atem?.programInput === facet.input) return [...TALLY_COLORS.pgm];
      if (snapshot.atem?.previewInput === facet.input) return [...TALLY_COLORS.prv];
      return [...TALLY_COLORS.off];
    }
    case 'youtube-stream': {
      if (snapshot.youtube?.live || snapshot.youtube?.state === 'live') return [...TALLY_COLORS.pgm];
      if (snapshot.youtube?.status === 'buffering' || snapshot.youtube?.status === 'starting') {
        return [...TALLY_COLORS.amber];
      }
      return [...TALLY_COLORS.off];
    }
    case 'matrox-encoder': {
      const isLive = facet.encoder === 1 ? snapshot.matrox?.encoder1Live : snapshot.matrox?.encoder2Live;
      return isLive ? [...TALLY_COLORS.pgm] : [...TALLY_COLORS.off];
    }
    case 'atem-recording': {
      return snapshot.atemStreamRecord?.recording ? [...TALLY_COLORS.pgm] : [...TALLY_COLORS.off];
    }
    case 'atem-streaming': {
      return snapshot.atemStreamRecord?.streaming ? [...TALLY_COLORS.pgm] : [...TALLY_COLORS.off];
    }
    case 'projector': {
      const isOn = facet.projector === 1 ? snapshot.projectors?.projector1On : snapshot.projectors?.projector2On;
      if (isOn) return [...TALLY_COLORS.cyan];
      if (snapshot.projectors?.warmingOrCooling) return [...TALLY_COLORS.amber];
      return [...TALLY_COLORS.off];
    }
    case 'atlona-output': {
      const route = facet.output === 1
        ? snapshot.atlona?.output1Input
        : facet.output === 2
          ? snapshot.atlona?.output2Input
          : facet.output === 5
            ? (snapshot.atlona?.output5Input ?? snapshot.atlona?.routes?.[5])
            : snapshot.atlona?.routes?.[facet.output];
      if (route === 1) return [...TALLY_COLORS.purple];
      if (route && route > 1) return [...TALLY_COLORS.electricBlue];
      return [...TALLY_COLORS.off];
    }
    case 'atlona-input': {
      const isRouted = snapshot.atlona?.output1Input === facet.input || snapshot.atlona?.output2Input === facet.input;
      if (isRouted) return [...TALLY_COLORS.electricBlue];
      return [...TALLY_COLORS.off];
    }
    case 'pi-output': {
      const active = facet.output === 1 ? snapshot.piOutputs?.output1Active : snapshot.piOutputs?.output2Active;
      return active ? [...TALLY_COLORS.pgm] : [...TALLY_COLORS.off];
    }
    case 'stt-state': {
      if (snapshot.stt?.busy) return [...TALLY_COLORS.amber];
      if (snapshot.stt?.voiceDetected) return [...TALLY_COLORS.prv];
      return [...TALLY_COLORS.off];
    }
    case 'caption-state': {
      return snapshot.captions?.flowing ? [...TALLY_COLORS.cyan] : [...TALLY_COLORS.off];
    }
    case 'manual': {
      return facet.color ?? [...TALLY_COLORS.off];
    }
    default:
      return [...TALLY_COLORS.off];
  }
}

/**
 * Coordinates multi-facet status evaluation, per-light conditionals, and syncs with PiGateway telemetry.
 */
export class FacetCoordinator extends EventEmitter {
  private manager: TallyManager;
  private currentSnapshot: SystemStatusSnapshot = {};
  private sseAbortController: AbortController | null = null;
  private sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pigatewayUrl?: string | undefined;

  constructor(manager: TallyManager, pigatewayUrl?: string) {
    super();
    this.manager = manager;
    this.pigatewayUrl = pigatewayUrl;
  }

  getSnapshot(): SystemStatusSnapshot {
    return { ...this.currentSnapshot };
  }

  /**
   * Updates part or all of the system status snapshot, immediately evaluating all affected lights.
   */
  async updateStatus(partial: Partial<SystemStatusSnapshot>): Promise<void> {
    this.currentSnapshot = {
      ...this.currentSnapshot,
      ...partial,
      atem: partial.atem !== undefined ? partial.atem : this.currentSnapshot.atem,
      youtube: partial.youtube !== undefined ? partial.youtube : this.currentSnapshot.youtube,
      matrox: partial.matrox !== undefined ? partial.matrox : this.currentSnapshot.matrox,
      atemStreamRecord:
        partial.atemStreamRecord !== undefined ? partial.atemStreamRecord : this.currentSnapshot.atemStreamRecord,
      projectors: partial.projectors !== undefined ? partial.projectors : this.currentSnapshot.projectors,
      atlona: partial.atlona !== undefined ? partial.atlona : this.currentSnapshot.atlona,
      cameras: partial.cameras !== undefined ? partial.cameras : this.currentSnapshot.cameras,
      pivoice: partial.pivoice !== undefined ? partial.pivoice : this.currentSnapshot.pivoice,
      pisound: partial.pisound !== undefined ? partial.pisound : this.currentSnapshot.pisound,
      spatial: partial.spatial !== undefined ? partial.spatial : this.currentSnapshot.spatial,
      rundown: partial.rundown !== undefined ? partial.rundown : this.currentSnapshot.rundown,
      ecosystem: partial.ecosystem !== undefined ? partial.ecosystem : this.currentSnapshot.ecosystem,
    };

    await this.evaluateAll();
    this.emit('snapshotChange', this.currentSnapshot);
  }

  /**
   * Evaluates a single registered light against its rules, segments, or default ATEM mapping.
   */
  async evaluateDevice(dev: import('./devices/tally-device.js').TallyDevice): Promise<void> {
    const state = dev.getState();
    if (state.isAnimating) {
      return;
    }

    const rules = dev.getRules();
    const hasStateRules = rules.some((r) => r.enabled !== false && r.when !== undefined);

    if (hasStateRules) {
      const matched = selectMatchingStateRule(rules, this.currentSnapshot);
      if (matched) {
        if (!doesDeviceMatchAction(state, matched.action, matched.id)) {
          await dev
            .applyRuleAction(matched.action, matched.id, () => this.evaluateDevice(dev))
            .catch((err) => {
              console.error(`[FacetCoordinator] Failed applying rule "${matched.id}" on ${dev.id}:`, err.message);
            });
        }
        return;
      }

      // No state rule matched: fall back to segments if configured, otherwise off
      const segments = state.segments;
      if (segments && segments.length > 0) {
        dev.setActiveRuleId(null);
        const updates = segments.map((seg) => ({
          segmentId: seg.id,
          color: evaluateFacetColor(seg.facet, this.currentSnapshot),
        }));
        await dev.updateSegments(updates).catch((err) => {
          console.error(`[FacetCoordinator] Failed updating segments on ${dev.id}:`, err.message);
        });
        return;
      }

      if (state.mode !== 'off' || state.activeRuleId !== null) {
        dev.setActiveRuleId(null);
        await dev.setOff().catch(() => {});
      }
      return;
    }

    const segments = state.segments;
    if (segments && segments.length > 0) {
      // Multi-segment device (over UDP)
      const updates: Array<{ segmentId: string; color: RGB }> = [];
      for (const seg of segments) {
        const color = evaluateFacetColor(seg.facet, this.currentSnapshot);
        updates.push({ segmentId: seg.id, color });
      }
      await dev.updateSegments(updates).catch((err) => {
        console.error(`[FacetCoordinator] Failed updating segments on ${dev.id}:`, err.message);
      });
    } else {
      // Standard single tally device: check if device ID or name maps to an input
      // e.g. "cam1" -> input 1, "tally02" -> input 2
      const m = dev.id.match(/^(?:cam|tally|light)?0*(\d+)$/i);
      if (m && m[1]) {
        const inputNum = parseInt(m[1], 10);
        if (this.currentSnapshot.atem) {
          const isPgm = this.currentSnapshot.atem.programInput === inputNum;
          const isPrv = this.currentSnapshot.atem.previewInput === inputNum;

          if (isPgm && state.mode !== 'pgm') {
            await dev.setProgram().catch(() => {});
          } else if (isPrv && !isPgm && state.mode !== 'prv') {
            await dev.setPreview().catch(() => {});
          } else if (!isPgm && !isPrv && state.mode !== 'off') {
            await dev.setOff().catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Evaluates all registered lights and updates their rules, segments, or solid states.
   */
  async evaluateAll(): Promise<void> {
    const devices = this.manager.getAllDevices();
    for (const dev of devices) {
      await this.evaluateDevice(dev);
    }
  }

  /**
   * Evaluates transient `onEvent` triggers across all registered lights when a Gateway event arrives.
   */
  private evaluateEventTriggers(event: { type: string; data?: unknown }): void {
    const devices = this.manager.getAllDevices();
    for (const dev of devices) {
      const rules = dev.getRules();
      const matching = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => rule.enabled !== false && rule.onEvent && matchesEventTrigger(rule.onEvent, event))
        .sort((a, b) => {
          const prioDiff = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
          return prioDiff !== 0 ? prioDiff : a.index - b.index;
        });

      const first = matching[0]?.rule;
      if (first) {
        void dev
          .applyRuleAction(first.action, first.id, () => this.evaluateDevice(dev))
          .catch((err) => {
            console.error(`[FacetCoordinator] Failed firing event rule "${first.id}" on ${dev.id}:`, err.message);
          });
      }
    }
  }

  /**
   * Connects to PiGateway Server-Sent Events (SSE) to automatically follow ATEM, encoder, YouTube, and other events.
   */
  startPiGatewayListener(pigatewayUrl: string = this.pigatewayUrl ?? 'http://127.0.0.1:3000'): void {
    this.stopPiGatewayListener();
    this.pigatewayUrl = pigatewayUrl;
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    const connectSse = async () => {
      const url = `${this.pigatewayUrl}/api/v1/events`;
      console.log(`[FacetCoordinator] Connecting to PiGateway SSE at ${url}...`);

      try {
        const fetchOptions: RequestInit = {
          headers: { Accept: 'text/event-stream' },
        };
        if (this.sseAbortController) {
          fetchOptions.signal = this.sseAbortController.signal;
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok || !response.body) {
          throw new Error(`SSE response failed with status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const block of lines) {
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;

            const jsonStr = dataLine.replace(/^data:\s*/, '');
            try {
              const event = JSON.parse(jsonStr);
              await this.handleGatewayEvent(event);
            } catch {
              // Ignore unparseable frames
            }
          }
        }
        console.warn('[FacetCoordinator] PiGateway SSE stream ended. Retrying in 3s...');
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        console.warn(`[FacetCoordinator] PiGateway SSE disconnected (${err.message}). Retrying in 3s...`);
      }
      // PiTally works without the gateway: keep trying, also after a clean end of the stream.
      if (signal.aborted) return;
      this.sseRetryTimer = setTimeout(() => {
        this.sseRetryTimer = null;
        void connectSse();
      }, 3000);
    };

    connectSse();
  }

  /**
   * Processes a single GatewayEvent (either from SSE or injected in tests).
   */
  async handleGatewayEvent(event: any): Promise<void> {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;

    // Fire transient event triggers first so animations mark `isAnimating = true` before snapshot re-evaluation.
    this.evaluateEventTriggers(event);

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (event.type === 'video-mixer' || event.type === 'atem') {
      await this.updateStatus({
        atem: {
          connected: data.connected ?? true,
          programInput: data.programInput ?? null,
          previewInput: data.previewInput ?? null,
          fadeToBlack: data.fadeToBlack,
          downstreamKeyers: Array.isArray(data.downstreamKeyers) ? data.downstreamKeyers : undefined,
        },
      });
    } else if (event.type === 'youtube') {
      const state = data.state ?? (data.live ? 'live' : 'offline');
      const live = typeof data.live === 'boolean' ? data.live : state === 'live';
      await this.updateStatus({
        youtube: {
          live,
          state,
          status: data.status ?? state,
          detail: data.detail,
        },
      });
    } else if (event.type === 'encoder') {
      const enc1State = data.encoder1?.state;
      const enc2State = data.encoder2?.state;
      await this.updateStatus({
        matrox: {
          connected: data.connected,
          encoder1Live: isEncoderStateActive(enc1State),
          encoder2Live: isEncoderStateActive(enc2State),
          encoder1State: enc1State,
          encoder2State: enc2State,
        },
      });
    } else if (event.type === 'matrix' && data.routes) {
      await this.updateStatus({
        atlona: {
          locked: data.locked,
          output1Input: data.routes[1] ?? undefined,
          output2Input: data.routes[2] ?? undefined,
          output5Input: data.routes[5] ?? undefined,
          routes: data.routes,
        },
      });
    } else if (event.type === 'camera' && typeof data.id === 'string') {
      const nextCameras = { ...(this.currentSnapshot.cameras ?? {}) };
      nextCameras[data.id] = {
        ...nextCameras[data.id],
        action: data.action,
        streaming: data.streaming ?? nextCameras[data.id]?.streaming,
        privacyBlur: data.privacyBlur ?? nextCameras[data.id]?.privacyBlur,
        presetId: data.presetId ?? nextCameras[data.id]?.presetId,
      };
      await this.updateStatus({ cameras: nextCameras });
    } else if (event.type === 'pivoice' || event.type === 'pivoice-activity') {
      const isSpeaking = Boolean(data.isSpeaking ?? data.active ?? data.vadSpeech ?? data.speechActive);
      await this.updateStatus({
        pivoice: {
          isSpeaking,
          classification: data.classification,
          vadProbability: data.vadProbability,
        },
      });
    } else if (event.type === 'pisound') {
      const activeChannels: number[] = Array.isArray(data.activeChannels)
        ? data.activeChannels
        : Array.isArray(data.channels)
          ? data.channels
              .filter((c: any) => c && (c.signalPresent || c.active))
              .map((c: any) => Number(c.index ?? c.channel))
              .filter((n: number) => Number.isFinite(n))
          : [];
      const activeChannelsCount =
        typeof data.activeChannelsCount === 'number' ? data.activeChannelsCount : activeChannels.length;
      await this.updateStatus({
        pisound: { activeChannels, activeChannelsCount },
      });
    } else if (event.type === 'spatial') {
      await this.updateStatus({
        spatial: {
          activeZones: Array.isArray(data.activeZones) ? data.activeZones : [],
        },
      });
    } else if (event.type === 'spatial-zone' && typeof data.zoneId === 'string') {
      const currentZones = new Set(this.currentSnapshot.spatial?.activeZones ?? []);
      if (data.event === 'entered') {
        currentZones.add(data.zoneId);
      } else if (data.event === 'left') {
        currentZones.delete(data.zoneId);
      }
      await this.updateStatus({
        spatial: { activeZones: Array.from(currentZones) },
      });
    } else if (event.type === 'rundown') {
      await this.updateStatus({
        rundown: {
          loaded: Boolean(data.loaded),
          title: data.title,
          currentCueId: data.currentCueId ?? data.currentCue?.id,
          currentCueTitle: data.currentCueTitle ?? data.currentCue?.title,
          assignedSpeaker: data.assignedSpeaker ?? data.currentCue?.assignedSpeaker,
        },
      });
    } else if (event.type === 'ecosystem' && data.components && typeof data.components === 'object') {
      const ecosystem: Record<string, { available: boolean; active: boolean }> = {};
      for (const [k, v] of Object.entries(data.components as Record<string, any>)) {
        if (v && typeof v === 'object') {
          ecosystem[k] = {
            available: Boolean(v.available),
            active: Boolean(v.active),
          };
        }
      }
      await this.updateStatus({ ecosystem });
    } else if (event.type === 'world-state') {
      const partial: Partial<SystemStatusSnapshot> = {};
      if (data.switcher) {
        partial.atem = {
          ...this.currentSnapshot.atem,
          connected: Boolean(data.switcher.connected),
          programInput: data.switcher.programInput ?? null,
          previewInput: data.switcher.previewInput ?? null,
        };
      }
      if (data.spatial) {
        partial.spatial = {
          activeZones: Array.isArray(data.spatial.activeZones) ? data.spatial.activeZones : [],
        };
      }
      if (data.activeSpeaker || data.audio) {
        partial.pivoice = {
          isSpeaking: Boolean(data.activeSpeaker?.isSpeaking ?? data.audio?.isSpeaking),
          classification: data.activeSpeaker?.vadClassification ?? data.audio?.classification,
          vadProbability: data.activeSpeaker?.vadProbability,
        };
      }
      if (data.ceremony) {
        partial.rundown = {
          loaded: Boolean(data.ceremony.loaded),
          title: data.ceremony.title,
          currentCueId: data.ceremony.currentCueId,
          currentCueTitle: data.ceremony.currentCueTitle,
          assignedSpeaker: data.ceremony.assignedSpeaker,
        };
      }
      if (Object.keys(partial).length > 0) {
        await this.updateStatus(partial);
      }
    }
  }

  stopPiGatewayListener(): void {
    if (this.sseRetryTimer) {
      clearTimeout(this.sseRetryTimer);
      this.sseRetryTimer = null;
    }
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
  }
}
