import { config } from './config';
import { pcmToWav } from './pcm-to-wav';

export interface VoiceprintEnrollResult {
  VoicePrintId: string;
  SpeakerNick: string;
}

export interface VoiceprintVerifyResult {
  Score: number;
  SpeakerId: string;
  VoicePrintId: string;
}

let tencentClient: any = null;

function getTencentClient(): any {
  if (!tencentClient) {
    const tencentcloud = require('tencentcloud-sdk-nodejs');
    const AsrClient = tencentcloud.asr.v20190614.Client;
    tencentClient = new AsrClient({
      credential: {
        secretId: config.tencentSecretId,
        secretKey: config.tencentSecretKey,
      },
      region: config.tencentRegion,
      profile: {
        httpProfile: {
          endpoint: 'asr.tencentcloudapi.com',
          timeout: 10,
        },
      },
    });
  }
  return tencentClient;
}

async function httpPostJson(url: string, body: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(text);
        errMsg = errJson.detail || errJson.message || errMsg;
      } catch {}
      throw new Error(errMsg);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function httpDelete(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'DELETE', signal: controller.signal });
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrollVoicePrint(
  pcmBuffer: Buffer,
  speakerNick: string,
  groupId?: string
): Promise<VoiceprintEnrollResult> {
  if (config.voiceprintBackend === 'selfhosted') {
    const wavBuffer = pcmToWav(pcmBuffer);
    const audioBase64 = wavBuffer.toString('base64');
    const url = config.voiceprintServiceUrl.replace(/\/$/, '') + '/api/v1/enroll';
    const result = await httpPostJson(url, {
      username: speakerNick,
      audio_base64: audioBase64,
      audio_format: 'wav',
    });
    return {
      VoicePrintId: speakerNick,
      SpeakerNick: speakerNick,
    };
  } else {
    const wavBuffer = pcmToWav(pcmBuffer);
    const base64Data = wavBuffer.toString('base64');
    const params: any = {
      VoiceFormat: 1,
      SampleRate: 16000,
      Data: base64Data,
      SpeakerNick: speakerNick,
    };
    if (groupId) {
      params.GroupId = groupId;
    }
    const response = await getTencentClient().VoicePrintEnroll(params);
    if (!response.Data) {
      throw new Error('VoicePrintEnroll returned empty data');
    }
    return {
      VoicePrintId: response.Data.VoicePrintId || '',
      SpeakerNick: response.Data.SpeakerNick || speakerNick,
    };
  }
}

export async function verifyGroupVoicePrint(
  pcmBuffer: Buffer,
  topN: number = 3,
  groupId?: string
): Promise<VoiceprintVerifyResult[]> {
  if (config.voiceprintBackend === 'selfhosted') {
    const wavBuffer = pcmToWav(pcmBuffer);
    const audioBase64 = wavBuffer.toString('base64');
    const url = config.voiceprintServiceUrl.replace(/\/$/, '') + '/api/v1/verify';
    const result = await httpPostJson(url, {
      audio_base64: audioBase64,
      audio_format: 'wav',
      top_n: topN,
    });
    if (!result.success || !Array.isArray(result.results)) {
      return [];
    }
    return result.results
      .filter((r: any) => r.score >= 0)
      .map((r: any) => ({
        Score: Math.round(r.score),
        SpeakerId: r.username,
        VoicePrintId: r.username,
      }));
  } else {
    const wavBuffer = pcmToWav(pcmBuffer);
    const base64Data = wavBuffer.toString('base64');
    const params: any = {
      VoiceFormat: 1,
      SampleRate: 16000,
      Data: base64Data,
      GroupId: groupId || config.voiceprintGroupId,
      TopN: topN,
    };
    const response = await getTencentClient().VoicePrintGroupVerify(params);
    if (!response.Data || !response.Data.VerifyTops) {
      return [];
    }
    return response.Data.VerifyTops.map((item: any) => ({
      Score: parseFloat(item.Score) || 0,
      SpeakerId: item.SpeakerId || '',
      VoicePrintId: item.VoicePrintId || '',
    }));
  }
}

export async function deleteVoicePrint(voicePrintId: string): Promise<void> {
  if (config.voiceprintBackend === 'selfhosted') {
    const url = config.voiceprintServiceUrl.replace(/\/$/, '') + '/api/v1/speakers/' + encodeURIComponent(voicePrintId);
    await httpDelete(url);
  } else {
    await getTencentClient().VoicePrintDelete({
      VoicePrintId: voicePrintId,
    });
  }
}

export async function checkVoiceprintServiceHealth(): Promise<{ ok: boolean; model_type?: string; device?: string; count?: number; error?: string }> {
  try {
    const url = config.voiceprintServiceUrl.replace(/\/$/, '') + '/healthz';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    return {
      ok: res.ok && data.status === 'ready',
      model_type: data.model_type,
      device: data.device,
      count: data.registered_count,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
