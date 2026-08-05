import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

const SUMMARY_DIR = (() => {
  const dir = path.resolve(__dirname, 'public', 'summaries');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

const SUMMARIES_URL_PREFIX = '/asr-demo/summaries';
const MAX_SUMMARIES = 5;

export interface SpeakerTurn {
  speaker: number;
  text: string;
}

export interface Attendee {
  name: string;
  role: string;
}

export interface SummaryMeta {
  id: string;
  ts: number;
  timeLabel: string;
  url: string;
  snippet: string;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function listSummaries(): SummaryMeta[] {
  if (!fs.existsSync(SUMMARY_DIR)) return [];
  const files = fs.readdirSync(SUMMARY_DIR)
    .filter(f => f.endsWith('.html') && f.startsWith('summary-'))
    .map(f => {
      const fp = path.join(SUMMARY_DIR, f);
      const st = fs.statSync(fp);
      return { name: f, path: fp, ts: st.mtimeMs };
    })
    .sort((a, b) => b.ts - a.ts);
  return files.slice(0, MAX_SUMMARIES).map(f => {
    const id = f.name.replace(/^summary-/, '').replace(/\.html$/, '');
    const html = fs.readFileSync(f.path, 'utf8');
    const snippetMatch = html.match(/<meta\s+name="snippet"\s+content="([^"]*)"/);
    const snippet = snippetMatch ? snippetMatch[1] : '';
    return {
      id,
      ts: f.ts,
      timeLabel: formatTime(f.ts),
      url: `${SUMMARIES_URL_PREFIX}/${f.name}`,
      snippet,
    };
  });
}

export function clearAllSummaries(): number {
  if (!fs.existsSync(SUMMARY_DIR)) return 0;
  const files = fs.readdirSync(SUMMARY_DIR).filter(f => f.endsWith('.html'));
  for (const f of files) {
    try { fs.unlinkSync(path.join(SUMMARY_DIR, f)); } catch {}
  }
  return files.length;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSummaryHtml(meta: { ts: number; durationMs: number; sentenceCount: number; speakerCount: number }, content: string, transcript: string, snippet: string): string {
  const timeLabel = formatTime(meta.ts);
  const minutes = Math.floor(meta.durationMs / 60000);
  const seconds = Math.floor((meta.durationMs % 60000) / 1000);
  const durationLabel = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="snippet" content="${escapeHtml(snippet)}">
<title>会议纪要 · ${timeLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f8f9fa; color: #202124; line-height: 1.7; padding: 24px;
  }
  .container { max-width: 820px; margin: 0 auto; }
  .header {
    background: #1a73e8; color: #fff; padding: 32px 40px; border-radius: 12px 12px 0 0;
  }
  .header h1 { font-size: 24px; font-weight: 500; margin-bottom: 8px; }
  .header .meta { font-size: 13px; opacity: .9; }
  .header .meta span { margin-right: 20px; }
  .card {
    background: #fff; padding: 32px 40px; box-shadow: 0 1px 3px rgba(0,0,0,.08);
    margin-bottom: 1px;
  }
  .card:last-child { border-radius: 0 0 12px 12px; }
  .card h2 {
    font-size: 16px; font-weight: 500; color: #1a73e8; margin-bottom: 16px;
    padding-bottom: 8px; border-bottom: 1px solid #e8eaed;
  }
  .content { font-size: 15px; color: #3c4043; word-break: break-word; }
  .content p { margin-bottom: 10px; }
  .content h2.summary-title {
    font-size: 22px; font-weight: 600; color: #202124;
    margin: 0 0 14px 0; padding: 0; border: none;
  }
  .content p.summary-intro {
    font-size: 15px; color: #3c4043; line-height: 1.8;
    margin: 0 0 22px 0; padding: 14px 18px;
    background: #f1f7ff; border-left: 3px solid #1a73e8; border-radius: 4px;
  }
  .content h3 {
    font-size: 16px; font-weight: 600; color: #1a73e8;
    margin: 20px 0 10px 0;
  }
  .content ul { list-style: none; padding-left: 0; margin: 0 0 12px 0; }
  .content ul ul { padding-left: 0; margin: 8px 0 0 0; }
  .content li { margin-bottom: 8px; line-height: 1.75; }
  .content li.theme-item {
    margin: 16px 0 10px 0; padding: 12px 16px;
    background: #f8f9fa; border-radius: 8px; border-left: 3px solid #1a73e8;
  }
  .content li.theme-item > .item-label {
    font-size: 16px; font-weight: 600; color: #202124;
  }
  .content li.point-item {
    margin-bottom: 8px; padding-left: 16px; position: relative;
  }
  .content li.point-item::before {
    content: ""; position: absolute; left: 2px; top: 11px;
    width: 6px; height: 6px;
    background: #1a73e8; border-radius: 50%;
  }
  .content li.point-item > .item-label {
    font-weight: 600; color: #202124;
  }
  .content .point-detail { color: #3c4043; font-weight: 400; }
  .content .theme-note {
    margin-top: 8px; padding: 8px 12px;
    background: #fff; border-radius: 6px; font-size: 14px; color: #5f6368;
  }
  .content strong { color: #202124; }
  .content .mention {
    display: inline-block;
    background: #e8f0fe;
    color: #1a73e8;
    padding: 1px 6px;
    border-radius: 4px;
    font-weight: 500;
    margin: 0 2px;
    font-size: 0.95em;
  }
  details summary {
    cursor: pointer; color: #5f6368; font-size: 14px; padding: 8px 0;
    user-select: none;
  }
  details summary:hover { color: #1a73e8; }
  .transcript {
    margin-top: 12px; padding: 16px; background: #f8f9fa; border-radius: 8px;
    font-size: 13px; color: #5f6368; max-height: 300px; overflow-y: auto;
    white-space: pre-wrap; line-height: 1.8;
  }
  .footer { text-align: center; color: #9aa0a6; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>📝 会议纪要</h1>
    <div class="meta">
      <span>🕐 ${timeLabel}</span>
      <span>⏱️ ${durationLabel}</span>
      <span>💬 ${meta.sentenceCount} 句</span>
      <span>👥 ${meta.speakerCount > 0 ? meta.speakerCount + ' 位说话人' : '未区分'}</span>
    </div>
  </div>
  <div class="card">
    <h2>纪要摘要</h2>
    <div class="content">${content}</div>
  </div>
  <div class="card">
    <h2>原始转录</h2>
    <details>
      <summary>点击展开查看完整转录文本</summary>
      <div class="transcript">${escapeHtml(transcript)}</div>
    </details>
  </div>
  <div class="footer">由豆包 ASR + 大模型自动生成</div>
</div>
</body>
</html>`;
}

const SYSTEM_PROMPT = `你是一个专业的会议结论提取专家，下面是会议讨论文本，文字信息是按照实际时间线进行排列，其中包含了用户说的话以及可能存在的投屏过程中文档评论的信息，你的任务是仔细查看这场会议的全部内容，给出详实、不遗漏信息的摘要总结。由于文本来自语音转文字的结果，需要过滤掉文本中无关紧要的主题结论，且其中的错别字你需要自行纠正。

## 参会人员参考（必须严格遵守）：
用户会提供本次会议的参会人员名单，包含每个人的姓名和岗位职务。你必须严格将名单作为人物参考的唯一权威来源，执行以下名称规范化：
1. **发言人识别**：将转录文本中所有对人的称呼、外号、简称、职务代称、昵称、谐音名等，全部替换为参会名单中的标准姓名。例如："王总"→"王建国"、"张工"→"张伟"、"那个产品"→"李明（产品经理）"、"小李"→"李娜"。
2. **待办负责人**：待办事项中的责任人必须使用参会名单中的标准姓名，以 @姓名 格式标注。如果任务是分配给某个职务角色的，也需根据参会名单映射到具体人名。
3. **讨论内容**：在纪要正文中提到人物时，统一使用参会名单中的标准姓名（可在首次出现时以"姓名（职务）"格式标注，之后直接用姓名）。
4. **无法匹配**：如果出现的人物称呼确实无法对应到任何参会人，保留原称呼但需特别注意；如果分配任务时无法确定具体负责人，标注为 @全员。
5. **严格使用**：不允许在纪要中出现"张总"、"李工"、"王经理"、"那个谁"等模糊称呼，必须全部替换为参会名单中的真实姓名。

## 输出格式：
首先确定会议的标题，全文重点讨论的关键信息必须在标题中出现，字数控制在20以内。然后用一段话总结全文，请以"本次会议围绕"开头，一段话概括背景和主要内容，开头第一句话不要用markdown格式，然后以"内容如下"结尾，字数控制在100字左右。接着将全文内容根据会议流程划分成5-10个重点核心段落，每个段落主题下包含2-3条关键要点（不能只有1条），不能遗漏任何要点。最后加入会议的待办事项（Action Items）。
段落格式如下：
- **简短的段落主题1** ：
  - **该主题简短的关键结论要点1** ：关键结论要点1的详细说明
  - **该主题简短的关键结论要点2** ：关键结论要点2的详细说明
  - **该主题简短的关键结论要点3** ：关键结论要点3的详细说明
- **简短的段落主题2** ：
  - **该主题简短的关键结论要点1** ：关键结论要点1的详细说明
  - **该主题简短的关键结论要点2** ：关键结论要点2的详细说明
  - **该主题简短的关键结论要点3** ：关键结论要点3的详细说明

### 待办事项格式要求（必须严格遵守）：
待办事项部分必须以"### 待办事项"作为三级标题开头。每一条待办必须包含：
1. 具体的任务内容描述
2. 明确的跟进责任人，使用 **@姓名** 格式标注（例如：@张三、@李四），姓名必须来自参会人员名单
3. 如果有明确时间节点，需一并注明

待办事项格式示例：
### 待办事项
- **完成项目方案初稿**：本周五前提交第一版方案供评审 @王五
- **协调会议室资源**：确认下周评审会议场地并发送邀请 @赵六 @孙七
- **跟进客户反馈**：整理客户意见并同步给团队 @周八

在总结过程中，你需要确保内容的丰富性和全面性，包括但不限于以下几点：
1. 会议标题务必总结出具体的信息，需要包含会议关键词，不可以泛泛而谈。注意："会议标题"这四个字绝不允许在你的答案中出现。
2. 对于每个主题，都要尽可能地提取出所有的关键结论要点，严禁只有一条。
3. 对于每个关键结论要点，都要提供足够的详细说明，包括相关的背景信息、讨论过程、决定结果等，并将发言人替换为参会名单中的真实姓名。
4. 对于非会议场景的闲聊或短对话，直接以"讨论了..."开头输出，不加标题。
5. **待办事项责任人必须明确**：从会议讨论中识别出具体的负责人，使用 @姓名 格式标注，姓名必须来自参会人员名单。如果会议中明确指派了任务给某人，必须准确标注；如果没有明确指派但根据语境（包括职务称呼）可以推断负责人，也需要根据参会名单映射到具体人名标注；如果确实无法确定责任人，标注为 @全员。

## 例子：
办公室搬迁流程及注意事项总结
本次会议围绕办公室搬迁流程、物品打包规范及注意事项展开讨论，明确了各环节的操作要求和时间安排，内容如下：
- **物品分类与打包**：
  - **可装箱物品**：包括书籍、办公文具、文件夹、个人用品等。这些物品应整齐放入纸箱中，并确保箱子不要过重，便于搬运。
  - **不可装箱物品**：如大型设备（例如打印机、传真机）、易碎物品（如植物、奖杯等）和贵重物品（如个人电子设备）。这些物品应单独处理，避免在搬运过程中受损。
  - **拆卸电脑前**：请先断开所有电源并关闭电脑。将键盘、鼠标、电源线、显示器后面的连线整理成束，使用扎带固定，方便打包。
  - **主机和显示器**：只需要将主机和显示器放在桌面上，以便于后续的搬运和安装。确保主机与显示器的接口无损坏，以免在搬迁过程中造成损坏。
- **物品核对表和标签填写**：
  - **标签填写**：每个纸箱需标记新址的座位编号、员工姓名及装箱编号。建议使用圆珠笔清晰地书写，以避免因字迹模糊而造成误解。可以在纸箱的显眼位置贴上标签，确保搬运工人一目了然。
  - **物品核对表填写**：物品核对表上需要记录回收时间和搬运方式。具体信息会在公司群组中同步发布，请大家及时关注。
### 待办事项
- **发放打包材料**：明天上午将纸箱、标签、扎带等物资发放到各工位 @行政部
- **完成个人物品打包**：本周四下班前完成个人工位物品打包 @全员
- **检查公共区域设备**：周五前确认打印机、复印机等公共设备的拆卸准备情况 @IT部

## 注意：
- 使用 Markdown 格式输出（会被直接渲染为 HTML，不要使用代码块包裹，不要在输出前后加任何解释性文字）。
- 不要输出重复性的或无关紧要的要点。无关紧要的要点内容包括闲聊、与会议主题无关的信息、明显讨论篇幅小且与前后话题无关的信息。
- 重点的核心段落通常会有较多讨论内容，在会议中占据了较多时间。
- 段落主题下的关键结论要点不能只有1点，否则该段落的主题可以结合语义与其他主题进行合并。
- 具体内容必须使用上述格式总结各个核心段落，段落主题（关键核心要点）不能超过20个，结论要点说明必须详细具体，输出总字数不超过4000字。
- **@提及责任人是强制要求**：每一条待办事项都必须有 @姓名 标注的责任人，不允许出现无负责人的待办事项。
- **姓名规范化是强制要求**：纪要中所有出现的人物称呼必须替换为参会名单中的标准姓名，不允许保留"X总"、"X工"、"X经理"等模糊代称。
- 如果转录文本过短或无实质内容，请直接输出"本次会话内容较短，未形成有效会议纪要。"`;

async function callLLM(transcript: string, attendees?: Attendee[]): Promise<string> {
  if (!config.arkApiKey) {
    throw new Error('LLM_NOT_CONFIGURED');
  }
  let userContent = '';
  if (attendees && attendees.length > 0) {
    const attendeeList = attendees
      .filter(a => a.name && a.name.trim())
      .map((a, i) => `${i + 1}. ${a.name.trim()}（${a.role.trim() || '未填写岗位'}）`)
      .join('\n');
    userContent += `## 本次会议参会人员名单\n${attendeeList}\n\n请严格按照以上参会人员名单进行姓名规范化和待办责任人标注。\n\n`;
  }
  userContent += `以下是会议转录文本：\n\n${transcript}`;

  const url = `${config.arkBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.arkModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 4000,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.arkApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM_HTTP_${resp.status}: ${text.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('LLM_EMPTY_RESPONSE');
  }
  return content.trim();
}

function simpleMarkdownToHtml(md: string): string {
  const lines = escapeHtml(md).split('\n');
  const out: string[] = [];
  let i = 0;

  function isListLine(line: string): boolean {
    return /^\s*[-*•]\s+/.test(line);
  }
  function listLevel(line: string): number {
    const m = line.match(/^(\s*)/);
    if (!m) return 0;
    return Math.floor(m[1].length / 2);
  }
  function stripListMarker(line: string): string {
    return line.replace(/^\s*[-*•]\s+/, '');
  }

  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return '';

  const first = lines[i].trim();
  const isShort = first.length > 0 && first.length <= 40;
  const firstIsListItem = isListLine(lines[i]);
  const firstIsHeading = /^#{1,6}\s+/.test(lines[i]);
  const looksLikeTitle = isShort && !firstIsListItem && !firstIsHeading
    && !/^本次会议围绕/.test(first) && !/^讨论了/.test(first);

  if (looksLikeTitle) {
    out.push(`<h2 class="summary-title">${first}</h2>`);
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  const paraBuf: string[] = [];
  while (i < lines.length && !isListLine(lines[i]) && !/^#{1,6}\s+/.test(lines[i])) {
    const t = lines[i].trim();
    if (t.length > 0) paraBuf.push(t);
    else if (paraBuf.length > 0) break;
    i++;
  }
  if (paraBuf.length > 0) {
    out.push(`<p class="summary-intro">${paraBuf.join(' ')}</p>`);
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      out.push(`<h3>${h[1]}</h3>`);
      i++;
      continue;
    }
    if (isListLine(line)) {
      out.push('<ul class="summary-list-root">');
      const stack: { level: number; hasLi: boolean }[] = [{ level: 0, hasLi: false }];
      let curLevel = 0;
      function closeOpenLi() {
        const top = stack[stack.length - 1];
        if (top.hasLi) { out.push('</li>'); top.hasLi = false; }
      }
      function openUl(lv: number) {
        out.push('<ul>');
        stack.push({ level: lv, hasLi: false });
        curLevel = lv;
      }
      function closeUl() {
        closeOpenLi();
        out.push('</ul>');
        stack.pop();
        curLevel = stack[stack.length - 1].level;
      }
      while (i < lines.length && (isListLine(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '') { i++; continue; }
        const raw = lines[i];
        const lv = listLevel(raw);
        let text = stripListMarker(raw);
        let inlineDetail = '';
        const colonMatch = text.match(/^([^：:]*[：:])([\s\S]*)$/);
        if (colonMatch) {
          text = colonMatch[1].replace(/[：:]\s*$/, '');
          inlineDetail = colonMatch[2].trim();
        }
        if (lv > curLevel) {
          openUl(lv);
        } else if (lv < curLevel) {
          while (lv < curLevel && stack.length > 1) closeUl();
          closeOpenLi();
        } else {
          closeOpenLi();
        }
        const cls = lv === 0 ? ' class="theme-item"' : ' class="point-item"';
        out.push(`<li${cls}><span class="item-label">${text}</span>`);
        if (colonMatch) {
          out.push('<span class="item-colon">：</span>');
          if (inlineDetail) out.push(`<span class="point-detail">${inlineDetail}</span>`);
        }
        stack[stack.length - 1].hasLi = true;
        i++;
        if (lv === 0) {
          const contBuf: string[] = [];
          while (i < lines.length && !isListLine(lines[i]) && lines[i].trim() !== '' && !/^#{1,6}\s+/.test(lines[i])) {
            const cont = lines[i].trim();
            if (cont) contBuf.push(cont);
            i++;
          }
          if (contBuf.length > 0) {
            out.push(`<div class="theme-note">${contBuf.join('<br>')}</div>`);
          }
        }
      }
      while (stack.length > 1) closeUl();
      closeOpenLi();
      out.push('</ul>');
      continue;
    }
    out.push(`<p>${line.trim()}</p>`);
    i++;
  }

  let html = out.join('\n');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/@([\u4e00-\u9fa5a-zA-Z0-9_]+)/g, '<span class="mention">@$1</span>');
  return html;
}

function stripMarkdownFence(md: string): string {
  let s = md.trim();
  s = s.replace(/^```[\w-]*\s*\n?/i, '');
  s = s.replace(/\n?```\s*$/i, '');
  return s.trim();
}

function extractSnippet(md: string): string {
  const cleaned = stripMarkdownFence(md)
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 80);
}

export async function generateSummary(transcript: string, turns: SpeakerTurn[], durationMs: number, attendees?: Attendee[]): Promise<SummaryMeta> {
  const ts = Date.now();
  const speakerSet = new Set(turns.map(t => t.speaker).filter(s => s >= 0));
  let llmMarkdown = await callLLM(transcript, attendees);
  llmMarkdown = stripMarkdownFence(llmMarkdown);
  const htmlContent = simpleMarkdownToHtml(llmMarkdown);
  const snippet = extractSnippet(llmMarkdown);
  const speakerCount = speakerSet.size;
  const sentenceCount = turns.length > 0 ? turns.length : transcript.split(/[。！？\.\!\?]+/).filter(s => s.trim().length > 0).length;
  const id = String(ts);
  const filename = `summary-${id}.html`;
  const fp = path.join(SUMMARY_DIR, filename);
  const html = buildSummaryHtml(
    { ts, durationMs, sentenceCount, speakerCount },
    htmlContent,
    transcript,
    snippet,
  );
  fs.writeFileSync(fp, html, 'utf8');
  enforceMaxFiles();
  const metas = listSummaries();
  const meta = metas.find(m => m.id === id);
  if (!meta) throw new Error('SUMMARY_WRITE_FAILED');
  return meta;
}

function enforceMaxFiles() {
  if (!fs.existsSync(SUMMARY_DIR)) return;
  const files = fs.readdirSync(SUMMARY_DIR)
    .filter(f => f.endsWith('.html') && f.startsWith('summary-'))
    .map(f => ({ name: f, path: path.join(SUMMARY_DIR, f), ts: fs.statSync(path.join(SUMMARY_DIR, f)).mtimeMs }))
    .sort((a, b) => b.ts - a.ts);
  for (let i = MAX_SUMMARIES; i < files.length; i++) {
    try { fs.unlinkSync(files[i].path); } catch {}
  }
}

export function summaryDirFsPath(): string {
  return SUMMARY_DIR;
}

export function isLlmConfigured(): boolean {
  return !!config.arkApiKey;
}
