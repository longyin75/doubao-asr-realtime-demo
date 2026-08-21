# 实时声纹匹配功能 - E2E测试执行报告

**测试时间**: 2026-08-20 23:25-23:35
**测试环境**: 生产环境 txcvm (62.234.42.199:36001) + GPU节点 (192.168.1.146:8002)
**访问地址**: https://longer8888.tech/asr-demo-multi/
**部署版本**: v1.0.0-realtime-voiceprint

---

## 一、环境验证

| 检查项 | 结果 | 证据/日志 |
|--------|------|-----------|
| GPU embedding服务健康 | ✅ 通过 | `[cloud] GPU embed service health: OK` |
| PM2服务状态 | ✅ online | doubao-asr-cloud pid=3393364, uptime=0s |
| 公网页面访问 (HTTP 200) | ✅ 通过 | curl返回200 |
| 声纹列表API | ✅ 通过 | 返回27个声纹，localCount=0（预期：内存库重启清空） |
| TypeScript编译 | ✅ 通过 | tsc --noEmit 无错误 |
| 前端JS语法 | ✅ 通过 | node -c app.js 无错误 |
| build:cloud构建 | ✅ 通过 | dist目录完整生成 |

---

## 二、浏览器自动化E2E测试结果

使用BUA (Browser-Use Automation) Agent执行自动化测试，验证结果：

| 测试项 | 结果 | 说明 |
|--------|------|------|
| 页面加载 | ✅ 通过 | 标题包含'ASR'，页面元素完整 |
| WebSocket自动连接 | ✅ 通过 | 事件日志显示"WebSocket 已连接" |
| 麦克风按钮存在 | ✅ 通过 | UI元素可交互 |
| 声纹管理按钮 | ✅ 通过 | 按钮可点击，位于index 0 |
| 声纹面板打开 | ✅ 通过 | 点击后弹出模态框 |
| 声纹列表加载 | ✅ 通过 | 可见21个声纹条目（罗新宇、严伟、赵磊磊、易中天、王立群、杨澜、马斯克、罗永浩、王自如、于谦、希拉里、特朗普、罗翔、刘宝瑞、林志玲、郦波、华春莹、郭德纲、卢亮、ligs66、邓聪） |
| 配置面板存在 | ✅ 通过 | 参数配置区域正常显示 |
| 事件日志区域 | ✅ 通过 | 连接事件实时展示 |
| JavaScript错误 | ✅ 无致命错误 | 页面正常交互无阻塞报错 |

**浏览器测试日志摘要**:
```
INFO: Page loaded successfully. Title contains 'ASR'
INFO: 声纹管理 button exists (index 0)
INFO: WebSocket status shows '已连接'
INFO: microphone button exists (index 15)
INFO: Voiceprint management panel opened, shows 21 registered voiceprints
```

---

## 三、后端代码结构验证

新增/修改文件清单：

### 新增文件
1. **server-cloud/gpu-embed-client.ts** - GPU embedding服务客户端
   - keepAlive HTTP连接池 (maxSockets=10)
   - extractEmbedding(audio, format) → Promise<{embedding: Float32Array, duration_ms: number}>
   - healthCheck() → Promise<boolean>
   - 2秒超时，base64编解码

2. **server-cloud/realtime-speaker-matcher.ts** - 四层匹配状态机
   - 静态全局声纹库 (globalSpeakerDB: Map<string, Float32Array>)
   - per-session实例状态：环形缓冲区、speaker状态、互斥锁、超时定时器
   - 四层匹配逻辑实现：
     1. 高置信度早停 (top1≥85, margin≥25)
     2. 增量Embedding聚合 (连续2次同一人≥80)
     3. 互斥约束 (一人一ID，排除已绑定)
     4. 超时兜底 (3s强制/5s硬截止/参会人标记)
   - 事件：speaker_identifying, speaker_matched(confidence: high/low, method), speaker_guest
   - 余弦相似度计算 (纯JS，<1ms/100人)
   - 加权平均mergeEmbedding + L2归一化

### 修改文件
3. **server-cloud/config.ts**
   - Config接口新增14个VOICEPRINT_*配置项
   - voiceprintEnabled改为环境变量控制 (VOICEPRINT_ENABLED=true)

4. **server-cloud/index.ts**
   - 声纹注册接口双写：字节云端成功后提取embedding写入全局库
   - 注册时长校验 (≥15秒)、人数上限校验 (≤100人)
   - 声纹删除同步删除本地embedding
   - per-session RealtimeSpeakerMatcher实例创建
   - WebSocket音频帧feedAudio喂入环形缓冲区
   - ASR definite utterance触发匹配
   - matcher事件转发给前端
   - bind_speaker消息处理手动绑定
   - speakerOverrides随result消息下发前端
   - 服务启动GPU健康检查日志

5. **public-cloud/app.js**
   - 6种徽章状态支持：unknown/identifying/matched_high/matched_low/manual_bound/guest
   - 新事件格式处理：speaker_identifying/speaker_matched(confidence)/speaker_guest
   - speakerOverrides对象处理
   - 兼容旧事件名
   - 低置信度斜体半透明样式、参会人虚线灰色样式

6. **public-cloud/style.css**
   - 新增.speaker-identified-low（半透明斜体）
   - 新增.speaker-guest（灰色虚线边框）

---

## 四、已知限制与后续验证项

### ⚠️ 需要人工验证（依赖真实麦克风录音）
1. **实际声纹识别准确率** - 需要2-6人现场对话测试
2. **快速对答场景延迟** - p50≤2s, p95≤4s, p99≤5s
3. **识别后徽章回溯更新** - 匹配成功瞬间历史字幕标签更新
4. **手动绑定功能** - 点击徽章弹出绑定对话框
5. **新声纹注册双写** - 注册新wav文件是否成功写入全局embedding库
6. **低置信度状态展示** - matched_low的问号显示
7. **参会人标记** - 超时无法匹配时标记为"参会人N"

### 说明
- 旧声纹（已注册的27个）**不会自动迁移**到本地embedding库（因为字节API不返回embedding，模型空间不同）。要启用实时识别功能，这些用户需要重新录制≥15秒音频注册（新注册会双写本地库）。
- 声纹本地库为进程内存存储，PM2重启后清空。生产环境如有需要可持久化到文件，但考虑到双写重新注册成本低（15秒/人），当前内存存储满足需求。

---

## 五、日志留存位置

| 日志类型 | 本地路径 | 服务器路径 |
|----------|----------|------------|
| PM2启动日志 | test-logs/e2e/pm2_startup_logs.txt | /root/doubao-asr-cloud/logs/out.log |
| PM2错误日志 | - | /root/doubao-asr-cloud/logs/error.log |
| 构建产物 | dist/ | - |
| E2E测试任务 | test-logs/bua_task.md | - |
| 本报告 | test-logs/E2E_TEST_REPORT.md | - |

---

## 六、部署配置

服务器 ecosystem.config.cjs 环境变量：
```javascript
env: {
  NODE_ENV: 'production',
  CLOUD_PORT: 3001,
  VOICEPRINT_ENABLED: 'true',
}
```

GPU服务信息：
- 地址：http://192.168.1.146:8002
- 模型：iic/speech_campplus_sv_zh-cn_16k-common v2.0.2 (CAM++)
- GPU：Tesla V100-SXM2-32GB
- 单条embedding推理：45-50ms
- 向量维度：192维 L2归一化
