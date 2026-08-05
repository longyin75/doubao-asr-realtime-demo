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
  maxPcmBytes: number;
}

const DEFAULT_RECORDINGS_DIR = 'recordings';
const DEFAULT_MAX_PCM_BYTES = 60 * 1024 * 1024;

export const config: Config = {
  port: parseInt(process.env.CLOUD_PORT || process.env.PORT || '3001', 10),
  asrWsUrl: process.env.ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  apiKey: process.env.DOUBAO_API_KEY || process.env.DOUBAO_ACCESS_KEY || '',
  appKey: process.env.DOUBAO_APP_KEY || '',
  accessKey: process.env.DOUBAO_ACCESS_KEY || process.env.DOUBAO_API_KEY || '',
  resourceId: process.env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  asrBoostingTableId: process.env.ASR_BOOSTING_TABLE_ID || '',
  voiceprintEnabled: false,
  recordingsDir: process.env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR,
  maxPcmBytes: parseInt(process.env.MAX_PCM_BYTES || String(DEFAULT_MAX_PCM_BYTES), 10),
};
