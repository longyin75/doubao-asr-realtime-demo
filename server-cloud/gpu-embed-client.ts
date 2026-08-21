import * as http from 'http';
import { config } from './config';

export class GpuEmbedClient {
  private url: string;
  private timeout: number;
  private agent: http.Agent;
  private healthUrl: string;

  constructor(url: string, timeout: number) {
    this.url = url;
    this.timeout = timeout;
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
    });
    const urlObj = new URL(url);
    this.healthUrl = `${urlObj.protocol}//${urlObj.host}/healthz`;
  }

  async extractEmbedding(audioBuffer: Buffer, format: 'pcm' | 'wav' = 'pcm'): Promise<{ embedding: Float32Array; duration_ms: number }> {
    const audio_b64 = audioBuffer.toString('base64');
    const body = JSON.stringify({ audio_b64, format });

    return new Promise<{ embedding: Float32Array; duration_ms: number }>((resolve, reject) => {
      const urlObj = new URL(this.url);
      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        agent: this.agent,
        timeout: this.timeout,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            const json = JSON.parse(data);
            if (!json.embedding || !Array.isArray(json.embedding)) {
              reject(new Error('Invalid response: embedding not found or not an array'));
              return;
            }
            const embedding = new Float32Array(json.embedding);
            if (embedding.length !== 192) {
              reject(new Error(`Expected embedding length 192, got ${embedding.length}`));
              return;
            }
            const duration_ms = typeof json.duration_ms === 'number' ? json.duration_ms : 0;
            resolve({ embedding, duration_ms });
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  async healthCheck(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const urlObj = new URL(this.healthUrl);
      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: 'GET',
        agent: this.agent,
        timeout: this.timeout,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(res.statusCode === 200);
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }
}

export const gpuEmbedClient = new GpuEmbedClient(config.voiceprintEmbedUrl, config.voiceprintHttpTimeoutMs);
