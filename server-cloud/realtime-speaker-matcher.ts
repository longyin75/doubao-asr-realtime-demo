import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { gpuEmbedClient } from './gpu-embed-client';
import { estimateVoiceActivity, pcmDurationMs } from './pcm-to-wav';

export type SpeakerStatus = 'unknown' | 'identifying' | 'candidate' | 'matched_high' | 'matched_low' | 'manual_bound' | 'guest';

export interface SpeakerInfo {
  status: SpeakerStatus;
  username?: string;
  color: string;
  score?: number;
  confidence?: 'high' | 'low';
}

interface SpeakerState {
  status: SpeakerStatus;
  username?: string;
  score?: number;
  color: string;
  avgEmbedding?: Float32Array;
  totalVoicedMs: number;
  candidateName?: string;
  candidateScore?: number;
  consecutiveHits: number;
  firstSeenAt: number;
  matching: boolean;
  utteranceCount: number;
  timeoutTimer?: NodeJS.Timeout;
  driftCounter: number;
  lastVerifiedName?: string;
  lastVerifiedScore?: number;
  lastVerifiedAt?: number;
}

interface RingBufferChunk {
  timestamp: number;
  pcm: Buffer;
}

const SPEAKER_COLORS = [
  '#1a73e8',
  '#ea4335',
  '#34a853',
  '#fbbc04',
  '#9334e6',
  '#ff6d01',
  '#46bdc6',
  '#f06292',
  '#7986cb',
  '#a1887f',
];

export class RealtimeSpeakerMatcher extends EventEmitter {
  private static globalSpeakerDB: Map<string, Float32Array> = new Map();
  private static persistencePath: string = '';
  private static persistenceInitialized: boolean = false;

  private speakers: Map<number, SpeakerState> = new Map();
  private ringBuffer: RingBufferChunk[] = [];
  private audioStartTime: number = 0;
  private bytesPerMs: number;
  private boundNames: Set<string> = new Set();
  private guestSeq: number = 0;
  private nameColorMap: Map<string, string> = new Map();
  private nextColorIdx: number = 0;

  constructor() {
    super();
    this.bytesPerMs = 16000 * 2 / 1000;
  }

  /**
   * 初始化持久化存储：启动时调用一次，从JSON文件加载声纹库
   */
  static initPersistentStorage(baseDir?: string): void {
    if (RealtimeSpeakerMatcher.persistenceInitialized) return;

    const dir = baseDir || config.voiceprintsDir;
    const absDir = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
    RealtimeSpeakerMatcher.persistencePath = path.join(absDir, 'local-voiceprints.json');

    try {
      if (!fs.existsSync(absDir)) {
        fs.mkdirSync(absDir, { recursive: true });
        console.log(`[vp] Created voiceprints directory: ${absDir}`);
      }
    } catch (err) {
      console.error(`[vp] Failed to create voiceprints directory: ${err}`);
    }

    try {
      if (fs.existsSync(RealtimeSpeakerMatcher.persistencePath)) {
        const raw = fs.readFileSync(RealtimeSpeakerMatcher.persistencePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.speakers)) {
          let loaded = 0;
          for (const spk of data.speakers) {
            if (spk.name && Array.isArray(spk.embedding)) {
              const emb = new Float32Array(spk.embedding);
              RealtimeSpeakerMatcher.globalSpeakerDB.set(spk.name, emb);
              loaded++;
            }
          }
          console.log(`[vp] Loaded ${loaded} speakers from persistent storage`);
        }
      } else {
        console.log(`[vp] No persistent voiceprint file found, starting with empty library`);
      }
    } catch (err) {
      console.error(`[vp] Failed to load persistent voiceprints: ${err}`);
      console.log(`[vp] Starting with empty in-memory library`);
    }

    RealtimeSpeakerMatcher.persistenceInitialized = true;
  }

  /**
   * 同步将当前内存声纹库写入JSON文件（原子写：先写tmp再rename）
   */
  private static saveToDiskSync(): void {
    if (!RealtimeSpeakerMatcher.persistenceInitialized || !RealtimeSpeakerMatcher.persistencePath) {
      return;
    }

    try {
      const speakers: Array<{ name: string; embedding: number[] }> = [];
      RealtimeSpeakerMatcher.globalSpeakerDB.forEach((emb, name) => {
        speakers.push({ name, embedding: Array.from(emb) });
      });

      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        speakers,
      };

      const tmpPath = RealtimeSpeakerMatcher.persistencePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmpPath, RealtimeSpeakerMatcher.persistencePath);
    } catch (err) {
      console.error(`[vp] Failed to save voiceprints to disk: ${err}`);
    }
  }

  static enrollGlobalSpeaker(name: string, embedding: Float32Array): void {
    const normalized = RealtimeSpeakerMatcher.normalizeEmbeddingStatic(embedding);
    RealtimeSpeakerMatcher.globalSpeakerDB.set(name, normalized);
    console.log(`[vp] Enrolled global speaker: ${name}, total=${RealtimeSpeakerMatcher.globalSpeakerDB.size}`);
    RealtimeSpeakerMatcher.saveToDiskSync();
  }

  static deleteGlobalSpeaker(name: string): void {
    RealtimeSpeakerMatcher.globalSpeakerDB.delete(name);
    console.log(`[vp] Deleted global speaker: ${name}, total=${RealtimeSpeakerMatcher.globalSpeakerDB.size}`);
    RealtimeSpeakerMatcher.saveToDiskSync();
  }

  static listGlobalSpeakers(): string[] {
    return Array.from(RealtimeSpeakerMatcher.globalSpeakerDB.keys());
  }

  static getGlobalEmbedding(name: string): Float32Array | undefined {
    return RealtimeSpeakerMatcher.globalSpeakerDB.get(name);
  }

  static getGlobalCount(): number {
    return RealtimeSpeakerMatcher.globalSpeakerDB.size;
  }

  private static normalizeEmbeddingStatic(emb: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < emb.length; i++) {
      norm += emb[i] * emb[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return emb;
    const normalized = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) {
      normalized[i] = emb[i] / norm;
    }
    return normalized;
  }

  start(sessionStart: number): void {
    console.log(`[vp] Drift correction: ${config.voiceprintDriftCorrectionEnabled ? 'enabled' : 'DISABLED (v4.0 fallback mode)'}`);
    this.audioStartTime = sessionStart;
    this.speakers.forEach((state) => {
      if (state.timeoutTimer) {
        clearTimeout(state.timeoutTimer);
      }
    });
    this.speakers.clear();
    this.ringBuffer = [];
    this.boundNames.clear();
    this.guestSeq = 0;
    this.nameColorMap.clear();
    this.nextColorIdx = 0;
    console.log(`[vp] Matcher started, globalSpeakers=${RealtimeSpeakerMatcher.globalSpeakerDB.size}`);
  }

  /**
   * 在第一个音频包到达时调用，校准音频起始时间
   * ASR的start_time=0对应第一个音频包的发送时间，而非WebSocket连接时间
   */
  markAudioStart(now?: number): void {
    this.audioStartTime = now ?? Date.now();
    this.ringBuffer = [];
    console.log(`[vp] Audio start calibrated at t=${this.audioStartTime}`);
  }

  feedAudio(pcmData: Buffer, now?: number): void {
    const timestamp = now ?? Date.now();
    const chunk: RingBufferChunk = { timestamp, pcm: pcmData };
    this.ringBuffer.push(chunk);

    const cutoff = timestamp - config.voiceprintRingBufferMs;
    while (this.ringBuffer.length > 0 && this.ringBuffer[0].timestamp < cutoff) {
      this.ringBuffer.shift();
    }
  }

  getSpeakerInfo(speakerId: number): SpeakerInfo {
    const state = this.speakers.get(speakerId);
    if (!state) {
      return {
        status: 'unknown',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
      };
    }
    return {
      status: state.status,
      username: state.username,
      color: state.color,
      score: state.score,
      confidence: state.status === 'matched_high' ? 'high' : state.status === 'matched_low' ? 'low' : undefined,
    };
  }

  onDefiniteUtterance(speakerId: number, startTimeMs: number, endTimeMs: number): void {
    if (!config.voiceprintEnabled) return;
    console.log(`[vp] onDefiniteUtterance: spk=${speakerId}, start=${startTimeMs}, end=${endTimeMs}`);

    let state = this.speakers.get(speakerId);
    if (!state) {
      state = {
        status: 'unknown',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
        totalVoicedMs: 0,
        consecutiveHits: 0,
        firstSeenAt: Date.now(),
        matching: false,
        utteranceCount: 0,
        driftCounter: 0,
      };
      this.speakers.set(speakerId, state);
    }

    // v5.0: 不再跳过已绑定speaker，每句都校验（除非flag关闭回退到v4.0）
    const useDriftCorrection = config.voiceprintDriftCorrectionEnabled;
    const isBoundState = state.status === 'matched_high' || state.status === 'matched_low' || state.status === 'manual_bound' || state.status === 'guest';
    if (isBoundState && !useDriftCorrection) {
      // v4.0 fallback: 已绑定直接跳过
      return;
    }

    state.utteranceCount++;

    const utterancePcm = this.extractAudioFromRingBuffer(startTimeMs, endTimeMs);
    console.log(`[vp] extractAudio: req [${startTimeMs},${endTimeMs}] got ${utterancePcm.length} bytes (${Math.round(utterancePcm.length / this.bytesPerMs)}ms)`);
    if (utterancePcm.length === 0) return;

    const { voiced, durationMs } = estimateVoiceActivity(utterancePcm);
    if (durationMs < 100) return;

    this.processUtterance(speakerId, state, voiced, durationMs, startTimeMs, endTimeMs);
  }

  manualBind(speakerId: number, username: string): void {
    console.log(`[vp] manualBind: spk=${speakerId}, username=${username}`);
    let state = this.speakers.get(speakerId);
    if (!state) {
      state = {
        status: 'manual_bound',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
        totalVoicedMs: 0,
        consecutiveHits: 0,
        firstSeenAt: Date.now(),
        matching: false,
        utteranceCount: 0,
        driftCounter: 0,
      };
      this.speakers.set(speakerId, state);
    }

    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }

    if (state.username) {
      this.boundNames.delete(state.username);
    }

    state.status = 'manual_bound';
    state.username = username;
    state.score = undefined;
    state.avgEmbedding = undefined;
    state.matching = false;
    state.driftCounter = 0;
    state.color = this.getOrAssignColor(username);
    this.boundNames.add(username);
    console.log(`[vp] speaker_matched (manual): spk=${speakerId}, username=${username}`);
    this.emit('speaker_matched', speakerId, username, undefined, 'high', 'manual', state.color);
  }

  reset(): void {
    this.speakers.forEach((state) => {
      if (state.timeoutTimer) {
        clearTimeout(state.timeoutTimer);
      }
    });
    this.speakers.clear();
    this.ringBuffer = [];
    this.audioStartTime = 0;
    this.boundNames.clear();
    this.guestSeq = 0;
    this.nameColorMap.clear();
    this.nextColorIdx = 0;
    console.log(`[vp] Matcher reset`);
  }

  private async processUtterance(speakerId: number, state: SpeakerState, voiced: Buffer, newVoicedMs: number, startTimeMs: number, endTimeMs: number): Promise<void> {
    if (state.matching) return;

    const useDriftCorrection = config.voiceprintDriftCorrectionEnabled;
    const boundName = state.username || 'none';
    let verdict = 'unknown';

    const isUnbound = state.status === 'unknown' || state.status === 'identifying' || state.status === 'candidate';

    if (isUnbound) {
      if (state.status === 'unknown') {
        state.status = 'identifying';
        console.log(`[vp] speaker_identifying: spk=${speakerId}`);
        this.emit('speaker_identifying', speakerId);
        this.setupForceMatchTimeout(speakerId, state);
      }
      if (newVoicedMs < config.voiceprintMinUttMs) {
        return;
      }
    } else {
      if (newVoicedMs < config.voiceprintMinUttMs) {
        console.log(`[vp] utt: spk=${speakerId} time=[${startTimeMs},${endTimeMs}] bound=${boundName} top1=? drift=${state.driftCounter}/${config.voiceprintDriftThreshold} verdict=skip_short_audio`);
        return;
      }
    }

    state.matching = true;

    try {
      const { embedding: newEmbedding } = await gpuEmbedClient.extractEmbedding(voiced, 'pcm');
      const normalizedNew = this.normalizeEmbedding(newEmbedding);

      const topMatch = this.findTopMatch(normalizedNew);
      const top1Name = topMatch ? topMatch.name : 'none';
      const top1Score = topMatch ? topMatch.score : 0;

      if (isUnbound || !useDriftCorrection) {
        if (topMatch && topMatch.score >= config.voiceprintScoreEarlyStop) {
          const margin = topMatch.secondScore !== undefined ? topMatch.score - topMatch.secondScore : 100;
          if (margin >= config.voiceprintScoreMargin) {
            verdict = 'match_high';
            console.log(`[vp] Early match: spk=${speakerId}, name=${topMatch.name}, score=${topMatch.score}`);
            this.confirmMatch(speakerId, state, topMatch.name, topMatch.score, 'high', 'early_stop');
            this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
            return;
          }
        }

        state.totalVoicedMs += newVoicedMs;
        state.avgEmbedding = state.avgEmbedding
          ? this.mergeEmbedding(state.avgEmbedding, normalizedNew, state.totalVoicedMs - newVoicedMs, newVoicedMs)
          : normalizedNew;

        const mergedTop = this.findTopMatch(state.avgEmbedding);

        if (mergedTop) {
          if (state.candidateName === mergedTop.name) {
            state.consecutiveHits++;
          } else {
            state.candidateName = mergedTop.name;
            state.candidateScore = mergedTop.score;
            state.consecutiveHits = 1;
          }

          if (state.consecutiveHits >= 2 && mergedTop.score >= config.voiceprintScoreConfirm) {
            verdict = 'match_high';
            console.log(`[vp] Incremental match: spk=${speakerId}, name=${mergedTop.name}, score=${mergedTop.score}`);
            this.confirmMatch(speakerId, state, mergedTop.name, mergedTop.score, 'high', 'incremental');
            this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
            return;
          }

          if (state.status === 'identifying') {
            state.status = 'candidate';
            verdict = 'match_incremental_pending';
          }
        }

        if (state.totalVoicedMs >= config.voiceprintForceMatchMs) {
          this.tryForceMatchV5(speakerId, state, false, startTimeMs, endTimeMs, boundName, top1Name, top1Score);
        }
      } else {
        const isGuest = state.status === 'guest';

        if (!isGuest) {
          if (topMatch && top1Name === state.username && top1Score >= config.voiceprintVerifyMinScore) {
            verdict = 'confirm';
            state.driftCounter = 0;
            state.lastVerifiedName = top1Name;
            state.lastVerifiedScore = top1Score;
            state.lastVerifiedAt = Date.now();
          } else if (topMatch && top1Name !== state.username && top1Score >= config.voiceprintDriftMinScore) {
            state.driftCounter++;
            if (state.driftCounter < config.voiceprintDriftThreshold) {
              verdict = 'drift_ignore';
            } else {
              verdict = `DRIFT_CORRECTION→${top1Name}`;
              const oldName = state.username!;
              this.releaseColorIfUnused(oldName, speakerId);
              this.resetSpeakerState(state);
              state.status = 'matched_high';
              state.username = top1Name;
              state.score = top1Score;
              state.driftCounter = 0;
              state.lastVerifiedName = top1Name;
              state.lastVerifiedScore = top1Score;
              state.lastVerifiedAt = Date.now();
              state.avgEmbedding = normalizedNew;
              state.totalVoicedMs = newVoicedMs;
              state.consecutiveHits = 1;
              state.color = this.getOrAssignColor(top1Name);
              state.matching = false;
              if (state.timeoutTimer) {
                clearTimeout(state.timeoutTimer);
                state.timeoutTimer = undefined;
              }
              console.log(`[vp] DRIFT_CORRECTION: spk=${speakerId} ${oldName}→${top1Name}, score=${top1Score}, drift=${config.voiceprintDriftThreshold} hits`);
              this.emit('speaker_matched', speakerId, top1Name, top1Score, 'high', 'drift_correction', state.color);
              this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
              return;
            }
          } else if (!topMatch || top1Score < config.voiceprintVerifyMinScore) {
            verdict = 'ignore_low_score';
          } else {
            verdict = 'ignore_low_score';
          }

          if (topMatch && top1Score < config.voiceprintScoreLowConf) {
            state.driftCounter++;
            if (state.driftCounter >= config.voiceprintDriftThreshold) {
              verdict = `guest→${'参会人' + (this.guestSeq+1)}`;
              const oldName = state.username!;
              this.releaseColorIfUnused(oldName, speakerId);
              this.resetSpeakerState(state);
              this.assignGuest(speakerId, state);
              this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
              return;
            } else {
              verdict = 'guest_drift_ignore';
            }
          }
        } else {
          if (topMatch && top1Score >= config.voiceprintDriftMinScore) {
            if (state.candidateName === top1Name) {
              state.driftCounter++;
            } else {
              state.candidateName = top1Name;
              state.candidateScore = top1Score;
              state.driftCounter = 1;
            }
            if (state.driftCounter >= config.voiceprintGuestUpgradeHits) {
              verdict = `guest_upgrade→${top1Name}`;
              const oldGuestName = state.username!;
              this.releaseColorIfUnused(oldGuestName, speakerId);
              this.resetSpeakerState(state);
              state.status = 'matched_high';
              state.username = top1Name;
              state.score = top1Score;
              state.driftCounter = 0;
              state.lastVerifiedName = top1Name;
              state.lastVerifiedScore = top1Score;
              state.lastVerifiedAt = Date.now();
              state.avgEmbedding = normalizedNew;
              state.totalVoicedMs = newVoicedMs;
              state.color = this.getOrAssignColor(top1Name);
              state.matching = false;
              if (state.timeoutTimer) {
                clearTimeout(state.timeoutTimer);
                state.timeoutTimer = undefined;
              }
              console.log(`[vp] Guest upgraded: spk=${speakerId}, name=${top1Name}, score=${top1Score}`);
              this.emit('speaker_matched', speakerId, top1Name, top1Score, 'high', 'guest_upgrade', state.color);
              this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
              return;
            } else {
              verdict = 'guest_upgrade_pending';
            }
          } else {
            state.driftCounter = 0;
            state.candidateName = undefined;
            verdict = 'confirm_guest';
          }
        }
      }

      this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName, top1Name, top1Score, state, verdict);
    } catch (err) {
      console.error('[vp] Processing error:', err);
    } finally {
      state.matching = false;
    }
  }

  private setupForceMatchTimeout(speakerId: number, state: SpeakerState): void {
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
    }

    state.timeoutTimer = setTimeout(() => {
      if (state.status === 'matched_high' || state.status === 'matched_low' || state.status === 'manual_bound' || state.status === 'guest') {
        return;
      }
      this.tryForceMatchV5(speakerId, state, true);
    }, config.voiceprintMaxWaitMs);
  }

  private tryForceMatch(speakerId: number, state: SpeakerState, isTimeout: boolean = false): void {
    if (state.matching) return;
    if (!state.avgEmbedding) {
      if (isTimeout) {
        this.assignGuest(speakerId, state);
      }
      return;
    }

    const results = this.cosineSearch(state.avgEmbedding, this.boundNames);
    if (results.length === 0) {
      if (isTimeout) {
        this.assignGuest(speakerId, state);
      }
      return;
    }

    const top1 = results[0];
    if (top1.score >= config.voiceprintScoreForce) {
      console.log(`[vp] Force match: spk=${speakerId}, name=${top1.name}, score=${top1.score}`);
      this.confirmMatch(speakerId, state, top1.name, top1.score, 'high', 'force');
    } else if (top1.score >= config.voiceprintScoreLowConf) {
      console.log(`[vp] Low-conf match: spk=${speakerId}, name=${top1.name}, score=${top1.score}`);
      this.confirmMatch(speakerId, state, top1.name, top1.score, 'low', 'force_lowconf');
    } else if (isTimeout) {
      this.assignGuest(speakerId, state);
    }
  }

  private tryForceMatchV5(speakerId: number, state: SpeakerState, isTimeout: boolean = false, startTimeMs?: number, endTimeMs?: number, boundName?: string, top1Name?: string, top1Score?: number): void {
    if (state.matching) return;
    if (!state.avgEmbedding) {
      if (isTimeout) {
        this.assignGuest(speakerId, state);
        if (startTimeMs !== undefined && endTimeMs !== undefined) {
          this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName || 'none', top1Name || 'none', top1Score || 0, state, 'guest');
        }
      }
      return;
    }

    const top = this.findTopMatch(state.avgEmbedding);
    if (!top) {
      if (isTimeout) {
        this.assignGuest(speakerId, state);
        if (startTimeMs !== undefined && endTimeMs !== undefined) {
          this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName || 'none', 'none', 0, state, 'guest');
        }
      }
      return;
    }

    if (top.score >= config.voiceprintScoreForce) {
      console.log(`[vp] Force match: spk=${speakerId}, name=${top.name}, score=${top.score}`);
      this.confirmMatch(speakerId, state, top.name, top.score, 'high', 'force');
      if (startTimeMs !== undefined && endTimeMs !== undefined) {
        this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName || 'none', top.name, top.score, state, 'match_high');
      }
    } else if (top.score >= config.voiceprintScoreLowConf) {
      console.log(`[vp] Low-conf match: spk=${speakerId}, name=${top.name}, score=${top.score}`);
      this.confirmMatch(speakerId, state, top.name, top.score, 'low', 'force_lowconf');
      if (startTimeMs !== undefined && endTimeMs !== undefined) {
        this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName || 'none', top.name, top.score, state, 'match_low');
      }
    } else if (isTimeout) {
      this.assignGuest(speakerId, state);
      if (startTimeMs !== undefined && endTimeMs !== undefined) {
        this.logVerdict(speakerId, startTimeMs, endTimeMs, boundName || 'none', top.name, top.score, state, 'guest');
      }
    }
  }

  private logVerdict(speakerId: number, startMs: number, endMs: number, bound: string, top1: string, top1Score: number, state: SpeakerState, verdict: string): void {
    console.log(`[vp] utt: spk=${speakerId} time=[${startMs},${endMs}] bound=${bound} top1=${top1}:${top1Score} drift=${state.driftCounter}/${config.voiceprintDriftThreshold} verdict=${verdict}`);
  }

  private resetSpeakerState(state: SpeakerState): void {
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }
    state.status = 'unknown';
    state.username = undefined;
    state.score = undefined;
    state.avgEmbedding = undefined;
    state.candidateName = undefined;
    state.candidateScore = undefined;
    state.consecutiveHits = 0;
    state.totalVoicedMs = 0;
    state.driftCounter = 0;
    state.lastVerifiedName = undefined;
    state.lastVerifiedScore = undefined;
    state.lastVerifiedAt = undefined;
  }

  private releaseColorIfUnused(name: string, currentSpeakerId: number): void {
    let inUse = false;
    this.speakers.forEach((s, spkId) => {
      if (spkId !== currentSpeakerId && s.username === name) {
        inUse = true;
      }
    });
    if (!inUse) {
      this.nameColorMap.delete(name);
    }
  }

  private findTopMatch(embedding: Float32Array): { name: string; score: number; secondScore: number } | null {
    let best: { name: string; score: number } | null = null;
    let secondBest = 0;
    RealtimeSpeakerMatcher.globalSpeakerDB.forEach((storedEmb, name) => {
      const sim = this.cosineSimilarity(embedding, storedEmb);
      const score = Math.round((sim + 1) * 50);
      if (!best || score > best.score) {
        secondBest = best ? best.score : 0;
        best = { name, score };
      } else if (score > secondBest) {
        secondBest = score;
      }
    });
    if (!best) return null;
    const bestResult = best as { name: string; score: number };
    return { name: bestResult.name, score: bestResult.score, secondScore: secondBest };
  }

  private assignGuest(speakerId: number, state: SpeakerState): void {
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }
    this.guestSeq++;
    const guestName = `参会人${this.guestSeq}`;
    state.status = 'guest';
    state.username = guestName;
    state.matching = false;
    state.color = this.getOrAssignColor(guestName);
    console.log(`[vp] speaker_guest: spk=${speakerId}, guestName=${guestName}`);
    this.emit('speaker_guest', speakerId, guestName, state.color);
  }

  private confirmMatch(speakerId: number, state: SpeakerState, name: string, score: number, confidence: 'high' | 'low', method: string): void {
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }

    state.status = confidence === 'high' ? 'matched_high' : 'matched_low';
    state.username = name;
    state.score = score;
    state.matching = false;
    state.avgEmbedding = undefined;
    state.driftCounter = 0;
    state.lastVerifiedName = name;
    state.lastVerifiedScore = score;
    state.lastVerifiedAt = Date.now();
    state.color = this.getOrAssignColor(name);
    this.boundNames.add(name);
    console.log(`[vp] speaker_matched: spk=${speakerId}, name=${name}, score=${score}, conf=${confidence}, method=${method}`);
    this.emit('speaker_matched', speakerId, name, score, confidence, method, state.color);
  }

  private getOrAssignColor(name: string): string {
    if (this.nameColorMap.has(name)) {
      return this.nameColorMap.get(name)!;
    }
    const color = SPEAKER_COLORS[this.nextColorIdx % SPEAKER_COLORS.length];
    this.nameColorMap.set(name, color);
    this.nextColorIdx++;
    return color;
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  cosineSearch(emb: Float32Array, exclude: Set<string>): Array<{ name: string; score: number }> {
    const results: Array<{ name: string; score: number }> = [];
    RealtimeSpeakerMatcher.globalSpeakerDB.forEach((storedEmb, name) => {
      if (exclude.has(name)) return;
      const sim = this.cosineSimilarity(emb, storedEmb);
      const score = Math.round((sim + 1) * 50);
      results.push({ name, score });
    });
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  mergeEmbedding(prev: Float32Array, newEmb: Float32Array, prevMs: number, newMs: number): Float32Array {
    const totalMs = prevMs + newMs;
    const prevWeight = prevMs / totalMs;
    const newWeight = newMs / totalMs;

    const merged = new Float32Array(prev.length);
    for (let i = 0; i < prev.length; i++) {
      merged[i] = prev[i] * prevWeight + newEmb[i] * newWeight;
    }

    return this.normalizeEmbedding(merged);
  }

  private normalizeEmbedding(emb: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < emb.length; i++) {
      norm += emb[i] * emb[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return emb;
    const normalized = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) {
      normalized[i] = emb[i] / norm;
    }
    return normalized;
  }

  private extractAudioFromRingBuffer(startTimeMs: number, endTimeMs: number): Buffer {
    const sessionStart = this.audioStartTime;
    const relStart = startTimeMs;
    const relEnd = endTimeMs;

    const chunks: Buffer[] = [];
    for (const chunk of this.ringBuffer) {
      const chunkRelStart = chunk.timestamp - sessionStart;
      const chunkRelEnd = chunkRelStart + (chunk.pcm.length / this.bytesPerMs);

      if (chunkRelEnd < relStart || chunkRelStart > relEnd) continue;

      const overlapStart = Math.max(relStart, chunkRelStart);
      const overlapEnd = Math.min(relEnd, chunkRelEnd);

      const byteStart = Math.floor((overlapStart - chunkRelStart) * this.bytesPerMs);
      const byteEnd = Math.floor((overlapEnd - chunkRelStart) * this.bytesPerMs);

      if (byteEnd > byteStart && byteStart < chunk.pcm.length) {
        chunks.push(chunk.pcm.slice(byteStart, Math.min(byteEnd, chunk.pcm.length)));
      }
    }

    return Buffer.concat(chunks);
  }
}
