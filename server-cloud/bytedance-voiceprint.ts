/**
 * 字节 openspeech 声纹服务客户端
 * 基于飞书文档: https://bytedance.larkoffice.com/wiki/BYtNw4QYJiArNdkfso3cpMUqnCf
 */

import https from 'https';
import { config } from './config';

const BASE_URL = config.voiceprintBaseUrl || 'https://openspeech.bytedance.com/api/proxy/invoke';

export interface BytedanceVoiceprint {
  SpeakID: string;
  SpeakerName: string;
  AudioURL?: string;
  Embedding?: number[];
  Status: number;
  GroupID?: string;
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
  if (config.appKey && config.accessKey && config.accessKey !== config.apiKey) {
    headers['X-Api-App-Id'] = config.appKey;
    headers['X-Api-Access-Key'] = config.accessKey;
  } else if (config.apiKey) {
    headers['X-Api-Key'] = config.apiKey;
  }
  return headers;
}

async function request<T = any>(action: string, body: any, redirectCount = 0): Promise<ApiResponse<T>> {
  if (redirectCount > 5) {
    throw new Error('Too many redirects');
  }
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
      // 跟随 3xx 重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location;
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location);
        } catch {
          redirectUrl = new URL(location, url.origin);
        }
        // 重定向时重新构造 BASE_URL 走一遍
        const origBase = BASE_URL;
        // 简化：使用临时的路径跟随
        res.resume(); // 消费响应体
        // 直接重新请求，将请求路径改为重定向目标路径
        const redirectPath = redirectUrl.pathname + redirectUrl.search;
        const redirectOpts = { ...options, hostname: redirectUrl.hostname || options.hostname, path: redirectPath };
        const newReq = https.request(redirectOpts, (res2) => {
          let responseBody = '';
          res2.on('data', (chunk) => { responseBody += chunk; });
          res2.on('end', () => {
            handleResponse(res2, responseBody, resolve, reject);
          });
        });
        newReq.on('error', reject);
        newReq.on('timeout', () => { newReq.destroy(); reject(new Error('Request timeout')); });
        newReq.write(postData);
        newReq.end();
        return;
      }

      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        handleResponse(res, responseBody, resolve, reject);
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

function handleResponse<T>(res: any, responseBody: string, resolve: (v: ApiResponse<T>) => void, reject: (e: Error) => void) {
  if (!responseBody || responseBody.trim() === '') {
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      reject(new Error(`Empty response with status ${res.statusCode}`));
    } else {
      reject(new Error(`HTTP ${res.statusCode || 'unknown'}: empty response`));
    }
    return;
  }
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
    reject(new Error(`Failed to parse response (${responseBody.length} bytes): ${responseBody.substring(0, 200)}`));
  }
}

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
  SpeakID: string;
}

export async function createVoiceprint(opts: CreateVoiceprintOptions): Promise<string> {
  const res = await request<UpdateVoiceprintResult>('UpdateVoiceprint', {
    Action: UpdateAction.CREATE,
    SpeakerName: opts.speakerName,
    AudioUrl: opts.audioUrl,
  });
  return res.Result?.SpeakID || '';
}

export async function updateVoiceprint(opts: UpdateVoiceprintOptions): Promise<void> {
  const body: any = {
    Action: UpdateAction.UPDATE,
    SpeakId: opts.speakId,
  };
  if (opts.speakerName) body.SpeakerName = opts.speakerName;
  if (opts.audioUrl) body.AudioUrl = opts.audioUrl;
  await request<UpdateVoiceprintResult>('UpdateVoiceprint', body);
}

export async function deleteVoiceprint(speakId: string): Promise<void> {
  await request<UpdateVoiceprintResult>('UpdateVoiceprint', {
    Action: UpdateAction.DELETE,
    SpeakId: speakId,
  });
}

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

export async function getVoiceprints(speakIds: string[]): Promise<BytedanceVoiceprint[]> {
  const res = await request<GetVoiceprintResult>('GetVoiceprint', {
    SpeakIdList: speakIds,
  });
  return res.Result?.AudioEmbedding || [];
}

export async function testConnection(): Promise<{ ok: boolean; count?: number; error?: string; requestId?: string }> {
  try {
    const { total, items } = await listVoiceprints({ limit: 1, offset: 0 });
    return { ok: true, count: total };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
