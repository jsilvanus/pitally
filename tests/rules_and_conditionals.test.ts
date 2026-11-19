import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { TallyManager } from '../src/manager.js';
import { evaluateCondition, type SystemStatusSnapshot, type TallyRule } from '../src/rules.js';
import { TALLY_COLORS } from '../src/types.js';

test('Condition evaluator supports YouTube, encoder, ATEM, matrix, voice, sound, spatial, rundown, ecosystem, and combinators', () => {
  const snapshot: SystemStatusSnapshot = {
    youtube: { live: true, state: 'live' },
    matrox: { connected: true, encoder1Live: true, encoder2Live: false, encoder1State: 'LIVE', encoder2State: 'OFF' },
    atem: {
      connected: true,
      programInput: 1,
      previewInput: 2,
      fadeToBlack: { fullyBlack: false, inTransition: false },
      downstreamKeyers: [{ dsk: 1, onAir: true }],
    },
    atlona: { locked: true, routes: { 1: 2, 4: 1 } },
    cameras: { cam1: { streaming: true, privacyBlur: false } },
    pivoice: { isSpeaking: true, classification: 'speech' },
    pisound: { activeChannels: [1, 3], activeChannelsCount: 2 },
    spatial: { activeZones: ['pulpit'] },
    rundown: { loaded: true, currentCueId: 'cue-2', currentCueTitle: 'Sermon', assignedSpeaker: 'Pastor' },
    ecosystem: { pitube: { available: true, active: true }, pivoice: { available: false, active: false } },
  };

  assert.equal(evaluateCondition({ type: 'youtube-live' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'youtube-live', state: 'offline' }, snapshot), false);
  assert.equal(evaluateCondition({ type: 'encoder-active', encoder: 1 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'encoder-active', encoder: 2 }, snapshot), false);
  assert.equal(evaluateCondition({ type: 'atem-program', input: 1 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'atem-preview', input: 2 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'atem-dsk', dsk: 1 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'atem-ftb' }, snapshot), false);
  assert.equal(evaluateCondition({ type: 'matrix-route', output: 1, input: 2 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'matrix-locked' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'camera-active', cameraId: 'cam1' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'voice-speaking', classification: 'speech' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'sound-active', channel: 3 }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'spatial-zone', zoneId: 'pulpit' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'rundown-cue', titleIncludes: 'sermon' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'ecosystem-online', component: 'pitube' }, snapshot), true);
  assert.equal(evaluateCondition({ type: 'ecosystem-online', component: 'pivoice' }, snapshot), false);

  assert.equal(
    evaluateCondition(
      {
        type: 'all',
        conditions: [
          { type: 'youtube-live' },
          { type: 'not', condition: { type: 'ecosystem-online', component: 'pivoice' } },
        ],
      },
      snapshot
    ),
    true
  );
});

test('Per-light state rules follow PiGateway events (YouTube live -> pgm, encoder -> amber, cam1 -> white)', async () => {
  const originalFetch = globalThis.fetch;
  const httpCalls: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request) => {
    httpCalls.push(String(url));
    return new Response('OK', { status: 200 });
  }) as any;

  try {
    const manager = new TallyManager({ disableDiscovery: true });
    const { coordinator } = createServer({ manager });

    const rules: TallyRule[] = [
      {
        id: 'yt-live',
        priority: 30,
        when: { type: 'youtube-live' },
        action: { mode: 'pgm' },
      },
      {
        id: 'cam1-white',
        priority: 20,
        when: { type: 'atem-program', input: 1 },
        action: { mode: 'color', color: 'white' },
      },
      {
        id: 'enc1-amber',
        priority: 10,
        when: { type: 'encoder-active', encoder: 1 },
        action: { mode: 'color', color: 'amber' },
      },
    ];

    const device = manager.registerDevice({
      id: 'tally01',
      name: 'Studio Light',
      ip: '192.168.1.70',
      rules,
    });

    // 1. Encoder 1 goes LIVE -> amber
    await coordinator.handleGatewayEvent({
      type: 'encoder',
      data: {
        configured: true,
        connected: true,
        name: 'Monarch',
        encoder1: { mode: 'Streaming', state: 'LIVE' },
        encoder2: { mode: 'Recording', state: 'OFF' },
      },
    });
    assert.equal(device.getState().activeRuleId, 'enc1-amber');
    assert.equal(device.getState().mode, 'color');
    assert.deepEqual(device.getState().rgb, TALLY_COLORS.amber);

    // 2. Cam 1 goes on ATEM Program (higher priority 20 > 10) -> white
    await coordinator.handleGatewayEvent({
      type: 'atem',
      data: { connected: true, programInput: 1, previewInput: 2 },
    });
    assert.equal(device.getState().activeRuleId, 'cam1-white');
    assert.deepEqual(device.getState().rgb, TALLY_COLORS.white);

    // 3. YouTube goes live (highest priority 30) -> pgm (red)
    await coordinator.handleGatewayEvent({
      type: 'youtube',
      data: { state: 'live', checkedAt: Date.now(), ttlMs: 30000, receivedAt: Date.now() },
    });
    assert.equal(device.getState().activeRuleId, 'yt-live');
    assert.equal(device.getState().mode, 'pgm');
    assert.deepEqual(device.getState().rgb, TALLY_COLORS.pgm);

    // 4. YouTube goes offline, ATEM switches to input 2, Encoder stops -> off
    await coordinator.handleGatewayEvent({
      type: 'youtube',
      data: { state: 'offline', checkedAt: Date.now(), ttlMs: 30000, receivedAt: Date.now() },
    });
    await coordinator.handleGatewayEvent({
      type: 'atem',
      data: { connected: true, programInput: 2, previewInput: 1 },
    });
    await coordinator.handleGatewayEvent({
      type: 'encoder',
      data: {
        configured: true,
        connected: true,
        name: 'Monarch',
        encoder1: { mode: 'Streaming', state: 'OFF' },
        encoder2: { mode: 'Recording', state: 'OFF' },
      },
    });
    assert.equal(device.getState().activeRuleId, null);
    assert.equal(device.getState().mode, 'off');

    await manager.destroy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Transient event trigger (onEvent) flashes white and restores underlying state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('OK', { status: 200 })) as any;
  const manager = new TallyManager({ disableDiscovery: true });

  try {
    const { coordinator } = createServer({ manager });

    const device = manager.registerDevice({
      id: 'tally01',
      name: 'Cue Light',
      host: '127.0.0.1',
      ip: '127.0.0.1',
      rules: [
        {
          id: 'yt-live',
          priority: 10,
          when: { type: 'youtube-live' },
          action: { mode: 'pgm' },
        },
        {
          id: 'flash-on-z',
          onEvent: { eventType: 'action', match: { action: 'event:z' } },
          action: { mode: 'flash', color: 'white', durationMs: 120, intervalMs: 50 },
        },
      ],
    });

    // Put light into YouTube Live (PGM) state first
    await coordinator.handleGatewayEvent({
      type: 'youtube',
      data: { state: 'live' },
    });
    assert.equal(device.getState().mode, 'pgm');

    // Fire matching event Z
    await coordinator.handleGatewayEvent({
      type: 'action',
      data: { actor: 'ui', action: 'event:z', params: {}, ok: true, timestamp: new Date().toISOString() },
    });

    // Wait for flash animation to complete and restore PGM
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(device.getState().isAnimating, false);
    assert.equal(device.getState().mode, 'pgm');
  } finally {
    await manager.destroy();
    globalThis.fetch = originalFetch;
  }
});

test('REST endpoints: GET /conditionals and CRUD /lights/:id/rules', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('OK', { status: 200 })) as any;
  const manager = new TallyManager({ disableDiscovery: true });
  const { app, coordinator } = createServer({ manager });

  try {
    await coordinator.updateStatus({ youtube: { live: true, state: 'live' } });

    const catRes = await app.inject({ method: 'GET', url: '/api/v1/conditionals' });
    assert.equal(catRes.statusCode, 200);
    const cat = catRes.json();
    assert.ok(Array.isArray(cat.conditions));
    assert.ok(cat.conditions.some((c: any) => c.type === 'youtube-live'));

    await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'tally01', name: 'Tally 1', host: '127.0.0.1', ip: '127.0.0.1' },
    });

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/lights/tally01/rules',
      payload: {
        rules: [
          {
            id: 'r1',
            when: { type: 'youtube-live' },
            action: { mode: 'pgm' },
          },
        ],
      },
    });
    assert.equal(putRes.statusCode, 200);
    assert.equal(putRes.json().state.mode, 'pgm');
    assert.equal(putRes.json().state.activeRuleId, 'r1');

    const getRes = await app.inject({ method: 'GET', url: '/api/v1/lights/tally01/rules' });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().rules.length, 1);

    const delRes = await app.inject({ method: 'DELETE', url: '/api/v1/lights/tally01/rules/r1' });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.json().state.mode, 'off');
    assert.equal(delRes.json().state.rules.length, 0);
  } finally {
    await manager.destroy();
    await app.close();
    globalThis.fetch = originalFetch;
  }
});
