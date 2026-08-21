/**
 * 字节 openspeech 声纹服务客户端
 * 基于飞书文档: https://bytedance.larkoffice.com/wiki/BYtNw4QYJiArNdkfso3cpMUqnCf
 */

import https from 'https';
import { config } from './config';

const BASE_URL = 'https://openspeech.bytedance.com/api/proxy/invoke';

export interface BytedanceVoiceprint {
  SpeakId: string;
  SpeakerName: string;
  AudioUrl?: string;
  Embedding?: number[];
  Status: number;
}

export interface ApiResponse<T = any> {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
    Error?: {
      Code: string;
      Message: string;
    };
  };
  Result?: T;
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // 优先使用 App ID + Access Key，否则使用 API Key
  if (config.appKey && config.accessKey && config.accessKey !== config.apiKey) {
    headers['X-Api-App-Id'] = config.appKey;
    headers['X-Api-Access-Key'] = config.accessKey;
  } else if (config.apiKey) {
    headers['X-Api-Key'] = config.apiKey;
  }
  return headers;
}

async function request<T = any>(action: string, body: any): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL);
    url.searchParams.set('Action', action);

    const postData = JSON.stringify(body);
    const headers = buildAuthHeaders();
    headers['Content-Length'] = Buffer.byteLength(postData).toString();

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody) as ApiResponse<T>;
          if (json.ResponseMetadata?.Error) {
            reject(new Error(`${json.ResponseMetadata.Error.Code}: ${json.ResponseMetadata.Error.Message}`));
          } else if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody.substring(0, 200)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${responseBody.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// ========== 声纹管理 API ==========

export enum UpdateAction {
  CREATE = 0,
  UPDATE = 1,
  DELETE = 2,
}

export interface CreateVoiceprintOptions {
  speakerName: string;
  audioUrl: string;
}

export interface UpdateVoiceprintOptions {
  speakId: string;
  speakerName?: string;
  audioUrl?: string;
}

export interface ListVoiceprintOptions {
  limit?: number;
  offset?: number;
}

export interface ListVoiceprintResult {
  Code: number;
  TotalCount: number;
  AudioEmbedding: BytedanceVoiceprint[];
}

export interface GetVoiceprintResult {
  Code: number;
  AudioEmbedding: BytedanceVoiceprint[];
}

export interface UpdateVoiceprintResult {
  Code: number;
  SpeakId: string;
}

/**
 * 创建声纹（注册新说话人）
 * 飞书文档: POST /api/proxy/invoke?Action=UpdateVoiceprint, body.Action=0
 */
export async function createVoiceprint(opts: CreateVoiceprintOptions): Promise<string> {
  const res = await request<UpdateVoiceprintResult>('UpdateVoiceprint', {
    Action: UpdateAction.CREATE,
    SpeakerName: opts.speakerName,
    AudioUrl: opts.audioUrl,
  });
  return res.Result?.SpeakId || '';
}

/**
 * 更新声纹（更新名称或重新注册音频）
 */
export async function updateVoiceprint(opts: UpdateVoiceprintOptions): Promise<void> {
  const body: any = {
    Action: UpdateAction.UPDATE,
    SpeakId: opts.speakId,
  };
  if (opts.speakerName) body.SpeakerName = opts.speakerName;
  if (opts.audioUrl) body.AudioUrl = opts.audioUrl;
  await request<UpdateVoiceprintResult>('UpdateVoiceprint', body);
}

/**
 * 删除声纹
 */
export async function deleteVoiceprint(speakId: string): Promise<void> {
  await request<UpdateVoiceprintResult>('UpdateVoiceprint', {
    Action: UpdateAction.DELETE,
    SpeakId: speakId,
  });
}

/**
 * 分页列出所有声纹
 */
export async function listVoiceprints(opts: ListVoiceprintOptions = {}): Promise<{ total: number; items: BytedanceVoiceprint[] }> {
  const res = await request<ListVoiceprintResult>('ListVoiceprint', {
    Limit: opts.limit || 50,
    Offset: opts.offset || 0,
  });
  return {
    total: res.Result?.TotalCount || 0,
    items: res.Result?.AudioEmbedding || [],
  };
}

/**
 * 批量获取声纹信息
 */
export async function getVoiceprints(speakIds: string[]): Promise<BytedanceVoiceprint[]> {
  const res = await request<GetVoiceprintResult>('GetVoiceprint', {
    SpeakIdList: speakIds,
  });
  return res.Result?.AudioEmbedding || [];
}

/**
 * 先列出所有声纹（简单测试）
 */
export async function testConnection(): Promise<{ ok: boolean; count?: number; error?: string; requestId?: string }> {
  try {
    const { total, items } = await listVoiceprints({ limit: 1, offset: 0 });
    return { ok: true, count: total };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
