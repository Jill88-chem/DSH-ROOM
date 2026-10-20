# dsh-room — 多 AI 会话室

> M1 最小闭环。设计文档：[`../02-多AI会话室设计/README.md`](../02-多AI会话室设计/README.md)（v3）

一个工作区可以有一个或多个房间：人类**定向**把指令发给某个 AI，AI 答完**自动**回填到房间账本，账本落盘、重启可恢复。房间里的多个 AI 各用各的模型、各守各的上下文，谁也不偷看别人的历史。

## 它解决什么

| 你的诉求 | dsh-room 的做法 |
|---|---|
| 几个 AI 接入同一个项目 | 每个成员是独立会话，自己的 provider/model |
| 发指令时指定谁答 | 「发给…」选择器，**必选**，没有默认广播 |
| AI 答完自动回会话 | 监听 `turn/end`，取最终回答写进账本，不依赖 AI 记得调工具 |
| 非指定的 AI 不该看到 | 未选中的成员**收不到任何东西**，它的会话日志 seq 不变 |
| 换 AI 后能接上历史 | 各自历史天然连续；被 @ 时收到的是**指针**（摘要 + 产物路径） |
| 同一个项目开多个独立讨论 | **多房间**：每个房间独立成员、独立账本 |
| 重启不丢 | `ledger.jsonl` append-only + 半行修复 |

### 多房间

- **跨工作区**：每个工作区天然是一个房间
- **同一工作区**：可以再建任意多个（右上角「＋ 添加成员」→ 填「新房间」名字）
- 房间之间**完全隔离**：成员表、账本、产物目录各自独立
- 顶部的房间下拉按 `工作区 · 房间名` 列出所有房间
- 默认房间沿用旧布局 `<ws>/.dsh/room/ledger.jsonl`，旧数据无需迁移

## 安装

宿主需要 Node.js 24+（使用内置 SQLite 取得跨进程账本独占锁）。SQLite 文件只负责锁，不保存权威业务状态；成员、任务和幂等回执均由 `ledger.jsonl` 重放。账本中间的完整行损坏会停止打开，仅自动修复最后一条未完成写入。

## Codex 外部成员

桥接器位于 [`../dsh-room-bridge`](../dsh-room-bridge/README.md)。在可信本地管理端点 `POST /room?cwd=…&room=…` 先执行 `{"action":"enable-protocol"}`，再执行 `{"action":"issue-enrollment"}`，将返回的一次性 `enrollmentToken` 交给桥接器进程环境。有效期一小时，注册提交后消费；账本只保存摘要。

外部成员注册后出现在成员列表和「发给…」选择器。定向或广播到该成员会生成只读任务，由桥接器领取，完整答案进入房间账本。成员在线状态以最近 30 秒的已认证请求判断。移除外部成员会撤销凭据并保留身份与历史。

本地管理还支持 `revoke-external`（`memberId`）及 `cancel-task`（`taskId`）。外部成员 Bearer 凭据只用于 `/room/self`、任务和消息接口，不能调用管理入口。

**先确认你用的是哪个 profile**——这是最容易踩的坑：

| 你打开的 | profile | 安装方式 |
|---|---|---|
| DeepSeek Harness 桌面应用 | `desktop` | **只能在应用内装的**；CLI 会拒绝（`profile "desktop" is managed exclusively by the Electron application`） |
| `dsh web` / `npx @deepseek-ai/dsh web` | `web` | CLI 可用 |

`web` profile：

```powershell
# pnpm 必须在 PATH 上，否则报 'pnpm' is not recognized
$env:PATH = "$HOME\.dsh\profiles\web\node_modules\.bin;" + $env:PATH
dsh plugin --profile web add <插件目录>
```

`desktop` profile 手工登记（三步都必须做，缺一不生效）：

```powershell
$root = "<插件目录>"
$prof = "$HOME\.dsh\profiles\desktop"

# 1) junction：让 profile 能解析到包
cmd /c mklink /J "$prof\node_modules\dsh-room" "$root"

# 2) package.json：加 dependency + 加进 dsh.profile.bundles
# 3) pnpm-lock.yaml：importers['.'].dependencies 里补 dsh-room 的 link 条目
```

装完**完全退出并重开 DSH**（host 半不热重载），会话界面出现「房间」标签。

> 验证是否真的加载了：`GET http://127.0.0.1:<端口>/room` 应返回 `200` +
> `{"ok":true,"rooms":[...]}`；返回 `404` 说明插件没进组合，回上一步查 profile。

## 使用

### 1. 建成员（界面上做）

打开「房间」标签 → 右上角 **「＋ 添加成员」** → 填两项：

| 字段 | 说明 |
|---|---|
| **工作区** | 仅当还没有任何房间时出现；房间跟着工作区走 |
| **昵称** | 房间内的唯一名字，`@` 用它。不能含空格与 `@`，≤32 字符 |
| **模型** | 下拉框，**按供应商分组**（`optgroup`），数据来自宿主自己的模型目录 |

**模型列表从哪来？** 就是 DSH 自己的模型目录
（`ctx.sessionController.modelCatalog()`），也就是你在「设置 → 模型」里配好的
provider 与 API key。所以这里能选的，和主对话里模型选择器能选的**完全一致**；
供应商名就是那一组的分组标题（如 `KIMI-K3`、`WorkBuddy`、`DeepSeek`）。

> 下拉里是空的 → 说明宿主没返回目录，通常是**还没配置任何 provider 或 API key**。
> 先去「设置 → 模型」配好，再回房间。

同一个模型可以建多个成员（比如两个 `kimi-k3` 分别扮演不同角色），昵称不同即可。

### 1b. 把「正在聊的这个会话」拉进房间

在**你想加入的那个会话里**打开「房间」标签 → 右上角「＋ 添加成员」→ 中段「**加入已有会话**」：

1. 「会话」下拉选一个（同工作区、正在运行、还没在房间里的会话）
2. 「昵称」填它在房间里叫什么（如 `主控`）
3. 点「加入房间」

**和「新建成员」的区别**：加入的是**同一个会话**，复用它的历史与上下文——所以拉进来的 AI 记得你们之前聊过什么。新建成员则是一个空白会话。

> 只能加入**正在运行**的会话。已关闭/归档的会话不在候选里。

### 1c. 移出成员

同一个面板底部的「成员」列表，每行右侧 **✕**。

**只移出房间，不删会话**——那个会话本身还在侧栏，历史都在。之后想加回来，用 1b 再拉一次（可以换个昵称）。

### 1d. 广播：一条消息发给所有人

收件人下拉里的 **「所有人（广播）」**。

- 一次投递给当前全部成员，账本里只记一条 `ask`，`targets` 冻结为当时的全部 `sessionId`
- 之后被移出房间的成员**不会**再收到这条（投递是逐个判定的）
- 空房间广播会明确报错 `no-members`，不会静默成功

### 1e. AI 之间派活：`room_post` 的 `to`

成员（AI）可以直接把任务派给另一个成员，**署名是它自己的昵称**：

```json
{ "digest": "派单：算 1+1", "to": "kimi", "text": "请计算 1+1，只回一行。" }
```

- `to` = 昵称 → 只投给那一位
- `to` = `"all"` → 投给**除自己以外**的全部成员
- 省略 `to` → 只写账本、不投递（原来的行为）
- 发给自己 / 未知昵称 / 缺 `text` 都会明确报错

账本里记成 `ask`，`from` 是派单者；界面上显示 `主控 → kimi`。

### 1f. 房间改名

「＋ 添加成员」面板 →「房间 → 改名」。

- 默认房间也能改名（存在 `rooms.json`，索引项 id 为 `default`）
- 重名会被拒（`room-name-taken`），≤40 字

### 1g. 删除房间

「＋ 添加成员」面板最底部，**只有空房间**（0 条消息）才会出现「删除这个空房间」。

- 删除会移除账本目录 + `rooms.json` 里的索引项
- 非空房间默认拒绝（`room-not-empty`）—— 账本是唯一副本，删掉就没了
- **默认房间**（旧布局 `<ws>/.dsh/room/ledger.jsonl`）的账本为空时**不会出现在房间下拉里**，
  所以不会再多出一个"没有名字的空房间"

> 成员会话本身不会因为删房间而消失；要清理会话请在侧栏归档。

### 关于"多出来的会话"

每个房间成员都是一个**真实的 DSH 会话**，所以侧栏会多出对应数量的条目——这是设计如此：

| 你做的 | 侧栏表现 |
|---|---|
| 新建成员 | 多一个**全新空会话**，标题自动设为 `房间名·昵称` |
| 加入已有会话 | **不新增**，复用你选的会话 |
| 移出成员 / 删房间 | 会话**不删除**，仍在侧栏 |

**会话标题**：成员加入时会被重命名为 `<房间名>·<昵称>`（例如 `大航海时代2·kimi`），
所以侧栏里能一眼看出在跟谁对话，不会全是"未命名"。

- **只在会话还没有标题时命名**：你自己改过的名字（侧栏重命名）不会被覆盖
- 改名用的是宿主的 `sessionTitle` 服务，**缺失时静默跳过**，不影响房间功能

要做到"成员会话不出现在侧栏"需要换用子代理形态，属于后续改动。

### 命令行方式（等价，便于脚本化）

界面不可用时也可以直接调 HTTP：

```powershell
$port = "52144"                      # 换成当前 GUI 的端口
$cwd  = "<你的工作区>"            # 换成你的工作区

$body = @{
  action   = 'create-member'
  nick     = 'kimi'
  provider = 'goaichat'
  model    = 'kimi-k3'
} | ConvertTo-Json -Compress

# 关键：必须用 UTF-8 字节发送，否则中文会变成 ????
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body $bytes `
  -Uri "http://127.0.0.1:$port/room?cwd=$([uri]::EscapeDataString($cwd))"
```

查当前可用的供应商与模型：

```powershell
$j = Invoke-RestMethod "http://127.0.0.1:$port/room?cwd=$([uri]::EscapeDataString($cwd))"
$j.modelGroups | ForEach-Object { "$($_.name) ($($_.id)): $(($_.models.id) -join ', ')" }
```

> ⚠️ **PowerShell 5 会把中文参数按 ANSI 编码传出去**，表现为账本里全是 `????`。
> 上面用 `UTF8.GetBytes` 显式编码即可避免。

### 2. 发指令

打开「房间」标签 → 左下角「发给…」选成员 → 输入 → 回车。

**必选收件人**，没有默认广播：没选就不让发。这是刻意的——避免手滑唤醒全部成员。

### 3. 看回填

AI 跑完一轮后，房间出现一条 `[answer]` 行，内容是一句话摘要。

> 如果 AI 自己调了 `room_post(kind:'answer')`，就以它为准（同一轮不重复写）；
> 没调则宿主自动回填。两种都会带 `sourceSeq`，`room_read(seq)` 能取回全文。

## 模型可见工具

| 工具 | 用途 |
|---|---|
| `room_post` | 主动往房间写摘要（`kind` 默认 `note`，最终结果用 `answer`） |
| `room_artifact` | **先申请产物路径**再写文件，避免并发覆盖 |
| `room_read` | `count` 读最近摘要；`seq` 读某条正文 |

## 数据布局

```
<工作区>/.dsh/room/
  ledger.jsonl                    ← 默认房间的账本（旧数据在这里）
  rooms.json                      ← 额外房间索引 [{id,name,createdAt}]
  artifacts/                      ← 默认房间的产物
  rooms/<roomId>/ledger.jsonl     ← 额外房间的账本
  rooms/<roomId>/artifacts/       ← 额外房间的产物
```

一个房间 = **一份账本 + 一份产物目录 + 一组成员**。房间由 `(工作区, roomId)` 唯一确定。

**建议加进 `.gitignore`**：

```gitignore
.dsh/room/
```

## 主控（lead）的操作纪律

> 2026-10-20 与用户约定的协作方式。**这节约束的是"主持房间的 AI"，不是插件行为。**

### 派单后不要盲目等待

| 用户状态 | 主控该怎么做 |
|---|---|
| **在电脑前**（默认） | 派完单**就结束这一轮**，不写 `Start-Sleep`。用户看到成员回复后会主动联系，不需要轮询 |
| **明确说"我不在 / 要自动"** | 才需要等；且应提前确认等待策略（固定间隔轮询 / 上自动唤醒） |

**为什么**：

- 成员的 turn 通常几十秒到几分钟，`sleep 75` 这种固定值要么白等要么不够
- 房间的 `backfill` **只写账本、不投递**（防止 AI 互相无限唤醒），所以"等"并不能替代回调
- 真正需要"派完自己继续"时，要的是**自动唤醒**机制（TODO 里的 P2 项），不是 sleep

**例外**：同一轮里要立刻用结果做下一步（如"让对方算个数，我马上要用"）时，
可以用 SSE `change` 事件监听代替固定 sleep，精确知道何时有新答案。

---

## 设计要点（实现者须知）

1. **先定收件人，再落账**。`targets` 在落账那一刻冻结为 `sessionId[]`；恢复**只读 targets**，绝不重新解析昵称或正文。
2. **投递幂等靠会话日志，不靠额外状态表**。传入的 `message.id` 会出现在 `agent/inbox/spliced` 与 `user/message` 里，据此判定"已入队 / 已消费 / 已取消"。
3. **只有 `turn/end.reason.kind === 'completed'` 才算完成**。`aborted` 即使有半截文本，也只记 `partial` note，不冒充成功。
4. **去重键是 `(session, turn)`**，检查与写入在同一临界区，并发 turn 不会双写。
5. **恢复成员时显式传入它自己的路由**，绝不回落到全局默认模型。
6. **摘要提取失败不伪造**：只有标题没有正文时记 `system/no-digest`，不写 `answer`。

## 测试

```powershell
cd <插件目录>
node --test --test-isolation=none test/decide.test.js test/ledger.test.js test/host.test.js
```

45 个用例，覆盖：

- 判定纯函数（38 步轮次取最后一步、`aborted` 不算完成、摘要跳过标题、代码块内 @ 不解析）
- 账本文件级（半行修复、并发串行、去重临界区、重启重建、原文不截断）
- 宿主集成（T1/T2/T9/T13/T16、W2/W4/W9 崩溃窗口）

> `--test-isolation=none` 是必需的：DSH 沙箱下 `node --test` 默认的进程隔离会 `spawn EPERM`。

## 排错

### 桌面端启动即崩：`Unexpected token '\uFEFF' ... is not valid JSON`

**这是 2026-10-18 真实踩过的坑，且是我方造成的。**

用 PowerShell 的 `Set-Content -Encoding UTF8` 或 `Out-File` 写 profile 的 `package.json`，
在 Windows PowerShell 5.1 下会**带 BOM**。DSH 的 `readProfileManifest` 用裸 `JSON.parse`，
遇到 BOM 直接抛错，表现为：**应用闪退、完全进不去**，并生成
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`。

**正确写法**（任意 PowerShell 版本都安全）：

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
```

**排查一行命令**：

```powershell
$b = [System.IO.File]::ReadAllBytes($path)
"$($b[0..2] -join ',')"   # 239,187,191 = BOM，必须去掉
```

需要同时检查这个 profile 下的：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。

### 桌面端装不了：`profile "desktop" is managed exclusively by the Electron application`

desktop profile 由 Electron 独占，**CLI 一律拒绝读写**。手工改 `package.json` 属于非受支持路径，
风险自负（本次就是这么把应用弄崩的）。

**推荐**：用应用内的「设置 → 插件 → 添加插件」填本地路径或 git 地址，让应用自己跑 pnpm。

### 历史会话报 `no adapter registered for provider "workbuddy-cn"`

使用 `@axiaohungry/dsh-llm-workbuddy` 的 profile 必须在 `cordis.patch.yml` 里补齐 provider 配置，
否则插件加载了但没注册任何 provider：

```yaml
- id: llm-workbuddy
  name: "@axiaohungry/dsh-llm-workbuddy"
  config:
    providers:
      workbuddy-cn: {}
```

## 实时推送（SSE）

房间页的新消息是**服务端推**的，不是定时轮询。

`
GET /room/events?cwd=<ws>&room=<id>
  event: hello   {"roomId":"default","seq":0}      ← 通道建立
  event: ready   {"roomId":"default","seq":41}     ← 当前最新序号
  event: change  {"seq":42,"kind":"ask"}           ← 每写一条账本就推一次
  : ping                                           ← 25s 心跳，防中间层断连
`

- **只推序号，不推正文**：客户端收到 seq 后按现有 /room 接口拉增量，
  推送体积恒定（几十字节），也不会出现两套数据格式。
- **落盘后才推**：账本 datasync 成功之后才广播，客户端不会看到"可能不存在"的消息。
- **自动降级**：EventSource 不可用或断线时，客户端自动退回 4 秒轮询；
  重连成功收到 eady 后自动关掉轮询。
- **断开即清理**：es.on('close') 取消订阅，不留悬挂 listener。

来源校验与 /room 一致（仅环回地址）。

## 已知限制
| 限制 | 计划 |
|---|---|
| 只能加入**正在运行**的会话（归档/关闭的不在候选里） | 后续 |
| 无 AI 互相 @ 投递 | M4 |
| `{mode:'mentioned'}` 只有 API，UI 用不到 | 后续 |
| 单进程持有房间（无 `owner.lock`） | 后续 |
| 无 SSE 推送，4 秒轮询 | M3 |
| 房间不能重命名、不能删除 | 后续（目前只能删目录） |

## 许可证

MIT。成员生命周期与 slot 注册形态参考了 [dsh-groupchat](https://github.com/ikun666666/dsh-groupchat)（MIT）。
