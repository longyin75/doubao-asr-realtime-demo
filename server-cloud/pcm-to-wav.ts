const SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const BYTE_RATE = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8;
const BLOCK_ALIGN = CHANNELS * BITS_PER_SAMPLE / 8;

export function pcmToWav(pcmBuffer: Buffer): Buffer {
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(BYTE_RATE, 28);
  buffer.writeUInt16LE(BLOCK_ALIGN, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcmBuffer.copy(buffer, 44);

  return buffer;
}

export function pcmDurationMs(pcmBuffer: Buffer): number {
  const bytesPerMs = SAMPLE_RATE * 2 / 1000;
  return Math.floor(pcmBuffer.length / bytesPerMs);
}

export function estimateVoiceActivity(pcmBuffer: Buffer, threshold: number = 500): { voiced: Buffer; durationMs: number } {
  const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const chunks: Buffer[] = [];
  const chunkSize = 160;

  for (let i = 0; i < int16.length; i += chunkSize) {
    let sum = 0;
    const end = Math.min(i + chunkSize, int16.length);
    for (let j = i; j < end; j++) {
      sum += Math.abs(int16[j]);
    }
    const avg = sum / (end - i);
    if (avg > threshold) {
      const start = i * 2;
      const len = (end - i) * 2;
      chunks.push(pcmBuffer.slice(start, start + len));
    }
  }

  const voiced = Buffer.concat(chunks);
  return { voiced, durationMs: pcmDurationMs(voiced) };
}
