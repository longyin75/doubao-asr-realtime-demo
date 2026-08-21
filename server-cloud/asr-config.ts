export interface HotwordConfig {
  hotwords?: string[];
  correct_words?: Record<string, string>;
}

export interface SanitizedConfig {
  enable_itn: boolean;
  enable_punc: boolean;
  enable_ddc: boolean;
  enable_speaker_info: boolean;
  end_window_size: number;
}

export const DEFAULT_HOTWORDS: string[] = [
  '陈明辉','李思远','王雨桐','张文博','赵梦琪','刘天阳','孙雅婷','周浩然',
  'ASR会议转写','实时语音识别','豆包大模型','Doubao-Seed-ASR','Seed-ASR-2.0',
  '语音转写','实时转写','会议纪要','说话人分离','声纹识别','声纹注册',
  'VAD端点检测','降噪','回声消除','自动增益控制','AGC',
  '热词','替换词','标点恢复','顺滑去语气词','DDC','逆文本规整','ITN',
  '二遍识别','非流式修正','N-gram语言模型','端到端模型',
  'WebSocket长连接','二进制协议','音频帧','PCM','OPUS编码','采样率16kHz',
  '首字延迟','尾字延迟','TTFT','RTF','字错率','CER','识别准确率',
  '并发连接数','QPS','Nginx反向代理','路径剥离','PM2进程管理',
  'Docker容器化','K8s编排','水平扩展','负载均衡','TLS握手','WSS安全连接',
  '录音回放','MP3编码','LAME编码器','分片上传','断点续传',
  '云端中转','客户端直连','网关鉴权','API Key','Access Key','App Key',
  '技术评审','架构设计','PRD评审','灰度上线','全量发布','回滚预案',
  '压测报告','MVP版本','V1.0','里程碑','交付节点','技术债','风险项','阻塞问题',
];

export const DEFAULT_CORRECT_WORDS: Record<string, string> = {
  'T T F T': 'TTFT', 'T T F B': 'TTFB', '首字节时间': 'TTFB', '首字时间': 'TTFT',
  '西伊啊尔': 'CER', '字错误率': 'CER', '啊尔提艾弗': 'RTF', '实时率': 'RTF',
  '克呦皮艾斯': 'QPS', '每秒查询': 'QPS',
  '阿皮克以': 'API Key', '阿皮可以': 'API Key',
  '艾克赛斯克以': 'Access Key', '艾克赛斯可以': 'Access Key',
  '艾普克以': 'App Key',
  '诶皮爱': 'API', '皮啊儿抵': 'PRD', '哦克啊': 'OKR', '诶斯迪开': 'SDK',
  'M V P': 'MVP', '微一皮': 'MVP',
  '威斯克特': 'WebSocket', 'websocket': 'WebSocket',
  '道克': 'Docker', '达克': 'Docker',
  '开八茨': 'K8s', '库伯奈茨': 'Kubernetes', '库伯奈提斯': 'Kubernetes',
  '恩进克斯': 'Nginx', '英克斯': 'Nginx', '诺克': 'Nginx',
  '皮埃姆二': 'PM2', '皮姆图': 'PM2',
  'W S S': 'WSS', 'W S': 'WS',
  '皮西姆': 'PCM', '欧普斯': 'OPUS', '莱姆': 'LAME', '雷姆': 'LAME',
  '瓦德': 'VAD', '威艾迪': 'VAD',
  '艾提恩': 'ITN', '迪迪西': 'DDC', 'A G C': 'AGC', '艾及西': 'AGC',
  '替艾欧': 'TTS', 'N格拉姆': 'N-gram', 'N克然姆': 'N-gram',
  '端到端的': '端到端', '端对端': '端到端',
  '佛兰金': 'Flask', '凡果': 'FastAPI', '法斯特API': 'FastAPI',
  '瑞迪斯': 'Redis', '卡夫卡': 'Kafka', '格瑞pc': 'gRPC',
  '普若米修斯': 'Prometheus', '格拉法纳': 'Grafana',
  '布软驰': 'branch', '卡米特': 'commit', '康米特': 'commit',
  '普尔瑞奎斯特': 'PR', '普尔': 'PR',
  '迈尔斯通': 'milestone', '斯普林特': 'Sprint',
  '拜格默德尔': 'bigmodel', '比格默德尔': 'bigmodel',
  '赛德啊斯啊': 'Seed-ASR', '西的啊斯啊': 'Seed-ASR', 'seedasr': 'Seed-ASR',
  '道包': '豆包', '逗包': '豆包',
  '灰读': '灰度', '灰度发不': '灰度发布',
  '回滚预案': '回滚预案', '回溯预案': '回滚预案',
  '压测': '压测', '鸭测': '压测', '负载测': '压测',
  '鉴全': '鉴权', '鉴权啊': '鉴权',
  '撰写': '转写', '声文': '声纹',
  '说话分离': '说话人分离',
  '端的检测': '端点检测', '断点检测': '端点检测',
};

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

export function buildDoubaoConnection(config: SanitizedConfig, hotwordConfig?: HotwordConfig, boostingTableId?: string): DoubaoConnection {
  const wsUrl = WS_URL_BIGMODEL_ASYNC;

  const request: any = {
    model_name: 'bigmodel',
    enable_itn: !!config.enable_itn,
    enable_punc: !!config.enable_punc,
    result_type: 'single',
    end_window_size: config.end_window_size,
    force_to_speech_time: 1000,
    show_utterances: true,
    enable_nonstream: true,
  };

  if (config.enable_ddc) request.enable_ddc = true;

  if (config.enable_speaker_info) {
    request.enable_speaker_info = true;
    request.ssd_version = '200';
  }

  const hotwords = hotwordConfig?.hotwords && hotwordConfig.hotwords.length > 0
    ? hotwordConfig.hotwords
    : DEFAULT_HOTWORDS;
  const correctWords = hotwordConfig?.correct_words && Object.keys(hotwordConfig.correct_words).length > 0
    ? hotwordConfig.correct_words
    : DEFAULT_CORRECT_WORDS;

  const contextObj: any = {
    hotwords: hotwords.map(w => ({ word: w })),
    context_type: 'dialog_ctx',
    context_data: [
      { text: '当前是ASR会议转写产品的技术评审会，讨论实时语音识别、豆包大模型、说话人分离、声纹识别、云端中转架构等技术方案' },
    ],
  };

  const corpus: any = {
    context: JSON.stringify(contextObj),
    correct_words: JSON.stringify(correctWords),
  };

  // 热词表（L1基础词库，从火山引擎控制台管理）
  if (boostingTableId && boostingTableId.trim().length > 0) {
    corpus.boosting_table_id = boostingTableId.trim();
  }

  request.corpus = corpus;

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
