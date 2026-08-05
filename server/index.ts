import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { buildFullClientRequest, buildAudioRequest, buildLastPacket, parseServerResponse } from './asr-protocol';
import { getPublicSchema, validateAndFillConfig, buildDoubaoConnection, SanitizedConfig } from './asr-config';
import { SpeakerMatcher } from './speaker-matcher';
import { enrollVoicePrint, deleteVoicePrint, checkVoiceprintServiceHealth } from './tencent-voiceprint';
import { pcmToWav } from './pcm-to-wav';
import {
  listSummaries,
  clearAllSummaries,
  generateSummary,
  summaryDirFsPath,
  isLlmConfigured,
  SpeakerTurn,
  Attendee,
} from './summary';

function findRootDir(): string {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, '..', '..', 'public'),
    path.join(process.cwd(), 'public'),
  ];
  for (const pubDir of candidates) {
    if (fs.existsSync(pubDir) && fs.existsSync(path.join(pubDir, 'index.html'))) {
      return path.dirname(pubDir);
    }
  }
  return process.cwd();
}

const ROOT_DIR = findRootDir();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SUMMARIES_DIR = summaryDirFsPath();

function sendJson(res: http.ServerResponse, status: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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

const server = http.createServer(async (req, res) => {
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

  if (urlPath === '/api/llm-status') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    sendJson(res, 200, { configured: isLlmConfigured(), model: config.arkModel });
    return;
  }

  if (urlPath === '/api/voiceprint-status') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    let health: any = { ok: false };
    if (config.voiceprintEnabled && config.voiceprintBackend === 'selfhosted') {
      health = await checkVoiceprintServiceHealth();
    }
    sendJson(res, 200, {
      enabled: config.voiceprintEnabled,
      backend: config.voiceprintBackend,
      threshold: config.voiceprintScoreThreshold,
      serviceUrl: config.voiceprintServiceUrl,
      health,
    });
    return;
  }

  if (urlPath === '/api/voiceprint/enroll') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    if (!config.voiceprintEnabled) {
      const msg = config.voiceprintBackend === 'selfhosted'
        ? '声纹服务未配置，请设置VOICEPRINT_SERVICE_URL'
        : '腾讯云声纹API未配置，请设置TENCENT_SECRET_ID/SECRET_KEY';
      sendJson(res, 503, { error: 'VOICEPRINT_NOT_CONFIGURED', message: msg });
      return;
    }
    if (config.voiceprintBackend === 'selfhosted') {
      const health = await checkVoiceprintServiceHealth();
      if (!health.ok) {
        sendJson(res, 503, { error: 'VOICEPRINT_SERVICE_UNAVAILABLE', message: '声纹服务未就绪: ' + (health.error || '未知错误'), health });
        return;
      }
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const username = String(body.username || '').trim();
      const audioBase64 = String(body.audioBase64 || '');
      if (!username) {
        sendJson(res, 400, { error: 'username required' });
        return;
      }
      if (!audioBase64) {
        sendJson(res, 400, { error: 'audioBase64 required' });
        return;
      }
      const pcmBuffer = Buffer.from(audioBase64, 'base64');
      const result = await enrollVoicePrint(pcmBuffer, username, config.voiceprintGroupId);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e: any) {
      console.log(`[voiceprint] enroll error: ${e?.message}`);
      sendJson(res, 500, { error: 'enroll_failed', message: e?.message || String(e) });
    }
    return;
  }

  if (urlPath === '/api/summaries') {
    if (method === 'GET') {
      sendJson(res, 200, { items: listSummaries() });
      return;
    }
    if (method === 'DELETE') {
      const n = clearAllSummaries();
      sendJson(res, 200, { ok: true, deleted: n });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (urlPath === '/api/summarize') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const transcript: string = (typeof body.transcript === 'string' ? body.transcript : '').trim();
      const turns: SpeakerTurn[] = Array.isArray(body.turns)
        ? body.turns.filter((t: any) => t && typeof t.text === 'string').map((t: any) => ({
            speaker: typeof t.speaker === 'number' ? t.speaker : -1,
            text: String(t.text),
          }))
        : [];
      const durationMs: number = typeof body.durationMs === 'number' ? body.durationMs : 0;
      const attendees: Attendee[] = Array.isArray(body.attendees)
        ? body.attendees
            .filter((a: any) => a && typeof a.name === 'string' && a.name.trim())
            .map((a: any) => ({
              name: String(a.name).trim(),
              role: typeof a.role === 'string' ? a.role.trim() : '',
            }))
        : [];
      if (!transcript) {
        sendJson(res, 400, { error: 'transcript is empty' });
        return;
      }
      if (!isLlmConfigured()) {
        sendJson(res, 503, {
          error: 'LLM_NOT_CONFIGURED',
          message: '未配置大模型 API Key，请在服务器 inventory.local.env 中设置 ARK_API_KEY（豆包方舟 API Key）后重启服务',
        });
        return;
      }
      const meta = await generateSummary(transcript, turns, durationMs, attendees);
      sendJson(res, 200, { ok: true, summary: meta });
    } catch (e: any) {
      console.log(`[summary] error: ${e?.message}`);
      sendJson(res, 500, { error: 'summarize_failed', message: e?.message || String(e) });
    }
    return;
  }

  if (urlPath.startsWith('/summaries/')) {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const rel = urlPath.slice('/summaries/'.length).replace(/\.\./g, '').replace(/^\//, '');
    if (!rel || !rel.endsWith('.html')) { res.writeHead(404); res.end(); return; }
    const filePath = path.join(SUMMARIES_DIR, rel);
    if (!filePath.startsWith(SUMMARIES_DIR)) { res.writeHead(403); res.end(); return; }
    serveStatic(req, res, filePath, MIME['.html']);
    return;
  }

  if (urlPath === '/asr-check') {
    const filePath = path.join(PUBLIC_DIR, 'asr-check.html');
    serveStatic(req, res, filePath, MIME['.html']);
    return;
  }

  if (method !== 'GET') {
    res.writeHead(404);
    res.end();
    return;
  }

  // 通用静态文件服务
  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const safeRel = relPath.replace(/\.\./g, '').replace(/^\//, '');
  const ext = path.extname(relPath).toLowerCase();
  const contentType = MIME[ext as keyof typeof MIME] || 'application/octet-stream';
  const filePath = path.join(PUBLIC_DIR, safeRel);
  
  // 安全检查：确保路径在PUBLIC_DIR内
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  serveStatic(req, res, filePath, contentType);
});

const wss = new WebSocketServer({ noServer: true });
const wssCompare = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  const urlPath = url.split('?')[0];

  if (urlPath === '/ws-compare') {
    wssCompare.handleUpgrade(req, socket, head, (ws) => {
      wssCompare.emit('connection', ws, req);
    });
  } else if (urlPath.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs: WebSocket) => {
  const requestId = crypto.randomUUID();
  // 使用 requestId 作为初始会话追踪 ID
  let logid: string = requestId;
  let doubaoLogid = '';
  console.log(`[${requestId}] Client connected, initial logid: ${logid}`);

  let doubaoWs: WebSocket | null = null;
  let appliedConfig: SanitizedConfig | null = null;
  let firstAudioPacket = true;
  let started = false;
  let sessionStartAt = 0;
  const matcher = new SpeakerMatcher();

  matcher.on('speaker_matching', (speakerId: number) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'speaker_matching', speakerId }));
    }
  });

  matcher.on('speaker_matched', (speakerId: number, username: string, score: number | undefined, auto: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'speaker_matched',
        speakerId,
        username,
        score,
        auto,
      }));
    }
  });

  matcher.on('speaker_match_failed', (speakerId: number, score: number) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'speaker_match_failed',
        speakerId,
        score,
      }));
    }
  });

  matcher.on('speaker_match_error', (speakerId: number, message: string) => {
    console.log(`[${requestId}] Speaker match error for spk=${speakerId}: ${message}`);
  });

  const cleanup = () => {
    if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
      try { doubaoWs.close(); } catch {}
    }
    doubaoWs = null;
    started = false;
    matcher.reset();
  };

  const sendClientError = (code: number, message: string) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', code, message, logid }));
    }
  };

  const connectDoubao = (sanitized: SanitizedConfig) => {
    cleanup();
    appliedConfig = sanitized;
    firstAudioPacket = true;
    sessionStartAt = Date.now();
    matcher.start();
    // 每次新会话生成新的追踪 ID
    const sessionId = crypto.randomUUID();
    logid = sessionId;
    doubaoLogid = '';

    const { wsUrl, payload } = buildDoubaoConnection(sanitized, config.asrBoostingTableId);
    console.log(`[${requestId}] Connecting to Doubao ASR at ${wsUrl}, config=${JSON.stringify(sanitized)}`);
    if (config.asrBoostingTableId) {
      console.log(`[${requestId}] Hotword boosting table enabled: ${config.asrBoostingTableId}`);
    }
    console.log(`[${requestId}] Full client request payload: ${JSON.stringify(payload)}`);

    doubaoWs = new WebSocket(wsUrl, {
      headers: {
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Connect-Id': sessionId,
      },
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
      // 如果已经 open 了，发送 logid 更新
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
      // 立即发送 connected，使用 sessionId 作为初始 logid
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

        if (Array.isArray(utterances)) {
          for (const utt of utterances) {
            const spk = utt.speaker_id ?? utt.speaker ?? (utt.additions && utt.additions.speaker_id);
            const speakerId = typeof spk === 'number' ? spk : (parseInt(spk, 10) || 0);
            const uttText = utt.text || '';
            const definite = !!utt.definite;
            const stMs = typeof utt.start_time === 'number' ? utt.start_time : 0;
            const edMs = typeof utt.end_time === 'number' ? utt.end_time : stMs + 1000;

            if (config.voiceprintEnabled && definite) {
              matcher.onUtterance(speakerId, uttText, stMs, edMs, definite);
            }
          }
        }

        const speakerOverrides: Record<number, { username?: string; color: string }> = {};
        if (Array.isArray(utterances)) {
          for (const utt of utterances) {
            const spk = utt.speaker_id ?? utt.speaker ?? (utt.additions && utt.additions.speaker_id);
            const speakerId = typeof spk === 'number' ? spk : (parseInt(spk, 10) || 0);
            if (!speakerOverrides[speakerId]) {
              const info = matcher.getSpeakerInfo(speakerId);
              speakerOverrides[speakerId] = {
                username: info.username,
                color: info.color,
              };
            }
          }
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
              const spkOverride = speakerOverrides[u.speaker_id ?? u.speaker ?? additions.speaker_id ?? 0];
              return `#${i}[spk=${u.speaker_id ?? u.speaker ?? additions.speaker_id ?? '?'}${spkOverride?.username ? '->' + spkOverride.username : ''} def=${u.definite}] "${(u.text || '').substring(0, 30)}"`;
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
          connectDoubao(sanitized);
        } else if (parsed.type === 'stop') {
          if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
            doubaoWs.send(buildLastPacket());
            console.log(`[${requestId}] Sent last packet`);
          }
        } else if (parsed.type === 'bind_speaker') {
          const speakerId = parseInt(parsed.speakerId, 10);
          const username = String(parsed.username || '').trim();
          if (!isNaN(speakerId) && username) {
            matcher.manualBind(speakerId, username);
          }
        }
      } catch (e: any) {
        console.log(`[${requestId}] Failed to parse client message: ${e?.message}`);
      }
    } else {
      if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
        if (firstAudioPacket) {
          firstAudioPacket = false;
          console.log(`[${requestId}] First audio packet received`);
        }
        const buf = Buffer.from(msg as Buffer);
        doubaoWs.send(buildAudioRequest(buf));
        if (config.voiceprintEnabled) {
          matcher.feedAudio(buf);
        }
      } else if (!started) {
        console.log(`[${requestId}] Received audio before start; ignoring`);
      }
    }
  });

  clientWs.on('close', () => {
    console.log(`[${requestId}] Client disconnected`);
    started = false;
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.log(`[${requestId}] Client WS error: ${err.message}`);
    started = false;
    cleanup();
  });
});

type CompareMode = 'two_pass' | 'one_pass';

interface CompareConnectionState {
  mode: CompareMode;
  doubaoWs: WebSocket | null;
  logid: string;
  connected: boolean;
  readyForAudio: boolean;
  audioBuffer: Buffer[];
  readyTimer: NodeJS.Timeout | null;
  pendingLastPacket: boolean;
  closeByUs: boolean;
  reconnectTimer: NodeJS.Timeout | null;
}

wssCompare.on('connection', (clientWs: WebSocket) => {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}][compare] Client connected for compare mode`);

  let appliedConfig: SanitizedConfig | null = null;
  let firstAudioPacket = true;
  let started = false;
  let stopping = false;

  const states: Record<CompareMode, CompareConnectionState> = {
    two_pass: { mode: 'two_pass', doubaoWs: null, logid: '', connected: false, readyForAudio: false, audioBuffer: [], readyTimer: null, pendingLastPacket: false, closeByUs: false, reconnectTimer: null },
    one_pass: { mode: 'one_pass', doubaoWs: null, logid: '', connected: false, readyForAudio: false, audioBuffer: [], readyTimer: null, pendingLastPacket: false, closeByUs: false, reconnectTimer: null },
  };

  const allConnectionsClosed = () => {
    return !states.two_pass.doubaoWs && !states.one_pass.doubaoWs;
  };

  const cleanupMode = (mode: CompareMode) => {
    const state = states[mode];
    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.audioBuffer = [];
    state.readyForAudio = false;
    state.pendingLastPacket = false;
    state.closeByUs = true;
    if (state.doubaoWs) {
      if (state.doubaoWs.readyState === WebSocket.OPEN) {
        try { state.doubaoWs.close(); } catch {}
      }
      state.doubaoWs = null;
    }
    state.connected = false;
    state.logid = '';

    if (stopping && allConnectionsClosed()) {
      stopping = false;
      started = false;
      firstAudioPacket = true;
      console.log(`[${requestId}][compare] Both connections closed after stop, ready for next start`);
    }
  };

  const cleanup = () => {
    cleanupMode('two_pass');
    cleanupMode('one_pass');
    started = false;
  };

  const sendClientError = (code: number, message: string, mode?: CompareMode) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', code, message, mode }));
    }
  };

  const doConnectMode = (mode: CompareMode, baseConfig: SanitizedConfig) => {
    const state = states[mode];
    const modeConfig: SanitizedConfig = {
      ...baseConfig,
      enable_two_pass: mode === 'two_pass',
    };

    const sessionId = crypto.randomUUID();
    state.logid = sessionId;
    state.closeByUs = false;

    const { wsUrl, payload } = buildDoubaoConnection(modeConfig, config.asrBoostingTableId);
    console.log(`[${requestId}][compare][${mode}] Connecting to Doubao ASR, config=${JSON.stringify(modeConfig)}`);

    state.doubaoWs = new WebSocket(wsUrl, {
      headers: {
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Connect-Id': sessionId,
      },
    });

    state.doubaoWs.binaryType = 'nodebuffer';

    state.doubaoWs.on('headers', (headers: string[]) => {
      for (const h of headers) {
        const lowerH = h.toLowerCase();
        if (lowerH.startsWith('x-tt-logid:') || lowerH.startsWith('x-tt-log-id:')) {
          const colonIdx = h.indexOf(':');
          if (colonIdx >= 0) {
            state.logid = h.substring(colonIdx + 1).trim();
            console.log(`[${requestId}][compare][${mode}] Extracted doubao logid: ${state.logid}`);
          }
        }
      }
      if (state.doubaoWs && state.doubaoWs.readyState === WebSocket.OPEN && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'logid_update',
          mode,
          logid: state.logid,
        }));
      }
    });

    state.doubaoWs.on('open', () => {
      console.log(`[${requestId}][compare][${mode}] WebSocket opened, sending full client request`);
      state.doubaoWs!.send(buildFullClientRequest(payload));
      if (clientWs.readyState === WebSocket.OPEN) {
        state.connected = true;
        clientWs.send(JSON.stringify({
          type: 'connected',
          mode,
          logid: state.logid,
        }));
      }
      // 给豆包服务端300ms处理配置，期间缓冲音频，就绪后一次性发送
      state.readyForAudio = false;
      state.pendingLastPacket = false;
      if (state.readyTimer) clearTimeout(state.readyTimer);
      state.readyTimer = setTimeout(() => {
        state.readyForAudio = true;
        state.readyTimer = null;
        let buffered = 0;
        for (const chunk of state.audioBuffer) {
          if (state.doubaoWs && state.doubaoWs.readyState === WebSocket.OPEN) {
            state.doubaoWs.send(buildAudioRequest(chunk));
            buffered += chunk.length;
          }
        }
        state.audioBuffer = [];
        console.log(`[${requestId}][compare][${mode}] Ready for audio, flushed ${buffered} bytes of buffered audio`);
        if (state.pendingLastPacket) {
          state.pendingLastPacket = false;
          if (state.doubaoWs && state.doubaoWs.readyState === WebSocket.OPEN) {
            state.doubaoWs.send(buildLastPacket());
            console.log(`[${requestId}][compare][${mode}] Sent pending last packet after ready`);
          }
        }
      }, 300);
    });

    state.doubaoWs.on('message', (data: Buffer) => {
      const result = parseServerResponse(data);
      if (result.type === 'response') {
        const text = result.payload?.result?.text || '';
        const duration = result.payload?.audio_info?.duration;
        const utterances = result.payload?.result?.utterances;
        console.log(`[${requestId}][compare][${mode}] ASR resp isFinal=${result.isFinal} dur=${duration} text="${text.substring(0, 80)}"`);

        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'result',
            mode,
            text,
            duration,
            isFinal: !!result.isFinal,
            utterances,
          }));
        }

        if (result.isFinal) {
          console.log(`[${requestId}][compare][${mode}] Utterance final, connection will close and auto-reconnect for next utterance`);
        }
      } else if (result.type === 'error') {
        console.log(`[${requestId}][compare][${mode}] Error from Doubao: code=${result.code} ${result.message}`);
        sendClientError(result.code || -1, result.message || 'ASR error', mode);
        cleanupMode(mode);
      }
    });

    state.doubaoWs.on('error', (err) => {
      console.log(`[${requestId}][compare][${mode}] Doubao WS error: ${err.message}`);
      sendClientError(-1, 'ASR connection error: ' + err.message, mode);
    });

    state.doubaoWs.on('close', () => {
      console.log(`[${requestId}][compare][${mode}] Doubao WS closed (closeByUs=${state.closeByUs})`);
      state.doubaoWs = null;
      state.connected = false;
      if (state.readyTimer) {
        clearTimeout(state.readyTimer);
        state.readyTimer = null;
      }
      state.readyForAudio = false;

      if (state.closeByUs) {
        // 我们主动关闭的，不重连
        state.audioBuffer = [];
        state.pendingLastPacket = false;
        if (stopping && allConnectionsClosed()) {
          stopping = false;
          started = false;
          firstAudioPacket = true;
          console.log(`[${requestId}][compare] Both connections closed after stop, ready for next start`);
        }
      } else if (started && !stopping) {
        // 豆包服务端关闭的（utterance结束），自动重连
        console.log(`[${requestId}][compare][${mode}] Server closed connection, auto-reconnecting in 200ms...`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'reconnecting', mode }));
        }
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          if (started && !stopping && clientWs.readyState === WebSocket.OPEN && appliedConfig) {
            doConnectMode(mode, appliedConfig);
          }
        }, 200);
      }
    });
  };

  const connectMode = (mode: CompareMode, baseConfig: SanitizedConfig) => {
    const state = states[mode];
    // Cancel any pending reconnect
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    // Close existing connection if any
    if (state.doubaoWs) {
      state.closeByUs = true;
      if (state.doubaoWs.readyState === WebSocket.OPEN || state.doubaoWs.readyState === WebSocket.CONNECTING) {
        try { state.doubaoWs.close(); } catch {}
      }
      state.doubaoWs = null;
    }
    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    state.audioBuffer = [];
    state.readyForAudio = false;
    state.pendingLastPacket = false;
    state.connected = false;
    doConnectMode(mode, baseConfig);
  };

  clientWs.on('message', (msg, isBinary) => {
    if (!isBinary) {
      const text = msg.toString();
      try {
        const parsed = JSON.parse(text);
        if (parsed.type === 'start') {
          if (started && !allConnectionsClosed()) {
            sendClientError(-2, 'Already started');
            return;
          }
          if (allConnectionsClosed()) {
            started = false;
            stopping = false;
          }
          started = true;
          firstAudioPacket = true;
          const sanitized = validateAndFillConfig(parsed.config || {});
          appliedConfig = sanitized;
          connectMode('two_pass', sanitized);
          connectMode('one_pass', sanitized);
        } else if (parsed.type === 'stop') {
          stopping = true;
          for (const mode of ['two_pass', 'one_pass'] as CompareMode[]) {
            const state = states[mode];
            // Cancel any pending reconnect
            if (state.reconnectTimer) {
              clearTimeout(state.reconnectTimer);
              state.reconnectTimer = null;
            }
            if (state.doubaoWs && state.doubaoWs.readyState === WebSocket.OPEN) {
              if (state.readyForAudio) {
                state.doubaoWs.send(buildLastPacket());
                console.log(`[${requestId}][compare][${mode}] Sent last packet`);
              } else {
                // 还没就绪，标记pending，等readyTimer触发后发送
                state.pendingLastPacket = true;
                console.log(`[${requestId}][compare][${mode}] Last packet queued (waiting for ready)`);
              }
            }
          }
          if (allConnectionsClosed()) {
            stopping = false;
            started = false;
            firstAudioPacket = true;
          }
        }
      } catch (e: any) {
        console.log(`[${requestId}][compare] Failed to parse client message: ${e?.message}`);
      }
    } else {
      let hasActive = false;
      for (const mode of ['two_pass', 'one_pass'] as CompareMode[]) {
        const state = states[mode];
        const buf = Buffer.from(msg as Buffer);
        if (state.doubaoWs && state.doubaoWs.readyState === WebSocket.OPEN) {
          if (state.readyForAudio) {
            state.doubaoWs.send(buildAudioRequest(buf));
          } else {
            // 配置未就绪，缓冲音频（最多500ms=16000字节）
            state.audioBuffer.push(buf);
            let totalBuffered = 0;
            for (const b of state.audioBuffer) totalBuffered += b.length;
            const MAX_AUDIO_BUFFER = 16000;
            while (totalBuffered > MAX_AUDIO_BUFFER && state.audioBuffer.length > 1) {
              const removed = state.audioBuffer.shift();
              if (removed) totalBuffered -= removed.length;
            }
          }
          hasActive = true;
        } else if (started && !stopping) {
          // 连接正在重连中（doubaoWs为null或未OPEN），继续缓冲音频
          state.audioBuffer.push(buf);
          let totalBuffered = 0;
          for (const b of state.audioBuffer) totalBuffered += b.length;
          const MAX_AUDIO_BUFFER = 16000;
          while (totalBuffered > MAX_AUDIO_BUFFER && state.audioBuffer.length > 1) {
            const removed = state.audioBuffer.shift();
            if (removed) totalBuffered -= removed.length;
          }
          hasActive = true;
        }
      }
      if (hasActive && firstAudioPacket) {
        firstAudioPacket = false;
        console.log(`[${requestId}][compare] First audio packet received, forwarding to ready connections`);
      } else if (!started) {
        console.log(`[${requestId}][compare] Received audio before start; ignoring`);
      }
    }
  });

  clientWs.on('close', () => {
    console.log(`[${requestId}][compare] Client disconnected`);
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.log(`[${requestId}][compare] Client WS error: ${err.message}`);
    cleanup();
  });
});

server.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  console.log(`Public dir: ${PUBLIC_DIR}`);
  console.log(`Summaries dir: ${SUMMARIES_DIR}`);
  console.log(`LLM configured: ${isLlmConfigured() ? 'yes (' + config.arkModel + ')' : 'NO (set ARK_API_KEY to enable)'}`);
  if (config.voiceprintEnabled) {
    const backendDesc = config.voiceprintBackend === 'selfhosted'
      ? `self-hosted open-source model @ ${config.voiceprintServiceUrl}`
      : `Tencent Cloud VPR API`;
    console.log(`Voiceprint auto-recognition: ENABLED (${backendDesc})`);
  } else {
    console.log(`Voiceprint auto-recognition: DISABLED (manual binding mode)`);
  }
});
