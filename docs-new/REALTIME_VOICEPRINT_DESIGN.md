# 实时字幕声纹匹配功能规格说明书

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| v1.0 | 2026-08-20 | Trae AI | 初始版本 |
| v2.0 | 2026-08-20 | Trae AI | GPU部署方案，四层匹配策略，量化性能指标 |
| v3.0 | 2026-08-20 | Trae AI | **GPU环境实勘完成**：V100已有CAM++服务运行；支持100人注册；详细前端字幕替换逻辑；架构大幅简化 |
| v4.0 | 2026-08-21 | Trae AI | **声纹库持久化**：本地声纹embedding JSON文件持久化，PM2重启自动加载，增删实时同步写入 |
| v5.0 | 2026-08-21 | Trae AI | **架构反转：声纹为最终裁判**——修复ASR speaker_id标签漂移导致名字张冠李戴的核心bug；每个definite utt独立声纹校验+漂移检测纠正机制；动态重映射speaker槽位 |

---

## 0. GPU环境实勘报告（2026-08-20）

### 0.1 硬件与系统

| 项 | 实勘值 | 备注 |
|----|--------|------|
| GPU型号 | **Tesla V100-SXM2-32GB** | 非A10，V100推理性能同样足够 |
| NVIDIA驱动 | 550.144.03 | CUDA 12.4 |
| 显存总量 | 32768MiB (32GB) | |
| 显存已用 | ~10881MiB (10.6GB) | 其他业务占用（8188端口python服务占~10GB，voiceprint占494MB） |
| 显存可用 | ~21.8GB | 完全满足需求 |
| 系统内存 | 31GB（已用14GB，可用16GB） | |
| 系统盘 | 49GB（已用39GB，可用8.1GB，83%使用率） | 注意磁盘清理 |
| Python版本 | 3.10.12（venv内） | |

### 0.2 已部署声纹服务现状

**重大发现：GPU节点 `/opt/voiceprint-embedder` 已部署目标模型并正常运行！**

| 项 | 实勘值 |
|----|--------|
| 模型 | 3D-Speaker CAM++ `iic/speech_campplus_sv_zh-cn_16k-common` v2.0.2 |
| 运行状态 | ✅ 在线（从2026-07-27运行至今） |
| 监听端口 | **8002**（注意：不是原计划的8001） |
| 运行设备 | **CUDA（GPU加速正常）** |
| 进程管理 | 裸uvicorn启动（非PM2），命令：`cd /opt/voiceprint-embedder && source venv/bin/activate && MODELSCOPE_CACHE=/opt/voiceprint-embedder/models uvicorn app:app --host 0.0.0.0 --port 8002 --workers 1` |
| PyTorch版本 | venv内2.5.1+cu121（CUDA可用），系统python3为2.12+cu130（不兼容，不影响服务） |
| Embedding维度 | **192维**（L2归一化） |
| 实测单条推理耗时 | **45-50ms**（3秒音频，CUDA模式，日志实测） |
| 现有接口 | `GET /healthz`、`POST /embed`（单条embedding提取）、`POST /embed-batch`（批量embedding提取） |
| txcvm→gpu网络连通性 | ✅ 正常，内网千兆，延迟<1ms |
| 显存占用 | 494MiB |

### 0.3 方案影响与调整

1. **无需在GPU节点部署任何新代码**：现有/embed接口完全满足embedding提取需求
2. **声纹库和匹配逻辑全部放在Node.js侧（txcvm）**：GPU只做纯embedding提取，职责单一
3. **不需要GPU侧批处理worker**：Node.js并发调用/embed即可，V100单条45ms，4人并发总耗时<100ms
4. **端口改为8002**：避免与现有服务冲突
5. **性能指标基于V100实测值校准**

### 0.4 其他端口占用情况

| 端口 | 服务 | 备注 |
|------|------|------|
| 22 | SSH | |
| 8000 | 其他python服务 | 避免使用 |
| 8001 | Docker容器（docker-proxy） | 避免使用 |
| **8002** | **voiceprint-embedder（我们要用）** | ✅ 已有服务 |
| 8188 | 其他python服务（占10GB显存） | 避免使用 |

---

## 1. 项目目标

### 1.1 核心目标
在现有录音文件识别（AUC）已支持声纹姓名的基础上，为**实时双向流式ASR字幕**提供说话人姓名自动识别能力，复用GPU节点已部署的CAM++声纹模型，在Node.js侧实现四层递进式匹配策略，实现会议场景下的实时说话人标注。

### 1.2 非目标（本期不做）
- ❌ 不做说话人分离（Diarization）：完全依赖火山ASR返回的`speaker_id`聚类结果
- ❌ 不做声纹库迁移：字节云端已有声纹不自动迁移，用户需重新注册
- ❌ 不做降级/容灾：声纹服务单点部署在GPU节点，服务不可用时实时字幕仅显示数字编号，不影响ASR核心功能
- ❌ 不修改GPU节点现有服务：不升级、不重启、不改代码，完全复用现有/embed接口

---

## 2. 系统约束与性能指标（量化）

### 2.1 功能约束
| 约束项 | 指标值 | 说明 |
|--------|--------|------|
| **最大支持注册声纹数** | ≤ 100人 | Node.js内存暴力余弦计算100×192维<1ms，完全无压力；超过100人误识率上升 |
| **单场会议最大说话人数** | ≤ 6人 | 超过6人时火山ASR聚类稳定性下降，新speaker自动标记为"参会人X"，仅支持手动绑定 |
| **声纹注册音频最短时长** | ≥ 15秒 | 必须15秒以上有效语音，确保注册embedding质量，提高识别准确率 |
| **声纹注册音频推荐时长** | 30-60秒 | 越长注册质量越高，建议包含不同语速和语调 |
| **实时识别最短音频要求** | ≥ 800ms 净语音 | VAD过滤后有效语音不足800ms不触发匹配，避免超短音频误判 |
| **声纹库双写一致性** | 最终一致 | 字节云端注册成功即返回，本地embedding提取失败打日志不阻断，但标记为`realtimeEnabled: false` |

### 2.2 性能指标（基于Tesla V100实勘数据）
| 指标 | 目标值 | 测量条件 |
|------|--------|---------|
| **首次识别延迟（p50）** | ≤ 2.0秒 | 从用户开始说话到徽章显示姓名的端到端时间（特征明显的说话人第一句话识别） |
| **首次识别延迟（p95）** | ≤ 4.0秒 | 普通说话人2-3句话后识别 |
| **首次识别延迟（p99）** | ≤ 5.0秒 | 最坏情况硬截止，5秒内必须给出结果或标记低置信度 |
| **单次embedding提取耗时（GPU侧）** | 45-55ms | V100 CUDA实测，3秒以内音频 |
| **端到端单次匹配总耗时** | 60-80ms | 含：PCM提取→base64编码→内网HTTP传输→GPU推理→JSON返回→余弦相似度计算（txcvm内网到gpu延迟<1ms） |
| **Node.js侧100人声纹余弦计算** | < 1ms | 纯JS暴力计算，100×192浮点运算可忽略 |
| **并发匹配支持** | ≥ 6路并发 | 6人同时说话时，并发6个HTTP请求，V100串行推理总耗时≤300ms（用户无感知） |
| **声纹库内存占用（Node.js）** | < 100KB | 100人 × 192维 × 4字节 ≈ 77KB，完全忽略 |
| **GPU显存额外占用** | 0MB | 复用现有服务，不需要额外显存 |

### 2.3 准确率指标（实验室环境）
| 场景 | 准确率目标 | 条件 |
|------|-----------|------|
| **安静环境、2人对话** | ≥ 95% | 注册音频≥15秒，质量良好无背景噪音 |
| **安静环境、4人讨论** | ≥ 88% | |
| **办公室环境（有背景噪声）** | ≥ 80% | |
| **声音高度相似场景** | ≥ 65% | 允许用户手动绑定兜底，第四层超时强制匹配 |
| **快速轮次问答（每人1-2秒短句）** | ≥ 85% | 四层递进策略+互斥约束优化场景 |

---

## 3. 部署架构（简化版）

### 3.1 拓扑结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户浏览器（公网）                                                  │
│  https://longer8888.tech/asr-demo-multi/                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS / WSS
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  txcvm 公网节点（现有服务，无需新增系统依赖）                        │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Nginx :443  →  Node.js :3001（PM2: doubao-asr-cloud）        │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  server-cloud/index.ts                                  │  │ │
│  │  │  ├─ 火山ASR WebSocket代理（已有）                       │  │ │
│  │  │  ├─ 环形音频缓冲区（已有，复用）                        │  │ │
│  │  │  ├─ RealtimeSpeakerMatcher 四层匹配状态机（新增）       │  │ │
│  │  │  │   └─ 内存声纹库 Map<name, embedding(192维)>          │  │ │
│  │  │  │   └─ Per-speaker状态机 + 增量embedding聚合          │  │ │
│  │  │  │   └─ 1:N余弦相似度计算（纯JS，<1ms）                 │  │ │
│  │  │  ├─ 声纹双写逻辑（修改现有注册接口）                    │  │ │
│  │  │  └─ WebSocket字幕事件广播 + 说话人更新回溯通知          │  │ │
│  │  └───────────────────────────┬─────────────────────────────┘  │ │
│  └──────────────────────────────┼────────────────────────────────┘ │
                                 │ HTTP 内网（千兆，延迟<1ms）
                                 │ POST /embed（base64 PCM/WAV → 192维embedding）
                                 │ （已有服务，不修改、不重启）
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  gpu 内网节点（Tesla V100-32GB，已有服务，零修改）                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  uvicorn :8002 （/opt/voiceprint-embedder，已运行24天）       │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  3D-Speaker CAM++ 声纹模型（CUDA加速，已加载）          │  │ │
│  │  │  ✅ 单条embedding提取: 45-50ms（实测）                 │  │ │
│  │  │  ✅ 支持批量/embed-batch接口                            │  │ │
│  │  │  ❌ 无声纹库、无匹配逻辑（Node.js侧负责）              │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  SSH别名: ssh gpu                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 服务职责划分（简化后）

| 服务 | 部署位置 | 职责 | 修改状态 |
|------|---------|------|---------|
| Nginx | txcvm | 公网HTTPS终止、静态文件、反向代理 | 无需修改 |
| **Node.js (doubao-asr-cloud)** | txcvm | ASR协议处理、环形缓冲、**四层匹配状态机、声纹库管理、余弦计算、WebSocket事件广播、声纹双写、字幕回溯更新** | 需要修改 |
| **voiceprint-embedder** | gpu节点 | 纯embedding提取：输入音频→输出192维L2归一化向量 | ✅ 已有，**零修改** |
| 火山SAUC | 公网 | 双向流式ASR、说话人聚类（返回数字speaker_id） | 已有，无需修改 |
| 字节openspeech | 公网 | 录音文件识别声纹、声纹CRUD管理（主存储） | 已有，无需修改 |

### 3.3 网络安全
- GPU节点8002端口已绑定`0.0.0.0`，txcvm内网可直接访问
- 声纹音频base64仅在内网传输，不经过公网
- GPU服务不暴露公网入口

---

## 4. 四层实时匹配策略

针对快速轮次对话场景（如问答"办了吗？""办了"），设计四层递进式匹配策略，在速度和准确率间取平衡。**所有匹配逻辑在Node.js侧实现，GPU只做embedding提取。**

### 4.1 第一层：高置信度早停（Early Stopping）

**触发时机**：每个`definite=true`分句到达时立即触发，不等待音频积累。

**处理流程**：
```typescript
// Node.js侧逻辑
onDefiniteUtterance(speakerId: number, pcmBuffer: Buffer, voicedMs: number) {
  if (voicedMs < MIN_UTT_MS) return; // <800ms跳过
  if (speakerStates[speakerId].status === 'matched' || 
      speakerStates[speakerId].status === 'manual_bound') return; // 已匹配跳过

  // 1. 调用GPU /embed接口提取embedding（45-50ms）
  const emb = await extractEmbedding(pcmBuffer);

  // 2. Node.js侧计算余弦相似度（<1ms）
  const results = cosineSearch(emb, speakerDB);
  const [top1, top2] = results;

  // 3. 早停判断
  if (top1.score >= EARLY_STOP_SCORE && (top1.score - top2.score) >= SCORE_MARGIN) {
    // ✅ 置信度极高 + 领先第二名25分以上 → 直接确认
    confirmMatch(speakerId, top1.name, top1.score, 'early_stop');
  } else {
    // 保存为候选，进入第二层
    saveCandidate(speakerId, emb, voicedMs, top1);
  }
}
```

**设计理由**：
- 注册音频质量好、说话人特征明显时，第一句话（800ms-1.5秒）就能高置信度识别
- "领先25分"的条件有效防止误匹配：必须把第二名远远甩开才算数
- 预计覆盖~60%的场景

### 4.2 第二层：增量Embedding聚合（Incremental Aggregation）

**触发时机**：早停未确认时，同一speaker_id的下一个definite分句到达。

**核心算法**：为每个speaker维护按时长加权的平均embedding，等价于用更长音频识别。

```typescript
// Node.js侧
function mergeEmbedding(prev: Float32Array, newEmb: Float32Array, prevMs: number, newMs: number): Float32Array {
  const alpha = prevMs / (prevMs + newMs);
  const merged = new Float32Array(192);
  for (let i = 0; i < 192; i++) {
    merged[i] = alpha * prev[i] + (1 - alpha) * newEmb[i];
  }
  // L2归一化
  let norm = 0;
  for (let i = 0; i < 192; i++) norm += merged[i] * merged[i];
  norm = Math.sqrt(norm) + 1e-8;
  for (let i = 0; i < 192; i++) merged[i] /= norm;
  return merged;
}
```

**处理流程**：
```
同一speaker_id新分句到达:
  1. 提取new_emb（GPU，45ms）
  2. 与已有avg_emb做时长加权合并
  3. 用merged_emb重新计算相似度
  4. 如果连续2次top1是同一人且分数≥80 → 确认
  5. 否则继续等待下一分句
```

**设计理由**：
- 准确率随说话时长单调上升
- "连续两次同一人+分数上升"避免单次误判
- 预计覆盖~30%的场景

### 4.3 第三层：互斥约束全局过滤（Mutual Exclusion）

**触发时机**：每次相似度计算后，应用全局约束。

**约束规则**：
1. **人名唯一性**：一场会议一个名字只能绑一个speaker_id。已绑定名字自动从候选集排除
2. **已绑定跳过**：matched/manual_bound状态speaker直接跳过匹配，零开销
3. **未注册兜底**：已确认人数 = 已注册人数时，剩余speaker标记为"参会人X"，不再调用GPU

**2人快速问答场景互斥收益**：第一个人确认后，第二个人匹配候选集直接减半，准确率显著提升。

### 4.4 第四层：强制匹配与超时兜底（Timeout Fallback）

**规则**：
| 条件 | 动作 |
|------|------|
| 累计净语音 ≥ 3000ms | 强制取top1，score≥60确认显示绿色名字，<60显示黄色"名字?" |
| 距首次出现超过5秒 | 强制取top1，score≥50确认，<50显示"识别中"直到下一句 |
| 连续3次top1不一致 | 标记"识别困难"，徽章可点击手动绑定 |
| 用户点击手动选择 | 立即manual_bind锁定，回溯更新所有历史字幕 |

---

## 5. 前端字幕说话人标签替换逻辑（详细设计）

### 5.1 核心数据结构

**前端维护的全局状态：**

```typescript
// 说话人ID → 显示信息的映射（核心！所有更新通过这个Map驱动UI）
interface SpeakerDisplay {
  speakerId: number;           // 火山返回的数字ID (0,1,2...)
  displayName: string;         // 当前显示文字："说话人0" / "张三" / "张三?" / "参会人1"
  status: 'unknown' | 'identifying' | 'matched_high' | 'matched_low' | 'manual_bound' | 'guest';
  color: string;               // 徽章颜色：gray/blue/green/yellow/green(带锁)
  confirmedName?: string;      // 最终确认的真实姓名（一旦设置不再改变）
  firstSeenAt: number;         // 首次出现时间戳（用于超时计算）
}

// 字幕条目数据结构
interface SubtitleItem {
  id: string;                  // 唯一ID
  speakerId: number;           // 说话人数字ID（固定不变）
  text: string;                // 字幕文本（增量更新）
  isFinal: boolean;            // 是否为最终结果
  startTime: number;
  endTime?: number;
  // 注意：不存displayName！通过speakerId实时查speakerDisplayMap获取
}

// 全局状态
const speakerDisplayMap = new Map<number, SpeakerDisplay>();
const subtitleList: SubtitleItem[] = [];
```

**关键设计决策：字幕条目不缓存说话人姓名，只存speakerId，渲染时实时查询映射表。** 这是回溯更新能瞬间完成的核心。

### 5.2 徽章状态与显示规则

| status | displayName格式 | 颜色 | 图标 | 用户感知 |
|--------|----------------|------|------|---------|
| `unknown` | `说话人${speakerId}` | 灰色 `#9CA3AF` | 无 | 刚检测到这个说话人，还没开始匹配 |
| `identifying` | `识别中...` | 蓝色 `#3B82F6` 脉动动画 | ⏳ | 正在匹配，通常0.5-3秒 |
| `matched_high` | `${name}` | 绿色 `#10B981` | ✓ | 高置信度匹配成功（score≥70） |
| `matched_low` | `${name}?` | 黄色 `#F59E0B` | ? | 低置信度（50-70分），建议确认 |
| `manual_bound` | `${name}` | 绿色 `#10B981` | 🔒 | 用户手动绑定，锁定不再变更 |
| `guest` | `参会人${guestSeq}` | 灰色 `#6B7280` | 无 | 未注册参会人，不尝试自动匹配 |

### 5.3 状态流转与回溯更新机制

**状态流转图：**
```
unknown → identifying → matched_high / matched_low → (不再变化，除非manual_bound)
   ↓           ↓              ↓
 guest      manual_bound ←────┘ (用户手动绑定可随时触发，优先级最高)
```

**回溯更新触发时机（3种场景）：**

| 场景 | 触发动作 | UI更新逻辑 |
|------|---------|-----------|
| **场景1：自动匹配成功** | 后端WS发送`speaker_matched`事件 | 1. 更新speakerDisplayMap中对应条目<br>2. **不遍历subtitleList**，因为React/Vue响应式系统会自动重新渲染所有引用该speakerId的徽章<br>3. 新增300ms CSS淡入淡出过渡，避免跳变 |
| **场景2：低置信度→高置信度升级** | 后续分句分数升高，确认匹配 | 同上，仅更新Map，徽章颜色从黄变绿，问号消失 |
| **场景3：用户手动绑定** | 用户点击徽章下拉选择人名 | 1. 立即更新speakerDisplayMap为manual_bound状态<br>2. 广播给其他所有参会者（多人会议场景）<br>3. 该speakerId所有历史字幕徽章**瞬间更新**，不需要后端重新推送字幕 |

**React渲染示例（伪代码）：**
```tsx
// 字幕徽章组件 - 纯组件，从Map实时取数据
function SpeakerBadge({ speakerId }: { speakerId: number }) {
  const display = speakerDisplayMap.get(speakerId) ?? {
    displayName: `说话人${speakerId}`,
    color: 'gray',
    status: 'unknown'
  };
  
  return (
    <span 
      className="speaker-badge" 
      style={{ 
        backgroundColor: display.color,
        transition: 'all 300ms ease-in-out'  // 颜色/文字淡入淡出
      }}
      onClick={() => openManualBindDropdown(speakerId)}
    >
      {display.icon} {display.displayName}
    </span>
  );
}

// 字幕列表项
function SubtitleItemView({ item }: { item: SubtitleItem }) {
  return (
    <div className="subtitle-line">
      <SpeakerBadge speakerId={item.speakerId} />
      <span className="subtitle-text">{item.text}</span>
    </div>
  );
}
```

### 5.4 中间结果 vs 最终结果的标签更新

| 字幕类型 | 说话人标签处理 |
|---------|-------------|
| **中间结果（isFinal=false）** | 正常显示当前speaker状态。如果匹配还在进行中显示蓝色"识别中..."，不等待匹配完成，先上屏再说（保证实时性） |
| **最终结果（isFinal=true）** | 标记为最终结果但**不冻结说话人标签**！即使字幕已经是final，说话人标签仍可回溯更新（因为匹配可能在字幕final之后才完成） |
| **已匹配后新到的中间结果** | speaker状态是matched_high/manual_bound时，直接显示绿色姓名徽章，零延迟，不显示"识别中" |

### 5.5 快速问答场景标签时序示例（V100实测数据）

```
场景：A(张三)问"这个事情你上周办了吗？"（2秒），B(李四)立即答"是的我办了"（1秒）

时间线：
0.0s    A开始说话（speaker_id=0）
0.0-0.8s 中间结果返回 → 显示灰色徽章[说话人0]
0.8s    第一个短分句（净语音0.7s<800ms）→ 跳过匹配
1.5s    第二个definite分句"你上周办了吗"（净语音1.2s）
        → 触发匹配，徽章变蓝色[识别中...]
1.56s   GPU返回embedding+Node.js余弦计算完成（60ms）
        → top1=张三 88分，top2=其他人 32分 → 领先56分≥25分阈值
        → ✅ 早停确认A=张三
        → 徽章瞬间变绿色[张三]，之前所有[说话人0]的字幕同步更新（CSS淡入）
        → 端到端延迟1.56秒（达到p50≤2s目标）

1.6s    B开始回答（speaker_id=1）
1.6-2.6s B说"是的我办了"（净语音0.9s）→ 显示灰色[说话人1]
2.6s    B第一个definite分句到达 → 触发匹配
        → 此时A=张三已确认，互斥约束排除张三
        → GPU返回top1=李四 82分，top2=其他人 38分
        → 82 < 85早停阈值，领先44分但分数不够 → 不确认
        → 进入第二层候选状态，徽章蓝色[识别中...]

3.4s    A回"好没问题"（speaker_id=0，已匹配）
        → 直接显示绿色[张三]，零延迟，不触发匹配，不调用GPU

4.0s    B又说一句"昨天发了"（净语音0.8s）
        → 增量embedding合并（0.9s:0.8s权重）
        → 新相似度：李四 89分
        → 连续两次top1=李四，分数上升到89≥80
        → ✅ 增量确认B=李四（延迟4.0-1.6=2.4秒，p95≤4s目标内）
        → 徽章变绿色[李四]，之前[说话人1]内容同步更新为[李四]
```

### 5.6 手动绑定交互细节

1. 任何状态下徽章都可点击（除了manual_bound锁定状态）
2. 点击弹出下拉列表，显示：
   - 所有已注册但未绑定到其他speaker的人名
   - 选项："标记为未注册参会人"
3. 选择后立即：
   - 更新本地speakerDisplayMap
   - 通过WebSocket发送`manual_bind`事件给后端（用于统计和广播给其他参会者）
   - 所有历史字幕瞬间更新
   - 徽章显示🔒图标，后续不再自动匹配
4. 手动绑定可以被覆盖（再次点击选择其他人即可）

### 5.7 WebSocket事件协议（后端→前端）

```typescript
// 说话人匹配状态更新事件
interface SpeakerMatchedEvent {
  type: 'speaker_matched';
  speakerId: number;
  name: string;
  confidence: 'high' | 'low';  // high=绿色，low=黄色问号
  matchMethod: 'early_stop' | 'incremental' | 'force' | 'manual';
}

// 说话人进入识别中状态
interface SpeakerIdentifyingEvent {
  type: 'speaker_identifying';
  speakerId: number;
}

// 手动绑定广播（多人会议同步）
interface ManualBindEvent {
  type: 'manual_bind';
  speakerId: number;
  name: string;
  byUser: string;
}

// 声纹注册结果（返回是否支持实时识别）
interface VoiceprintRegisterResponse {
  success: boolean;
  speakId: string;
  realtimeEnabled: boolean;  // 本地embedding提取是否成功
  message?: string;
}
```

---

## 6. 并发稳定性设计

### 6.1 Node.js侧并发控制（txcvm）

**Per-Speaker状态锁（无全局锁）**：
- 每个speaker_id独立维护`matching: boolean`标志
- speaker0在匹配时，speaker1/2/...可以同时发起匹配
- Node.js单线程事件循环，天然无竞态问题
- 同一speaker_id上一次匹配未完成时，新分句到达：
  - 如果新分句音频更长，取消旧请求（abortController），用新音频匹配
  - 如果新分句更短，忽略新请求，等待旧请求返回

**环形缓冲区线程安全**：
- Node.js单线程，Buffer操作天然原子性，无需锁

**背压与超时控制**：
```typescript
const httpAgent = new http.Agent({
  keepAlive: true,        // 复用TCP连接
  maxSockets: 10,         // 最大并发连接到GPU
  maxFreeSockets: 5,
  timeout: 2000,          // 单次请求硬超时2秒
});
```
- 超时后不重试，等下一个分句
- 不做请求排队，避免堆积

**100人声纹库性能**：
- 余弦相似度计算：100次192维向量点积，纯JS约0.1-0.5ms
- 不需要FAISS/Annoy近似最近邻，暴力计算完全够用且准确率100%
- 内存占用：100人 × 192 Float32 = 76,800字节 ≈ 75KB

### 6.2 GPU侧稳定性保障（零修改复用）

- 现有服务已稳定运行24天，健康检查正常
- 单worker uvicorn自然支持并发（FastAPI异步）
- 我们的并发请求≤6个，GPU串行处理单条45ms，6条总耗时≈270ms
- 现有服务已有body大小限制，单请求≤1MB足够

### 6.3 资源限制

| 资源 | 限制值 | 说明 |
|------|--------|------|
| GPU节点HTTP请求body | ≤ 1MB | 现有服务限制，5秒音频约220KB base64，足够 |
| txcvm→gpu并发连接 | ≤ 10 | keepAlive连接池配置 |
| 单次匹配HTTP超时 | 2000ms | 超时放弃，等下一句 |
| Node.js进程内存增量 | < 5MB | 声纹库+状态机可忽略 |
| 声纹库最大容量 | 100人 | 注册接口超过100人返回错误 |
| 单session自动匹配speaker数 | ≤ 6人 | 超过6人新speaker标记guest，仅手动绑定 |

---

## 7. 声纹双写注册策略

### 7.1 注册流程

```
用户提交注册(speakerName, audioFile):
  │
  ├─ 1. 验证音频格式、时长（≥15秒净语音，不足直接返回错误）
  │
  ├─ 2. 调用字节云端API（主路径，必须成功）
  │     createVoiceprint(audioFile) → 返回SpeakID
  │     失败：直接返回错误给前端，不执行后续
  │
  ├─ 3. 读取本地WAV文件（注册接口已有临时文件路径）
  │
  ├─ 4. 本地注册（实时识别用）：
  │     ├─ 4.1 如果音频>30秒，分段取多个chunk提取embedding后加权平均
  │     │      （提高注册embedding质量）
  │     ├─ 4.2 调用GPU /embed接口提取embedding（可多次取平均）
  │     ├─ 4.3 成功 → 存入Node.js内存声纹库 Map<name, embedding>
  │     │        → realtimeEnabled = true
  │     └─ 4.4 失败 → log.warn，不阻断主流程
  │                  → realtimeEnabled = false
  │                  → UI标记"该声纹暂不支持实时识别，请重新注册"
  │
  └─ 5. 删除临时WAV文件
      返回: { success: true, speakId, realtimeEnabled }
```

### 7.2 删除流程
- 调用字节云端删除API（必须成功）
- 同步从Node.js内存声纹库删除对应embedding
- **同步删除持久化文件中对应条目**

### 7.3 本地声纹库持久化设计（v4.0新增）

#### 7.3.1 存储方案
- **存储格式**：JSON文件，Float32Array序列化为普通number数组
- **存储路径**：`{workDir}/voiceprints/local-voiceprints.json`（与recordings同级目录）
- **文件结构**：
  ```json
  {
    "version": 1,
    "updatedAt": "ISO timestamp",
    "speakers": [
      { "name": "尹龙", "embedding": [0.123, -0.456, ..., 0.789] }
    ]
  }
  ```
- **文件大小**：100人 × 192维 × 8字节(number) ≈ 150KB，完全可忽略

#### 7.3.2 启动加载流程
```
服务启动:
  │
  ├─ 1. 确保voiceprints目录存在（mkdirSync recursive）
  │
  ├─ 2. 读取 local-voiceprints.json
  │     ├─ 文件不存在 → 空库启动，打info日志
  │     ├─ 文件存在且JSON合法 → 反序列化，Float32Array转换
  │     │        → 批量注入 globalSpeakerDB
  │     │        → 打日志: [vp] Loaded N speakers from persistent storage
  │     └─ 文件损坏/JSON解析失败 → 打error日志，空库启动，不崩溃
  │
  └─ 3. 正常服务启动流程
```

#### 7.3.3 写入时机（同步写盘）
| 操作 | 内存更新 | 持久化更新 | 失败处理 |
|------|---------|-----------|---------|
| 声纹注册 | `globalSpeakerDB.set(name, emb)` | **同步**全量写JSON文件 | log.error，不阻断注册流程（内存已生效） |
| 声纹删除 | `globalSpeakerDB.delete(name)` | **同步**全量写JSON文件 | log.error，不阻断删除流程 |
| 热注册API（debug-enroll-local） | 同上 | 同上 | 同上 |

- 采用**全量覆写**而非增量更新：100人数据量极小，全量写盘<1ms，无并发冲突风险
- 写盘使用`fs.writeFileSync`原子写（先写tmp文件再rename），防止进程崩溃导致文件损坏

#### 7.3.4 一致性保证
- 内存是唯一真相源（source of truth）
- 持久化文件是内存的快照，每次变更立即同步
- 启动时以持久化文件为准恢复内存
- 写入失败只打日志不阻塞业务：下次重启前内存仍正常工作，下次启动从最后一次成功的快照恢复

---

## 8. 配置参数与默认值

### 8.1 Node.js配置（环境变量）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `VOICEPRINT_EMBED_URL` | `http://192.168.1.146:8002/embed` | GPU embedding服务地址（实勘IP+端口） |
| `VOICEPRINT_SCORE_EARLY_STOP` | `85` | 早停确认分数阈值（0-100） |
| `VOICEPRINT_SCORE_MARGIN` | `25` | 早停领先第二名最小分差 |
| `VOICEPRINT_SCORE_CONFIRM` | `80` | 增量确认分数阈值 |
| `VOICEPRINT_SCORE_FORCE` | `60` | 3秒强制匹配阈值（绿色） |
| `VOICEPRINT_SCORE_LOW_CONF` | `50` | 低置信度阈值（黄色问号） |
| `VOICEPRINT_MIN_UTT_MS` | `800` | 触发匹配的最短分句净语音 |
| `VOICEPRINT_MAX_WAIT_MS` | `5000` | 最长等待确认时间（硬截止） |
| `VOICEPRINT_FORCE_MATCH_MS` | `3000` | 强制匹配阈值 |
| `VOICEPRINT_HTTP_TIMEOUT_MS` | `2000` | 单次HTTP请求超时 |
| `VOICEPRINT_RING_BUFFER_MS` | `30000` | 环形缓冲区保留时长 |
| `VOICEPRINT_MAX_ENROLL` | `100` | 最大支持注册人数 |
| `VOICEPRINT_MAX_SESSION_SPEAKERS` | `6` | 单场会议最多自动匹配人数 |
| `VOICEPRINT_MIN_ENROLL_SEC` | `15` | 声纹注册最短音频秒数 |

---

## 9. 文件变更清单

**重大简化：GPU节点零修改，变更全在txcvm公网节点Node.js侧和前端**

| # | 操作 | 文件路径 | 说明 |
|---|------|---------|------|
| 1 | 新建 | `server-cloud/realtime-speaker-matcher.ts` | 四层匹配状态机、增量embedding聚合、余弦相似度计算、声纹库管理 |
| 2 | 新建 | `server-cloud/gpu-embed-client.ts` | GPU /embed接口HTTP客户端（keepAlive连接池、超时、base64编解码） |
| 3 | 修改 | `server-cloud/config.ts` | 新增上述14个配置项 |
| 4 | 修改 | `server-cloud/index.ts` | 集成匹配器到WS流程、注册接口双写、speaker事件广播、健康检查 |
| 5 | 修改 | `public-cloud/app.js` | 徽章6种状态、CSS过渡动画、手动绑定下拉、回溯更新响应式渲染、`realtimeEnabled`状态显示 |
| 6 | 修改 | `ecosystem.config.cjs` | 无需新增GPU服务配置，Node.js配置不变 |
| 7 | ❌ 不需要 | `voiceprint-service/` | GPU服务已运行，**零修改、零部署** |

---

## 10. 测试验收标准

### 10.1 性能测试
- [ ] 2人安静环境对话，p50端到端识别延迟 ≤ 2.0秒，p95 ≤ 4.0秒
- [ ] 6人同时说话模拟，所有匹配在500ms内返回
- [ ] Node.js进程内存增量<10MB（100人声纹库）
- [ ] 连续1小时会议模拟，服务不崩溃、无内存泄漏

### 10.2 准确率测试
- [ ] 2人安静场景100句对话，正确识别率≥95%
- [ ] 4人讨论场景200句对话，正确识别率≥88%
- [ ] 快速轮次问答（每人1-2秒短句），正确识别率≥85%
- [ ] 手动绑定点击后立即生效，历史字幕全量回溯更新

### 10.3 前端体验测试
- [ ] 徽章颜色/文字变化有300ms CSS过渡，无突兀跳变
- [ ] 中间结果字幕显示"识别中..."不影响字幕实时上屏
- [ ] 匹配成功后所有历史字幕徽章瞬间更新，无需刷新
- [ ] 手动绑定下拉列表正确排除已绑定人名
- [ ] 注册15秒以下音频返回明确错误提示

### 10.4 异常场景测试
- [ ] GPU服务不可用时（kill uvicorn进程模拟），实时字幕显示数字编号不崩溃，ASR功能正常
- [ ] 网络抖动时请求超时自动在下一句重试，不雪崩
- [ ] 超过100人注册时返回友好错误
- [ ] 超过6人说话时新speaker显示"参会人X"，可手动绑定
- [ ] Node.js服务重启后，声纹库清空不报错，重新注册正常

### 10.5 环境连通性验收
- [ ] txcvm上 `curl http://192.168.1.146:8002/healthz` 返回CUDA可用状态
- [ ] 双写注册流程正常，`realtimeEnabled`返回正确
- [ ] 删除声纹时内存库同步删除

---

## 11. 风险与应对

| 风险 | 概率 | 影响 | 应对措施 |
|------|------|------|---------|
| GPU现有服务意外重启 | 低 | 实时识别不可用 | 加简单监控脚本，服务挂了自动重启；或后续迁移到PM2管理；挂期间显示数字编号不影响核心功能 |
| GPU节点磁盘满（已用83%） | 中 | 模型加载失败/日志写满 | 部署前清理GPU节点旧日志和不用的文件；现有服务日志输出到/tmp可定期清理 |
| V100推理延迟波动（>100ms） | 低 | 单次匹配慢 | HTTP超时2秒兜底，超时后下一句重试；不影响整体体验 |
| 100人声纹1:N误识率上升 | 中 | 偶尔标错名字 | 早停阈值保持85分+25分领先；低置信度黄色问号提示；手动绑定兜底 |
| 短音频（<800ms）无法识别 | 高 | 极短句匹配不上 | 设计使然，等下一句累积足够音频；3秒/5秒兜底机制保证最终有结果 |
| 用户注册音频不足15秒 | 高 | 注册质量差识别率低 | 注册接口强校验，不足15秒直接返回错误并提示需要更长音频 |

---

## 12. 执行计划（总计3天）

| 阶段 | 内容 | 预估工时 | 位置 |
|------|------|---------|------|
| 阶段一：后端核心 | gpu-embed-client、realtime-speaker-matcher状态机、余弦计算、四层策略实现 | 1天 | txcvm Node.js |
| 阶段二：注册接口与集成 | 注册接口双写15秒校验、声纹库管理、WS事件集成到ASR流程 | 0.5天 | txcvm Node.js |
| 阶段三：前端交互 | 6种徽章状态、CSS过渡、手动绑定、响应式回溯更新、realtimeEnabled提示 | 0.5天 | txcvm 前端 |
| 阶段四：联调测试与调参 | 2人/4人/快速问答场景测试、阈值调优、异常场景验证 | 0.5天 | 联调 |
| 阶段五：部署上线 | txcvm部署PM2重启、GPU节点健康检查验证、监控配置 | 0.5天 | txcvm |

---

## 13. v5.0 架构反转：声纹为最终裁判（2026-08-21）

### 13.1 问题根因：日志实锤证据

v3.0/v4.0架构存在**致命前提假设错误**：假设火山ASR返回的`speaker_id`稳定代表同一个物理人。实测日志（`test-logs/speaker_id_drift_evidence.log`）铁证如下：

#### 证据链：两人对话出现3个speaker_id + 张冠李戴

测试时间：2026-08-21 01:04-01:09（两人对话，尹龙+黄飞）

| 时间 | speaker_id | 匹配结果 | 文本内容 | 问题 |
|------|-----------|---------|---------|------|
| 01:04:27 | spk=0 | 尹龙 (score=70, force) | - | 首次绑定 |
| 01:04:43 | spk=1 | 黄飞 (score=73, force) | - | 第二人绑定 |
| 01:06:49 | spk=0 | 尹龙 (score=64, force) | - | 正常 |
| 01:06:54 | spk=1 | 黄飞 (score=57, **lowconf**) | - | ⚠️ 分数极低，已不可信 |
| 01:08:39 | **spk=2** | 参会人1 (guest) | - | ❌ **两人对话分出第3个ID！标签漂移发生** |
| 01:09:09 | spk=0 | （已绑定，跳过验证） | "对。" | - |
| 01:09:10 | spk=1 | （已绑定，跳过验证） | "这要存。" | - |
| 01:09:14 | **spk=2** | 参会人1 | "哎" | - |
| 01:09:18 | spk=1 | （已绑定，跳过验证） | "就是反。不稳。不稳。" | 用户开始吐槽 |
| 01:09:21-26 | spk=undefined→1 | - | **"一会我是皇妃，一会你是皇妃"** | 用户直接描述标签在跳 |
| 01:09:27 | spk=0 | （已绑定，跳过验证） | "嗯，那这样子的话，如果说。" | - |
| 01:09:27 | spk=1 | （已绑定，跳过验证） | "就不可用。" | - |
| 01:09:36 | spk=2 | 参会人1 | "嗯，对呀。" | 第三人反复出现 |
| 01:09:37-38 | spk=undefined→1 | - | **"你看，哎他妈这话不是我说的，名字出来了"** | ❌ **张冠李戴铁证：话不是他说的，但名字（尹龙/黄飞）显示出来了** |
| 01:09:42 | spk=0 | （已绑定，跳过验证） | "嗯。" | - |
| 01:09:42 | spk=1 | （已绑定，跳过验证） | "不合格儿。" | 用户判定功能不合格 |

#### 根因机制分析

v3.0/v4.0代码中的两个致命设计：

1. **绑定即锁定，永不验证**（`realtime-speaker-matcher.ts:251-253`）：
```typescript
if (state.status === 'matched_high' || ...) {
  return;  // 已绑定就跳过，永远不再做声纹校验
}
```

2. **强互斥约束（boundNames）**：一个名字只能绑定到一个speaker_id，其他speaker即使声纹匹配也会被排除。

**错误连锁反应**：
```
时序（尹龙=A，黄飞=B）：
1. A说话 → ASR分到spk0 → 声纹匹配尹龙 → spk0=尹龙（锁定）→ boundNames加"尹龙"
2. A继续说话 → ASR**漂移到spk1** → spk1做匹配:
     top1=尹龙(分数最高)，但"尹龙"在boundNames排除列表！
     → spk1只能匹配黄飞（第二人选）或参会人
3. B说话 → ASR**错误分到spk0** → spk0直接return不验证
     → 字幕显示"尹龙：xxx"但实际是B在说话！
4. A说话 → ASR又跳到spk2 → spk2声纹匹配:
     top1=尹龙（排除），top2=黄飞（排除）→ 只能标记"参会人1"
5. 结果：字幕在尹龙/黄飞/参会人1之间乱跳，且一旦跳变永远无法自动恢复
```

**结论**：ASR的speaker_id是**实时聚类槽位**而非身份标识，在短句打断、快速轮替场景下必然跳变。信任speaker_id作为身份主键的架构从根本上不可靠。

---

### 13.2 v5.0 核心原则：架构反转

| 维度 | v3.0/v4.0（有bug） | v5.0（修复后） |
|------|-------------------|---------------|
| **身份主键** | ASR speaker_id（数字槽位） | 声纹识别结果（人名） |
| **ASR speaker_id的作用** | 身份标识（信任） | 仅作音频分段索引（不信任） |
| **绑定后是否再验证** | 否，永久锁定 | **是，每句都验证** |
| **互斥约束** | 强互斥（一个名字只绑一个spk） | 弱关联（允许多spk指向同一人） |
| **标签跳变处理** | 无，错误永久累积 | **漂移检测+自动纠正** |
| **错误恢复** | 无法恢复，必须刷新页面 | 3次连续不一致自动重置纠正 |
| **前端渲染** | 按speaker_id着色/显示徽章 | **按人名合并着色/显示徽章** |

---

### 13.3 数据结构调整

#### SpeakerState 扩展

```typescript
interface SpeakerState {
  // === 原有字段保留 ===
  status: 'unknown' | 'identifying' | 'matched_high' | 'matched_low' | 'manual_bound' | 'guest';
  color: string;
  totalVoicedMs: number;
  consecutiveHits: number;
  firstSeenAt: number;
  matching: boolean;
  utteranceCount: number;
  username?: string;
  score?: number;
  avgEmbedding?: Float32Array;
  timeoutTimer?: NodeJS.Timeout;

  // === v5.0 新增：漂移检测 ===
  driftCounter: number;           // 连续声纹与已绑定人不一致次数
  lastVerifiedName?: string;      // 最近一次声纹验证通过的人名
  lastVerifiedScore?: number;     // 最近一次验证分数
  lastVerifiedAt?: number;        // 最近一次验证时间戳
}
```

#### 新增全局映射：名字→当前活跃颜色

```typescript
// 以人名为主键的颜色分配，确保同一人不管在哪个spk槽位都显示同一颜色
private nameColorMap: Map<string, string> = new Map();
private nextColorIdx: number = 0;
```

---

### 13.4 核心算法：每句校验 + 漂移检测纠正

#### 13.4.1 onDefiniteUtterance 新流程（每个definite utt都执行，不跳过）

```
onDefiniteUtterance(speakerId, startTimeMs, endTimeMs):
  │
  ├─ 1. 提取音频片段（从ringBuffer，不变）
  ├─ 2. VAD检测有效语音时长（不变，<800ms跳过）
  ├─ 3. 调用GPU提取embedding（每句都调用，不再因已绑定而跳过）
  │
  ├─ 4. 与全量声纹库余弦匹配，得到top1 = {name, score}
  │      注意：不再排除boundNames！所有人名都参与匹配
  │
  ├─ 5. 分情况处理:
  │      │
  │      ├─=== 情况A：该speaker槽位尚未绑定任何人 ===
  │      │  （status === unknown/identifying）
  │      │   → 走原四层匹配策略：
  │      │     ├─ 高置信早停：top1≥85 且领先第二名≥25 → matched_high
  │      │     ├─ 增量聚合：连续2次同一人且≥80 → 累积embedding → matched_high
  │      │     ├─ 超时兜底：3s→force_match(≥60)，5s→参会人
  │      │     └─ 手动绑定：覆盖一切
  │      │
  │      ├─=== 情况B：该speaker槽位已绑定username ===
  │      │  （status === matched_high/matched_low/manual_bound）
  │      │   │
  │      │   ├─ B1: 本次声纹top1.name === 已绑定username 且 score≥60
  │      │   │    → 一致！重置driftCounter=0
  │      │   │    → 更新lastVerifiedName/Score/At
  │      │   │    → 用本次embedding做增量平均，提升后续准确率
  │      │   │    → 不发事件（名字没变，前端无变化）
  │      │   │
  │      │   ├─ B2: 本次声纹top1是另一个已注册人 且 score≥75
  │      │   │    （分数足够高，基本可以判定不是当前绑定的人）
  │      │   │    → driftCounter++
  │      │   │    → console.log(`[vp] drift detected: spk=${spk}, bound=${username}, detected=${top1.name}, score=${top1.score}, driftCount=${driftCounter}`)
  │      │   │    │
  │      │   │    ├─ driftCounter < 3:
  │      │   │    │    → 抗抖动：单次/双次不一致忽略，仍显示原username
  │      │   │    │    → 不发事件，前端不变
  │      │   │    │
  │      │   │    └─ driftCounter ≥ 3:
  │      │   │         → 【标签漂移确认】触发纠正：
  │      │   │         → console.log(`[vp] DRIFT CONFIRMED: spk=${spk} was ${username}, now ${top1.name}`)
  │      │   │         → 释放旧username的颜色（如果其他spk没在用这个名字）
  │      │   │         → 重置该speakerState为unknown
  │      │   │         → 将本次embedding作为该spk的首次样本
  │      │   │         → 直接绑定为top1.name（分数已经≥75，无需再等四层策略）
  │      │   │         → emit('speaker_matched', spk, top1.name, top1.score, 'high', 'drift_correction')
  │      │   │         → 前端回溯更新该spk历史字幕为新名字
  │      │   │
  │      │   ├─ B3: 本次声纹分数<60（无法判定是谁）
  │      │   │    → driftCounter保持不变（既不确认也不否定）
  │      │   │    → 仍显示原绑定名字（不轻易因一句模糊音频就漂移）
  │      │   │
  │      │   └─ B4: 本次声纹是guest（所有注册人分数<50）
  │      │        → driftCounter++
  │      │        ├─ driftCounter < 3: 忽略
  │      │        └─ driftCounter ≥ 3:
  │      │             → 该spk确实换了一个未注册的人
  │      │             → 重置为unknown，分配参会人编号
  │      │             → emit('speaker_guest', ...)
  │      │
  │      └─=== 情况C：该speaker是guest ===
  │          → 正常每句校验，如果分数≥75且连续3次同一人，则升级为matched_high
  │
  └─ 6. 前端渲染：按名字统一着色
```

#### 13.4.2 颜色分配策略（人名为主键）

```
为新绑定的人分配颜色时:
  if (nameColorMap.has(username)) {
    // 该人已经有颜色了（可能在另一个spk槽位出现过）
    → 复用已有颜色，确保视觉一致
  } else {
    // 新出现的人
    → 从SPEAKER_COLORS取下一个颜色
    → 存入nameColorMap
    → nextColorIdx++
  }
```

**好处**：尹龙不管出现在spk0/spk1/spk2哪个槽位，永远是同一个颜色，用户视觉上知道是同一个人在说话。

---

### 13.5 漂移纠正阈值参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `VOICEPRINT_DRIFT_THRESHOLD` | 3次 | 连续N句声纹与绑定人不一致才触发纠正 |
| `VOICEPRINT_DRIFT_MIN_SCORE` | 75分 | 漂移检测中"识别为另一个人"的最低分数（防止低分误判） |
| `VOICEPRINT_VERIFY_MIN_SCORE` | 60分 | "与当前绑定人一致"的最低验证分数 |
| `VOICEPRINT_GUEST_UPGRADE_HITS` | 3次 | guest状态下连续N次匹配同一注册人则升级 |

**为什么需要连续3次？**
- 单次不一致可能是噪声、短音频、咳嗽/笑声等非语音
- 2次不一致可能是两句都很短或者恰好两句都切到了另一个人的尾音
- 连续3次不一致才确认：有足够音频证据表明确实换了人
- 3句对话约3-6秒，用户感知延迟可接受

---

### 13.6 前端调整

前端不需要大改，核心变化：

1. **徽章颜色不再按speaker_id分配**，后端在speaker_matched事件中直接携带color字段
2. **speakerOverrides中按人名去重**：如果同一个人名已经在另一个speaker_id显示，不需要重复创建徽章；但文本行仍按ASR的分段显示
3. **回溯更新时按speaker_id+时间范围更新**（原逻辑不变），因为后端纠正时会发出speaker_matched事件包含该spk，前端原逻辑会自动回溯更新该spk的历史文本

前端原有事件模型完全兼容：
- `speaker_identifying` → 显示动画（不变）
- `speaker_matched(spk, name, score, conf, method)` → method新增`drift_correction`来源，前端正常处理即可
- `speaker_guest(spk, guestName)` → 不变

---

### 13.7 GPU并发压力评估

**原方案**：每个speaker槽位只在identifying期间调用GPU，绑定后不再调用 → 整场会议N人约调用N×3-5次
**新方案**：每个definite utt都调用GPU → 调用量大幅增加

#### 量化估算
- 正常对话语速：每人每分钟约120-180字
- ASR definite utt颗粒度：每句约2-8秒，平均约4秒/句
- 两人对话每分钟ut数：约15-25句
- 每句GPU推理：45-50ms（V100实测）
- **峰值QPS**：25句/60s ≈ 0.4 QPS → GPU利用率<5%
- **6人会议峰值QPS**：约1.0-1.2 QPS → GPU利用率<15%

**结论**：V100完全扛得住。即使每句都调用，GPU负载远低于容量上限。

#### 可选优化（本期不做，按需加）
- 同一speaker相邻两句间隔<500ms时，复用上一句的embedding结果
- 同一speaker连续5句高置信(≥85)一致后，可降频为每3句校验一次（验证模式）
- 后续可扩展为batch接口，一次传多个utt音频批量推理（当前GPU /embed接口暂不支持，后续可升级）

---

### 13.8 手动绑定处理

手动绑定（用户点击徽章选择人名）逻辑保持不变，但增加：
- 手动绑定后重置driftCounter=0
- 手动绑定后立即用该人名分配颜色
- 手动绑定后该spk仍继续每句验证（不锁定），如果用户绑错了，声纹会检测到漂移并在3句后纠正

---

### 13.9 删除/重置处理

- session cleanup时清空：speakers Map、nameColorMap、guestSeq、ringBuffer
- 全局声纹库（globalSpeakerDB）不受session影响（不变）

---

### 13.10 日志增强

每个definite utt新增结构化日志：
```
[vp] utt: spk=N time=[start,end] bound=<name>|none top1=<name>:<score> drift=<n>/3 verdict=confirm|drift|ignore|reset
```

示例：
```
[vp] utt: spk=0 time=[146621,147371] bound=none top1=尹龙:88 drift=0/3 verdict=match_high
[vp] utt: spk=1 time=[147371,148391] bound=尹龙 top1=黄飞:82 drift=1/3 verdict=drift_ignore
[vp] utt: spk=1 time=[148542,150302] bound=尹龙 top1=黄飞:79 drift=2/3 verdict=drift_ignore
[vp] utt: spk=1 time=[152932,154011] bound=尹龙 top1=黄飞:86 drift=3/3 verdict=DRIFT_CORRECTION→黄飞
```

便于后续问题排查。

---

### 13.11 预期效果（v5.0修复后）

| 场景 | v3.0/v4.0表现 | v5.0表现 |
|------|--------------|---------|
| 单人说话 | 正常识别名字 | 正常识别名字（一致） |
| 两人轮流慢说（>3秒间隔） | 基本正常 | 正常 |
| 两人快速问答（1秒内轮替） | 大概率标签跳变→名字错乱→无法恢复 | 3句内自动纠正，最多3-6秒延迟 |
| ASR把A分到spk0→spk1→spk2 | A的名字只在spk0，spk1/spk2显示参会人/错名 | spk1/spk2连续3句后自动纠正为A，颜色保持一致 |
| B说话被错误分到已绑定A的spk0 | 永久显示"A：xxx"张冠李戴 | spk0连续3句是B的声纹→自动纠正为B，回溯更新 |
| 咳嗽/笑声/短嗯啊 | 可能触发误匹配 | 单句分数低，driftCounter不递增，不影响 |
| 陌生人加入 | 显示参会人N | 显示参会人N，若注册过则3句后识别为注册人 |
| 用户手动绑错人 | 永远错 | 3句后声纹自动纠正回正确的人 |

---

### 13.12 实施步骤

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1 | SpeakerState新增driftCounter/lastVerified*字段；新增nameColorMap | realtime-speaker-matcher.ts |
| 2 | 移除"已绑定就return"的逻辑，改为每句都做embedding+匹配 | realtime-speaker-matcher.ts onDefiniteUtterance |
| 3 | 移除boundNames强互斥约束（不再用） | realtime-speaker-matcher.ts |
| 4 | 实现漂移检测+纠正逻辑（B1-B4四种情况） | realtime-speaker-matcher.ts processUtterance |
| 5 | 实现按人名分配颜色逻辑 | realtime-speaker-matcher.ts |
| 6 | 新增结构化DEBUG日志（每句verdict日志） | realtime-speaker-matcher.ts |
| 7 | 构建部署+两人对话实测验证 | - |
| 8 | 验证日志中不再出现"一会我是X一会你是X"和"这话不是我说的"现象 | - |
| **总计** | | **3天** | GPU节点零工作量 |
