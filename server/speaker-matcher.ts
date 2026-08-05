import { config } from './config';
import { verifyGroupVoicePrint } from './tencent-voiceprint';
import { estimateVoiceActivity, pcmDurationMs } from './pcm-to-wav';
import { EventEmitter } from 'events';

export type SpeakerMatchStatus = 'unknown' | 'buffering' | 'matching' | 'matched' | 'unmatched' | 'manual_bound';

export interface SpeakerMatchInfo {
  status: SpeakerMatchStatus;
  username?: string;
  score?: number;
  color: string;
  auto: boolean;
}

interface SpeakerState {
  status: SpeakerMatchStatus;
  username?: string;
  score?: number;
  color: string;
  pcmBuffer: Buffer;
  voicedDurationMs: number;
  matching: boolean;
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

export class SpeakerMatcher extends EventEmitter {
  private speakers: Map<number, SpeakerState> = new Map();
  private ringBuffer: RingBufferChunk[] = [];
  private ringBufferMaxMs: number = 30000;
  private audioStartTime: number = 0;
  private bytesPerMs: number;

  constructor() {
    super();
    this.bytesPerMs = 16000 * 2 / 1000;
  }

  start(): void {
    this.audioStartTime = Date.now();
    this.speakers.clear();
    this.ringBuffer = [];
  }

  feedAudio(pcmData: Buffer): void {
    const now = Date.now();
    const chunk: RingBufferChunk = {
      timestamp: now,
      pcm: pcmData,
    };
    this.ringBuffer.push(chunk);

    const cutoff = now - this.ringBufferMaxMs;
    while (this.ringBuffer.length > 0 && this.ringBuffer[0].timestamp < cutoff) {
      this.ringBuffer.shift();
    }
  }

  getSpeakerInfo(speakerId: number): SpeakerMatchInfo {
    const state = this.speakers.get(speakerId);
    if (!state) {
      return {
        status: 'unknown',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
        auto: false,
      };
    }
    return {
      status: state.status,
      username: state.username,
      score: state.score,
      color: state.color,
      auto: state.status === 'matched',
    };
  }

  onUtterance(speakerId: number, text: string, startTimeMs: number, endTimeMs: number, definite: boolean): void {
    if (!config.voiceprintEnabled) return;

    let state = this.speakers.get(speakerId);
    if (!state) {
      state = {
        status: 'buffering',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
        pcmBuffer: Buffer.alloc(0),
        voicedDurationMs: 0,
        matching: false,
      };
      this.speakers.set(speakerId, state);
    }

    if (state.status === 'matched' || state.status === 'manual_bound' || state.matching) {
      return;
    }

    if (!definite) return;

    const utterancePcm = this.extractAudioFromRingBuffer(startTimeMs, endTimeMs);
    if (utterancePcm.length === 0) return;

    const { voiced, durationMs } = estimateVoiceActivity(utterancePcm);
    if (durationMs < 100) return;

    state.pcmBuffer = Buffer.concat([state.pcmBuffer, voiced]);
    state.voicedDurationMs += durationMs;

    if (state.status === 'unknown') {
      state.status = 'buffering';
      this.emit('speaker_matching', speakerId);
    }

    if (state.voicedDurationMs >= config.voiceprintMinAudioMs ||
        pcmDurationMs(state.pcmBuffer) >= config.voiceprintMaxAudioMs) {
      this.triggerMatch(speakerId, state);
    }
  }

  manualBind(speakerId: number, username: string): void {
    let state = this.speakers.get(speakerId);
    if (!state) {
      state = {
        status: 'manual_bound',
        color: SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length],
        pcmBuffer: Buffer.alloc(0),
        voicedDurationMs: 0,
        matching: false,
      };
      this.speakers.set(speakerId, state);
    }
    state.status = 'manual_bound';
    state.username = username;
    state.pcmBuffer = Buffer.alloc(0);
    this.emit('speaker_matched', speakerId, username, undefined, false);
  }

  private extractAudioFromRingBuffer(startTimeMs: number, endTimeMs: number): Buffer {
    const now = Date.now();
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

  private async triggerMatch(speakerId: number, state: SpeakerState): Promise<void> {
    if (state.matching) return;
    state.matching = true;
    state.status = 'matching';
    this.emit('speaker_matching', speakerId);

    try {
      let audioToVerify = state.pcmBuffer;
      const maxBytes = config.voiceprintMaxAudioMs * this.bytesPerMs;
      if (audioToVerify.length > maxBytes) {
        audioToVerify = audioToVerify.slice(audioToVerify.length - maxBytes);
      }

      const results = await verifyGroupVoicePrint(audioToVerify, 3);

      if (results.length > 0 && results[0].Score >= config.voiceprintScoreThreshold) {
        state.status = 'matched';
        state.username = results[0].SpeakerId;
        state.score = results[0].Score;
        state.pcmBuffer = Buffer.alloc(0);
        this.emit('speaker_matched', speakerId, results[0].SpeakerId, results[0].Score, true);
      } else {
        state.status = 'unmatched';
        state.pcmBuffer = Buffer.alloc(0);
        state.matching = false;
        this.emit('speaker_match_failed', speakerId, results.length > 0 ? results[0].Score : 0);
      }
    } catch (err) {
      console.error('[SpeakerMatcher] Match error:', err);
      state.status = 'unmatched';
      state.matching = false;
      this.emit('speaker_match_error', speakerId, err instanceof Error ? err.message : String(err));
    }
  }

  reset(): void {
    this.speakers.clear();
    this.ringBuffer = [];
    this.audioStartTime = 0;
  }
}
