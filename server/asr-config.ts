export interface SanitizedConfig {
  enable_itn: boolean;
  enable_punc: boolean;
  enable_ddc: boolean;
  enable_speaker_info: boolean;
  enable_two_pass: boolean;
  max_speakers: number;
  end_window_size: number;
}

export interface ParamOption {
  value: string | number | boolean;
  label: string;
}

export interface ParamSchema {
  key: keyof SanitizedConfig;
  label: string;
  hint: string;
  type: 'bool' | 'enum' | 'number';
  default: string | number | boolean;
  options?: ParamOption[];
  min?: number;
  max?: number;
  step?: number;
  group: string;
  dependsOn?: { key: keyof SanitizedConfig; value: any };
}

export interface PublicSchema {
  groups: { id: string; label: string }[];
  params: ParamSchema[];
  defaults: SanitizedConfig;
}

const WS_URL_BIGMODEL_ASYNC = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

const GROUPS = [
  { id: 'features', label: '识别功能开关' },
  { id: 'speaker', label: '说话人分离' },
  { id: 'vad', label: 'VAD 与判停' },
];

export const PARAM_SCHEMAS: ParamSchema[] = [
  {
    key: 'enable_itn',
    label: '逆文本规整 (ITN)',
    hint: '将书面语转为阿拉伯数字/日期等规范形式（默认开启）',
    type: 'bool',
    default: true,
    group: 'features',
  },
  {
    key: 'enable_punc',
    label: '自动加标点',
    hint: '在识别结果中自动添加逗号、句号等标点符号（默认开启）',
    type: 'bool',
    default: true,
    group: 'features',
  },
  {
    key: 'enable_two_pass',
    label: '启用二遍大模型修正',
    hint: '开启后使用大模型做二遍修正，准确率更高但有延迟；关闭后仅用一遍实时流，延迟最低但可能有错字',
    type: 'bool',
    default: true,
    group: 'features',
  },
  {
    key: 'enable_ddc',
    label: 'DDC 顺滑去语气词',
    hint: '删除"嗯/啊/那个/就是"等停顿词和重复词，文本更通顺（默认开启）',
    type: 'bool',
    default: true,
    group: 'features',
  },
  {
    key: 'enable_speaker_info',
    label: '说话人分离',
    hint: '自动区分不同说话人；关闭后不返回 utterances 级结果（默认开启）',
    type: 'bool',
    default: true,
    group: 'speaker',
  },
  {
    key: 'max_speakers',
    label: '最大说话人数',
    hint: '0=自动识别；建议 2-4 分离更准确；范围 0-10，默认 0',
    type: 'number',
    default: 0,
    min: 0,
    max: 10,
    step: 1,
    group: 'speaker',
    dependsOn: { key: 'enable_speaker_info', value: true },
  },
  {
    key: 'end_window_size',
    label: '静音判停时长 (ms)',
    hint: '尾点静音检测时长，越小停顿切分越灵敏；范围 200-3000，默认 200',
    type: 'number',
    default: 200,
    min: 200,
    max: 3000,
    step: 100,
    group: 'vad',
  },
];

export function getDefaultConfig(): SanitizedConfig {
  const cfg: any = {};
  for (const p of PARAM_SCHEMAS) {
    cfg[p.key] = p.default;
  }
  return cfg as SanitizedConfig;
}

function clamp(v: number, min: number, max: number): number {
  if (isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

export function validateAndFillConfig(input: any): SanitizedConfig {
  const def = getDefaultConfig();
  const out: any = { ...def };
  if (!input || typeof input !== 'object') return out;

  for (const p of PARAM_SCHEMAS) {
    const key = p.key;
    const v = input[key];
    if (v === undefined || v === null) continue;

    if (p.type === 'bool') {
      out[key] = v === true || v === 'true' || v === 1 || v === '1';
    } else if (p.type === 'enum') {
      const allowed = (p.options || []).map(o => String(o.value));
      const sv = String(v);
      if (allowed.indexOf(sv) >= 0) out[key] = sv as any;
    } else if (p.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      out[key] = clamp(Math.round(n), p.min ?? 0, p.max ?? Infinity);
    }
  }

  return out as SanitizedConfig;
}

export interface DoubaoConnection {
  wsUrl: string;
  payload: any;
}

export function buildDoubaoConnection(config: SanitizedConfig, boostingTableId?: string): DoubaoConnection {
  const wsUrl = WS_URL_BIGMODEL_ASYNC;

  const request: any = {
    model_name: 'bigmodel',
    enable_itn: !!config.enable_itn,
    enable_punc: !!config.enable_punc,
    result_type: 'single',
    end_window_size: config.end_window_size,
    force_to_speech_time: 1000,
    show_utterances: true,
  };

  // 二遍大模型修正：enable_nonstream=true 启用二遍
  if (config.enable_two_pass !== false) {
    request.enable_nonstream = true;
  }

  if (config.enable_ddc) request.enable_ddc = true;

  if (config.enable_speaker_info) {
    request.enable_speaker_info = true;
    request.ssd_version = '200';
    if (config.max_speakers > 0) {
      request.max_speakers = config.max_speakers;
    }
  }

  // 热词表（L1基础词库，从火山引擎控制台管理）
  if (boostingTableId && boostingTableId.trim().length > 0) {
    request.corpus = {
      ...(request.corpus || {}),
      boosting_table_id: boostingTableId.trim(),
    };
  }

  const payload = {
    user: { uid: 'web-demo-user', platform: 'web' },
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    request,
  };

  return { wsUrl, payload };
}

export function getPublicSchema(): PublicSchema {
  const params = PARAM_SCHEMAS.map(p => ({ ...p }));
  return {
    groups: GROUPS.map(g => ({ ...g })),
    params,
    defaults: getDefaultConfig(),
  };
}
