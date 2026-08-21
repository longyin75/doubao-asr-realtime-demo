import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { buildFullClientRequest, buildAudioRequest, buildLastPacket, parseServerResponse } from './asr-protocol';
import { getPublicSchema, validateAndFillConfig, buildDoubaoConnection, SanitizedConfig, HotwordConfig, DEFAULT_HOTWORDS, DEFAULT_CORRECT_WORDS } from './asr-config';
import { pcmToWav } from './pcm-to-wav';
import { createVoiceprint, deleteVoiceprint, listVoiceprints, BytedanceVoiceprint } from './bytedance-voiceprint';
import { submitTask, queryTask, AucSubmitRequest, AucUtterance } from './auc-client';
import { RealtimeSpeakerMatcher } from './realtime-speaker-matcher';
import { gpuEmbedClient } from './gpu-embed-client';

function findRootDir(): string {
  const candidates = [
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
    path.join(process.cwd()),
  ];
  for (const rootDir of candidates) {
    if (fs.existsSync(rootDir)) {
      return rootDir;
    }
  }
  return process.cwd();
}

function findCloudPublicDir(): string {
  const candidates = [
    path.join(__dirname, 'public-cloud'),
    path.join(__dirname, '..', 'public-cloud'),
    path.join(__dirname, '..', '..', 'public-cloud'),
    path.join(process.cwd(), 'public-cloud'),
  ];
  for (const pubDir of candidates) {
    if (fs.existsSync(pubDir) && fs.existsSync(path.join(pubDir, 'index.html'))) {
      return pubDir;
    }
  }
  return path.join(ROOT_DIR, 'public');
}

const ROOT_DIR = findRootDir();
const CLOUD_PUBLIC_DIR = findCloudPublicDir();
const RECORDINGS_DIR = path.join(ROOT_DIR, config.recordingsDir);
const UPLOADS_DIR = path.join(ROOT_DIR, config.uploadsDir);
const TRANSCRIPTS_DIR = path.join(ROOT_DIR, config.transcriptsDir);
const VOICEPRINTS_DIR = path.join(ROOT_DIR, config.voiceprintsDir);

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`[cloud] Created recordings directory: ${RECORDINGS_DIR}`);
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log(`[cloud] Created uploads directory: ${UPLOADS_DIR}`);
}
if (!fs.existsSync(TRANSCRIPTS_DIR)) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  console.log(`[cloud] Created transcripts directory: ${TRANSCRIPTS_DIR}`);
}
if (!fs.existsSync(VOICEPRINTS_DIR)) {
  fs.mkdirSync(VOICEPRINTS_DIR, { recursive: true });
  console.log(`[cloud] Created voiceprints directory: ${VOICEPRINTS_DIR}`);
}
RealtimeSpeakerMatcher.initPersistentStorage(VOICEPRINTS_DIR);
try {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  let cleanedCount = 0;
  const files = fs.readdirSync(UPLOADS_DIR);
  for (const f of files) {
    const fp = path.join(UPLOADS_DIR, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && (now - st.mtimeMs) > ONE_HOUR) {
        fs.unlinkSync(fp);
        cleanedCount++;
      }
    } catch {}
  }
  if (cleanedCount > 0) {
    console.log(`[cloud] Cleaned up ${cleanedCount} stale upload file(s) at startup`);
  }
} catch (err: any) {
  console.log(`[cloud] Uploads cleanup warning: ${err.message}`);
}
try {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  let cleanedCount = 0;
  const files = fs.readdirSync(TRANSCRIPTS_DIR);
  for (const f of files) {
    const fp = path.join(TRANSCRIPTS_DIR, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && f.endsWith('.txt') && (now - st.mtimeMs) > ONE_DAY) {
        fs.unlinkSync(fp);
        cleanedCount++;
      }
    } catch {}
  }
  if (cleanedCount > 0) {
    console.log(`[cloud] Cleaned up ${cleanedCount} stale transcript file(s) at startup`);
  }
} catch (err: any) {
  console.log(`[cloud] Transcripts cleanup warning: ${err.message}`);
}

function sendJson(res: http.ServerResponse, status: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, filePath: string, contentType: string) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

interface AucConfig {
  modelVersion: '1.0' | '2.0';
  language: string;
  enable_itn: boolean;
  enable_punc: boolean;
  enable_ddc: boolean;
  enable_speaker_info: boolean;
  ssd_version: string;
  ssd_mode: number;
  show_utterances: boolean;
  end_window_size: number;
  use_voiceprints: boolean;
  selected_voiceprint_ids: string[];
}

const DEFAULT_AUC_CONFIG: AucConfig = {
  modelVersion: '2.0',
  language: '',
  enable_itn: true,
  enable_punc: true,
  enable_ddc: false,
  enable_speaker_info: true,
  ssd_version: '300',
  ssd_mode: 0,
  show_utterances: true,
  end_window_size: 800,
  use_voiceprints: true,
  selected_voiceprint_ids: [],
};

let aucConfig: AucConfig = { ...DEFAULT_AUC_CONFIG };

type AucTaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

interface AucTask {
  taskId: string;
  status: AucTaskStatus;
  recordingUrl: string;
  transcriptUrl?: string;
  text?: string;
  utterances?: AucUtterance[];
  duration?: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
  speakerNameMap?: Record<string, string>;
}

const aucTasks = new Map<string, AucTask>();
const MAX_AUC_TASKS = 50;

function inferPublicBaseUrl(req: http.IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers['x-forwarded-host'] as string || req.headers.host || '';
  let basePath = '/';
  const referer = req.headers.referer || '';
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const pn = refUrl.pathname;
      const idx = pn.indexOf('/asr-demo-multi');
      if (idx >= 0) {
        basePath = pn.substring(0, idx + '/asr-demo-multi'.length) + '/';
      }
    } catch {}
  }
  return `${proto}://${host}${basePath}`;
}

function buildTranscriptText(task: AucTask): string {
  const nameMap = task.speakerNameMap || {};
  if (!task.utterances || task.utterances.length === 0) {
    return task.text || '';
  }
  const lines: string[] = [];
  // 用于给未匹配声纹的聚类说话人分配递增编号（按出现顺序）
  const unknownSpeakerIds = new Map<string, number>();
  let unknownCounter = 0;

  for (const utt of task.utterances) {
    const additions = utt.additions || {};
    // 尝试多个可能的说话人标识字段（顶层优先，与实时ASR协议一致）
    let spkId: string | undefined =
      utt.speaker_id ||
      utt.speaker ||
      additions.speaker_id ||
      additions.speaker ||
      additions.channel_id;
    if (!spkId) spkId = '0';

    let spkName: string;
    const isNumericClusterId = /^\d+$/.test(spkId);
    if (!isNumericClusterId && spkId && spkId !== '0') {
      // 非数字ID = 声纹匹配成功，API 直接返回了人名，直接使用
      spkName = spkId;
    } else if (nameMap[spkId]) {
      // 数字聚类ID且在nameMap中（极少见，防御性处理）
      spkName = nameMap[spkId];
    } else {
      // 数字聚类ID且未匹配声纹，分配说话人编号
      if (!unknownSpeakerIds.has(spkId)) {
        unknownSpeakerIds.set(spkId, ++unknownCounter);
      }
      const num = unknownSpeakerIds.get(spkId)!;
      spkName = `说话人${num}`;
    }
    lines.push(`${spkName}：${utt.text}`);
  }
  return lines.join('\n');
}

function isInProgressMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  // 中文进行中关键词
  const zhKeywords = ['处理中', '排队', '不存在', '等待'];
  // 英文进行中关键词
  const enKeywords = ['processing', 'in progress', 'start processing', 'queued', 'queue', 'pending', 'handle response', 'waiting'];
  return zhKeywords.some(k => msg.includes(k)) || enKeywords.some(k => lower.includes(k));
}

function startAucPolling(taskId: string, modelVersion: '1.0' | '2.0') {
  let attempts = 0;
  const maxAttempts = config.aucMaxPollAttempts;
  const interval = config.aucPollIntervalMs;

  const poll = async () => {
    attempts++;
    const task = aucTasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') {
      return;
    }
    try {
      const resp = await queryTask(taskId, modelVersion);
      const statusCode = resp.statusCode;
      const msg = resp.message || '';

      // 调试：第一次轮询打印完整响应结构
      if (attempts <= 2) {
        console.log(`[auc] Task ${taskId} poll#${attempts}: statusCode=${statusCode}, msg="${msg.substring(0, 100)}", hasResult=${!!resp.result}, resultKeys=${resp.result ? Object.keys(resp.result).join(',') : 'none'}, audioInfo=${JSON.stringify(resp.audioInfo)}`);
        if (resp.rawBody) {
          const bodyStr = JSON.stringify(resp.rawBody);
          console.log(`[auc] Task ${taskId} rawBody (first 500 chars): ${bodyStr.substring(0, 500)}`);
        }
      }

      // 有识别结果 = 成功（必须同时满足：result存在 且 (text非空 或 utterances非空)）
      const result = resp.result;
      const hasContent = result && (
        (typeof result.text === 'string' && result.text.length > 0) ||
        (Array.isArray(result.utterances) && result.utterances.length > 0)
      );
      if (hasContent && result) {
        task.status = 'completed';
        task.text = result.text;
        task.utterances = result.utterances;
        task.duration = resp.audioInfo?.duration;
        task.completedAt = Date.now();

        // 调试：打印 utterances 中说话人相关字段
        if (task.utterances && task.utterances.length > 0) {
          const sample = task.utterances.slice(0, 3).map(u => ({
            text: u.text?.substring(0, 30),
            speaker: u.speaker,
            speaker_id: u.speaker_id,
            additions: u.additions,
          }));
          console.log(`[auc] Task ${taskId} utterance sample (${task.utterances.length} utts):`, JSON.stringify(sample, null, 2));
        }

        const shortUuid = crypto.randomUUID().substring(0, 8);
        const ts = Date.now();
        const filename = `auc_${shortUuid}_${ts}.txt`;
        const filePath = path.join(TRANSCRIPTS_DIR, filename);
        const text = buildTranscriptText(task);
        fs.writeFileSync(filePath, text, 'utf-8');
        task.transcriptUrl = '/transcripts/' + filename;
        console.log(`[auc] Task ${taskId} completed, transcript saved: ${filename}`);
        return;
      }

      // 状态码 20000000 = 成功（如果已经有 result 上面已经处理了，这里是成功但无结果的异常情况，继续轮询）
      if (statusCode === '20000000' && !result) {
        console.log(`[auc] Task ${taskId} status OK but no result yet, retrying (attempt ${attempts})`);
        if (attempts >= maxAttempts) {
          task.status = 'failed';
          task.error = '识别超时（超过5分钟）';
          task.completedAt = Date.now();
          console.log(`[auc] Task ${taskId} timed out after ${maxAttempts} attempts`);
          return;
        }
        task.status = 'processing';
        setTimeout(poll, interval);
        return;
      }

      // result存在但无内容（空对象等异常情况），继续轮询
      if (result && !hasContent) {
        console.log(`[auc] Task ${taskId} result exists but no text/utterances yet, retrying (attempt ${attempts})`);
        if (attempts >= maxAttempts) {
          task.status = 'failed';
          task.error = '识别超时（超过5分钟）';
          task.completedAt = Date.now();
          console.log(`[auc] Task ${taskId} timed out after ${maxAttempts} attempts`);
          return;
        }
        task.status = 'processing';
        setTimeout(poll, interval);
        return;
      }

      // 判断是否是进行中状态
      const inProgress = isInProgressMessage(msg) ||
        (!statusCode && !msg) /* 无状态码无消息 = 还在处理 */ ||
        (statusCode === '20000000' && !result);

      if (!inProgress && statusCode && statusCode !== '20000000') {
        // 真正的失败
        task.status = 'failed';
        task.error = msg || `识别失败 (${statusCode})`;
        task.completedAt = Date.now();
        console.log(`[auc] Task ${taskId} failed: code=${statusCode}, msg=${msg}`);
        return;
      }

      // 进行中，继续轮询
      if (attempts >= maxAttempts) {
        task.status = 'failed';
        task.error = '识别超时（超过5分钟）';
        task.completedAt = Date.now();
        console.log(`[auc] Task ${taskId} timed out after ${maxAttempts} attempts`);
        return;
      }
      task.status = 'processing';
      if (attempts <= 2 || attempts % 10 === 0) {
        console.log(`[auc] Task ${taskId} still processing (attempt ${attempts}/${maxAttempts}), msg=${msg || '(empty)'}`);
      }
      setTimeout(poll, interval);
    } catch (err: any) {
      console.log(`[auc] Task ${taskId} query error (attempt ${attempts}): ${err.message}`);
      if (attempts >= maxAttempts) {
        task.status = 'failed';
        task.error = err.message || '查询失败';
        task.completedAt = Date.now();
        console.log(`[auc] Task ${taskId} failed with error: ${err.message}`);
        return;
      }
      setTimeout(poll, interval);
    }
  };

  setTimeout(poll, interval);
}


const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';
  const urlPath = url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (urlPath === '/api/config-schema' || urlPath === '/api/config-schema/') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    sendJson(res, 200, getPublicSchema());
    return;
  }

  if (urlPath === '/api/voiceprint/upload' || urlPath === '/api/voiceprint/upload/') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const ext = (req.headers['x-file-ext'] as string || '').toLowerCase();
    const allowedExts = ['.wav', '.mp3', '.m4a', '.webm', '.ogg'];
    if (!allowedExts.includes(ext)) {
      sendJson(res, 400, { success: false, message: '不支持的文件格式，需要 X-File-Ext header 指定扩展名' });
      return;
    }
    const MAX_SIZE = 10 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalLen = 0;
    let sizeExceeded = false;
    req.on('data', (chunk: Buffer) => {
      totalLen += chunk.length;
      if (totalLen > MAX_SIZE) { sizeExceeded = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (sizeExceeded) {
        sendJson(res, 413, { success: false, message: '文件过大，最大支持 10MB' });
        return;
      }
      const shortUuid = crypto.randomUUID().substring(0, 8);
      const ts = Date.now();
      const filename = `vp_${shortUuid}_${ts}${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFile(filePath, Buffer.concat(chunks), (err) => {
        if (err) {
          sendJson(res, 500, { success: false, message: '保存文件失败: ' + err.message });
          return;
        }
        sendJson(res, 200, { success: true, url: '/uploads/' + filename });
      });
    });
    req.on('error', () => {
      sendJson(res, 500, { success: false, message: '上传失败' });
    });
    return;
  }

  if (urlPath === '/api/voiceprint/register' || urlPath === '/api/voiceprint/register/') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      let speakerName = '';
      let audioUrl = '';
      try {
        const parsed = JSON.parse(body);
        speakerName = (parsed.speakerName || '').trim();
        audioUrl = parsed.audioUrl || '';
      } catch {
        sendJson(res, 400, { success: false, message: '请求格式错误' });
        return;
      }
      if (!speakerName || speakerName.length < 2 || speakerName.length > 64) {
        sendJson(res, 400, { success: false, message: '说话人名称长度需在 2-64 字符之间' });
        return;
      }
      if (!audioUrl.startsWith('/uploads/')) {
        sendJson(res, 400, { success: false, message: '无效的音频路径' });
        return;
      }
      const rel = audioUrl.slice('/uploads/'.length).replace(/\.\./g, '');
      const localPath = path.join(UPLOADS_DIR, rel);
      const resolvedLocal = path.resolve(localPath);
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const host = req.headers['x-forwarded-host'] as string || req.headers.host || '';
      let basePath = '/';
      const referer = req.headers.referer || '';
      if (referer) {
        try {
          const refUrl = new URL(referer);
          const pn = refUrl.pathname;
          const idx = pn.indexOf('/asr-demo-multi');
          if (idx >= 0) {
            basePath = pn.substring(0, idx + '/asr-demo-multi'.length) + '/';
          }
        } catch {}
      }
      const audioUrlFull = `${proto}://${host}${basePath}uploads/${rel}`;
      const fileExt = path.extname(rel).toLowerCase();

      const cleanup = () => {
        try {
          if (resolvedLocal.startsWith(path.resolve(UPLOADS_DIR)) && fs.existsSync(resolvedLocal)) {
            fs.unlinkSync(resolvedLocal);
          }
        } catch {}
      };

      let localEnrolled = false;
      try {
        const speakId = await createVoiceprint({ speakerName, audioUrl: audioUrlFull });
        console.log(`[vp] Cloud voiceprint created: speakId=${speakId}, name=${speakerName}`);

        if (config.voiceprintEnabled) {
          try {
            if (fileExt !== '.wav') {
              console.log(`[vp] Skipping local enrollment: unsupported format ${fileExt}, name=${speakerName}`);
            } else {
              const wavBuffer = fs.readFileSync(resolvedLocal);
              const { embedding, duration_ms } = await gpuEmbedClient.extractEmbedding(wavBuffer, 'wav');
              console.log(`[vp] Extracted embedding: name=${speakerName}, duration=${duration_ms}ms`);

              const minDurationMs = config.voiceprintMinEnrollSec * 1000;
              if (duration_ms < minDurationMs) {
                throw new Error(`音频时长不足，需要至少 ${config.voiceprintMinEnrollSec} 秒（当前 ${Math.round(duration_ms / 1000)} 秒）`);
              }

              const globalCount = RealtimeSpeakerMatcher.getGlobalCount();
              if (globalCount >= config.voiceprintMaxEnroll) {
                throw new Error(`声纹库已满（最大 ${config.voiceprintMaxEnroll} 人）`);
              }

              RealtimeSpeakerMatcher.enrollGlobalSpeaker(speakerName, embedding);
              localEnrolled = true;
              console.log(`[vp] Local enrollment success: name=${speakerName}, total=${RealtimeSpeakerMatcher.getGlobalCount()}`);
            }
          } catch (localErr: any) {
            console.log(`[vp] Local enrollment failed: ${localErr.message}, name=${speakerName}`);
          }
        }

        cleanup();
        sendJson(res, 200, { success: true, speakId, message: '注册成功', localEnrolled });
      } catch (err: any) {
        cleanup();
        console.log(`[vp] Registration failed: ${err.message}, name=${speakerName}`);
        sendJson(res, 500, { success: false, message: err.message || '注册失败' });
      }
    });
    return;
  }

  // 临时调试接口：从recordings目录的wav文件热注册本地声纹（不写云端）
  if (urlPath === '/api/voiceprint/debug-enroll-local' || urlPath === '/api/voiceprint/debug-enroll-local/') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const speakerName = (parsed.speakerName || '').trim();
        const filename = (parsed.filename || '').trim();
        if (!speakerName || !filename) {
          sendJson(res, 400, { success: false, message: '需要speakerName和filename' });
          return;
        }
        const safeFilename = path.basename(filename);
        const filePath = path.join(RECORDINGS_DIR, safeFilename);
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(path.resolve(RECORDINGS_DIR)) || !fs.existsSync(resolvedPath)) {
          sendJson(res, 400, { success: false, message: '文件不存在: ' + safeFilename });
          return;
        }
        const wavBuffer = fs.readFileSync(resolvedPath);
        const { embedding, duration_ms } = await gpuEmbedClient.extractEmbedding(wavBuffer, 'wav');
        console.log(`[vp][debug] Extracted embedding: name=${speakerName}, file=${safeFilename}, duration=${duration_ms}ms`);
        const minDurationMs = config.voiceprintMinEnrollSec * 1000;
        if (duration_ms < minDurationMs) {
          sendJson(res, 400, { success: false, message: `音频时长不足${config.voiceprintMinEnrollSec}秒（当前${Math.round(duration_ms/1000)}秒）` });
          return;
        }
        RealtimeSpeakerMatcher.enrollGlobalSpeaker(speakerName, embedding);
        sendJson(res, 200, {
          success: true,
          message: '本地声纹热注册成功',
          speakerName,
          duration_ms,
          totalLocal: RealtimeSpeakerMatcher.getGlobalCount(),
        });
      } catch (err: any) {
        console.log(`[vp][debug] Enroll failed: ${err.message}`);
        sendJson(res, 500, { success: false, message: err.message || '注册失败' });
      }
    });
    return;
  }

  if (urlPath === '/api/voiceprint/list' || urlPath === '/api/voiceprint/list/') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    (async () => {
      try {
        const { items } = await listVoiceprints({ limit: 100, offset: 0 });
        const mapped = items.map(v => ({
          speakId: v.SpeakID,
          speakerName: v.SpeakerName,
          status: v.Status,
        }));
        const localCount = RealtimeSpeakerMatcher.getGlobalCount();
        sendJson(res, 200, { success: true, items: mapped, localCount });
      } catch (err: any) {
        sendJson(res, 500, { success: false, message: err.message || '获取列表失败' });
      }
    })();
    return;
  }

  if (urlPath === '/api/voiceprint/delete' || urlPath === '/api/voiceprint/delete/') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      let speakId = '';
      let speakerName = '';
      try {
        const parsed = JSON.parse(body);
        speakId = parsed.speakId || '';
        speakerName = (parsed.speakerName || '').trim();
      } catch {
        sendJson(res, 400, { success: false, message: '请求格式错误' });
        return;
      }
      if (!speakId) {
        sendJson(res, 400, { success: false, message: 'speakId 不能为空' });
        return;
      }
      try {
        await deleteVoiceprint(speakId);
        console.log(`[vp] Cloud voiceprint deleted: speakId=${speakId}, name=${speakerName}`);

        if (config.voiceprintEnabled && speakerName) {
          RealtimeSpeakerMatcher.deleteGlobalSpeaker(speakerName);
        }

        sendJson(res, 200, { success: true, message: '删除成功' });
      } catch (err: any) {
        console.log(`[vp] Delete failed: ${err.message}, speakId=${speakId}`);
        sendJson(res, 500, { success: false, message: err.message || '删除失败' });
      }
    });
    return;
  }

  if (urlPath === '/api/auc/config' || urlPath === '/api/auc/config/') {
    if (method === 'GET') {
      sendJson(res, 200, { success: true, config: aucConfig });
      return;
    }
    if (method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const cfg = parsed.config || parsed;
          aucConfig = {
            ...DEFAULT_AUC_CONFIG,
            modelVersion: cfg.modelVersion === '1.0' ? '1.0' : '2.0',
            language: typeof cfg.language === 'string' ? cfg.language : '',
            enable_itn: !!cfg.enable_itn,
            enable_punc: !!cfg.enable_punc,
            enable_ddc: !!cfg.enable_ddc,
            enable_speaker_info: cfg.enable_speaker_info !== false,
            ssd_version: cfg.ssd_version === '200' ? '200' : '300',
            ssd_mode: cfg.ssd_mode === 1 ? 1 : 0,
            show_utterances: cfg.show_utterances !== false,
            end_window_size: typeof cfg.end_window_size === 'number' ? Math.max(300, Math.min(5000, cfg.end_window_size)) : 800,
            use_voiceprints: cfg.use_voiceprints !== false,
            selected_voiceprint_ids: Array.isArray(cfg.selected_voiceprint_ids) ? cfg.selected_voiceprint_ids.slice(0, 50) : [],
          };
          sendJson(res, 200, { success: true, config: aucConfig });
        } catch {
          sendJson(res, 400, { success: false, message: '请求格式错误' });
        }
      });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (urlPath === '/api/auc/submit' || urlPath === '/api/auc/submit/') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      let recordingUrl = '';
      try {
        const parsed = JSON.parse(body);
        recordingUrl = parsed.recordingUrl || '';
      } catch {
        sendJson(res, 400, { success: false, message: '请求格式错误' });
        return;
      }
      let recordingDir: string;
      if (recordingUrl.startsWith('/recordings/')) {
        recordingDir = RECORDINGS_DIR;
      } else if (recordingUrl.startsWith('/uploads/')) {
        recordingDir = UPLOADS_DIR;
      } else {
        sendJson(res, 400, { success: false, message: '无效的录音路径' });
        return;
      }
      const urlPrefix = recordingUrl.startsWith('/recordings/') ? '/recordings/' : '/uploads/';
      const rel = recordingUrl.slice(urlPrefix.length).replace(/\.\./g, '').replace(/^\//, '');
      const supportedAudioExts = ['.wav', '.mp3', '.m4a', '.webm', '.ogg'];
      const ext = path.extname(rel).toLowerCase();
      if (!rel || !supportedAudioExts.includes(ext)) {
        sendJson(res, 400, { success: false, message: '无效的录音文件格式，支持 wav/mp3/m4a/webm/ogg' });
        return;
      }
      const localPath = path.join(recordingDir, rel);
      if (!fs.existsSync(localPath)) {
        sendJson(res, 404, { success: false, message: '录音文件不存在' });
        return;
      }
      const publicBase = inferPublicBaseUrl(req);
      const audioUrlFull = `${publicBase}${urlPrefix.slice(1)}${rel}`;

      // 根据文件扩展名确定音频格式参数
      const audioFormat: { format: string; rate?: number; bits?: number; channel?: number } = {
        format: ext.slice(1), // 去掉点号: .wav -> wav, .mp3 -> mp3
      };
      if (ext === '.wav') {
        // 现场录音是标准 16kHz 单声道 16-bit PCM WAV
        audioFormat.rate = 16000;
        audioFormat.bits = 16;
        audioFormat.channel = 1;
      } else {
        audioFormat.channel = 1;
      }

      let voiceprintList: BytedanceVoiceprint[] = [];
      let speakerNameMap: Record<string, string> = {};
      if (aucConfig.enable_speaker_info && aucConfig.use_voiceprints) {
        try {
          const { items } = await listVoiceprints({ limit: 100, offset: 0 });
          voiceprintList = items;
          const selectedIds = new Set(aucConfig.selected_voiceprint_ids);
          const filtered = selectedIds.size > 0
            ? items.filter(v => selectedIds.has(v.SpeakID))
            : items;
          for (const v of filtered) {
            speakerNameMap[v.SpeakID] = v.SpeakerName;
          }
        } catch (err: any) {
          console.log(`[auc] Failed to load voiceprints: ${err.message}`);
        }
      }

      const submitParams: AucSubmitRequest = {
        model_name: 'bigmodel',
        enable_itn: aucConfig.enable_itn,
        enable_punc: aucConfig.enable_punc,
        enable_ddc: aucConfig.enable_ddc,
        enable_speaker_info: aucConfig.enable_speaker_info,
        show_utterances: aucConfig.show_utterances,
      };

      // 构建热词和上下文（kiteX thrift要求corpus为STRUCT/object，内部context/correct_words为JSON字符串）
      const contextObj = {
        hotwords: DEFAULT_HOTWORDS.map(w => ({ word: w })),
        context_type: 'dialog_ctx',
        context_data: [
          { text: '当前是ASR会议转写产品的技术评审会，讨论实时语音识别、豆包大模型、说话人分离、声纹识别、云端中转架构等技术方案' },
        ],
      };
      const corpusObj: { context: string; correct_words: string } = {
        context: JSON.stringify(contextObj),
        correct_words: JSON.stringify(DEFAULT_CORRECT_WORDS),
      };
      submitParams.corpus = corpusObj;
      console.log(`[auc] corpus configured with ${DEFAULT_HOTWORDS.length} hotwords, ${Object.keys(DEFAULT_CORRECT_WORDS).length} correct words`);
      if (aucConfig.language) {
        submitParams.language = aucConfig.language;
      }
      if (aucConfig.enable_speaker_info) {
        submitParams.ssd_version = aucConfig.ssd_version;
        submitParams.end_window_size = aucConfig.end_window_size;
        if (aucConfig.ssd_version === '200') {
          submitParams.ssd_mode = aucConfig.ssd_mode;
        }
      }
      const vpIds = voiceprintList
        .filter(v => {
          if (aucConfig.selected_voiceprint_ids.length > 0) {
            return aucConfig.selected_voiceprint_ids.includes(v.SpeakID);
          }
          return true;
        })
        .slice(0, 50)
        .map(v => ({ id: v.SpeakID }));
      if (vpIds.length > 0) {
        submitParams.voiceprints = vpIds;
      }

      try {
        const { taskId } = await submitTask(audioUrlFull, submitParams, aucConfig.modelVersion, audioFormat);
        while (aucTasks.size >= MAX_AUC_TASKS) {
          const oldestKey = aucTasks.keys().next().value;
          if (oldestKey) aucTasks.delete(oldestKey);
        }
        aucTasks.set(taskId, {
          taskId,
          status: 'queued',
          recordingUrl,
          createdAt: Date.now(),
          speakerNameMap,
        });
        console.log(`[auc] Task submitted: ${taskId}, audio=${audioUrlFull} (${audioFormat.format}), voiceprints=${vpIds.length}, vpIds=${JSON.stringify(vpIds.map(v => v.id))}, nameMap keys=${Object.keys(speakerNameMap)}`);
        startAucPolling(taskId, aucConfig.modelVersion);
        sendJson(res, 200, { success: true, taskId, status: 'queued' });
      } catch (err: any) {
        console.log(`[auc] Submit failed: ${err.message}`);
        sendJson(res, 500, { success: false, message: err.message || '提交失败' });
      }
    });
    return;
  }

  if (urlPath === '/api/auc/query' || urlPath === '/api/auc/query/') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const taskId = parsedUrl.searchParams.get('taskId') || '';
    if (!taskId) {
      sendJson(res, 400, { success: false, message: 'taskId 不能为空' });
      return;
    }
    const task = aucTasks.get(taskId);
    if (!task) {
      sendJson(res, 404, { success: false, message: '任务不存在' });
      return;
    }
    const response: any = {
      success: true,
      taskId: task.taskId,
      status: task.status,
    };
    if (task.status === 'completed') {
      response.transcriptUrl = task.transcriptUrl;
      response.text = task.text;
      response.duration = task.duration;
    } else if (task.status === 'failed') {
      response.message = task.error;
    }
    sendJson(res, 200, response);
    return;
  }

  if (urlPath === '/api/auc/list' || urlPath === '/api/auc/list/') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const tasks = Array.from(aucTasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map(t => ({
        taskId: t.taskId,
        status: t.status,
        recordingUrl: t.recordingUrl,
        transcriptUrl: t.transcriptUrl,
        error: t.error,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        duration: t.duration,
      }));
    sendJson(res, 200, { success: true, tasks });
    return;
  }

  if (method !== 'GET') {
    res.writeHead(404);
    res.end();
    return;
  }

  if (urlPath.startsWith('/transcripts/')) {
    const rel = urlPath.slice('/transcripts/'.length).replace(/\.\./g, '').replace(/^\//, '');
    if (!rel || !rel.endsWith('.txt')) { res.writeHead(404); res.end(); return; }
    const filePath = path.join(TRANSCRIPTS_DIR, rel);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(TRANSCRIPTS_DIR))) { res.writeHead(403); res.end(); return; }
    serveStatic(req, res, filePath, MIME['.txt']);
    return;
  }

  if (urlPath.startsWith('/recordings/')) {
    const rel = urlPath.slice('/recordings/'.length).replace(/\.\./g, '').replace(/^\//, '');
    if (!rel) { res.writeHead(404); res.end(); return; }
    const allowedExts = ['.wav', '.mp3', '.m4a', '.webm', '.ogg'];
    const ext = path.extname(rel).toLowerCase();
    if (!allowedExts.includes(ext)) { res.writeHead(404); res.end(); return; }
    const filePath = path.join(RECORDINGS_DIR, rel);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(RECORDINGS_DIR))) { res.writeHead(403); res.end(); return; }
    serveStatic(req, res, filePath, MIME[ext] || 'application/octet-stream');
    return;
  }

  if (urlPath.startsWith('/uploads/')) {
    const rel = urlPath.slice('/uploads/'.length).replace(/\.\./g, '').replace(/^\//, '');
    if (!rel) { res.writeHead(404); res.end(); return; }
    const allowedExts = ['.wav', '.mp3', '.m4a', '.webm', '.ogg'];
    const ext = path.extname(rel).toLowerCase();
    if (!allowedExts.includes(ext)) { res.writeHead(404); res.end(); return; }
    const filePath = path.join(UPLOADS_DIR, rel);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) { res.writeHead(403); res.end(); return; }
    serveStatic(req, res, filePath, MIME[ext] || 'application/octet-stream');
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    serveStatic(req, res, path.join(CLOUD_PUBLIC_DIR, 'index.html'), MIME['.html']);
    return;
  }
  if (urlPath === '/app.js') {
    serveStatic(req, res, path.join(CLOUD_PUBLIC_DIR, 'app.js'), MIME['.js']);
    return;
  }
  if (urlPath === '/style.css') {
    serveStatic(req, res, path.join(CLOUD_PUBLIC_DIR, 'style.css'), MIME['.css']);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url !== '/ws' && !url.startsWith('/ws?')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (clientWs: WebSocket) => {
  const requestId = crypto.randomUUID();
  const matcher = new RealtimeSpeakerMatcher();
  let logid: string = requestId;
  let doubaoLogid = '';
  console.log(`[${requestId}] Client connected (cloud mode), initial logid: ${logid}`);

  let doubaoWs: WebSocket | null = null;
  let appliedConfig: SanitizedConfig | null = null;
  let firstAudioPacket = true;
  let started = false;
  let sessionStartAt = 0;
  let pcmChunks: Buffer[] = [];
  let totalPcmBytes = 0;
  let wavSaveTriggered = false;
  let clientStillConnected = true;

  matcher.on('speaker_identifying', (speakerId: number) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'speaker_identifying', speakerId }));
    }
  });

  matcher.on('speaker_matched', (speakerId: number, username: string, score: number | undefined, confidence: 'high' | 'low', method: string) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'speaker_matched', speakerId, username, score, confidence, method }));
    }
  });

  matcher.on('speaker_guest', (speakerId: number, guestName: string) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'speaker_guest', speakerId, guestName }));
    }
  });

  const triggerWavSave = () => {
    if (wavSaveTriggered) return;
    wavSaveTriggered = true;

    if (pcmChunks.length === 0 || totalPcmBytes === 0) {
      console.log(`[${requestId}] No PCM data, skipping WAV generation`);
      return;
    }

    const pcmBuffer = Buffer.concat(pcmChunks);
    const durationMs = Math.round((totalPcmBytes / 2 / 16000) * 1000);
    const shortUuid = crypto.randomUUID().substring(0, 8);
    const now = new Date();
    const timestamp = now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, '0') +
      now.getDate().toString().padStart(2, '0') +
      now.getHours().toString().padStart(2, '0') +
      now.getMinutes().toString().padStart(2, '0') +
      now.getSeconds().toString().padStart(2, '0');
    const filename = `rec_${shortUuid}_${timestamp}.wav`;
    const outputPath = path.join(RECORDINGS_DIR, filename);

    console.log(`[${requestId}] Generating WAV: ${filename}, duration=${durationMs}ms, bytes=${totalPcmBytes}`);

    try {
      const wavBuffer = pcmToWav(pcmBuffer);
      fs.writeFileSync(outputPath, wavBuffer);
      console.log(`[${requestId}] WAV saved: ${outputPath}, size=${wavBuffer.length} bytes`);

      if (clientStillConnected && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'recording_ready',
          url: '/recordings/' + filename,
          durationMs,
        }));
      }
    } catch (err: any) {
      console.log(`[${requestId}] WAV save failed: ${err?.message}`);
      console.log(err?.stack);
    }
  };

  const cleanup = () => {
    matcher.reset();
    if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
      try { doubaoWs.close(); } catch {}
    }
    doubaoWs = null;
    started = false;
    triggerWavSave();
  };

  const sendClientError = (code: number, message: string) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', code, message, logid }));
    }
  };

  const connectDoubao = (sanitized: SanitizedConfig, hotwordConfig?: HotwordConfig) => {
    cleanup();
    pcmChunks = [];
    totalPcmBytes = 0;
    wavSaveTriggered = false;
    appliedConfig = sanitized;
    firstAudioPacket = true;
    sessionStartAt = Date.now();
    matcher.start(sessionStartAt);
    const sessionId = crypto.randomUUID();
    logid = sessionId;
    doubaoLogid = '';

    const { wsUrl, payload } = buildDoubaoConnection(sanitized, hotwordConfig, config.asrBoostingTableId);
    console.log(`[${requestId}] Connecting to Doubao ASR at ${wsUrl}, config=${JSON.stringify(sanitized)}`);
    if (config.asrBoostingTableId) {
      console.log(`[${requestId}] Hotword boosting table enabled: ${config.asrBoostingTableId}`);
    }
    console.log(`[${requestId}] Full client request payload: ${JSON.stringify(payload)}`);

    const authHeaders: Record<string, string> = {
      'X-Api-Resource-Id': config.resourceId,
      'X-Api-Connect-Id': sessionId,
    };
    if (config.appKey && config.accessKey && config.accessKey !== config.apiKey) {
      authHeaders['X-Api-App-Id'] = config.appKey;
      authHeaders['X-Api-Access-Key'] = config.accessKey;
      console.log(`[${requestId}] Using auth method: App ID + Access Key`);
    } else if (config.apiKey) {
      authHeaders['X-Api-Key'] = config.apiKey;
      console.log(`[${requestId}] Using auth method: API Key`);
    } else {
      console.log(`[${requestId}] WARNING: No ASR API key configured!`);
    }

    doubaoWs = new WebSocket(wsUrl, {
      headers: authHeaders,
    });

    doubaoWs.binaryType = 'nodebuffer';

    doubaoWs.on('headers', (headers: string[]) => {
      console.log(`[${requestId}] Received response headers: ${JSON.stringify(headers)}`);
      for (const h of headers) {
        const lowerH = h.toLowerCase();
        if (lowerH.startsWith('x-tt-logid:') || lowerH.startsWith('x-tt-log-id:')) {
          const colonIdx = h.indexOf(':');
          if (colonIdx >= 0) {
            doubaoLogid = h.substring(colonIdx + 1).trim();
            logid = doubaoLogid;
            console.log(`[${requestId}] Extracted doubao logid from headers: ${doubaoLogid}`);
          }
        }
      }
      if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN && clientWs.readyState === WebSocket.OPEN && doubaoLogid) {
        clientWs.send(JSON.stringify({
          type: 'logid_update',
          logid,
        }));
      }
    });

    doubaoWs.on('open', () => {
      console.log(`[${requestId}] Connected to Doubao ASR, logid: ${logid}, doubaoLogid: ${doubaoLogid}`);
      doubaoWs!.send(buildFullClientRequest(payload));
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'connected',
          appliedConfig: sanitized,
          logid,
          voiceprintEnabled: config.voiceprintEnabled,
        }));
      }
    });

    doubaoWs.on('message', (data: Buffer) => {
      const result = parseServerResponse(data);
      if (result.type === 'response') {
        const text = result.payload?.result?.text || '';
        const duration = result.payload?.audio_info?.duration;
        const utterances = result.payload?.result?.utterances;
        console.log(`[${requestId}] ASR resp isFinal=${result.isFinal} dur=${duration} text="${text.substring(0, 80)}" utts=${Array.isArray(utterances) ? utterances.length : 0}`);

        let speakerOverrides: Record<string, any> = {};
        if (config.voiceprintEnabled && Array.isArray(utterances)) {
          const speakerIdSet = new Set<number>();
          for (const u of utterances as any[]) {
            const rawSpk = u.speaker_id ?? u.speaker ?? (u.additions && u.additions.speaker_id);
            // speaker_id可能是字符串"0"，parseInt转数字
            let numericSpk: number | undefined;
            if (typeof rawSpk === 'number') {
              numericSpk = rawSpk;
            } else if (typeof rawSpk === 'string' && rawSpk.trim()) {
              const parsed = parseInt(rawSpk, 10);
              if (!isNaN(parsed)) numericSpk = parsed;
            }
            // definite必须严格为true
            const isDefinite = u.definite === true;
            // 调试日志：打印每个utt的详细状态
            if (utterances.indexOf(u) < 3) {
              console.log(`[vp] DEBUG utt: rawSpk=${rawSpk}(${typeof rawSpk})→num=${numericSpk} definite=${u.definite}(${isDefinite}) words=${u.words?.length ?? 0} text="${(u.text||'').substring(0,20)}"`);
            }
            if (numericSpk !== undefined && isDefinite) {
              const startTime = u.start_time ?? 0;
              const endTime = u.end_time ?? duration ?? 0;
              matcher.onDefiniteUtterance(numericSpk, startTime, endTime);
              speakerIdSet.add(numericSpk);
            }
          }
          Array.from(speakerIdSet).forEach((spkId) => {
            const info = matcher.getSpeakerInfo(spkId);
            speakerOverrides[String(spkId)] = {
              status: info.status,
              username: info.username,
              color: info.color,
              score: info.score,
              confidence: info.confidence,
            };
          });
        }

        clientWs.send(JSON.stringify({
          type: 'result',
          text,
          duration,
          isFinal: !!result.isFinal,
          utterances,
          speakerOverrides,
        }));
        if (result.isFinal) {
          const sessionDur = Date.now() - sessionStartAt;
          console.log(`[${requestId}] Final result: "${text}" (${duration}ms, session=${sessionDur}ms)`);
          if (Array.isArray(utterances) && utterances.length > 0) {
            const summary = utterances.map((u: any, i: number) => {
              const additions = u.additions || {};
              return `#${i}[spk=${u.speaker_id ?? u.speaker ?? additions.speaker_id ?? '?'} def=${u.definite}] "${(u.text || '').substring(0, 30)}"`;
            }).join(' | ');
            console.log(`[${requestId}] Utterances (${utterances.length}): ${summary}`);
          } else {
            console.log(`[${requestId}] No utterances in final response`);
          }
          setTimeout(() => cleanup(), 200);
        }
      } else if (result.type === 'error') {
        console.log(`[${requestId}] Error from Doubao: code=${result.code} ${result.message}`);
        sendClientError(result.code || -1, result.message || 'ASR error');
        cleanup();
      }
    });

    doubaoWs.on('error', (err) => {
      console.log(`[${requestId}] Doubao WS error: ${err.message}`);
      sendClientError(-1, 'ASR connection error: ' + err.message);
      cleanup();
    });

    doubaoWs.on('close', () => {
      console.log(`[${requestId}] Doubao WS closed`);
      cleanup();
    });
  };

  clientWs.on('message', (msg, isBinary) => {
    if (!isBinary) {
      const text = msg.toString();
      try {
        const parsed = JSON.parse(text);
        if (parsed.type === 'start') {
          if (started) {
            sendClientError(-2, 'Already started');
            return;
          }
          started = true;
          const sanitized = validateAndFillConfig(parsed.config || {});
          const hotwordConfig: HotwordConfig = {};
          if (parsed.hotwords && Array.isArray(parsed.hotwords)) {
            hotwordConfig.hotwords = parsed.hotwords.filter((w: any) => typeof w === 'string' && w.trim().length > 0).map((w: string) => w.trim());
          }
          if (parsed.correct_words && typeof parsed.correct_words === 'object') {
            const cw: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed.correct_words)) {
              if (typeof v === 'string' && k.trim().length > 0 && v.trim().length > 0) {
                cw[k.trim()] = v.trim();
              }
            }
            if (Object.keys(cw).length > 0) hotwordConfig.correct_words = cw;
          }
          connectDoubao(sanitized, hotwordConfig);
        } else if (parsed.type === 'stop') {
          if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
            doubaoWs.send(buildLastPacket());
            console.log(`[${requestId}] Sent last packet`);
          }
        } else if (parsed.type === 'bind_speaker') {
          const spkId = parsed.speakerId;
          const username = parsed.username;
          if (typeof spkId === 'number' && username) {
            console.log(`[${requestId}] bind_speaker: spk=${spkId}, username=${username}`);
            matcher.manualBind(spkId, username);
          }
        }
      } catch (e: any) {
        console.log(`[${requestId}] Failed to parse client message: ${e?.message}`);
      }
    } else {
      if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
        if (firstAudioPacket) {
          firstAudioPacket = false;
          const audioStartTs = Date.now();
          console.log(`[${requestId}] First audio packet received at t=${audioStartTs}`);
          if (config.voiceprintEnabled) {
            matcher.markAudioStart(audioStartTs);
          }
        }
        const buf = Buffer.from(msg as Buffer);

        if (config.voiceprintEnabled) {
          matcher.feedAudio(buf);
        }

        const MAX_FRAME_SIZE = 32 * 1024;
        for (let offset = 0; offset < buf.length; offset += MAX_FRAME_SIZE) {
          const end = Math.min(offset + MAX_FRAME_SIZE, buf.length);
          const chunk = buf.subarray(offset, end);
          doubaoWs.send(buildAudioRequest(chunk));
        }

        if (totalPcmBytes + buf.length <= config.maxPcmBytes) {
          pcmChunks.push(buf);
          totalPcmBytes += buf.length;
        } else {
          if (totalPcmBytes < config.maxPcmBytes) {
            console.log(`[${requestId}] PCM buffer limit reached (${config.maxPcmBytes} bytes), stopping accumulation`);
          }
        }
      } else if (!started) {
        console.log(`[${requestId}] Received audio before start; ignoring`);
      }
    }
  });

  clientWs.on('close', () => {
    console.log(`[${requestId}] Client disconnected`);
    clientStillConnected = false;
    started = false;
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.log(`[${requestId}] Client WS error: ${err.message}`);
    clientStillConnected = false;
    started = false;
    cleanup();
  });
});

(async () => {
  let gpuOk = false;
  try {
    gpuOk = await gpuEmbedClient.healthCheck();
  } catch (err: any) {
    console.log(`[cloud] GPU health check error: ${err.message}`);
  }
  console.log(`[cloud] GPU embed service health: ${gpuOk ? 'OK' : 'UNAVAILABLE'}, voiceprintEnabled=${config.voiceprintEnabled}`);

  if (config.voiceprintEnabled && !gpuOk) {
    console.log(`[cloud] WARNING: voiceprintEnabled=true but GPU embed service is unavailable!`);
  }

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Cloud relay server running at http://0.0.0.0:${config.port}`);
    console.log(`Cloud public dir: ${CLOUD_PUBLIC_DIR}`);
    console.log(`Recordings dir: ${RECORDINGS_DIR}`);
    console.log(`Transcripts dir: ${TRANSCRIPTS_DIR}`);
    console.log(`Max PCM buffer: ${config.maxPcmBytes} bytes (≈ ${Math.round(config.maxPcmBytes / 2 / 16000)} seconds)`);
  });
})();
