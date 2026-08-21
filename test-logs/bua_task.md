# E2E 浏览器自动化测试任务

测试目标地址：https://longer8888.tech/asr-demo-multi/

测试内容和步骤：

1. **页面加载验证**：
   - 访问 https://longer8888.tech/asr-demo-multi/
   - 等待页面完全加载，截图保存
   - 验证页面标题包含"实时字幕"或"ASR"
   - 验证麦克风按钮存在
   - 验证声纹管理按钮/入口存在（可能在页面某个按钮，如"声纹管理"）

2. **WebSocket连接验证**：
   - 打开浏览器开发者工具Console或Network面板
   - 等待WebSocket连接建立（页面自动连接ws）
   - 验证收到connected消息，检查返回的voiceprintEnabled是否为true
   - 截图保存console日志区域

3. **声纹管理面板测试**：
   - 点击声纹管理按钮（如果页面有"声纹"或"说话人"相关按钮）
   - 验证声纹列表加载，应该显示约27个已注册声纹（罗新宇、严伟、赵磊磊、易中天、王立群等）
   - 截图保存声纹列表界面

4. **页面UI元素检查**：
   - 验证配置面板存在（可能有热词、模型版本等配置项）
   - 验证麦克风按钮可点击
   - 验证事件日志区域存在（显示连接、识别等事件）

5. **API直接验证（可选）**：
   - 在console中fetch('/asr-demo-multi/api/voiceprint/list')验证返回success:true

6. **截图要求**：
   - 每个关键步骤截图，保存到 /Users/bytedance/Documents/work-trae/05 doubao-ASR/test-logs/screenshots/ 目录
   - 截图命名：01_homepage.png, 02_ws_connected.png, 03_voiceprint_list.png, 04_full_page.png
   - 截取完整页面和关键区域

7. **控制台日志收集**：
   - 收集页面加载后的所有console.log/warning/error输出
   - 特别关注是否有JavaScript错误
   - 验证无红色error报错

注意：不需要点击录音（需要麦克风权限），只做UI加载和功能验证。重点验证声纹相关UI是否正常加载、WebSocket连接成功、声纹列表可以打开。