/**
 * 火山引擎录音文件识别（AUC）API 客户端
 * 参考文档: https://docs.volcengine.com/docs/6561/2606791
 */

import https from 'https';
import { randomUUID } from 'crypto';
import { config } from './config';

export interface AucSubmitAudio {
  url: string;
  format: string;
  codec?: string;
  rate?: number;
  bits?: number;
  channel?: number;
  language?: string;
}

export interface AucSubmitRequest {
  model_name: 'bigmodel';
  enable_itn?: boolean;
  enable_punc?: boolean;
  enable_ddc?: boolean;
  enable_speaker_info?: boolean;
  ssd_version?: string;
  ssd_mode?: number;
  show_utterances?: boolean;
  end_window_size?: number;
  voiceprints?: Array<{ id: string }>;
  language?: string;
  /** corpus是object类型（kiteX thrift要求STRUCT），内部context/correct_words为JSON字符串 */
  corpus?: {
    context?: string;
    correct_words?: string;
    [key: string]: any;
  };
}

export interface AucUtterance {
  text: string;
  start_time: number;
  end_time: number;
  /** 顶层说话人ID（部分API版本在此返回声纹ID或聚类ID） */
  speaker?: string;
  speaker_id?: string;
  definite?: boolean;
  additions?: {
    speaker?: string;
    speaker_id?: string;
    channel_id?: string;
    [key: string]: string | undefined;
  };
  words?: Array<{
    text: string;
    start_time: number;
    end_time: number;
  }>;
}

export interface AucResult {
  text: string;
  utterances?: AucUtterance[];
  additions?: Record<string, string>;
}

export interface AucQueryResponse {
  statusCode?: string;
  message?: string;
  logId?: string;
  audioInfo?: {
    duration: number;
  };
  result?: AucResult;
  /** 原始解析后的 JSON body，用于调试 */
  rawBody?: any;
}

export interface AucSubmitResult {
  taskId: string;
}

function buildAucAuthHeaders(resourceId: string, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  };
  if (config.appKey && config.accessKey && config.accessKey !== config.apiKey) {
    headers['X-Api-App-Id'] = config.appKey;
    headers['X-Api-Access-Key'] = config.accessKey;
  } else if (config.apiKey) {
    headers['X-Api-Key'] = config.apiKey;
  }
  return headers;
}

function httpsRequest(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  redirectCount = 0,
): Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const location = res.headers.location;
          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location);
          } catch {
            redirectUrl = new URL(location, url.origin);
          }
          res.resume();
          const redirectHeaders = { ...headers, Host: redirectUrl.host };
          httpsRequest(redirectUrl.toString(), method, redirectHeaders, body, redirectCount + 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: responseBody,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

export async function submitTask(
  audioUrl: string,
  params: AucSubmitRequest,
  modelVersion: '1.0' | '2.0' = '2.0',
  audioFormat?: { format: string; rate?: number; bits?: number; channel?: number },
): Promise<AucSubmitResult> {
  const requestId = randomUUID();
  const resourceId = modelVersion === '1.0' ? config.aucResourceId1 : config.aucResourceId2;
  const headers = buildAucAuthHeaders(resourceId, requestId);

  const audioConfig = {
    url: audioUrl,
    format: 'wav',
    channel: 1,
    rate: 16000,
    bits: 16,
    ...audioFormat,
  };

  const requestBody = JSON.stringify({
    user: { uid: 'web-demo-user' },
    audio: audioConfig,
    request: params,
  });
  headers['Content-Length'] = Buffer.byteLength(requestBody).toString();

  const res = await httpsRequest(config.aucSubmitUrl, 'POST', headers, requestBody);

  let parsedBody: any = {};
  try {
    parsedBody = res.body ? JSON.parse(res.body) : {};
  } catch {
    throw new Error(`Submit failed: invalid JSON response (HTTP ${res.statusCode})`);
  }

  const statusCode = res.headers['x-api-status-code'] as string | undefined;
  const message = res.headers['x-api-message'] as string | undefined;

  if (statusCode && statusCode !== '20000000') {
    throw new Error(`Submit failed (${statusCode}): ${message || 'Unknown error'}`);
  }
  if (res.statusCode && res.statusCode >= 400) {
    throw new Error(`Submit HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
  }

  const taskId = parsedBody.task_id || parsedBody.id || requestId;
  return { taskId };
}

export async function queryTask(
  taskId: string,
  modelVersion: '1.0' | '2.0' = '2.0',
): Promise<AucQueryResponse> {
  const resourceId = modelVersion === '1.0' ? config.aucResourceId1 : config.aucResourceId2;
  const headers = buildAucAuthHeaders(resourceId, taskId);

  const requestBody = '{}';
  headers['Content-Length'] = Buffer.byteLength(requestBody).toString();

  const res = await httpsRequest(config.aucQueryUrl, 'POST', headers, requestBody);

  // 从 HTTP headers 中获取状态
  const headerStatusCode = res.headers['x-api-status-code'] as string | undefined;
  const headerMessage = res.headers['x-api-message'] as string | undefined;
  const headerLogId = res.headers['x-tt-logid'] as string | undefined;

  let parsedBody: any = null;
  if (res.body && res.body.trim() !== '') {
    try {
      parsedBody = JSON.parse(res.body);
    } catch {
      parsedBody = null;
    }
  }

  // 从 body 中提取状态码（两种格式兼容）：
  // 1) 扁平格式: { "X-Api-Status-Code": "20000000", "X-Api-Message": "OK", "result": {...} }
  // 2) 嵌套格式: { "headers": { "X-Api-Status-Code": "...", ... }, "body": { "result": {...} } }
  let bodyStatusCode: string | undefined;
  let bodyMessage: string | undefined;
  let bodyLogId: string | undefined;
  let resultData: any = undefined;
  let audioInfoData: any = undefined;

  if (parsedBody) {
    // 嵌套格式检测
    if (parsedBody.headers && typeof parsedBody.headers === 'object') {
      bodyStatusCode = parsedBody.headers['X-Api-Status-Code'] || parsedBody.headers['x-api-status-code'];
      bodyMessage = parsedBody.headers['X-Api-Message'] || parsedBody.headers['x-api-message'];
      bodyLogId = parsedBody.headers['X-Tt-Logid'] || parsedBody.headers['x-tt-logid'];
      const innerBody = parsedBody.body || parsedBody.data;
      if (innerBody) {
        resultData = innerBody.result;
        audioInfoData = innerBody.audio_info;
      }
    } else {
      // 扁平格式
      bodyStatusCode = parsedBody['X-Api-Status-Code'] || parsedBody['x-api-status-code'];
      bodyMessage = parsedBody['X-Api-Message'] || parsedBody['x-api-message'];
      bodyLogId = parsedBody['X-Tt-Logid'] || parsedBody['x-tt-logid'];
      resultData = parsedBody.result;
      audioInfoData = parsedBody.audio_info;
    }
  }

  // HTTP headers 优先，body 中字段作为补充
  return {
    statusCode: headerStatusCode || bodyStatusCode,
    message: headerMessage || bodyMessage,
    logId: headerLogId || bodyLogId,
    audioInfo: audioInfoData,
    result: resultData,
    rawBody: parsedBody,
  };
}
