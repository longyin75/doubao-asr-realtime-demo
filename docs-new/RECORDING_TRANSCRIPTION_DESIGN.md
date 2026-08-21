# 录音文件识别功能设计文档

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| v1.0 | 2026-08-19 | Trae AI | 初始版本，基于火山引擎录音文件识别（AUC）大模型 API |

---

## 1. 需求概述

在 `https://longer8888.tech/asr-demo-multi/` 云端 ASR Demo 页面的「本次会话录音」区域，新增**录音文件转写**功能，支持：

- ✅ **参数配置**：点击「设置参数」打开 Modal 弹窗，配置录音识别参数（模型版本、语言、ITN/标点、说话人分离、声纹匹配等），配置保存后对后续转写任务生效
- ✅ **录音转写**：实时 ASR 结束后，将生成的 MP3 录音文件提交至火山引擎 AUC API 进行异步转写
- ✅ **状态轮询**：服务端后台轮询任务状态，前端实时显示排队中/处理中/已完成/失败
- ✅ **结果预览**：识别完成后自动生成带说话人标签的 TXT 文件，支持点击在新标签页预览
- ✅ **声纹匹配**：提交任务时携带已注册声纹 ID，自动将说话人编号替换为已注册的说话人名称
- ✅ **任务历史**：页面刷新后恢复历史任务，未完成任务自动继续轮询

参考文档：
- 火山引擎官方 API：https://docs.volcengine.com/docs/6561/2606791?lang=zh
- 最佳实践（声纹匹配）：https://bytedance.larkoffice.com/wiki/IizRwirLiiUJ0GkmiyXcrOPPnDe

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户浏览器 (https://longer8888.tech/asr-demo-multi/)                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  本次会话录音区域                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  [⚙️ 设置参数]  [📄 录音转写]  提示文字                  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  转写结果列表                                             │  │  │
│  │  │  • 🕐 排队中  HH:MM:SS                                    │  │  │
│  │  │  • ⏳ 处理中  HH:MM:SS  [spinner]                        │  │  │
│  │  │  • ✅ 已完成  HH:MM:SS  时长:xxs  [查看结果]               │  │  │
│  │  │  • ❌ 失败    HH:MM:SS  错误信息  [重试]                  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                               │  │
│  │  ┌─── AUC 参数配置 Modal（弹窗） ─────────────────────────┐  │  │
│  │  │  模型版本、语言、增强功能、说话人分离、声纹匹配选择      │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────┬────────────────────────────────┘  │
│                                 │ HTTP/JSON                          │
└─────────────────────────────────┼───────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  server-cloud/index.ts (Node.js, 端口 3001)                          │
│  ┌──────────────────────┐  ┌──────────────────────────────────────┐ │
│  │ GET/POST /api/auc/   │  │ POST /api/auc/submit                  │ │
│  │     config            │─▶│  1. 读取当前 AUC 配置                  │ │
│  │  参数读写             │  │  2. 校验录音 URL 合法性                │ │
│  └──────────────────────┘  │  3. 加载声纹列表，过滤选中的声纹 ID     │ │
│                             │  4. 调用火山 AUC submit API            │ │
│  ┌──────────────────────┐  │  5. 创建任务记录，启动后台轮询          │ │
│  │ GET  /api/auc/query  │  │  6. 返回 taskId                        │ │
│  │  单任务状态查询       │  └──────────────────────────────────────┘ │
│  └──────────────────────┘  ┌──────────────────────────────────────┐ │
│                             │ startAucPolling() 后台轮询            │ │
│  ┌──────────────────────┐  │  • 每 3 秒调用一次 query API           │ │
│  │ GET  /api/auc/list   │  │  • 最多轮询 100 次（5 分钟超时）       │ │
│  │  任务历史列表         │  │  • 识别成功：                          │ │
│  └──────────────────────┘  │    - 映射说话人名称（声纹匹配）         │ │
│                             │    - 格式化为 TXT：「说话人N：文本」    │ │
│  ┌──────────────────────┐  │    - 保存到 transcripts/ 目录          │ │
│  │ GET  /transcripts/*  │  │    - 更新任务状态为 completed          │ │
│  │  TXT 结果静态服务    │  │  • 识别失败：更新任务状态为 failed      │ │
│  └──────────────────────┘  └──────────────────────────────────────┘ │
│  • 启动时扫描 transcripts/，清理超过 24 小时的旧文件                  │
│  • 内存中保留最近 50 个任务记录（超出淘汰最旧的）                     │
└──────────────────┬──────────────────────────────────────────────────┘
                   │ HTTPS (X-Api-App-Id + X-Api-Access-Key 鉴权)
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  火山引擎 录音文件识别（AUC）大模型 API                                │
│  Submit: https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit │
│  Query:  https://openspeech.bytedance.com/api/v3/auc/bigmodel/query  │
│  Resource-Id: volc.seedasr.auc (大模型2.0) / volc.bigasr.auc (1.0)   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 文件变更清单

| # | 操作 | 文件路径 | 说明 |
|---|------|---------|------|
| 1 | 新建 | `server-cloud/auc-client.ts` | 火山引擎 AUC API 客户端（submit + query + 307 重定向处理） |
| 2 | 修改 | `server-cloud/config.ts` | 新增 AUC 相关配置项（端点、资源ID、轮询参数、结果目录） |
| 3 | 修改 | `server-cloud/index.ts` | 新增 AUC 配置/提交/查询/列表接口 + 后台轮询 + transcripts 静态服务 + 启动清理 |
| 4 | 修改 | `public-cloud/index.html` | 添加 AUC 工具栏按钮 + 参数配置 Modal 弹窗 |
| 5 | 修改 | `public-cloud/app.js` | AUC 全部前端交互逻辑（参数配置、任务提交、轮询、结果渲染） |
| 6 | 修改 | `public-cloud/style.css` | AUC 区域相关样式（工具栏、结果列表、表单、spinner 动画） |
| 7 | 修改 | `Makefile` | build-cloud 创建 transcripts 目录，QA 增加 5 项 AUC 检查，cloud-sync 排除 transcripts |
| 8 | 修改 | `package.json` | build:cloud 脚本添加 `mkdir -p dist/transcripts` |
| 9 | 新建 | `docs-new/RECORDING_TRANSCRIPTION_DESIGN.md` | 本文档 |
| 10 | 新建 | `docs-new/TEST_EXECUTION_LOG.md` | 测试执行日志 |

---

## 4. 后端设计

### 4.1 配置项（server-cloud/config.ts）

复用现有 ASR 的 AppID 和 AccessKey，新增以下配置：

```typescript
// server-cloud/config.ts 新增
transcriptsDir: string;      // 识别结果 TXT 目录，默认 'transcripts'
aucSubmitUrl: string;        // Submit API 地址
aucQueryUrl: string;         // Query API 地址
aucResourceId2: string;      // 大模型 2.0 资源 ID，默认 'volc.seedasr.auc'
aucResourceId1: string;      // 大模型 1.0 资源 ID，默认 'volc.bigasr.auc'
aucPollIntervalMs: number;   // 轮询间隔毫秒，默认 3000
aucMaxPollAttempts: number;  // 最大轮询次数，默认 100（5 分钟）
```

### 4.2 目录初始化与清理

服务启动时：
1. 创建 `transcripts/` 目录（如不存在）
2. 扫描 `transcripts/` 目录，删除所有**最后修改时间超过 24 小时**的文件
3. 记录清理日志

### 4.3 数据结构

```typescript
// AUC 参数配置（前后端一致）
interface AucConfig {
  model_version: '2.0' | '1.0';      // 模型版本
  language: string;                   // 语言，默认 'zh-CN'
  enable_itn: boolean;                // 逆文本正则化（数字→阿拉伯数字）
  enable_punc: boolean;               // 标点符号
  enable_ddc: boolean;                // 口语顺滑（去语气词）
  show_utterances: boolean;           // 输出逐句结果
  enable_speaker_info: boolean;       // 说话人分离
  ssd_version: '200' | '300';        // 说话人分离版本（200=短音频，300=长音频会议）
  ssd_mode: 0 | 1;                   // 聚类模式（仅 ssd_version=200 时有效）
  end_window_size: number;            // VAD 静音窗口大小（毫秒，300-5000）
  enable_voiceprint: boolean;         // 启用声纹匹配
  selected_voiceprint_ids: string[];  // 选中参与匹配的声纹 ID 列表
}

// AUC 任务状态
type AucTaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

// AUC 任务记录
interface AucTask {
  taskId: string;
  status: AucTaskStatus;
  recordingUrl: string;
  submitTime: number;
  completeTime?: number;
  transcriptUrl?: string;            // /transcripts/xxx.txt
  durationMs?: number;
  error?: string;
  speakerNameMap?: Record<string, string>;  // speakId -> speakerName
  pollAttempts: number;
  timeoutHandle?: NodeJS.Timeout;
}
```

### 4.4 API 接口详细设计

#### 4.4.1 获取/保存参数配置 `GET/POST /api/auc/config`

**GET**：返回当前生效的 AUC 配置

**POST**：保存 AUC 配置
- 请求体：`AucConfig` 对象
- 成功响应：`{ "success": true, "config": { ... } }`

#### 4.4.2 提交识别任务 `POST /api/auc/submit`

| 项目 | 说明 |
|------|------|
| **方法** | POST |
| **Content-Type** | `application/json` |
| **请求体** | `{ "recordingUrl": "/recordings/rec_xxx.mp3" }` |
| **成功响应** | `{ "success": true, "taskId": "xxx" }` |
| **失败响应** | `{ "success": false, "message": "错误原因" }` |

**处理流程**：
1. 校验 `recordingUrl`：必须以 `/recordings/` 开头，禁止路径遍历（`..`）
2. 读取当前 AUC 配置
3. 如果启用了声纹匹配，调用声纹 list API 获取所有声纹，过滤出选中的 ID
4. 构造公网音频 URL：`{protocol}://{host}{basePath}{recordingUrl}`
5. 构造 Submit API 请求体：
   ```json
   {
     "audio": {
       "url": "公网音频URL",
       "format": "mp3",
       "channel": 1
     },
     "request": {
       "model_name": "bigmodel",
       "enable_itn": true,
       "enable_punc": true,
       "enable_ddc": false,
       "enable_speaker_info": true,
       "ssd_version": "300",
       "show_utterances": true,
       "end_window_size": 800,
       "voiceprints": [{ "id": "speakId1" }, { "id": "speakId2" }],
       "language": "zh-CN"
     }
   }
   ```
6. 调用火山 AUC submit API，获取 `id`（taskId）
7. 创建任务记录，状态设为 `queued`
8. 启动后台轮询 `startAucPolling(taskId)`
9. 返回 taskId

#### 4.4.3 查询任务状态 `GET /api/auc/query?taskId=xxx`

| 项目 | 说明 |
|------|------|
| **方法** | GET |
| **查询参数** | `taskId` |
| **成功响应** | `{ "success": true, "task": { ...AucTask... } }` |

**响应字段说明**：
- `status`: `queued`/`processing`/`completed`/`failed`
- `submitTime`/`completeTime`: 时间戳（毫秒）
- `durationMs`: 识别音频时长（毫秒，仅完成时）
- `transcriptUrl`: TXT 文件访问路径（仅完成时）
- `error`: 错误信息（仅失败时）

#### 4.4.4 任务历史列表 `GET /api/auc/list`

返回内存中保留的最近 50 个任务（按提交时间倒序），用于页面刷新后恢复状态。

#### 4.4.5 识别结果静态服务 `GET /transcripts/*.txt`

- 路径遍历防护（`..` 过滤，必须在 transcripts 目录内）
- 正确设置 `Content-Type: text/plain; charset=utf-8`
- Nginx 现有配置已支持 `/asr-demo-multi/` 路径下的静态转发

### 4.5 后台轮询机制（startAucPolling）

```
startAucPolling(taskId):
  1. 等待 aucPollIntervalMs（3秒）
  2. 调用火山 AUC query API
  3. 检查响应 code：
     - code === '20000000'（成功）：
       a. 从 utterances 提取每句话的文本和 additions.speaker
       b. 构建 speakerNameMap：如果声纹匹配成功，将 speakId 映射为 speakerName；否则按出现顺序编号为「说话人1」「说话人2」...
       c. 格式化为 TXT 文本：每行「{说话人名称}：{文本}」
       d. 写入 transcripts/auc_{taskId}.txt
       e. 更新任务状态为 completed，设置 completeTime、durationMs、transcriptUrl
       f. 清理定时器
     - 其他 code（处理中/排队中）：
       a. 更新任务状态为 processing（如果之前是 queued）
       b. pollAttempts++
       c. 如果 pollAttempts >= aucMaxPollAttempts：
          - 更新任务状态为 failed，error = '识别超时（5分钟）'
          - 清理定时器
       d. 否则：继续下一轮轮询（回到步骤1）
     - 异常/错误：
       a. pollAttempts++
       b. 如果连续失败次数过多或达到最大尝试次数，标记为 failed
       c. 否则继续轮询
```

### 4.6 火山 AUC API 鉴权与请求头

```
Content-Type: application/json
X-Api-App-Id: {AppID}
X-Api-Access-Key: {AccessKey}
X-Api-Resource-Id: {volc.seedasr.auc 或 volc.bigasr.auc}
X-Api-Request-Id: {UUID v4}
X-Api-Sequence: -1
```

---

## 5. 前端设计（public-cloud/）

### 5.1 入口与工具栏

在「本次会话录音」区域（录音播放器下方），新增工具栏：

```html
<div id="aucToolbar" class="auc-toolbar" hidden>
  <button type="button" class="btn btn-secondary btn-sm" id="aucConfigBtn">
    ⚙️ 设置参数
  </button>
  <button type="button" class="btn btn-primary btn-sm" id="aucTranscribeBtn" disabled>
    📄 录音转写
  </button>
  <span id="aucHint" class="auc-hint">录音完成后可提交转写</span>
</div>
```

- 页面初始状态 `hidden`（因为还没有录音）
- 实时 ASR 结束、收到 `recording_ready` WebSocket 消息后：
  - 保存 `window.__currentRecordingUrl = msg.url`
  - 显示工具栏 `aucToolbar.hidden = false`
  - 启用转写按钮 `aucTranscribeBtn.disabled = false`
  - 更新提示文字为「录音已就绪，可提交转写」

### 5.2 结果列表区域

工具栏下方是转写结果列表容器：

```html
<div id="aucResultsSection" class="auc-results-section">
  <div class="auc-results-header">转写记录</div>
  <div id="aucResultsList" class="auc-results-list">
    <div class="auc-results-empty">暂无转写记录</div>
  </div>
</div>
```

每个结果项样式：
- **排队中**：灰色时钟图标 + 「排队中」+ 提交时间
- **处理中**：旋转 spinner 图标 + 「处理中」+ 提交时间
- **已完成**：绿色对勾图标 + 「已完成」+ 提交时间 + 音频时长 + 「查看结果」蓝色按钮（新标签页打开 TXT）
- **失败**：红色叉号图标 + 「失败」+ 提交时间 + 错误信息 + 「重试」文本按钮

### 5.3 参数配置 Modal 结构

参照声纹管理 Modal，新增 `aucConfigModalOverlay`：

```
┌───────────────────────────────────────────────────────────┐
│ 🔊 录音转写参数配置                                    [X] │
├───────────────────────────────────────────────────────────┤
│                                                           │
│ 【模型设置】                                               │
│  模型版本:  (●) 大模型 2.0（推荐）  (○) 大模型 1.0         │
│  识别语言: [中文（普通话） ▼]                               │
│                                                           │
│ 【识别增强】                                               │
│  ☑ ITN 逆文本正则化（数字、日期格式归一化）                 │
│  ☑ 自动添加标点符号                                        │
│  ☐ 口语顺滑（过滤嗯、啊等语气词）                           │
│  ☑ 输出逐句详细结果                                        │
│                                                           │
│ 【说话人分离】                                             │
│  ☑ 启用说话人分离（区分不同说话人）                         │
│  ┌─ 说话人分离选项（启用时显示） ────────────────────────┐ │
│  │  分离版本:  (○) 200（短音频<3分钟）  (●) 300（长音频会议）│ │
│  │  聚类模式:  (●) 模式0  (○) 模式1  （仅200版本时显示）  │ │
│  │  VAD 静音窗口: [══════●══════] 800ms  (300-5000ms)   │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                           │
│ 【声纹匹配】                                               │
│  ☐ 启用声纹匹配（自动识别已注册说话人名称）                 │
│  ┌─ 声纹选择列表（启用时显示） ──────────────────────────┐ │
│  │  提示：选择参与匹配的声纹（最多50个）                   │ │
│  │  ☑ 张三   ☐ 李四   ☑ 王五  ...                        │ │
│  │  （滚动列表，支持多选）                                 │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                           │
├───────────────────────────────────────────────────────────┤
│                    [恢复默认]  [保存设置]                   │
└───────────────────────────────────────────────────────────┘
```

### 5.4 参数默认值

```javascript
const DEFAULT_AUC_CONFIG = {
  model_version: '2.0',
  language: 'zh-CN',
  enable_itn: true,
  enable_punc: true,
  enable_ddc: false,
  show_utterances: true,
  enable_speaker_info: true,
  ssd_version: '300',
  ssd_mode: 0,
  end_window_size: 800,
  enable_voiceprint: false,
  selected_voiceprint_ids: []
};
```

### 5.5 前端交互流程

#### 5.5.1 页面初始化
1. 从 `GET /api/auc/config` 加载配置
2. 从 `GET /api/auc/list` 加载历史任务，渲染到结果列表
3. 对历史任务中状态为 `queued`/`processing` 的任务，自动启动轮询
4. 绑定按钮事件、Modal 事件、表单事件

#### 5.5.2 打开参数配置 Modal
1. 点击「设置参数」按钮
2. 用当前配置填充表单
3. 如果启用了声纹匹配，加载声纹列表并渲染复选框，回显选中状态
4. 根据选项联动显示/隐藏子选项（如 ssd_version=200 时显示 ssd_mode）

#### 5.5.3 提交转写任务
1. 点击「录音转写」按钮
2. 按钮置为 disabled，防止重复提交
3. POST 到 `/api/auc/submit`，body: `{ recordingUrl: window.__currentRecordingUrl }`
4. 成功：将新任务添加到结果列表顶部，立即启动轮询 `pollTaskStatus(taskId)`
5. 失败：显示错误提示

#### 5.5.4 轮询任务状态
`pollTaskStatus(taskId)`:
1. 每 3 秒 GET `/api/auc/query?taskId=xxx`
2. 根据返回的 task.status 更新 UI：
   - queued/processing：更新 spinner 和状态文字
   - completed：显示绿色「查看结果」按钮，停止轮询
   - failed：显示红色错误信息和「重试」按钮，停止轮询

#### 5.5.5 查看结果
点击「查看结果」按钮：
```javascript
window.open(apiUrl(task.transcriptUrl), '_blank');
```

---

## 6. 结果 TXT 格式规范

```
说话人1：大家好，今天我们来讨论一下项目进度。
说话人2：好的，我先汇报一下后端的开发情况...
张三：前端这边也差不多完成了，就差联调了。
说话人1：好的，那我们预计本周五可以提测。
```

格式规则：
- 每行一句话，格式为「{说话人名称}：{文本内容}」
- 说话人名称：声纹匹配成功的使用注册的名称（如「张三」）；未匹配的按出现顺序编号「说话人1」「说话人2」...
- 说话人编号连续，从 1 开始
- 标点符号由 API 自动添加（enable_punc=true）
- 文件编码：UTF-8
- 文件命名：`auc_{taskId}.txt`

---

## 7. 部署与运维

| 项目 | 说明 |
|------|------|
| **Nginx 配置** | 无需修改。现有 `/asr-demo-multi/` 路径下的 `/api/auc/*` 和 `/transcripts/*` 会被自动转发到 Node 服务 |
| **PM2 配置** | 无需修改 `ecosystem.config.cjs`，transcripts 目录在代码内自动创建 |
| **环境变量** | 无需新增。复用现有 `DOUBAO_API_APP_ID` 和 `DOUBAO_API_ACCESS_KEY`（同一个账号同时支持实时 ASR 和录音文件识别） |
| **Makefile build-cloud** | 已更新，确保 `dist/transcripts/` 目录被创建 |
| **Makefile cloud-sync** | 已更新，rsync 排除 `transcripts/*`（任务结果数据不需要同步到部署包），并在远程服务器 mkdir |
| **磁盘空间** | transcripts 保留 24 小时，每个 TXT 文件几 KB 到几十 KB，对磁盘压力极小 |

---

## 8. 关键决策记录

| 决策 | 理由 |
|------|------|
| **服务端轮询而非客户端轮询** | 页面刷新或关闭不影响任务执行；通过 `/api/auc/list` 恢复历史任务后可继续轮询；可靠性更高 |
| **参数保存到后端而非 localStorage** | 参数是服务端调用 API 时使用的，统一保存在后端避免前后端不一致；多标签页共享同一份配置 |
| **结果文件持久化到服务器** | TXT 是最终交付物，需要支持随时预览、下载、分享；不依赖前端状态 |
| **任务历史仅保留最近 50 条** | 内存有限，50 条足够用户查看最近的转写记录；超出自动淘汰最旧的 |
| **transcripts 保留 24 小时** | 临时结果，不需要永久保存；24 小时足够用户查看和下载，又不会堆积磁盘 |
| **复用现有 Modal 和 IIFE 模式** | 与声纹管理功能保持代码风格一致，降低维护成本 |
| **通过 window.__currentRecordingUrl 跨 IIFE 通信** | 简单直接，不需要引入复杂的事件总线；主 ASR IIFE 在录音就绪后设置该全局变量，AUC IIFE 直接读取 |
| **VAD 窗口默认 800ms** | 会议场景下比较适中的值，既能切分句子又不会过度切断 |
| **ssd_version 默认 300** | 300 版本专为长音频/会议场景优化，效果更好，适用范围更广 |
| **声纹匹配默认关闭** | 声纹匹配需要用户先注册声纹并选择参与匹配的声纹，默认关闭避免无意义的参数传递 |

---

## 9. 测试验收清单

### 9.1 本地开发测试

- [x] `make qa` 全部通过（32/32）
- [x] TypeScript 编译无错误
- [x] JavaScript 语法检查通过
- [ ] `make dev-cloud` 启动无报错
- [ ] 浏览器打开页面，AUC 工具栏初始隐藏
- [ ] 完成一次实时 ASR 录音后，AUC 工具栏显示，「录音转写」按钮启用
- [ ] 点击「设置参数」打开 Modal，默认值正确显示
- [ ] 修改参数后保存，刷新页面验证参数持久化
- [ ] 启用声纹匹配，声纹列表正常加载，可多选
- [ ] 点击「录音转写」提交任务，状态从 queued → processing → completed
- [ ] 任务完成后显示「查看结果」按钮，点击在新标签页打开 TXT，内容格式正确
- [ ] 刷新页面，历史任务恢复显示，未完成任务继续轮询
- [ ] 模拟识别失败场景，显示错误信息和重试按钮
- [ ] 验证声纹匹配：注册测试声纹后转写，说话人显示为注册名称而非编号

### 9.2 云端部署测试

- [ ] `make cloud-build && make cloud-deploy` 成功
- [ ] 访问 `https://longer8888.tech/asr-demo-multi/`
- [ ] CSS/JS 版本号更新，强制刷新后看到 AUC 工具栏和按钮
- [ ] 走通完整转写流程（录音 → 提交 → 等待 → 查看结果）
- [ ] 验证火山引擎能成功下载 `/recordings/` 路径的 MP3（公网可访问）
- [ ] 验证 TXT 文件公网可访问
- [ ] 验证声纹匹配功能正常工作
