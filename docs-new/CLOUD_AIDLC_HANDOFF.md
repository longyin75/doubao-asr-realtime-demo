---
doc_id: meeting-asr-aidlc-handoff
title: Meeting ASR aidlc Codex 迁移与交接
version: 1.0.0
status: active
owner: project-maintainer
created_at: 2026-10-20
updated_at: 2026-10-20
dependencies:
  - README.md
  - docs-new/REALTIME_VOICEPRINT_DESIGN.md
  - docs-new/RECORDING_TRANSCRIPTION_DESIGN.md
  - docs-new/VOICEPRINT_REGISTER_DESIGN.md
---

# aidlc Codex 迁移与交接

## 1. 目标

将 GitHub `main` 分支迁移到 aidlc 云端开发环境，供 Codex 智能体在以下目录继续开发：

```text
/data/codex/workspace/03-meetingASR
```

GitHub 仓库：

```text
https://github.com/longyin75/doubao-asr-realtime-demo.git
```

## 2. 边界

- GitHub `main` 是代码真相源。
- 不迁移本机 `inventory.local.env`、API Key、Token、私钥或运行时音频。
- 不在本次迁移中启动、部署或切换生产服务。
- 不修改 txcvm、gpu 节点或现有 PM2 服务。
- aidlc 仅作为可重置的云端开发环境。

## 3. 远端环境基线

| 项目 | 值 |
|---|---|
| SSH 别名 | `aidlc` |
| 主机名 | `aidlc` |
| 目标目录 | `/data/codex/workspace/03-meetingASR` |
| Node.js | v20.20.2 |
| npm | 10.8.2 |
| Git | 2.47.1 |
| Make | 4.3 |
| tmux | 3.2a |
| Codex CLI | 0.159.0 |
| `/data` 可用空间 | 约 175GB |

## 4. 迁移流程

1. 在本地完成文档、代码、测试日志更新并执行 `make qa`。
2. 将迁移文档和 `AGENTS.md` 提交并推送至 GitHub `main`。
3. 目标目录为空时直接克隆；若后续已有仓库，则只允许在工作区干净时执行 fast-forward 更新。
4. 在 aidlc 配置 npm 淘宝镜像并执行 `npm ci`。
5. 在 aidlc 执行 `make qa`，确认 TypeScript、前端语法和项目结构门禁通过。
6. 核验远端 `HEAD` 与 GitHub `main` 一致。

## 5. Codex 开发入口

Codex 进入仓库后必须先阅读：

1. `AGENTS.md`
2. `README.md`
3. `docs-new/REALTIME_VOICEPRINT_DESIGN.md`
4. 与任务相关的 `docs-new/*_DESIGN.md`
5. `docs-new/CHANGE_JOURNAL.md`
6. `docs-new/TEST_EXECUTION_LOG.md`

标准流程：

```text
需求确认
  -> 更新 docs-new 设计文档
  -> 创建 spike/* 分支（实验任务）
  -> 修改代码
  -> 补充测试
  -> 更新审计日志
  -> make qa
  -> 提交并推送
```

## 6. 密钥与运行配置

- 真实凭证仅保存在目标环境的 `inventory.local.env` 或 `/data/home/.codex/resources/inventory.local.env`。
- `inventory.local.env.example` 只保存占位符。
- 禁止将真实密钥提交到 Git。
- 仅需静态 QA 时不创建 `inventory.local.env`。
- 需要启动服务前，先执行 `make preflight` 并确认端口与进程托管方式。

## 7. 常用命令

```bash
cd /data/codex/workspace/03-meetingASR
git status --short --branch
git pull --ff-only origin main
npm config set registry https://registry.npmmirror.com
npm ci
make qa
```

超过 1 分钟的构建、模型推理或大文件处理必须在 tmux 中执行。

## 8. 当前状态与后续重点

- aidlc 已完成 GitHub `main` 克隆、npm 依赖安装和 `make qa` 验证。
- Codex CLI 已安装，可从目标目录读取仓库级 `AGENTS.md` 继续开发。
- v4.0 已实现本地声纹库持久化。
- v5.0 已实现实时声纹标签漂移纠正、guest 升级和按姓名统一颜色。
- 当前自动化门禁为 `make qa` 33 项检查（第 33 项为单元测试）。
- 已有 `npm test` 单元测试入口：`test/realtime-speaker-matcher.test.ts`，覆盖漂移计数、自动纠正、guest 升级、颜色复用和 v4.0 回退开关。
- 后续测试重点：浏览器端双人实时 E2E（真实 ASR speaker 槽位漂移）与更多边界条件。

## 9. 回滚

- 迁移失败时删除 aidlc 目标目录并重新克隆，不影响 GitHub 或生产服务。
- 代码回滚使用 Git revert，不使用 `git reset --hard` 覆盖共享历史。
- 生产回滚仍遵循 txcvm 上的 PM2 与部署手册，本次迁移不改变生产拓扑。
