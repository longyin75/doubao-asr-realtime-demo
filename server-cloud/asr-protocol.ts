const MSG_FULL_CLIENT_REQUEST = 0b0001;
const MSG_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_FULL_SERVER_RESPONSE = 0b1001;
const MSG_ERROR_RESPONSE = 0b1111;

const FLAG_NONE = 0b0000;
const FLAG_POS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKET = 0b0010;

export interface ParsedResponse {
  type: 'response' | 'error';
  payload?: any;
  isFinal?: boolean;
  code?: number;
  message?: string;
}

export function buildFullClientRequest(payload: object): Buffer {
  const payloadJson = JSON.stringify(payload);
  const payloadBuf = Buffer.from(payloadJson, 'utf-8');
  const byte1 = (MSG_FULL_CLIENT_REQUEST << 4) | FLAG_NONE;
  const header = Buffer.from([0x11, byte1, 0x10, 0x00]);
  const sizeBE = Buffer.alloc(4);
  sizeBE.writeUInt32BE(payloadBuf.length, 0);
  return Buffer.concat([header, sizeBE, payloadBuf]);
}

export function buildAudioRequest(audioData: Buffer): Buffer {
  const byte1 = (MSG_AUDIO_ONLY_REQUEST << 4) | FLAG_NONE;
  const header = Buffer.from([0x11, byte1, 0x10, 0x00]);
  const sizeBE = Buffer.alloc(4);
  sizeBE.writeUInt32BE(audioData.length, 0);
  return Buffer.concat([header, sizeBE, audioData]);
}

export function buildLastPacket(): Buffer {
  const byte1 = (MSG_AUDIO_ONLY_REQUEST << 4) | FLAG_LAST_PACKET;
  const header = Buffer.from([0x11, byte1, 0x10, 0x00]);
  const sizeBE = Buffer.alloc(4);
  sizeBE.writeUInt32BE(0, 0);
  return Buffer.concat([header, sizeBE]);
}

export function parseServerResponse(data: Buffer): ParsedResponse {
  if (data.length < 8) {
    return { type: 'error', code: -1, message: 'Response too short' };
  }

  const byte0 = data[0];
  const byte1 = data[1];
  const serialization = (data[2] >> 4) & 0x0F;

  const headerSize = (byte0 & 0x0F) * 4;
  const msgType = (byte1 >> 4) & 0x0F;
  const flags = byte1 & 0x0F;
  const hasSequence = (flags & 0x01) === 0x01;
  const isLast = (flags & 0x02) === 0x02;

  let offset = headerSize;

  if (hasSequence) {
    if (data.length < offset + 4) {
      return { type: 'error', code: -1, message: 'Response too short for sequence' };
    }
    offset += 4;
  }

  if (data.length < offset + 4) {
    return { type: 'error', code: -1, message: 'Response too short for payload size' };
  }
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;

  if (payloadSize > 10 * 1024 * 1024) {
    return { type: 'error', code: -1, message: `Payload size too large: ${payloadSize}` };
  }

  if (data.length < offset + payloadSize) {
    return { type: 'error', code: -1, message: `Response payload truncated: expected ${payloadSize}, got ${data.length - offset}` };
  }

  const payloadBuf = data.slice(offset, offset + payloadSize);

  if (serialization !== 1) {
    return { type: 'error', code: -1, message: `Unsupported serialization: ${serialization}` };
  }

  let payloadJson: any;
  try {
    payloadJson = JSON.parse(payloadBuf.toString('utf-8'));
  } catch (e) {
    return { type: 'error', code: -1, message: `Failed to parse response JSON: ${(e as Error).message}` };
  }

  if (msgType === MSG_FULL_SERVER_RESPONSE) {
    return { type: 'response', payload: payloadJson, isFinal: isLast };
  }
  if (msgType === MSG_ERROR_RESPONSE) {
    return {
      type: 'error',
      code: payloadJson.code || payloadJson.status_code || -1,
      message: payloadJson.message || payloadJson.error || 'Unknown error'
    };
  }
  return { type: 'error', code: -1, message: `Unknown message type: ${msgType}` };
}
