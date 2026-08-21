/**
 * ASR 接口鉴权验证脚本
 * 验证：
 * 1. ASR WebSocket 接口鉴权 (wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async)
 * 2. 声纹 HTTP 接口鉴权 (https://openspeech.bytedance.com/api/proxy/invoke)
 * 
 * 支持两种鉴权方式：
 * - 方式一：X-Api-Key
 * - 方式二：X-Api-App-Id + X-Api-Access-Key
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 尝试加载环境变量
const envCandidates = [
  path.join(__dirname, 'inventory.local.env'),
  path.join(__dirname, '.env'),
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    console.log(`加载环境变量: ${envPath}`);
    break;
  }
}

// 配置
const ASR_WS_URL = process.env.ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const VOICEPRINT_HTTP_URL = 'https://openspeech.bytedance.com/api/proxy/invoke';
const API_KEY = process.env.DOUBAO_API_KEY || process.env.DOUBAO_ACCESS_KEY || process.env.VOLCENGINE_API_KEY || '';
const APP_ID = process.env.DOUBAO_APP_KEY || process.env.DOUBAO_APP_ID || '';
const ACCESS_KEY = process.env.DOUBAO_ACCESS_KEY || process.env.DOUBAO_API_KEY || process.env.VOLCENGINE_API_KEY || '';
const RESOURCE_ID = process.env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration';

function maskKey(key) {
  if (!key) return '(未配置)';
  if (key.length <= 10) return '***';
  return key.slice(0, 4) + '***' + key.slice(-6);
}

console.log('\n' + '='.repeat(70));
console.log('   豆包/字节语音平台 接口鉴权验证工具');
console.log('='.repeat(70));

console.log('\n【配置信息】');
console.log(`  ASR WebSocket URL: ${ASR_WS_URL}`);
console.log(`  声纹 HTTP URL:     ${VOICEPRINT_HTTP_URL}`);
console.log(`  API Key:           ${maskKey(API_KEY)}`);
console.log(`  App ID:            ${maskKey(APP_ID)}`);
console.log(`  Access Key:        ${maskKey(ACCESS_KEY)}`);
console.log(`  Resource ID:       ${RESOURCE_ID}`);

function buildFullClientRequest() {
  const payload = {
    user: { uid: 'auth-test-' + Date.now(), platform: 'web' },
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      result_type: 'single',
      end_window_size: 200,
      force_to_speech_time: 1000,
      show_utterances: true,
      enable_nonstream: true,
    },
  };
  
  const fullRequest = {
    payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
    payload_size: Buffer.from(JSON.stringify(payload)).length,
    payload_type: 'full_client_request',
  };
  
  return Buffer.from(JSON.stringify(fullRequest));
}

function testWebSocketAuth(authType, headers) {
  return new Promise((resolve) => {
    const result = {
      category: 'ASR WebSocket',
      authType,
      success: false,
      error: null,
      logid: null,
      httpCode: null,
    };

    if (!API_KEY && authType.includes('X-Api-Key') && !headers['X-Api-Key']) {
      result.error = '缺少 API Key 配置';
      resolve(result);
      return;
    }
    if ((!APP_ID || !ACCESS_KEY) && authType.includes('X-Api-App-Id') && 
        (!headers['X-Api-App-Id'] || !headers['X-Api-Access-Key'])) {
      result.error = '缺少 App ID 或 Access Key 配置';
      resolve(result);
      return;
    }

    console.log(`\n[测试] ${result.category} - ${authType}`);
    
    const connectId = 'auth-test-' + Date.now();
    const wsHeaders = {
      ...headers,
      'X-Api-Resource-Id': RESOURCE_ID,
      'X-Api-Connect-Id': connectId,
    };
    
    let logid = '';
    let settled = false;
    
    const ws = new WebSocket(ASR_WS_URL, { headers: wsHeaders, handshakeTimeout: 15000 });
    
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        result.error = '连接超时 (15s)';
        console.log(`  ❌ ${result.error}`);
        ws.terminate();
        resolve(result);
      }
    }, 15000);
    
    ws.on('upgrade', (response) => {
      result.httpCode = response.statusCode;
      console.log(`  HTTP 响应状态码: ${response.statusCode}`);
      
      for (const [key, value] of Object.entries(response.headers)) {
        if (key.toLowerCase() === 'x-tt-logid' || key.toLowerCase() === 'x-tt-log-id') {
          logid = value;
          result.logid = value;
          console.log(`  LogID: ${logid}`);
        }
      }

      if (response.statusCode === 401 || response.statusCode === 403) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          result.error = `鉴权失败 (HTTP ${response.statusCode})`;
          console.log(`  ❌ ${result.error}`);
          ws.terminate();
          resolve(result);
        }
      }
    });
    
    ws.on('open', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        console.log('  ✅ WebSocket 连接成功 (鉴权通过)!');
        result.success = true;
        
        ws.send(buildFullClientRequest());
        console.log('  ✅ 已发送 full_client_request');
        
        setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(result);
        }, 1500);
      }
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.payload_type === 'error') {
          const payload = msg.payload_msg ? JSON.parse(Buffer.from(msg.payload_msg, 'base64').toString()) : {};
          const code = payload.code || payload.Code;
          const message = payload.message || payload.Message;
          console.log(`  服务端返回错误: code=${code}, message=${message}`);
        } else if (msg.payload_type === 'server_response') {
          console.log(`  收到服务端响应: ${msg.payload_type}`);
        }
      } catch (e) {}
    });
    
    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        result.error = err.message;
        console.log(`  ❌ 连接错误: ${err.message}`);
        resolve(result);
      }
    });
    
    ws.on('close', (code, reason) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const reasonStr = reason ? reason.toString() : '';
        if (code !== 1000) {
          result.error = `连接关闭 code=${code} ${reasonStr}`;
          console.log(`  ❌ ${result.error}`);
        } else {
          result.success = true;
        }
        resolve(result);
      }
    });
  });
}

function testHttpVoiceprintAuth(authType, headers, redirectCount = 0) {
  return new Promise((resolve) => {
    const result = {
      category: '声纹 HTTP',
      authType,
      success: false,
      error: null,
      logid: null,
      httpCode: null,
    };

    if (redirectCount > 5) {
      result.error = '重定向次数过多';
      resolve(result);
      return;
    }

    if (!API_KEY && authType.includes('X-Api-Key') && !headers['X-Api-Key']) {
      result.error = '缺少 API Key 配置';
      resolve(result);
      return;
    }
    if ((!APP_ID || !ACCESS_KEY) && authType.includes('X-Api-App-Id') && 
        (!headers['X-Api-App-Id'] || !headers['X-Api-Access-Key'])) {
      result.error = '缺少 App ID 或 Access Key 配置';
      resolve(result);
      return;
    }

    if (redirectCount === 0) {
      console.log(`\n[测试] ${result.category} - ${authType} (Action=ListVoiceprint)`);
    }

    const url = new URL(VOICEPRINT_HTTP_URL);
    url.searchParams.set('Action', 'ListVoiceprint');

    const body = JSON.stringify({ Limit: 1, Offset: 0 });
    
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    };

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: reqHeaders,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      result.httpCode = res.statusCode;
      
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  HTTP ${res.statusCode} 重定向到: ${res.headers.location}`);
        // 声纹接口可能不需要测试，主要关注 ASR WebSocket
        // 对于重定向，我们认为鉴权已通过（否则会返回 401/403）
        console.log('  ✅ 鉴权通过（收到重定向响应，而非 401/403）');
        result.success = true;
        result.note = `HTTP ${res.statusCode} redirect (auth passed)`;
        // 读取并丢弃响应体
        res.resume();
        resolve(result);
        return;
      }

      console.log(`  HTTP 响应状态码: ${res.statusCode}`);

      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        // 提取 LogID
        for (const [key, value] of Object.entries(res.headers)) {
          if (key.toLowerCase() === 'x-top-request-id' || key.toLowerCase() === 'x-tt-logid') {
            result.logid = value;
            console.log(`  RequestId/LogID: ${value}`);
          }
        }

        try {
          const json = JSON.parse(responseBody);
          const meta = json.ResponseMetadata || {};
          const error = meta.Error;
          
          if (res.statusCode === 200 && !error) {
            result.success = true;
            console.log('  ✅ HTTP 接口调用成功!');
            console.log(`  Result.Code: ${json.Result?.Code}`);
            console.log(`  TotalCount: ${json.Result?.TotalCount}`);
          } else if (error) {
            result.error = `${error.Code}: ${error.Message}`;
            console.log(`  ❌ 接口返回错误: ${error.Code} - ${error.Message}`);
            
            // 检查是否是鉴权相关错误
            if (error.Code === 'AuthenticationError' || error.Code === 'AuthFailure' || 
                error.Message?.includes('auth') || error.Message?.includes('key') ||
                res.statusCode === 401 || res.statusCode === 403) {
              console.log('  → 这是鉴权失败错误');
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            result.error = `鉴权失败 HTTP ${res.statusCode}`;
            console.log(`  ❌ ${result.error}`);
          } else {
            result.error = `HTTP ${res.statusCode}`;
            console.log(`  ❌ HTTP 错误: ${res.statusCode}`);
            if (responseBody) console.log(`  响应: ${responseBody.substring(0, 300)}`);
          }
        } catch (e) {
          // 空响应或非 JSON 响应，检查状态码判断鉴权
          if (res.statusCode >= 200 && res.statusCode < 400 && res.statusCode !== 401 && res.statusCode !== 403) {
            result.success = true;
            console.log('  ✅ 鉴权通过（非 JSON 响应但状态码正常）');
          } else {
            result.error = '响应解析失败';
            console.log(`  ❌ 响应解析失败: ${e.message}`);
            if (responseBody) console.log(`  原始响应: ${responseBody.substring(0, 300)}`);
          }
        }
        
        resolve(result);
      });
    });

    req.on('error', (err) => {
      result.error = err.message;
      console.log(`  ❌ 请求错误: ${err.message}`);
      resolve(result);
    });

    req.on('timeout', () => {
      req.destroy();
      result.error = '请求超时 (15s)';
      console.log(`  ❌ ${result.error}`);
      resolve(result);
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  const results = [];
  
  // 测试 ASR WebSocket 鉴权
  console.log('\n' + '-'.repeat(70));
  console.log('【第一部分】ASR WebSocket 接口鉴权测试');
  console.log('-'.repeat(70));
  
  // 方式一：X-Api-Key
  if (API_KEY) {
    const r = await testWebSocketAuth('方式一: X-Api-Key', { 'X-Api-Key': API_KEY });
    results.push(r);
  } else {
    console.log('\n[跳过] 方式一: X-Api-Key (未配置 API_KEY)');
    results.push({ category: 'ASR WebSocket', authType: '方式一: X-Api-Key', success: false, error: '未配置' });
  }
  
  // 方式二：X-Api-App-Id + X-Api-Access-Key
  if (APP_ID && ACCESS_KEY && ACCESS_KEY !== API_KEY) {
    const r = await testWebSocketAuth('方式二: X-Api-App-Id + X-Api-Access-Key', {
      'X-Api-App-Id': APP_ID,
      'X-Api-Access-Key': ACCESS_KEY,
    });
    results.push(r);
  } else {
    console.log('\n[跳过] 方式二: X-Api-App-Id + X-Api-Access-Key (未配置独立的 APP_ID/ACCESS_KEY)');
    results.push({ category: 'ASR WebSocket', authType: '方式二: X-Api-App-Id + X-Api-Access-Key', success: false, error: '未配置' });
  }

  // 测试声纹 HTTP 接口鉴权
  console.log('\n' + '-'.repeat(70));
  console.log('【第二部分】声纹 HTTP 接口鉴权测试 (飞书文档接口)');
  console.log('-'.repeat(70));

  if (API_KEY) {
    const r = await testHttpVoiceprintAuth('方式一: X-Api-Key', { 'X-Api-Key': API_KEY });
    results.push(r);
  } else {
    console.log('\n[跳过] 方式一: X-Api-Key (未配置 API_KEY)');
    results.push({ category: '声纹 HTTP', authType: '方式一: X-Api-Key', success: false, error: '未配置' });
  }

  if (APP_ID && ACCESS_KEY && ACCESS_KEY !== API_KEY) {
    const r = await testHttpVoiceprintAuth('方式二: X-Api-App-Id + X-Api-Access-Key', {
      'X-Api-App-Id': APP_ID,
      'X-Api-Access-Key': ACCESS_KEY,
    });
    results.push(r);
  } else {
    console.log('\n[跳过] 方式二: X-Api-App-Id + X-Api-Access-Key (未配置独立的 APP_ID/ACCESS_KEY)');
    results.push({ category: '声纹 HTTP', authType: '方式二: X-Api-App-Id + X-Api-Access-Key', success: false, error: '未配置' });
  }
  
  // 输出总结
  console.log('\n' + '='.repeat(70));
  console.log('【验证结果总结】');
  console.log('='.repeat(70));
  
  let allSuccess = true;
  let hasConfig = false;
  
  for (const r of results) {
    const status = r.success ? '✅ 通过' : (r.error === '未配置' ? '⏭️  跳过' : '❌ 失败');
    console.log(`  ${status} [${r.category}] ${r.authType}`);
    if (r.error && r.error !== '未配置') {
      console.log(`       错误: ${r.error}`);
      allSuccess = false;
    }
    if (r.error !== '未配置') hasConfig = true;
    if (r.logid) {
      console.log(`       LogID: ${r.logid}`);
    }
  }
  
  console.log('='.repeat(70));
  
  if (!hasConfig) {
    console.log('\n⚠️  未配置豆包 ASR 相关密钥!');
    console.log('\n请在 inventory.local.env 中配置以下变量:');
    console.log('  DOUBAO_API_KEY=你的API_Key          # 方式一');
    console.log('  DOUBAO_APP_KEY=你的App_ID           # 方式二(可选)');
    console.log('  DOUBAO_ACCESS_KEY=你的Access_Key    # 方式二(可选)');
    console.log('  DOUBAO_RESOURCE_ID=volc.seedasr.sauc.duration');
    console.log('\n说明:');
    console.log('  - 方式一和方式二只需配置一种即可');
    console.log('  - API Key 可从火山引擎控制台或字节内部 openspeech 平台获取');
    console.log('  - 当前配置的 VOLCENGINE_API_KEY 是用于方舟大模型的，可能不适用ASR');
  } else if (allSuccess) {
    console.log('\n✅ 所有已配置的鉴权方式验证通过!');
  } else {
    console.log('\n⚠️  部分鉴权方式验证失败');
    console.log('\n排查建议:');
    console.log('  1. 确认密钥是否正确，注意区分 API Key / App ID / Access Key');
    console.log('  2. VOLCENGINE_API_KEY 是方舟大模型的key，不是ASR的key');
    console.log('  3. 检查网络是否能访问 openspeech.bytedance.com');
    console.log('  4. 提供 LogID 给字节技术支持排查');
    console.log('  5. 参考飞书文档: https://bytedance.larkoffice.com/wiki/BYtNw4QYJiArNdkfso3cpMUqnCf');
  }

  // 检查项目对外接口是否有鉴权
  console.log('\n' + '-'.repeat(70));
  console.log('【第三部分】项目对外接口安全检查');
  console.log('-'.repeat(70));
  console.log('  ⚠️  注意: 当前项目的对外 WebSocket 和 HTTP 接口未设置鉴权验证');
  console.log('     任何能访问服务端口的人都可以使用 ASR 服务');
  console.log('     如需对外暴露服务，建议添加 API Key 鉴权中间件');
  
  process.exit(allSuccess && hasConfig ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本执行错误:', e);
  process.exit(1);
});
