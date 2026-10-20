# 外部成员协议：实现笔记与踩坑记录

> 这份文档不是使用手册（那在 [README.md](README.md)）。
> 它记录的是**实现这套协议时踩过的坑**，以及为什么某些设计长成现在这样。
>
> 给两类人看：
> - 想给这个房间写桥接器的人（少走弯路）
> - 想改协议本身的人（知道哪里动不得）
>
> 日期：2026-10-20。对应提交 `1820418`，宿主测试 174/174 通过。

---

## 一、Why：为什么协议是现在这个样子

### 1.1 起点：一个错误的乐观估计

最初的设计（v1）是这样想的：房间已经有账本、有 HTTP、有 SSE，
让外部 AI 进来只需要「加两个接口」：

```
GET  /room/pending?nick=codex     ← 取待办
POST /room {action:'external-post'} ← 写回
```

估了 150 行。

**Codex 评审后推翻**：实际 MVP 是 400+ 行，完整版 970 行。理由六条，
后来逐条核实全部成立（见 §2.1）。真正让它从"加接口"变成"设计协议"的是这一条：

> 任务状态与消息分开保存，但放进同一个写入队列只能防并发交错，
> **不能保证两次写入共同成功**。

这就是 §2.2 单日志的由来。

### 1.2 两次返工

| 版本 | 核心方案 | 被推翻的原因 |
|---|---|---|
| v1/v2 | 双文件：`ledger.jsonl` + `tasks.jsonl` | 崩溃时可能只写成功一个（§2.2） |
| v2.1 | 单日志 + 重放，但 `attemptId` 只用时间戳 | 无法区分"同一个执行器"，旧批次会覆盖新批次（§2.3） |
| 当前 | 单日志 + 重放 + `leaseId`/`attempt` 双标识 + 幂等表 | — |

**两轮返工都来自"以为顺序等于原子"这个错觉。** 这是本协议最重要的一条经验。

---

## 二、How：五个关键设计决策

### 2.1 六条评审的核实结果

Codex 提意见时声明"尚未核查 DSH 接口源码"。我用真实账本和源码逐条验过：

| # | 意见 | 验证方法 | 结论 |
|---|---|---|---|
| 1 | answer 没有正文 | 统计真实账本 | ✅ **协议启用前的 27 条 `answer` 全部无 `text`** |
| 2 | msgId 不能判断"已回复" | 字段检查 | ✅ **0 条有 `replyTo`** |
| 3 | 需要稳定成员 ID | 源码检查 | ✅ `room.nicks.get()` 4 处，无 memberId |
| 4 | "没 answer" ≠ "没执行" | 源码检查 | ✅ 无任务状态表、无租约 |
| 5 | 需要增量游标 | 源码检查 | ✅ 只有 `count`，无 `afterSeq` |
| 6 | depth 应由宿主推导 | 源码检查 | ✅ 只写入 2 处，从不读取 |

> 第 1 条的"27 条"是协议启用前那一刻的统计。启用后外部成员写入的 answer
> 自带 `text`，所以现在账本里能看到两类 answer 并存——旧的是 `digest-only`，
> 新的是 `ledger` 正文。这个差异是设计演进的结果，不是 bug。

**教训**：外部评审说"我还没看源码"时，不要以为它的意见就浅;
它看到的**行为**往往比源码更真实。

### 2.2 单日志（本协议的地基）

**规则**：`ledger.jsonl` 是唯一权威。任务表、成员表、幂等表都是**从它重放出来的内存索引**。

```
✓ 创建 ask       → 写一行（含 targetMemberIds）→ 重放时自动派生 queued 任务
✓ claim / renew  → 各写一行控制事件
✓ complete       → 写一行 answer，**这一行同时就是完成凭据**
✗ 不存在 "写 answer 再写 complete" 这种两步操作
```

**为什么**：`RoomWriter.run()` 的队列只保证**同一队列内不交错**，
不保证跨两个文件"一起成功"。如果 `answer` 写进 A 文件、`complete` 写进 B 文件，
中间崩溃就永久不一致。

**把两个动作合成一行，崩溃窗口就消失了。** 这是唯一可靠的做法。

### 2.3 leaseId + attempt 双标识

**规则**：每次 claim 生成新的 `leaseId`，`attempt` 递增。
renew / complete / fail **必须同时带这两个值**，缺一或过期都返回 `409 lease-lost`。

**为什么不能用时间戳当身份**：

```
执行器 A 领取 → 租约 300s
330s 时 A 还在跑（超时了）
宿主把任务重新分配给 B
A 完成并提交 → 如果只校验"token 有效"，A 的结果会覆盖 B
```

加 `leaseId` 之后，A 的提交带的是**旧 leaseId**，直接 `lease-lost`。

### 2.4 幂等表的作用域

**规则**：幂等键作用域是 `(roomUid, memberId, action, idempotencyKey)`，
表索引是 `scope|key`。

**踩过的坑**：最初只用 `key` 做索引。两个成员的 claim 如果生成出同样的
key 字符串（随机撞了，或用了固定值），会**互相覆盖**——表现为
"我明明没提交过，却拿到别人的回执"。

### 2.5 幂等回执的 seq 从账本补

**规则**：`seq` 在 `append()` 之后才产生，而幂等回执在写之前就构造好了。
重放时**用行自身的 seq 补齐回执**。

**不补的后果**：幂等重放返回 `duplicate: true` 但**没有 `seq`**，
调用方无法定位到那条 answer。

---

## 三、坑：测试抓到的 8 个真 bug

按"如果不测就上线会怎样"排序。

### 3.1 并发 claim 领到同一任务 🔴

```
两个并发 claim → 都返回同一 taskId → 账本出现 2 条 task-claimed
```

**根因**：选任务在 `RoomWriter.run()` **之外**。两边都读到 `state=queued`，
都通过检查，都写了一条 claim。

**修法**：选任务 + 判次数 + 写事件全部放进**同一个临界区**，
临界区内 `replay(rows)` 重新折叠最新状态。

```js
// 错的
const picked = pickClaimable(state.tasks, ...)   // 临界区外
await writer.run(async ({ append }) => { ... })

// 对的
await writer.run(async ({ append, rows }) => {
  const fresh = replay(rows)                     // 临界区内重新折叠
  const picked = pickClaimable(fresh.tasks, ...)
  ...
})
```

### 3.2 `normalizeRow` 白名单漏字段 🔴

**症状**：`protocol-enabled` 写进账本了，但重放时 `roomUid` 永远是 `null`。

**根因**：`normalizeRow` 是**严格白名单**——没列出的字段静默丢弃。
新加的 40 个协议字段一个都没搬。

**这条最危险的地方**：写入"成功"了，只是读不回来。没有任何报错。

> **改协议字段时，必须同步检查 `normalizeRow`。** 这是本仓库最容易忘的一步。

### 3.3 `answer` 的 text 被丢弃 🔴

**根因**：`normalizeRow` 里 `text` 只给 `ask` 保留。

**后果**：外部成员的结论不在 DSH 会话日志里，不落 `text` 就**只剩摘要**——
这正是 Codex 评审第 1 条指出的问题。修之前，`/room/message` 对外部答案
永远只能返回 `digest-only`。

### 3.4 fail 的 state 被重放忽略 🟠

```
failTask 返回 {state: 'queued'}
重放后任务却是 failed
```

**根因**：`applyTaskEvent` 只认 `NEEDS_REVIEW`，其余一律 `FAILED`，
把"可重试"误判成终结性失败。

**危险性**：返回值与真实状态不一致。桥接器以为还能重试，实际任务已终结。

### 3.5 memberId 只用 registrationId 派生 → 可冒名 🟠

**攻击**：拿到你的 `registrationId`，用**自己的** token 注册，
得到同一个 `memberId`。

**修法**：`memberId = makeMemberId(roomUid, 'external', registrationId + ':' + tokenHash)`。

### 3.6 幂等回执缺 seq 🟡

见 §2.5。

### 3.7 续租"越续越短" 🟡

**根因**：`attemptDeadlineAt` 在重放时没更新，后续续租拿旧上限去夹。

### 3.8 控制事件被消息接口读到 🟡

**修法**：`/room/message` 用 `isPublicRow()` 过滤，且**不透露"这条是控制事件"**——
统一按 `404 not-found` 处理。

---

## 四、Gotchas：写桥接器时最容易错的六件事

### 4.1 不要用 `--last` 恢复会话

Codex CLI 的 `--last` 会串到别的会话。正确形态：

```
codex exec resume --json <THREAD_ID> -
```

`THREAD_ID` 来自 `thread.started` 事件的 `thread_id`。

### 4.2 `--json` 的 stdout 是事件流，不是最终答案

```
❌ 把整个 stdout 当正文
✅ 按换行解码 JSONL，取 turn.completed + 结果文件（-o 指定的路径）
```

### 4.3 不要把任务正文拼进 shell 命令

```
❌ exec(`codex exec --json "${task.text}"`)   ← 引号/换行/元字符会破坏命令
✅ spawn(cmd, args, {shell:false}) + stdin 传正文
```

Windows 上尤其危险。且任务正文可能有几 KB，会撞命令行长度限制。

### 4.4 执行失败与提交失败必须分开

```
❌ try { execute(); submit() } catch { submit({kind:'note'}) }
        ↑ 提交网络失败也会走 catch，把成功结果记成失败

✅ 执行 → 本地持久化(结果 + 固定幂等键) → 只重试提交
   执行失败 → POST /room/fail（明确状态转换）
```

**`note` 只表示进度，不能用来收尾。**

### 4.5 租约到期前必须续租

默认 300 秒，请求范围 60~600。`attemptDeadlineAt` 是**单轮硬上限**（默认 1800 秒），
续租只能延长到它，不能突破。

续租失败要**主动停止执行**——否则你的结果会因为 `lease-lost` 被丢弃，白跑。

### 4.6 outbox 必须在发送前持久化

```
✅ 先把 (action, 请求体, 幂等键) 写进本地状态库 → 再发 HTTP
❌ 先发 HTTP，成功了再记录
```

否则进程崩在"发出去了但没记录"的窗口里，重启后就不知道这条提交过没有。

---

## 五、Contract：不可违反的五条

给改协议的人：

| # | 契约 | 违反的后果 |
|---|---|---|
| 1 | `ledger.jsonl` 是唯一权威，任何状态都必须能从它重放 | 分裂出第二次源真相，重启后不一致 |
| 2 | 一个操作的判定与写入在同一个写锁内 | 并发下重复答案 / 状态被覆盖 |
| 3 | 只有 `turn/end.reason.kind === 'completed'` 才算完成 | `aborted` 也被当成功，账本失真 |
| 4 | 错误体统一 `{ok:false, error:{code,message,retryable}}` | 桥接器要写两套解析 |
| 5 | 不泄露内部事件与凭据摘要（`isPublicRow` / `toPublicRow`） | 凭据摘要外泄 |

另有一条**只对内**的：新增账本字段必须同步加进 `normalizeRow` 白名单（§3.2）。

---

## 六、没做的事

| 项 | 阶段 | 说明 |
|---|---|---|
| `afterSeq` 增量游标 | B | 消息量大时必需；当前只有 `count` |
| 实例发现文件 | B | 多宿主场景；当前靠显式配置 `baseUrl` |
| AI 派单给外部成员 | B | 需要 `parentTaskId` 验证与链配额；当前只有人类派单 |
| 写任务（workspace-write） | C | 需要工作区隔离 + `needs_review` 流程 |
| MCP 房间工具 | C | 让外部 AI 在执行中途能反问房间 |

**MVP 明确只接受 `executionMode=read-only` 与人类派单。**
这两条不是"暂时没做"，是**有意限制**：写任务一旦进程失联，
工作区状态就变成"不确定"，需要人工核对流程配套。

---

## 七、一条元经验

这套协议改了三次，每次都是同一个错误的变体：

> **以为"顺序"等于"原子"。**

- 双文件方案：以为队列能保证两次写都成功
- 时间戳当身份：以为时间能区分执行者
- 临界区外选任务：以为读到的状态进临界区时还有效

**每次的正确解法都是同一个方向**：把"判定"和"写入"压进同一个原子动作里。

如果你要扩展这套协议，先问一句：**我这个操作有没有可能只完成一半？**
如果有，就还没设计完。
