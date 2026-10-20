# 变更日志 (CHANGE JOURNAL)

## 格式说明
- 格式：`[日期] 变更类型 - 简要描述`
- 变更类型：`[DOCS]` 文档, `[FEAT]` 新功能, `[FIX]` 修复, `[REFACTOR]` 重构, `[CHORE]` 工程化

---

## 2026-08-18

- [DOCS] 新增声纹注册功能完整设计文档（VOICEPRINT_REGISTER_DESIGN.md）
  - 基于字节跳动 openspeech API 的声纹管理功能
  - 支持音频文件上传 + 现场录音注册（16kHz 单声道 WAV）
  - 支持声纹列表查询和删除
  - 临时音频立即删除 + 启动时清理 1 小时以上残留文件

- [FEAT] 声纹管理功能完整实现
  - **后端 (server-cloud/)**:
    - 新建 `bytedance-voiceprint.ts`：字节 openspeech 声纹 API 客户端，支持 HTTP 307 重定向跟随
    - 更新 `config.ts`：新增 `uploadsDir`、`voiceprintBaseUrl` 配置项
    - 更新 `index.ts`：新增 4 个 API 接口（upload/register/list/delete）+ uploads 静态文件服务 + 启动时过期文件清理逻辑
    - 修正 API 字段名：`SpeakID`（大写 D）、`AudioURL`（大写 URL），与实际接口响应一致
    - 增加路径遍历防护，upload 文件限制为 .wav/.mp3/.m4a/.webm/.ogg，大小 ≤10MB
  - **前端 (public-cloud/)**:
    - 更新 `index.html`：新增「声纹管理」按钮 + 完整 Modal 弹窗（声纹列表表格、注册表单、录音区、预览区）
    - 更新 `style.css`：新增约 250 行声纹管理相关样式（表格、上传区拖拽态、录音按钮脉冲动画、音量条渐变）
    - 更新 `app.js`：新增约 600 行 IIFE 独立逻辑，实现文件拖拽上传、16kHz WAV 现场录音（ScriptProcessorNode + WAV 头构造）、音量实时显示、列表渲染、删除确认
    - 声纹录音与 ASR 互斥，避免浏览器麦克风冲突
  - **工程化**:
    - 更新 `Makefile`：build-cloud 创建 `dist/uploads` 目录，qa 新增 5 项声纹模块检查，cloud-sync 排除 uploads/* 并创建远程目录
    - 更新 `package.json`：build:cloud 脚本包含 `mkdir -p dist/uploads`
  - **关键修复**:
    - 修复 openspeech API 返回 HTTP 307 重定向问题（POST 到无 trailing slash 路径会被重定向）
    - 修复空响应体 JSON.parse 异常处理
  - **测试结果**:
    - `make qa` 27/27 检查项全部通过
    - TypeScript 编译无错误
    - 本地服务端 API 接口测试全部通过：list 返回 21 条声纹、upload 返回正确 URL、静态文件服务正常

## 2026-08-19

- [CHORE] 声纹功能云端部署完成
  - 发现 Makefile 中 SSH_TARGET 和 CLOUD_IP 配置过时（原配置 shcvm/212.64.57.180 无法连接，实际服务运行在 txcvm/62.234.42.199 跳板机上），已修正配置
  - 修复沙箱环境 SSH ControlMaster 连接复用导致的 socket 文件权限问题，使用临时配置文件禁用 ControlMaster
  - 构建产物已同步至云端服务器：`/root/doubao-asr-cloud/`
  - PM2 服务 `doubao-asr-cloud` 已重启（cluster 模式，新 PID 2734085）
  - 公网验证通过：
    - `https://longer8888.tech/asr-demo-multi/` 页面已显示「声纹管理」按钮
    - `/api/voiceprint/list` 接口公网访问正常，返回 21 个已注册声纹
    - CSS/JS 静态资源更新确认（包含 vp-upload-area、vp-record-btn、buildWav 等新增代码）

- [FIX] 修复浏览器强缓存导致声纹按钮不显示问题
  - 问题原因：HTML 中 CSS/JS 引用无版本号（`style.css`、`app.js`），浏览器缓存旧版本 JS 文件导致新功能代码未加载
  - 解决方案：在 [public-cloud/index.html](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/index.html#L7) 中给静态资源添加版本号参数：`style.css?v=20260819`、`app.js?v=20260819`，强制浏览器重新加载
  - 附加发现：Node 服务不支持 HEAD 方法（返回 404），GET 请求正常
  - 重新部署后公网验证全部通过

- [FIX] 修复声纹按钮位置错误问题
  - **根本原因**：声纹管理按钮最初放在 `summary-section` 容器内（该容器设置了 `hidden` 属性，**只有录音结束后才显示**），导致页面初始状态看不到按钮
  - **修复方案**：将声纹按钮从录音后的 summary-toolbar 移至顶部蓝色 header 常驻显示
  - 修改文件：
    - [public-cloud/index.html](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/index.html#L10-L18) - header 区域添加 `header-actions` 容器和按钮，删除 summary-toolbar 中的重复按钮
    - [public-cloud/style.css](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/style.css#L10-L43) - header 改为 flex 布局，添加 header-actions 样式
  - 版本号更新：CSS/JS 更新至 `?v=20260819b` 强制浏览器刷新缓存
  - **浏览器自动化测试验证通过**：
    - ✅ 两次 Ctrl+Shift+R 强制刷新后，声纹按钮在蓝色 header 右侧可见
    - ✅ 点击按钮成功弹出声纹管理 Modal
    - ✅ Modal 中正常显示已注册的 21 个声纹列表

- [FIX] 修复声纹弹窗背景透明/重叠问题
  - **根本原因**：声纹弹窗内容容器使用了错误的 class 名 `modal`，而现有样式定义的是 `.modal-dialog`，导致弹窗没有白色背景、圆角、阴影，内容直接显示在半透明遮罩上，与底层内容重叠混乱
  - **修复内容**：
    1. 将声纹弹窗容器 class 从 `modal` 改为 `modal-dialog modal-dialog-lg`（与其他弹窗样式一致，大尺寸弹窗）
    2. 给 `.modal-overlay` 添加 `backdrop-filter: blur(4px)` 毛玻璃虚化效果，使背景模糊
    3. 添加 `-webkit-backdrop-filter` 兼容 Safari
  - 修改文件：
    - [public-cloud/index.html:187](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/index.html#L187) - 修正弹窗容器 class 名
    - [public-cloud/style.css:892-893](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/style.css#L892-L893) - 添加 backdrop-filter 虚化
  - 版本号：CSS/JS 更新至 `?v=20260819c`
  - 已部署到云端

## 2026-08-19 (录音文件识别功能)

- [FEAT] 录音文件识别（AUC）功能完整实现
  - **功能概述**：在实时 ASR 会话结束后，支持将录音 MP3 文件提交至火山引擎录音文件识别 API 进行异步转写，支持说话人分离、声纹匹配自动标注说话人名称，结果保存为 TXT 文件支持预览
  - **后端 (server-cloud/)**:
    - 新建 `auc-client.ts`：火山引擎 AUC API 客户端，支持 submit/query 两个接口，包含 HTTP 307 重定向处理
    - 更新 `config.ts`：新增 `transcriptsDir`、`aucSubmitUrl`、`aucQueryUrl`、`aucResourceId2`、`aucResourceId1`、`aucPollIntervalMs`、`aucMaxPollAttempts` 配置项
    - 更新 `index.ts`：新增 AUC 参数配置管理、任务提交、轮询查询、任务列表、结果文件静态服务等完整逻辑
    - 服务端轮询机制：提交任务后后台每 3 秒轮询一次状态，最多轮询 100 次（5 分钟超时）
    - 声纹匹配：提交任务时携带已选声纹 ID 列表，识别结果中匹配到的声纹自动替换为注册的说话人名称
    - 结果格式化：将识别结果转换为「说话人N：文本内容」格式的 TXT 文件，保存到 `transcripts/` 目录
    - 启动时清理 `transcripts/` 目录下超过 24 小时的旧文件
    - 任务历史：内存中保留最近 50 个任务，支持页面刷新后恢复状态并继续轮询未完成任务
    - 路径遍历防护：严格校验录音文件和 transcript 文件路径
  - **前端 (public-cloud/)**:
    - 更新 `index.html`：在「本次会话录音」区域新增「设置参数」和「录音转写」按钮，新增完整 AUC 参数配置 Modal
    - 参数配置 Modal 支持：模型版本选择（大模型2.0/1.0）、语言选择、ITN/标点/DDC/逐句输出开关、说话人分离配置（版本、聚类模式、VAD 静音窗口）、声纹匹配选择
    - 更新 `style.css`：新增约 230 行 AUC 相关样式（工具栏、结果列表、状态动画、表单控件、声纹选择列表）
    - 更新 `app.js`：新增约 530 行 IIFE 独立逻辑，实现参数配置保存/恢复、声纹列表加载、任务提交、状态轮询、结果渲染、预览跳转
    - 录音就绪后自动显示工具栏并启用转写按钮；转写过程中显示 spinner 和进度状态；完成后显示绿色「查看结果」按钮，失败显示红色错误信息
    - 页面加载时自动从 `/api/auc/list` 恢复历史任务，未完成任务自动继续轮询
  - **工程化**:
    - 更新 `Makefile`：build-cloud 创建 `dist/transcripts` 目录，qa 新增 5 项 AUC 模块检查（28-32），clean 清理 transcripts 目录，cloud-sync 排除 transcripts/*
    - 更新 `package.json`：build:cloud 脚本包含 `mkdir -p dist/transcripts`
  - **关键设计决策**:
    - 服务端轮询而非客户端轮询：页面刷新/关闭不影响任务执行，通过 /api/auc/list 恢复状态
    - 参数持久化：AUC 配置保存到后端内存，后续任务自动使用最新配置
    - 结果文件持久化：TXT 文件永久保存在服务器 transcripts/ 目录，随时可预览
    - 复用现有 Modal 样式和 IIFE 代码组织模式，与声纹管理保持一致
  - **测试结果**:
    - `make qa` 32/32 检查项全部通过
    - TypeScript 编译无错误
    - JavaScript 语法检查通过（本地+云端）

- [FIX] 修复声纹匹配默认值问题并完成云端部署
  - **问题**：`use_voiceprints`（启用声纹匹配）默认值错误地设为 `true`，与设计文档不符（应默认关闭）
  - **修复内容**：
    - 后端 `DEFAULT_AUC_CONFIG.use_voiceprints` 从 `true` 改为 `false`
    - 前端 `DEFAULT_AUC_CONFIG.use_voiceprints` 从 `true` 改为 `false`
    - 前端 `collectFormValues()` fallback 值从 `true` 改为 `false`
    - HTML 中 `aucUseVoiceprints` checkbox 移除 `checked` 属性
    - 静态资源版本号更新至 `?v=20260819e`
  - **云端部署验证通过**：
    - PM2 服务已重启，公网访问正常（200）
    - API `/api/auc/config` 返回正确默认值：`use_voiceprints:false, enable_ddc:false, end_window_size:800`
    - BUA 浏览器自动化测试全部通过：Modal 正常打开、所有默认值正确、声纹列表联动正常
  - **测试结果**:
    - `make qa` 32/32 二次验证通过
    - 浏览器 E2E 验证：9 项默认值检查全部通过

- [FIX] 修复录音转写轮询逻辑中英文消息不匹配导致的误判失败
  - **问题现象**：录音提交转写后约 3 秒即显示「转写失败」，错误信息为 `[Processing in progress] Handle response: Start Processing`
  - **根本原因**：
    1. 轮询状态判断逻辑 `startAucPolling()` 仅匹配中文关键词「处理中」「排队」判断任务进行中，但火山引擎 API 实际返回英文消息 `"[Processing in progress] Handle response: Start Processing"`，导致进行中状态被误判为失败
    2. `queryTask()` 仅从 HTTP headers 读取状态码/消息，未兼容响应 body 中同时返回的状态字段；也未处理文档中可能的 `{headers:{...}, body:{...}}` 嵌套响应格式
  - **修复内容**：
    - [server-cloud/auc-client.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/auc-client.ts)：重写 `queryTask()` 响应解析逻辑，**同时从 HTTP headers 和 JSON body 提取状态码/消息/结果**，兼容扁平格式（`{X-Api-Status-Code, result}`）和嵌套格式（`{headers:{...}, body:{result}}`）两种响应结构；重构接口类型定义
    - [server-cloud/index.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/index.ts#L224-L324)：
      - 新增 `isInProgressMessage()` 函数，同时匹配中文（处理中/排队/等待/不存在）和英文（processing/in progress/start processing/queued/pending/handle response/waiting）进行中关键词
      - 优化轮询判断优先级：**有 result 字段 = 成功**（最可靠依据），其次才检查状态码和消息
      - 添加调试日志：前两次轮询和每 10 次轮询打印处理进度，异常时打印详细错误信息
      - 增加容错：无状态码无消息时默认继续轮询（处理中），HTTP 异常时重试而非立即失败
  - **测试结果**:
    - `make qa` 32/32 全部通过
    - TypeScript 编译无错误
    - 已部署到云端，PM2 服务正常运行（PID 2768290，uptime 2s）
    - 公网访问验证：https://longer8888.tech/asr-demo-multi/ 返回 200

- [FIX] 修复声纹匹配后说话人名称显示问题（说话人NaN/说话人1 而非注册名）
  - **问题现象**：录音转写结果显示「说话人1」而非已注册的声纹人名（如「尹龙」），早期版本显示「说话人NaN」
  - **根本原因（通过日志确认）**：
    1. 火山引擎 AUC API 声纹匹配成功时，`additions.speaker` 直接返回**注册的人名**（如"尹龙"），而非声纹 SpeakID（UUID）
    2. 原代码 `nameMap` 以 SpeakID（UUID）为 key 构建映射，`nameMap["尹龙"]` 为 undefined
    3. 原代码用 `parseInt(spkId)+1` 生成编号，非数字字符串 parseInt 返回 NaN
  - **修复内容**：
    - [server-cloud/index.ts buildTranscriptText()](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/index.ts#L209-L249)：通过正则 `/^\d+$/` 判断 speaker 字段是否为数字聚类ID；非数字字符串直接作为人名使用；数字ID才走编号分配逻辑
    - [server-cloud/auc-client.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/auc-client.ts#L34-L53)：AucUtterance 接口补充顶层 `speaker`/`speaker_id` 字段定义
    - 添加 utterance sample 调试日志，便于后续排查
  - **补充说明**：首字乱码问题（`"三次测试"`中"第"字显示为``）是 API 返回文本中已存在的 Unicode 替换字符（0xEF 0xBF 0xBD），属于识别质量问题，非代码 Bug
  - **测试结果**：`make qa` 32/32 通过，已部署云端

- [FIX] 修复录音转写乱码问题（U+FFFD ``）
  - **问题现象**：转写文本中出现 `` 替换字符，如"现在是5点多，我是第四次测试"
  - **根本原因（通过 hex dump 确认）**：
    1. 现场录音保存为 MP3 格式（128kbps 有损压缩），引入编码伪影
    2. ASR API 对压缩伪影区域识别不确定时返回 U+FFFD（Unicode 替换字符）
    3. 实时 ASR 使用原始 PCM 无压缩无此问题
    4. 违反了项目规范中"现场录音需强制输出 16kHz 单声道 16-bit PCM WAV 格式"的要求
  - **修复内容**：
    - 新增 [server-cloud/pcm-to-wav.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/pcm-to-wav.ts)：16kHz/16bit/mono PCM → WAV（44字节头）编码模块
    - [server-cloud/index.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/index.ts)：将录音保存从 MP3（lamejs）改为 WAV 无损格式（同步写入，更快更可靠）
    - [server-cloud/auc-client.ts submitTask()](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/auc-client.ts#L151-L173)：默认音频格式改为 `wav`，并支持传入 `rate:16000, bits:16, channel:1` 参数
    - AUC submit 端点新增音频格式自动检测（根据文件扩展名），支持 wav/mp3/m4a/webm/ogg
    - `/recordings/` 和 `/uploads/` 静态文件服务统一为多格式支持
  - **可规避乱码的关键参数**：
    - 音频格式：使用 WAV（无损PCM）> MP3（有损），WAV 与实时 ASR 音质一致
    - 采样参数：16kHz、单声道、16-bit 是 ASR 模型的最佳输入规格
    - AUC API 参数：`enable_itn=true`（逆文本规整）、`enable_punc=true`（标点恢复）、`enable_ddc=true`（顺滑去语气词）保持开启
    - 环境因素：清晰麦克风、安静环境、正常音量说话也会影响识别准确度
  - **测试结果**：`make qa` 32/32 通过，已部署云端，并清理了旧的 .mp3 录音文件

- [FIX] ~~修复录音转写乱码问题（续）——补全二遍识别与热词参数~~ ⚠️ **方向有误，作废**
  - **误判原因**：最初以为乱码是缺少 `enable_nonstream` 等质量参数导致。经查阅火山引擎官方文档（https://www.volcengine.com/docs/6561/1354868）确认：`enable_nonstream`/`result_type`/`force_to_speech_time` 是**流式 WebSocket 接口**专属参数，AUC 录音文件识别 API 不支持这些字段。传入可能导致 API 参数解析异常，回退到默认配置。
  - **社区参考**：成熟开源实现（github.com/vahnxu/doubao-asr）仅传基础参数（model_name/enable_itn/enable_punc/enable_ddc/show_utterances/enable_speaker_info）即可正常识别，不传热词也无乱码。
  - **正确修复见下方**：HTTP 响应分块 UTF-8 解码截断才是乱码的真正根因。

- [FIX] **真正修复录音转写乱码问题（U+FFFD ``）—— HTTP 响应分块解码截断**
  - **问题现象**：转写文本中随机出现 `` 替换字符（U+FFFD），如"现在是��上5:53"、"第��次测试"，出现位置不固定，有时整句正常有时局部乱码
  - **根本原因**：
    1. [server-cloud/auc-client.ts httpsRequest()](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/auc-client.ts#L95-L151) 使用 `responseBody += chunk` 拼接 HTTP 响应
    2. Node.js `https` 模块的 `data` 事件 chunk 是 **Buffer**（原始字节），用 `+=` 操作符隐式转换为字符串时，**每个 chunk 独立做 UTF-8 解码**
    3. 中文字符的 UTF-8 编码占 3 字节（如"晚"= `0xE6 0x99 0x9A`），当 TCP 分块边界恰好切分这 3 字节时：
       - chunk1 末尾拿到不完整的字节序列（如 `0xE6 0x99`）→ 解码为 U+FFFD
       - chunk2 开头拿到孤立的剩余字节（如 `0x9A`）→ 也解码为 U+FFFD
    4. 这是 Node.js 中经典的 HTTP 响应解码陷阱！WebSocket 不受影响是因为每个 WS frame 是完整消息。
  - **修复内容**：
    - [server-cloud/auc-client.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/auc-client.ts#L130-L141)：改为**先收集所有 Buffer chunks，最后 Buffer.concat 拼接为完整 Buffer，再一次性 toString('utf8')**，彻底避免多字节字符被分块截断
    - 同时修正 AUC API 参数格式：`corpus` 字段类型从 object 改为 string（JSON 双重序列化），移除 AUC 不支持的 `result_type`/`enable_nonstream`/`force_to_speech_time` 参数，添加必填的 `user: { uid: 'web-demo-user' }` 字段（参考官方文档示例）
  - **代码变更**：
    - `server-cloud/auc-client.ts`：修复 HTTP 响应解码（核心修复）+ 修正接口定义
    - `server-cloud/index.ts`：修正 corpus 双重序列化 + 移除无效参数
    - `server-cloud/asr-config.ts`：导出热词常量供 AUC 复用
  - **测试结果**：`make qa` 32/32 全部通过，TypeScript 编译无错误，已部署至云端生产环境（PM2 doubao-asr-cloud 已 reload）

- [FIX] Hotfix：修正 corpus 字段类型（应为STRUCT/object而非string）
  - **问题**：部署后提交转写任务时报错 `kiteX processing error: need STRUCT type, but got: STRING`（field[corpus]）
  - **原因**：上一轮修复中对官方文档理解有误——`corpus` 字段在 kiteX thrift 协议中定义为 STRUCT（即JSON object），不是顶层string。只有其内部的 `context` 和 `correct_words` 子字段是JSON字符串（需要序列化）。
  - **修复**：
    - `server-cloud/auc-client.ts`：`AucSubmitRequest.corpus` 类型从 `string` 改回 `object`（带context/correct_words可选字段）
    - `server-cloud/index.ts`：`submitParams.corpus = corpusObj` 直接赋值object，不再 `JSON.stringify(corpusObj)`
  - **HTTP分块解码修复保留**：Buffer.concat + 一次性UTF-8解码的修复是正确的，仍然生效
  - **部署状态**：已重新构建、QA通过、同步至云端并PM2 reload成功（新PID 2876776）

## 2026-08-20 (实时声纹匹配功能)

- [FEAT] 实时双向流ASR说话人识别（本地CAM++声纹）完整实现
  - **功能概述**：基于GPU节点已部署的阿里达摩院3D-Speaker CAM++模型，实现实时ASR字幕的说话人姓名自动识别，解决火山豆包SAUC API不支持voiceprints参数的限制。支持"快速对答"场景（两人几乎无延迟对话）下的声纹分离，四层递进式匹配策略确保首次识别p99≤5秒。
  - **架构设计**：Node.js(txcvm) + Python CAM++ Embedding服务(GPU V100)侧车模式
    - GPU节点零修改：直接复用已在192.168.1.146:8002运行的FastAPI服务
    - 所有匹配逻辑、声纹库、余弦相似度计算全部在Node.js侧完成
    - 单条embedding推理45-50ms，余弦计算<1ms（100人规模）
  - **后端 (server-cloud/)**:
    - 新增 `config.ts` 配置项：14个VOICEPRINT_*参数（阈值、超时、端口、最大人数等）
    - 新增 `gpu-embed-client.ts`：HTTP keepAlive连接池客户端，支持wav/pcm输入，base64编码，2秒超时，healthCheck
    - 新增 `realtime-speaker-matcher.ts`：四层匹配状态机核心
      1. 高置信度早停：单分句净语音≥800ms，top1≥85分且领先第二名≥25分→立即确认
      2. 增量Embedding聚合：加权平均多句embedding，连续2次同一人≥80分→确认
      3. 互斥约束：已绑定名字的人不再参与其他speaker匹配
      4. 超时兜底：3秒强制匹配（≥60分确认，≥50分低置信度标记），5秒硬截止标记为"参会人N"
    - 静态全局声纹库 + per-session状态隔离（环形缓冲区30秒、speaker绑定状态）
    - 声纹注册双写：字节云端注册成功后，本地调用GPU提取embedding存入内存库
    - 注册强校验：音频≥15秒，总人数≤100人
    - WebSocket集成：音频帧feed环形缓冲区，ASR definite utterance触发匹配，事件实时广播
    - 手动绑定：bind_speaker消息支持用户手动指定说话人
  - **前端 (public-cloud/)**:
    - 6种说话人徽章状态：unknown/identifying/matched_high/matched_low/manual_bound/guest
    - 新增CSS样式：低置信度（半透明斜体+问号）、参会人（灰色虚线边框）
    - 新事件格式：speaker_identifying/speaker_matched(confidence/method)/speaker_guest
    - speakerOverrides增量更新，全量重渲染实现历史徽章回溯更新
    - 兼容旧事件格式避免过渡期错误
  - **工程化**:
    - ecosystem.config.cjs新增VOICEPRINT_ENABLED=true环境变量
    - PM2 cluster模式部署，max_memory_restart=500M
  - **关键技术决策**:
    - GPU零修改：利用已有embedding服务，不部署新组件，降低运维复杂度
    - 内存声纹库：100人×192维Float32≈77KB，无需FAISS/Annoy，纯JS余弦计算性能足够
    - Per-speaker状态锁：避免同一speaker并发匹配请求
    - 旧声纹不自动迁移：字节API不返回embedding且模型空间不同，需用户重新注册15秒音频启用实时识别
  - **测试结果**:
    - TypeScript编译通过（新增3个文件无错误）
    - JavaScript语法检查通过（node -c）
    - build:cloud构建成功，dist目录完整
    - 云端部署成功：PM2服务online，GPU健康检查OK
    - 公网页面访问200，声纹列表API返回27个声纹
    - 浏览器E2E自动化验证：页面加载、WS连接、声纹面板、麦克风按钮均正常

## 2026-08-21 (Bug修复 + AUC声纹默认开启 + 本地声纹持久化)

- [FIX] 实时声纹匹配未触发的两个根因修复
  - **根因1**：SAUC流式响应中`speaker_id`为字符串类型`"0"`而非数字`0`，`typeof spkId === 'number'`判断失败导致匹配逻辑完全不进入
  - **根因2**：`audioStartTime`在WebSocket连接建立时设置，而非第一个音频包到达时；连接到开始说话的延迟导致ASR时间坐标与ringBuffer时间坐标偏移，提取到空音频
  - **修复**：`parseInt(spkId, 10)`做类型转换；新增`markAudioStart()`方法在第一个音频包到达时校准时间坐标
  - **验证**：用户实测实时字幕成功显示"尹龙"，识别延迟符合预期

- [FIX] 页面路由错误 + 声纹按钮消失
  - **根因**：部署时误用`npm run build`（本地版构建，不含public-cloud目录）而非`npm run build:cloud`；rsync带`--delete`参数误删服务器public-cloud前端文件和node_modules
  - **修复**：使用正确的`build:cloud`命令构建；rsync同步不带`--delete`，显式排除node_modules/recordings/uploads/transcripts/logs/voiceprints目录
  - **npm install**恢复服务器依赖；ecosystem配置补回VOICEPRINT_ENABLED环境变量

- [FIX] 录音文件AUC转写不使用声纹（说话人只显示"说话人1"）
  - **根因**：`DEFAULT_AUC_CONFIG.use_voiceprints`默认值为`false`，PM2重启后全局配置重置，提交AUC任务时`voiceprints=0`未传入任何声纹ID
  - **修复**：后端[server-cloud/index.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/index.ts#L166)和前端[public-cloud/app.js](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/public-cloud/app.js#L2795)默认值均改为`true`，表单提交fallback值也改为true
  - **验证**：`/api/auc/config`接口返回`use_voiceprints: true`

- [FEAT] 本地声纹库JSON文件持久化（v4.0）
  - **功能**：解决PM2重启后本地内存声纹库清空、需重新注册的问题
  - **存储方案**：
    - 存储路径：`{workDir}/voiceprints/local-voiceprints.json`
    - 文件格式：JSON（version/updatedAt/speakers[]），Float32Array序列化为number数组
    - 100人声纹数据≈150KB，全量覆写<1ms
  - **后端变更**：
    - [config.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/config.ts#L36)：新增`voiceprintsDir`配置项（默认`voiceprints`）
    - [realtime-speaker-matcher.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/realtime-speaker-matcher.ts#L72-L140)：新增`initPersistentStorage()`启动加载、`saveToDiskSync()`原子写盘（tmp+rename防损坏）；`enrollGlobalSpeaker`/`deleteGlobalSpeaker`变更时自动同步写盘；文件损坏不崩溃仅打error日志空库启动
    - [index.ts](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/server-cloud/index.ts#L49-L67)：启动时创建voiceprints目录并调用初始化方法
    - [package.json](file:///Users/bytedance/Documents/work-trae/05%20doubao-ASR/package.json#L10)：build:cloud脚本新增`mkdir -p dist/voiceprints`
  - **一致性保证**：内存是source of truth，持久化文件是快照；写失败仅打日志不阻塞业务，下次启动从最后一次成功快照恢复
  - **部署验证**：
    - 首次启动：日志显示`Created voiceprints directory` + `No persistent voiceprint file found, starting with empty library`
    - 热注册"尹龙"后：文件生成(4KB)，包含正确192维embedding
    - **PM2重启验证**：日志显示`Loaded 1 speakers from persistent storage`，API返回`localCount=1`，尹龙声纹无需重新注册
  - **rsync安全**：同步时排除`voiceprints`目录，防止部署覆盖已有持久化数据

- [DOCS] REALTIME_VOICEPRINT_DESIGN.md更新至v4.0
  - 从"非目标"中移除"不做声纹库持久化"条目
  - 新增7.3节本地声纹库持久化设计（存储方案、启动加载流程、写入时机、一致性保证）

## 2026-10-20 (部署安全加固 + 前端缓存版本)

- [FIX] `Makefile` cloud-sync 增加 `--exclude='voiceprints/*'`：修复 rsync `--delete` 会删除线上本地声纹库（voiceprints/local-voiceprints.json）的隐患，同步后自动 mkdir 保留目录。
- [FIX] `Makefile` cloud-sync 增加 `--exclude='inventory.local.env'`：防止开发机构建产物中的占位/本地凭证覆盖 txcvm 生产凭证，凭证仅由目标环境维护。
- [CHORE] public-cloud 静态资源版本号 bump 至 `?v=20261020a`，强制浏览器加载 v5.0 漂移修复后的 app.js/style.css。

## 2026-10-20 (RealtimeSpeakerMatcher 单元测试补齐)

- [FEAT] 新增 `test/realtime-speaker-matcher.test.ts`（node:test + ts-node，零新增依赖）
  - 覆盖漂移连续计数与第 3 次自动纠正（drift_correction）、同姓名跨槽位颜色复用、guest 连续命中升级实名（guest_upgrade）、高置信确认重置漂移计数、v4.0 回退开关 5 个场景。
  - 通过覆写 `gpuEmbedClient.extractEmbedding` 注入 192 维向量、mutate `config` 阈值、合成高能量 PCM 实现可重复的纯状态机测试。
- [CHORE] `package.json` 新增 `npm test`；`Makefile` qa 新增第 33 项检查，`make qa` 升级为 33 项。
- [CHORE] aidlc 本地冒烟通过：服务启动、GPU embedding health、静态页与 config 接口正常（无豆包凭证，外部声纹列表接口除外）。
- 说明：双人实时 E2E 仍待人工验证。

## 2026-10-20 (v5.0 声纹漂移纠正实现)

- [FIX] 实现实时声纹标签漂移检测与自动纠正
  - 已绑定和 guest 状态不再永久信任 ASR `speaker_id`，每个满足最短语音时长的 definite utterance 均重新提取 embedding 并校验。
  - 新增连续漂移计数、当前绑定验证分数及验证时间；连续达到阈值后自动重映射为高置信注册人或 guest。
  - guest 连续命中同一注册人达到阈值后自动升级为实名说话人。
  - 增加 `VOICEPRINT_DRIFT_CORRECTION_ENABLED` 回退开关；关闭后恢复 v4.0 的“已绑定即跳过”行为。
  - 增加漂移阈值、最低纠正分数、最低验证分数和 guest 升级次数配置项。

- [FEAT] 统一说话人颜色与前端事件传递
  - 后端按姓名分配并复用颜色，避免同一人在不同 ASR speaker 槽位显示不同颜色。
  - `speaker_matched` 与 `speaker_guest` WebSocket 事件新增 `color` 字段。
  - 前端优先使用后端颜色，并在历史覆盖信息更新时同步颜色。

- [CHORE] 增强声纹判定日志
  - 服务启动记录漂移纠正开关状态。
  - 每个已处理分句记录时间范围、当前绑定、top1、分数、漂移计数与判定结果。

- [DOCS] 实现与设计对齐
  - 实现依据：`docs-new/REALTIME_VOICEPRINT_DESIGN.md` v5.0 第 13 节。
  - 涉及文件：`server-cloud/realtime-speaker-matcher.ts`、`server-cloud/config.ts`、`server-cloud/index.ts`、`public-cloud/app.js`。
  - 质量门禁结果记录于 `docs-new/TEST_EXECUTION_LOG.md`。

## 2026-10-20 (aidlc Codex 开发环境迁移)

- [DOCS] 新增 aidlc 云端开发交接文档
  - 新增 `docs-new/CLOUD_AIDLC_HANDOFF.md`，记录目标路径、环境基线、迁移步骤、密钥边界、回滚方式和后续开发重点。
  - 明确 GitHub `main` 为代码真相源，aidlc 仅作为云端开发环境，本次不切换生产服务。

- [CHORE] 新增 Codex 仓库级开发约束
  - 新增 `AGENTS.md`，要求 Codex 遵循文档先行、spike 分支、测试审计、`make qa`、密钥隔离和运行前检查。
  - 固化云端路径 `/data/codex/workspace/03-meetingASR`、Node.js 版本和国内 npm 镜像要求。

- [CHORE] 迁移边界
  - 通过 GitHub 克隆代码，不复制本机 `inventory.local.env`、Token、私钥、运行时音频或声纹数据。
  - aidlc 目标目录迁移前为空，不覆盖现有远端工作。

- [CHORE] aidlc 迁移完成
  - GitHub `main` 已克隆至 `/data/codex/workspace/03-meetingASR`。
  - npm 已配置淘宝镜像并通过 `npm ci` 安装依赖。
  - 远端 `make qa` 32/32 通过，`codex-cli 0.159.0` 可用。
