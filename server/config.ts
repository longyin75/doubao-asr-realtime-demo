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
  arkApiKey: string;
  arkModel: string;
  arkBaseUrl: string;
  asrBoostingTableId: string;
  voiceprintEnabled: boolean;
  voiceprintServiceUrl: string;
  voiceprintBackend: 'selfhosted' | 'tencent';
  tencentSecretId: string;
  tencentSecretKey: string;
  tencentRegion: string;
  voiceprintGroupId: string;
  voiceprintScoreThreshold: number;
  voiceprintMinAudioMs: number;
  voiceprintMaxAudioMs: number;
}

const vpServiceUrl = process.env.VOICEPRINT_SERVICE_URL || '';
const hasTencentConfig = !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
const voiceprintBackend: 'selfhosted' | 'tencent' = vpServiceUrl
  ? 'selfhosted'
  : hasTencentConfig
  ? 'tencent'
  : 'selfhosted';

export const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  asrWsUrl: process.env.ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  apiKey: process.env.DOUBAO_API_KEY || process.env.DOUBAO_ACCESS_KEY || '',
  appKey: process.env.DOUBAO_APP_KEY || '',
  accessKey: process.env.DOUBAO_ACCESS_KEY || process.env.DOUBAO_API_KEY || '',
  resourceId: process.env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  arkApiKey: process.env.ARK_API_KEY || process.env.DOUBAO_ARK_API_KEY || '',
  arkModel: process.env.ARK_MODEL || process.env.ARK_ENDPOINT_ID || 'doubao-pro-32k',
  arkBaseUrl: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
  asrBoostingTableId: process.env.ASR_BOOSTING_TABLE_ID || '',
  voiceprintEnabled: !!(vpServiceUrl || hasTencentConfig),
  voiceprintBackend,
  voiceprintServiceUrl: vpServiceUrl || 'http://127.0.0.1:8001',
  tencentSecretId: process.env.TENCENT_SECRET_ID || '',
  tencentSecretKey: process.env.TENCENT_SECRET_KEY || '',
  tencentRegion: process.env.TENCENT_REGION || 'ap-beijing',
  voiceprintGroupId: process.env.TENCENT_VOICEPRINT_GROUP_ID || 'meeting_asr',
  voiceprintScoreThreshold: parseInt(process.env.VOICEPRINT_SCORE_THRESHOLD || '70', 10),
  voiceprintMinAudioMs: parseInt(process.env.VOICEPRINT_MIN_AUDIO_MS || '2000', 10),
  voiceprintMaxAudioMs: parseInt(process.env.VOICEPRINT_MAX_AUDIO_MS || '5000', 10),
};
