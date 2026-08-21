/**
 * 字节 openspeech 声纹注册工具
 * 使用方法:
 *   node voiceprint-register.js test                     # 测试接口连接
 *   node voiceprint-register.js list                     # 列出已注册声纹
 *   node voiceprint-register.js register <name> <url>    # 用音频URL注册
 *   node voiceprint-register.js delete <speakId>         # 删除声纹
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
require('dotenv').config({ path: path.join(__dirname, 'inventory.local.env') });

const API_KEY = process.env.DOUBAO_API_KEY || '';
const APP_KEY = process.env.DOUBAO_APP_KEY || '';
const ACCESS_KEY = process.env.DOUBAO_ACCESS_KEY || '';

function buildAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (APP_KEY && ACCESS_KEY && ACCESS_KEY !== API_KEY) {
    headers['X-Api-App-Id'] = APP_KEY;
    headers['X-Api-Access-Key'] = ACCESS_KEY;
  } else if (API_KEY) {
    headers['X-Api-Key'] = API_KEY;
  }
  return headers;
}

function doRequest(options, postData, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const lib = options.protocol === 'http:' ? http : https;
    const headers = { ...buildAuthHeaders(), ...options.headers };
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);

    const req = lib.request({ ...options, headers, timeout: 30000 }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let location = res.headers.location;
        let redirectUrl;
        if (location.startsWith('/')) {
          redirectUrl = new url.URL(location, `${options.protocol}//${options.hostname}${options.port ? ':' + options.port : ''}`);
        } else {
          redirectUrl = new url.URL(location);
        }
        res.resume();
        const newOpts = {
          protocol: redirectUrl.protocol,
          hostname: redirectUrl.hostname,
          port: redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80),
          path: redirectUrl.pathname + redirectUrl.search,
          method: options.method,
          headers: options.headers,
        };
        doRequest(newOpts, postData, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (!data) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, headers: res.headers, data: null });
          } else {
            reject(new Error(`HTTP ${res.statusCode} empty response`));
          }
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout (30s)')); });
    if (postData) req.write(postData);
    req.end();
  });
}

async function request(action, body) {
  const targetUrl = new url.URL(`https://openspeech.bytedance.com/api/proxy/invoke?Action=${action}`);
  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: 443,
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
  };
  const postData = JSON.stringify(body);
  const result = await doRequest(options, postData);

  if (result.data && typeof result.data === 'object' && result.data.ResponseMetadata?.Error) {
    throw new Error(`${result.data.ResponseMetadata.Error.Code}: ${result.data.ResponseMetadata.Error.Message}`);
  }
  if (result.statusCode >= 400) {
    const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    throw new Error(`HTTP ${result.statusCode}: ${text.substring(0, 300)}`);
  }
  return result.data;
}

async function testConnection() {
  console.log('🔍 测试字节 openspeech 声纹接口连接...\n');
  try {
    const res = await request('ListVoiceprint', { Limit: 1, Offset: 0 });
    console.log('✅ 连接成功!');
    console.log(`   RequestId: ${res.ResponseMetadata?.RequestId}`);
    console.log(`   已注册声纹数量: ${res.Result?.TotalCount || 0}`);
    return true;
  } catch (e) {
    console.log('❌ 连接失败:', e.message);
    return false;
  }
}

async function listVoiceprints() {
  console.log('📋 已注册声纹列表:\n');
  try {
    let all = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const res = await request('ListVoiceprint', { Limit: limit, Offset: offset });
      const items = res.Result?.AudioEmbedding || [];
      all = all.concat(items);
      if (items.length < limit) break;
      offset++;
    }
    if (all.length === 0) {
      console.log('   (暂无注册声纹)');
    } else {
      console.log(`   总数: ${all.length}`);
      console.log('');
      all.forEach((v, i) => {
        console.log(`   ${i + 1}. ${v.SpeakerName || v.speaker_name || '(未命名)'}`);
        console.log(`      SpeakId: ${v.SpeakId || v.speak_id || v.Id || v.id}`);
        console.log(`      Status: ${v.Status === 1 ? '正常' : v.Status === 2 ? '已删除' : v.Status}`);
        if (v.AudioUrl) console.log(`      AudioUrl: ${v.AudioUrl}`);
        console.log('');
      });
    }
  } catch (e) {
    console.log('❌ 获取列表失败:', e.message);
  }
}

async function registerVoiceprint(name, audioUrl) {
  console.log(`🎤 注册声纹: ${name}`);
  console.log(`   AudioUrl: ${audioUrl}\n`);
  try {
    const res = await request('UpdateVoiceprint', {
      Action: 0,
      SpeakerName: name,
      AudioUrl: audioUrl,
    });
    console.log('✅ 声纹注册成功!');
    console.log(`   SpeakId: ${res.Result?.SpeakId || res.Result?.speakId}`);
    console.log(`   RequestId: ${res.ResponseMetadata?.RequestId}`);
    return res.Result?.SpeakId || res.Result?.speakId;
  } catch (e) {
    console.log('❌ 注册失败:', e.message);
    return null;
  }
}

async function deleteVoiceprint(speakId) {
  console.log(`🗑️  删除声纹: ${speakId}\n`);
  try {
    await request('UpdateVoiceprint', {
      Action: 2,
      SpeakId: speakId,
    });
    console.log('✅ 删除成功');
  } catch (e) {
    console.log('❌ 删除失败:', e.message);
  }
}

// ========== Main ==========
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  console.log('='.repeat(60));
  console.log('   字节 openspeech 声纹注册工具');
  console.log('='.repeat(60));
  console.log('');

  switch (cmd) {
    case 'test':
      await testConnection();
      break;
    case 'list':
      await listVoiceprints();
      break;
    case 'register':
      if (args.length < 3) {
        console.log('用法: node voiceprint-register.js register <说话人名称> <音频URL>');
        console.log('');
        console.log('【声纹注册需要提供的内容】');
        console.log('');
        console.log('1. 说话人名称 (SpeakerName):');
        console.log('   - 字符串，用于标识是谁的声音');
        console.log('   - 建议使用姓名、工号或昵称');
        console.log('');
        console.log('2. 音频URL (AudioUrl):');
        console.log('   - ❗️ 必须是公网可访问的URL（字节服务器需要能下载到音频）');
        console.log('   - 支持格式: WAV, MP3, M4A 等常见音频格式');
        console.log('');
        console.log('【音频录制要求】');
        console.log('');
        console.log('   ✅ 推荐:');
        console.log('      - 时长: 3-10秒（最短1.5秒）');
        console.log('      - 环境: 安静，无背景噪音/音乐');
        console.log('      - 内容: 单人清晰说话，自然语音即可，不需要特定文本');
        console.log('      - 设备: 正常手机/电脑麦克风即可');
        console.log('');
        console.log('   ❌ 避免:');
        console.log('      - 多人同时说话');
        console.log('      - 背景音乐或噪音');
        console.log('      - 过长的静音片段');
        console.log('      - 音频过短（<1.5秒）');
        console.log('');
        console.log('【如何获取音频URL】');
        console.log('   方案A: 如果你有对象存储(TOS/S3/OSS)，直接上传音频获取公网URL');
        console.log('   方案B: 将音频文件发给我，我帮你在服务端临时托管提供URL');
        console.log('   方案C: 我可以在本项目server上添加临时音频上传/托管端点');
        process.exit(1);
      }
      await registerVoiceprint(args[1], args[2]);
      break;
    case 'delete':
      if (args.length < 2) {
        console.log('用法: node voiceprint-register.js delete <SpeakId>');
        process.exit(1);
      }
      await deleteVoiceprint(args[1]);
      break;
    case 'help':
    default:
      console.log('可用命令:');
      console.log('  test                         测试接口连接');
      console.log('  list                         列出已注册声纹');
      console.log('  register <name> <audioUrl>  注册新声纹');
      console.log('  delete <speakId>             删除声纹');
      console.log('');
      console.log('运行 `node voiceprint-register.js register` 查看详细的音频要求说明');
  }
}

main().catch(console.error);
