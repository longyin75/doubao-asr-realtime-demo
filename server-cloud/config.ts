import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

function findEnvFile(): string {
  const candidates = [
    path.resolve(__dirname, 'inventory.local.env'),
    path.resolve(__dirname, '../inventory.local.env'),
    path.resolve(__dirname, '../../inventory.local.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

const envPath = findEnvFile();
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

export interface Config {
  port: number;
  asrWsUrl: string;
  apiKey: string;
  appKey: string;
  accessKey: string;
  resourceId: string;
  asrBoostingTableId: string;
  voiceprintEnabled: boolean;
  recordingsDir: string;
  uploadsDir: string;
  transcriptsDir: string;
  voiceprintsDir: string;
  voiceprintBaseUrl: string;
  aucSubmitUrl: string;
  aucQueryUrl: string;
  aucResourceId2: string;
  aucResourceId1: string;
  aucPollIntervalMs: number;
  aucMaxPollAttempts: number;
  maxPcmBytes: number;
  voiceprintEmbedUrl: string;
  voiceprintScoreEarlyStop: number;
  voiceprintScoreMargin: number;
  voiceprintScoreConfirm: number;
  voiceprintScoreForce: number;
  voiceprintScoreLowConf: number;
  voiceprintMinUttMs: number;
  voiceprintMaxWaitMs: number;
  voiceprintForceMatchMs: number;
  voiceprintHttpTimeoutMs: number;
  voiceprintRingBufferMs: number;
  voiceprintMaxEnroll: number;
  voiceprintMaxSessionSpeakers: number;
  voiceprintMinEnrollSec: number;
  voiceprintDriftCorrectionEnabled: boolean;
  voiceprintDriftThreshold: number;
  voiceprintDriftMinScore: number;
  voiceprintVerifyMinScore: number;
  voiceprintGuestUpgradeHits: number;
}

const DEFAULT_RECORDINGS_DIR = 'recordings';
const DEFAULT_UPLOADS_DIR = 'uploads';
const DEFAULT_TRANSCRIPTS_DIR = 'transcripts';
const DEFAULT_VOICEPRINTS_DIR = 'voiceprints';
const DEFAULT_VOICEPRINT_BASE_URL = 'https://openspeech.bytedance.com/api/proxy/invoke';
const DEFAULT_AUC_SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
const DEFAULT_AUC_QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';
const DEFAULT_AUC_RESOURCE_ID_2 = 'volc.seedasr.auc';
const DEFAULT_AUC_RESOURCE_ID_1 = 'volc.bigasr.auc';
const DEFAULT_MAX_PCM_BYTES = 60 * 1024 * 1024;

export const config: Config = {
  port: parseInt(process.env.CLOUD_PORT || process.env.PORT || '3001', 10),
  asrWsUrl: process.env.ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  apiKey: process.env.DOUBAO_API_KEY || process.env.DOUBAO_ACCESS_KEY || '',
  appKey: process.env.DOUBAO_APP_KEY || '',
  accessKey: process.env.DOUBAO_ACCESS_KEY || process.env.DOUBAO_API_KEY || '',
  resourceId: process.env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  asrBoostingTableId: process.env.ASR_BOOSTING_TABLE_ID || '',
  voiceprintEnabled: (process.env.VOICEPRINT_ENABLED || 'false').toLowerCase() === 'true',
  recordingsDir: process.env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR,
  uploadsDir: process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR,
  transcriptsDir: process.env.TRANSCRIPTS_DIR || DEFAULT_TRANSCRIPTS_DIR,
  voiceprintsDir: process.env.VOICEPRINTS_DIR || DEFAULT_VOICEPRINTS_DIR,
  voiceprintBaseUrl: process.env.VOICEPRINT_BASE_URL || DEFAULT_VOICEPRINT_BASE_URL,
  aucSubmitUrl: process.env.AUC_SUBMIT_URL || DEFAULT_AUC_SUBMIT_URL,
  aucQueryUrl: process.env.AUC_QUERY_URL || DEFAULT_AUC_QUERY_URL,
  aucResourceId2: process.env.AUC_RESOURCE_ID_2 || DEFAULT_AUC_RESOURCE_ID_2,
  aucResourceId1: process.env.AUC_RESOURCE_ID_1 || DEFAULT_AUC_RESOURCE_ID_1,
  aucPollIntervalMs: parseInt(process.env.AUC_POLL_INTERVAL_MS || '3000', 10),
  aucMaxPollAttempts: parseInt(process.env.AUC_MAX_POLL_ATTEMPTS || '100', 10),
  maxPcmBytes: parseInt(process.env.MAX_PCM_BYTES || String(DEFAULT_MAX_PCM_BYTES), 10),
  voiceprintEmbedUrl: process.env.VOICEPRINT_EMBED_URL || 'http://192.168.1.146:8002/embed',
  voiceprintScoreEarlyStop: parseInt(process.env.VOICEPRINT_SCORE_EARLY_STOP || '85', 10),
  voiceprintScoreMargin: parseInt(process.env.VOICEPRINT_SCORE_MARGIN || '25', 10),
  voiceprintScoreConfirm: parseInt(process.env.VOICEPRINT_SCORE_CONFIRM || '80', 10),
  voiceprintScoreForce: parseInt(process.env.VOICEPRINT_SCORE_FORCE || '60', 10),
  voiceprintScoreLowConf: parseInt(process.env.VOICEPRINT_SCORE_LOW_CONF || '50', 10),
  voiceprintMinUttMs: parseInt(process.env.VOICEPRINT_MIN_UTT_MS || '800', 10),
  voiceprintMaxWaitMs: parseInt(process.env.VOICEPRINT_MAX_WAIT_MS || '5000', 10),
  voiceprintForceMatchMs: parseInt(process.env.VOICEPRINT_FORCE_MATCH_MS || '3000', 10),
  voiceprintHttpTimeoutMs: parseInt(process.env.VOICEPRINT_HTTP_TIMEOUT_MS || '2000', 10),
  voiceprintRingBufferMs: parseInt(process.env.VOICEPRINT_RING_BUFFER_MS || '30000', 10),
  voiceprintMaxEnroll: parseInt(process.env.VOICEPRINT_MAX_ENROLL || '100', 10),
  voiceprintMaxSessionSpeakers: parseInt(process.env.VOICEPRINT_MAX_SESSION_SPEAKERS || '6', 10),
  voiceprintMinEnrollSec: parseInt(process.env.VOICEPRINT_MIN_ENROLL_SEC || '15', 10),
  voiceprintDriftCorrectionEnabled: (process.env.VOICEPRINT_DRIFT_CORRECTION_ENABLED || 'true').toLowerCase() === 'true',
  voiceprintDriftThreshold: parseInt(process.env.VOICEPRINT_DRIFT_THRESHOLD || '3', 10),
  voiceprintDriftMinScore: parseInt(process.env.VOICEPRINT_DRIFT_MIN_SCORE || '75', 10),
  voiceprintVerifyMinScore: parseInt(process.env.VOICEPRINT_VERIFY_MIN_SCORE || '60', 10),
  voiceprintGuestUpgradeHits: parseInt(process.env.VOICEPRINT_GUEST_UPGRADE_HITS || '3', 10),
};
