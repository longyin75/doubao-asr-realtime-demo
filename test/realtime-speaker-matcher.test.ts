import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../server-cloud/config';
import { gpuEmbedClient } from '../server-cloud/gpu-embed-client';
import { RealtimeSpeakerMatcher } from '../server-cloud/realtime-speaker-matcher';

const DIM = 192;

function unit(components: Array<[number, number]>): Float32Array {
  const v = new Float32Array(DIM);
  for (const [idx, val] of components) v[idx] = val;
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const EMB_A = unit([[0, 1]]);
const EMB_B = unit([[0, 0.5], [1, Math.sqrt(0.75)]]);
const EMB_NEG_A = unit([[0, -0.6], [2, 0.8]]);

function voicedPcm(ms: number = 400): Buffer {
  const samples = Math.floor((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  const view = new Int16Array(buf.buffer, buf.byteOffset, samples);
  for (let i = 0; i < samples; i++) view[i] = i % 128 < 64 ? 8000 : -8000;
  return buf;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface MatchEvent {
  speakerId: number;
  username: string;
  method: string;
  color: string;
}

function makeMatcher(): { matcher: RealtimeSpeakerMatcher; events: MatchEvent[] } {
  const matcher = new RealtimeSpeakerMatcher();
  const events: MatchEvent[] = [];
  matcher.on('speaker_matched', (speakerId: number, username: string, _score: number | undefined, _conf: string, method: string, color: string) => {
    events.push({ speakerId, username, method, color });
  });
  matcher.on('speaker_guest', (speakerId: number, username: string, color: string) => {
    events.push({ speakerId, username, method: 'guest', color });
  });
  return { matcher, events };
}

function enroll(name: string, emb: Float32Array): void {
  RealtimeSpeakerMatcher.enrollGlobalSpeaker(name, emb);
}

function clearGlobalDB(): void {
  for (const name of RealtimeSpeakerMatcher.listGlobalSpeakers()) {
    RealtimeSpeakerMatcher.deleteGlobalSpeaker(name);
  }
}

function mockEmbedding(provider: () => Float32Array): void {
  (gpuEmbedClient as unknown as { extractEmbedding: unknown }).extractEmbedding = async () => ({
    embedding: provider(),
    duration_ms: 100,
  });
}

function feedUtterance(matcher: RealtimeSpeakerMatcher, speakerId: number, t0: number, startMs: number, ms: number = 400): void {
  const pcm = voicedPcm(ms);
  matcher.feedAudio(pcm, t0 + startMs);
  matcher.onDefiniteUtterance(speakerId, startMs, startMs + ms);
}

describe('RealtimeSpeakerMatcher v5.0 状态机', () => {
  let t0: number;
  let saved: Record<string, unknown>;

  beforeEach(() => {
    clearGlobalDB();
    t0 = 1_000_000;
    saved = {
      voiceprintEnabled: config.voiceprintEnabled,
      voiceprintDriftCorrectionEnabled: config.voiceprintDriftCorrectionEnabled,
      voiceprintMinUttMs: config.voiceprintMinUttMs,
      voiceprintMaxWaitMs: config.voiceprintMaxWaitMs,
      voiceprintForceMatchMs: config.voiceprintForceMatchMs,
      voiceprintScoreEarlyStop: config.voiceprintScoreEarlyStop,
      voiceprintScoreMargin: config.voiceprintScoreMargin,
      voiceprintDriftMinScore: config.voiceprintDriftMinScore,
      voiceprintScoreLowConf: config.voiceprintScoreLowConf,
      voiceprintDriftThreshold: config.voiceprintDriftThreshold,
      voiceprintGuestUpgradeHits: config.voiceprintGuestUpgradeHits,
    };
    config.voiceprintEnabled = true;
    config.voiceprintDriftCorrectionEnabled = true;
    config.voiceprintMinUttMs = 100;
    config.voiceprintMaxWaitMs = 30;
    config.voiceprintForceMatchMs = 3000;
  });

  afterEach(() => {
    Object.assign(config, saved);
    clearGlobalDB();
  });

  test('连续 3 次命中他人后触发漂移纠正并改名换色', async () => {
    enroll('A-drift', EMB_A);
    enroll('B-drift', EMB_B);
    let next = EMB_A;
    mockEmbedding(() => next);

    const { matcher, events } = makeMatcher();
    matcher.start(t0);
    matcher.markAudioStart(t0);

    feedUtterance(matcher, 0, t0, 0);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-drift');
    const colorA = matcher.getSpeakerInfo(0).color;

    next = EMB_B;
    feedUtterance(matcher, 0, t0, 400);
    await sleep(20);
    feedUtterance(matcher, 0, t0, 800);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-drift', '前两次漂移计数不应改名');

    feedUtterance(matcher, 0, t0, 1200);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'B-drift', '第 3 次应漂移纠正为 B');
    assert.notEqual(matcher.getSpeakerInfo(0).color, colorA, '漂移后应切换为 B 的颜色');
    const driftEvent = events.find((e) => e.method === 'drift_correction');
    assert.ok(driftEvent, '应发出 drift_correction 事件');
    assert.equal(driftEvent?.username, 'B-drift');
  });

  test('同姓名跨 speaker 槽位复用同一颜色', async () => {
    enroll('A-color', EMB_A);
    mockEmbedding(() => EMB_A);

    const { matcher } = makeMatcher();
    matcher.start(t0);
    matcher.markAudioStart(t0);

    feedUtterance(matcher, 0, t0, 0);
    feedUtterance(matcher, 1, t0, 400);
    await sleep(20);

    assert.equal(matcher.getSpeakerInfo(0).username, 'A-color');
    assert.equal(matcher.getSpeakerInfo(1).username, 'A-color');
    assert.equal(matcher.getSpeakerInfo(0).color, matcher.getSpeakerInfo(1).color);
  });

  test('guest 连续命中注册人后升级为实名', async () => {
    enroll('A-guest', EMB_A);
    let next = EMB_NEG_A;
    mockEmbedding(() => next);

    const { matcher, events } = makeMatcher();
    matcher.start(t0);
    matcher.markAudioStart(t0);

    feedUtterance(matcher, 0, t0, 0);
    await sleep(60);
    assert.equal(matcher.getSpeakerInfo(0).status, 'guest', '超时无高匹配应分配 guest');
    assert.match(matcher.getSpeakerInfo(0).username ?? '', /^参会人\d+$/);

    next = EMB_A;
    feedUtterance(matcher, 0, t0, 400);
    await sleep(20);
    feedUtterance(matcher, 0, t0, 800);
    await sleep(20);
    assert.match(matcher.getSpeakerInfo(0).username ?? '', /^参会人\d+$/, '未达升级次数前保持 guest');

    feedUtterance(matcher, 0, t0, 1200);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-guest');
    assert.equal(matcher.getSpeakerInfo(0).status, 'matched_high');
    const upgradeEvent = events.find((e) => e.method === 'guest_upgrade');
    assert.ok(upgradeEvent, '应发出 guest_upgrade 事件');
  });

  test('高置信确认会重置漂移计数', async () => {
    enroll('A-reset', EMB_A);
    enroll('B-reset', EMB_B);
    let next = EMB_A;
    mockEmbedding(() => next);

    const { matcher } = makeMatcher();
    matcher.start(t0);
    matcher.markAudioStart(t0);

    feedUtterance(matcher, 0, t0, 0);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-reset');

    next = EMB_B;
    feedUtterance(matcher, 0, t0, 400);
    await sleep(20);
    feedUtterance(matcher, 0, t0, 800);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-reset');

    next = EMB_A;
    feedUtterance(matcher, 0, t0, 1200);
    await sleep(20);

    next = EMB_B;
    feedUtterance(matcher, 0, t0, 1600);
    await sleep(20);
    feedUtterance(matcher, 0, t0, 2000);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-reset', '中间确认后漂移计数应重新开始');
  });

  test('VOICEPRINT_DRIFT_CORRECTION_ENABLED=false 回退 v4.0：绑定后不再校验', async () => {
    config.voiceprintDriftCorrectionEnabled = false;
    enroll('A-v4', EMB_A);
    let calls = 0;
    let next = EMB_A;
    mockEmbedding(() => {
      calls++;
      return next;
    });

    const { matcher } = makeMatcher();
    matcher.start(t0);
    matcher.markAudioStart(t0);

    feedUtterance(matcher, 0, t0, 0);
    await sleep(20);
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-v4');
    const callsAfterBind = calls;

    next = EMB_B;
    feedUtterance(matcher, 0, t0, 400);
    await sleep(20);
    feedUtterance(matcher, 0, t0, 800);
    await sleep(20);
    assert.equal(calls, callsAfterBind, '已绑定 speaker 不应再请求 embedding');
    assert.equal(matcher.getSpeakerInfo(0).username, 'A-v4', 'v4.0 回退模式下名字保持不变');
  });
});
