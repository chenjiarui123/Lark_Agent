---
name: meetingflow-core
description: MeetingFlow 核心确定性工具。用于 evidence verification、stable ID、六维评分、运行锁、checkpoint，写入 Bitable 前必须使用。
metadata:
  short-description: MeetingFlow 核心确定性工具
---

# MeetingFlow Core

当 MeetingFlow 需要最终确认会议 claims、action items、评分、知识索引结果时，必须使用这个 Skill。

LLM 只负责理解上下文、抽取候选内容；最终的证据校验、ID 生成、评分、运行锁、checkpoint 都必须交给本地确定性脚本完成。

## 本地命令

统一调用方式：

```bash
node skills/meetingflow-core/scripts/core.mjs <command>
```

所有命令都从 stdin 读取 JSON，并向 stdout 输出 JSON。

## 支持的命令

- `verify-evidence`：校验每条 claim/action item 的 `evidence_sentence` 是否真的出现在原始文本中。
- `stable-id`：为 claims 和 action items 生成稳定、可复现的 ID。
- `score-run`：根据结构化指标计算 MeetingFlow 六维评分。
- `retrieve`：BM25 召回（CJK bigram + 拉丁词），用于会前 Meeting Lens 的候选打分；输入 `{ query, docs[], top_k }`，输出带 `score`、`matched_terms`、`snippet` 的 hit list。
- `checkpoint-get`：读取长任务上一次 checkpoint cursor。
- `checkpoint-set`：保存长任务 checkpoint cursor。
- `lock-acquire`：为某个 job + meeting_id 获取本地运行锁，防止重复执行。
- `lock-release`：释放本地运行锁。

## 必须遵守的流程

写入 Bitable 前必须按顺序执行：

1. LLM 只抽取候选 claims/action items。
2. 调用 `verify-evidence` 校验证据。
3. 未通过校验的内容不得作为正式记录写入 Bitable；除非当前流程明确写入 `needs_review`。
4. 调用 `stable-id` 生成稳定 ID。
5. 调用 `score-run` 计算本次会议六维评分。
6. 只把 verified、stable、scored 的结果写入 Bitable。

## 会前召回流程

执行 `MeetingFlow 会前扫描` 时，对每场未来会议：

1. 收集候选语料（飞书文档摘要、历史会议 MeetingItems、群聊片段）作为 `docs[]`。
2. 用会议标题 + 参会人 + 历史未闭环主题拼成 `query`。
3. 调用 `retrieve` 取 `top_k`（建议 8-12）作为 LLM Prompt 的 Context Pack。
4. LLM 仅在召回结果之上抽取候选 items，禁止凭空生成。
5. 后续走标准 verify-evidence → stable-id → score-run。

## 知识索引流程

执行 `MeetingFlow 知识索引` 时必须：

1. 开始前调用 `checkpoint-get` 读取上次 cursor。
2. 每次只处理小批量数据。
3. 每成功处理一批，立刻调用 `checkpoint-set` 保存 cursor。
4. 单批失败时，只记录失败项，不得从头重跑全部历史数据。
5. Cron 最终回复必须简短，不要输出大段原文，避免上下文继续膨胀。

## 输入输出约定

示例输入放在 `examples/`。字段约定放在 `schemas/`。

核心约定：

- 原文可以放在 `source_text`，也可以放在 `sources[].text`。
- 候选内容放在 `items[]`。
- 每条候选必须尽量包含 `type`、`claim` 或 `task`、`evidence_sentence`、`source_title`、`source_url`。
- 命令成功时返回 `ok: true`。
- 命令失败时返回 `ok: false` 和 `error`，此时不得继续写入正式 Bitable 记录。

## 安全规则

- 不要把 App Secret、token、cookie 等密钥写入输入、输出或日志。
- 不要把完整敏感文档写入状态文件。
- 能用原文片段和 hash 时，不要保存完整原文。
- 如果命令返回 `ok: false`，必须停止写入正式 Bitable 记录，并报告错误。

