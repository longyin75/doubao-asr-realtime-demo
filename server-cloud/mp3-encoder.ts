const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const DEFAULT_BITRATE = 128;

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

function pcmInt16ToFloat32(pcmBuffer: Buffer): Float32Array {
  const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export async function encodePcm16kMonoToMp3(pcmBuffer: Buffer, bitrate?: number): Promise<Buffer> {
  const mp3EncoderModule = await dynamicImport('@audio/encode-mp3');
  const mp3EncoderFactory = (mp3EncoderModule as any).default || mp3EncoderModule;

  const float32Data = pcmInt16ToFloat32(pcmBuffer);
  const encoderBitrate = bitrate || DEFAULT_BITRATE;

  const encoder = await mp3EncoderFactory({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitrate: encoderBitrate,
  });

  const chunks: Buffer[] = [];
  const chunkSize = 1152;

  for (let i = 0; i < float32Data.length; i += chunkSize) {
    const chunk = float32Data.subarray(i, Math.min(i + chunkSize, float32Data.length));
    const encoded = encoder.encode([chunk]);
    if (encoded && encoded.length > 0) {
      chunks.push(Buffer.from(encoded));
    }
  }

  const tail = encoder.flush();
  if (tail && tail.length > 0) {
    chunks.push(Buffer.from(tail));
  }

  if (encoder.free) {
    encoder.free();
  }

  return Buffer.concat(chunks);
}
