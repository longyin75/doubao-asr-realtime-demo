# 豆包语音 ASR 实时识别 Demo

基于火山引擎豆包语音 ASR 大模型的浏览器端实时语音识别 Demo。

## 功能

- 🎙️ 浏览器麦克风实时录音
- 📊 实时音量可视化
- 🔊 PCM S16LE / 16kHz / 单声道音频编码
- 🚀 WebSocket 流式传输
- 🤖 豆包 Seed ASR 2.0 大模型识别（流式输入模式）
- 📝 自动标点和数字转换
- 🎨 Google Material Design 风格 UI

## 架构

```
浏览器 (Web Audio API)
    │ 二进制 PCM
    ▼
Node.js 代理 (ws) ────► 豆包 ASR (wss://openspeech.bytedance.com)
    :3000                    鉴权头 (X-Api-App-Key/Access-Key/Resource-Id)
```

浏览器无法直接在 WebSocket 握手时设置自定义 HTTP 头，因此通过 Node.js 后端代理转发。

## 快速开始

### 前置要求

- Node.js 18+
- 麦克风权限

### 安装依赖

```bash
npm install
```

### 配置（可选）

默认已内置测试 Key，如需替换请复制模板：

```bash
cp inventory.local.env.example inventory.local.env
# 编辑 inventory.local.env 填入你的 Key
```

### 启动开发服务器

```bash
npm run dev
# 或
make dev
```

打开浏览器访问 http://localhost:3000

### 构建生产版本

```bash
npm run build
node dist/server/index.js
```

## 使用方法

1. 点击蓝色麦克风按钮
2. 允许麦克风权限
3. 开始说话，按钮变红表示录音中，音量条会实时跳动
4. 再次点击按钮停止录音
5. 等待 1-2 秒，识别结果显示在文本区域

## 技术栈

- **前端**: 原生 HTML/CSS/JS，Web Audio API，WebSocket
- **后端**: Node.js + TypeScript + ws
- **ASR**: 火山引擎豆包语音 Seed ASR Streaming 2.0 (bigmodel_nostream)

## 音频参数

- 格式: PCM
- 采样率: 16000 Hz
- 位深: 16-bit
- 声道: 单声道
- 分块: 200ms (6400 bytes)

## 协议说明

豆包 ASR WebSocket 使用自定义二进制协议：
- 4 字节头部 (版本/消息类型/序列化/保留)
- 4 字节 payload 长度 (大端)
- payload 数据 (JSON 或音频 PCM)

## Make 命令

```
make install    # 安装依赖（使用淘宝镜像）
make dev        # 启动开发服务器
make build      # 构建 TypeScript
make start      # 启动生产版本
make qa         # 质量门禁（编译 + 语法检查）
make clean      # 清理构建产物
```
