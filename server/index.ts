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

  if (method !== 'GET') {
    res.writeHead(404);
    res.end();
    return;
  }

  let filePath: string;
  let contentType: string;

  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
    contentType = MIME['.html'];
  } else if (urlPath === '/style.css') {
    filePath = path.join(PUBLIC_DIR, 'style.css');
    contentType = MIME['.css'];
  } else if (urlPath === '/app.js') {
    filePath = path.join(PUBLIC_DIR, 'app.js');
    contentType = MIME['.js'];
  } else {
    res.writeHead(404);
    res.end();
    return;
  }

  serveStatic(req, res, filePath, contentType);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (!url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (clientWs: WebSocket) => {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] Client connected`);

  let doubaoWs: WebSocket | null = null;
  let appliedConfig: SanitizedConfig | null = null;
  let logid = '';
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

    const { wsUrl, payload } = buildDoubaoConnection(sanitized, config.asrBoostingTableId);
    console.log(`[${requestId}] Connecting to Doubao ASR at ${wsUrl}, config=${JSON.stringify(sanitized)}`);
    if (config.asrBoostingTableId) {
      console.log(`[${requestId}] Hotword boosting table enabled: ${config.asrBoostingTableId}`);
    }
    console.log(`[${requestId}] Full client request payload: ${JSON.stringify(payload)}`);

    // 构建鉴权 headers，按飞书文档支持两种方式：
    // 方式一：X-Api-Key
    // 方式二：X-Api-App-Id + X-Api-Access-Key
    const authHeaders: Record<string, string> = {
      'X-Api-Resource-Id': config.resourceId,
      'X-Api-Connect-Id': requestId,
    };
    if (config.appKey && config.accessKey && config.accessKey !== config.apiKey) {
      // 方式二：App ID + Access Key
      authHeaders['X-Api-App-Id'] = config.appKey;
      authHeaders['X-Api-Access-Key'] = config.accessKey;
      console.log(`[${requestId}] Using auth method: App ID + Access Key`);
    } else if (config.apiKey) {
      // 方式一：API Key
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
      for (const h of headers) {
        if (h.toLowerCase().startsWith('x-tt-logid:')) {
          logid = h.substring('x-tt-logid:'.length).trim();
        }
      }
    });

    doubaoWs.on('open', () => {
      console.log(`[${requestId}] Connected to Doubao ASR, logid: ${logid}`);
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

        // Chunk audio to safe frame size (max 32KB per frame for Doubao protocol)
        const MAX_FRAME_SIZE = 32 * 1024;
        for (let offset = 0; offset < buf.length; offset += MAX_FRAME_SIZE) {
          const end = Math.min(offset + MAX_FRAME_SIZE, buf.length);
          const chunk = buf.subarray(offset, end);
          doubaoWs.send(buildAudioRequest(chunk));
        }

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
