import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { buildFullClientRequest, buildAudioRequest, buildLastPacket, parseServerResponse } from './asr-protocol';
import { getPublicSchema, validateAndFillConfig, buildDoubaoConnection, SanitizedConfig, HotwordConfig } from './asr-config';
import { encodePcm16kMonoToMp3 } from './mp3-encoder';

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

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`[cloud] Created recordings directory: ${RECORDINGS_DIR}`);
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

  if (method !== 'GET') {
    res.writeHead(404);
    res.end();
    return;
  }

  if (urlPath.startsWith('/recordings/')) {
    const rel = urlPath.slice('/recordings/'.length).replace(/\.\./g, '').replace(/^\//, '');
    if (!rel || !rel.endsWith('.mp3')) { res.writeHead(404); res.end(); return; }
    const filePath = path.join(RECORDINGS_DIR, rel);
    if (!filePath.startsWith(RECORDINGS_DIR)) { res.writeHead(403); res.end(); return; }
    serveStatic(req, res, filePath, MIME['.mp3']);
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
  // 使用 requestId 作为初始会话追踪 ID（也作为 X-Api-Connect-Id 传给豆包）
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
  let mp3EncodingTriggered = false;
  let clientStillConnected = true;

  const triggerMp3Encoding = () => {
    if (mp3EncodingTriggered) return;
    mp3EncodingTriggered = true;

    if (pcmChunks.length === 0 || totalPcmBytes === 0) {
      console.log(`[${requestId}] No PCM data to encode, skipping MP3 generation`);
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
    const filename = `rec_${shortUuid}_${timestamp}.mp3`;
    const outputPath = path.join(RECORDINGS_DIR, filename);

    console.log(`[${requestId}] Starting MP3 encoding: ${filename}, duration=${durationMs}ms, bytes=${totalPcmBytes}`);

    (async () => {
      try {
        const mp3Buffer = await encodePcm16kMonoToMp3(pcmBuffer);
        fs.writeFileSync(outputPath, mp3Buffer);
        console.log(`[${requestId}] MP3 saved: ${outputPath}, size=${mp3Buffer.length} bytes`);

        if (clientStillConnected && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'recording_ready',
            url: '/recordings/' + filename,
            durationMs,
          }));
        }
      } catch (err: any) {
        console.log(`[${requestId}] MP3 encoding failed: ${err?.message}`);
        console.log(err?.stack);
      }
    })();
  };

  const cleanup = () => {
    if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
      try { doubaoWs.close(); } catch {}
    }
    doubaoWs = null;
    started = false;
    triggerMp3Encoding();
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
    mp3EncodingTriggered = false;
    appliedConfig = sanitized;
    firstAudioPacket = true;
    sessionStartAt = Date.now();
    // 每次新会话生成新的追踪 ID
    const sessionId = crypto.randomUUID();
    logid = sessionId;
    doubaoLogid = '';

    const { wsUrl, payload } = buildDoubaoConnection(sanitized, hotwordConfig, config.asrBoostingTableId);
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
      // 立即发送 connected，使用 requestId 作为初始 logid
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'connected',
          appliedConfig: sanitized,
          logid,
          voiceprintEnabled: false,
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

        clientWs.send(JSON.stringify({
          type: 'result',
          text,
          duration,
          isFinal: !!result.isFinal,
          utterances,
          speakerOverrides: {},
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

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Cloud relay server running at http://0.0.0.0:${config.port}`);
  console.log(`Cloud public dir: ${CLOUD_PUBLIC_DIR}`);
  console.log(`Recordings dir: ${RECORDINGS_DIR}`);
  console.log(`Max PCM buffer: ${config.maxPcmBytes} bytes (≈ ${Math.round(config.maxPcmBytes / 2 / 16000)} seconds)`);
});
