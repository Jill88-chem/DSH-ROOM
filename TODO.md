# dsh-room 待修清单

> 来源：2026-10-18 房间实测（大航海时代2 / room-lab）。
> 每条都写清「现象 → 根因 → 打算怎么改」，方便下次直接动手。

---

## P2 · 成员会话在侧栏可见（已缓解：自动命名，未消除）

**现象**
每建一个成员，侧栏就多一个会话。用户觉得吵。

**根因**
成员是**真实的 root 会话**（这是 v3 设计的核心：独立上下文、独立缓存、可独立恢复）。

**改法（重）**
改用子代理形态（`dsh-subagent` 的 continuable），成员会话挂在父会话下、不进侧栏。
代价：子代理的模型选择、权限、恢复语义都不同，且 `startActivation` 在 0.2.1 变过，
需要重写投递层。**不建议现在做**，先用侧栏归档顶着。

---

## P3 · D2/D4 不可分（已知限制，记入风险）

**现象**
deliveryState() 在日志层无法区分"被领取"与"被取消"，兜底按 D4 处理（不补投）。

**影响**
极端情况下可能漏投一次，但不会重复投。已可接受，需在 README「已知限制」写明。

---

## P3 · deliveryState 每次全量扫日志

**现象**
每条投递都 eadEvents(sessionId) 读整个会话日志，长会话下很慢。

**改法**
只读最近 N 条（按 seq 倒序）或缓存 splices 索引。

---
## 已完成（本轮 2026-10-18 晚，全部有回归测试）

- **P1 派单署名**：`room_post` 新增 `to`（昵称 / `all`）与 `text`；写 `ask` 行时 `from` = 派单者昵称，
  并走同一套 `deliver()`。发给自己、未知昵称、缺正文都有明确错误码。
- **P2 无鉴权**：`/room` 增加来源校验——只接受环回地址；带 `Origin` 的必须是 `127.0.0.1` / `localhost` / `::1`，否则 `403`。
- **P2 孤儿会话**：`createMember` 落账失败时调用 `handle.dispose()` 回收会话，再抛出原错误。
- **P2 房间重命名**：新增 `rename-room` + 前端「改名」输入框；默认房间也可改名（索引项 id=`default`）。
- **P2 HTTP 类型守卫**：`cwd` / `room` 非字符串时返回 `400 invalid-cwd` / `invalid-room`，不再变成 500。
- **P3 内存泄漏**：`agent/status` → `idle`/`disposed` 时清理该会话所有 turn 临时状态；另加 `TURN_MAP_CAP=400` 兜底。
- **P3 throttled 死代码**：删除 `deliver()` 返回值里的 `throttled` 字段（从未被填充）。
- **P3 foldLedger O(n)**：按「数组 + 长度」记忆化（`WeakMap`），只在追加行后重建。
- **模型切换后路由过期**：投递时以活 agent 的 `options` 为准同步 `member.route`，
  避免离线恢复时把它切回旧模型（回答"切模型还在不在房间"时发现）。
- **成员会话工具残缺**（2026-10-19/20 两次定位，最终修复）：
  1. 第一次：`createMember` 没给 `meta.agentPreset` → header 无 preset 字段。
     补上后仍不行，说明还有第二层。
  2. **真正根因**：`meta.agentPreset` 只是**记录**（"会话从哪个 preset 起步"），
     **不会触发挂载**。preset 的插件树必须显式
     `agentPresets.mount(agentCtx, preset)` —— 且必须在 `agents.create({ setup })`
     的回调里调，因为 `mount` 要的是 **unpublished agent 的 scope context**。
     依据：`mount.d.ts` "Bind an unpublished Agent...@param ctx Agent context from its setup callback"。
  3. 只写 header 不 mount 的症状：成员拿到 **31 个工具**（MCP 14 + Team 9 + room 3 + 杂项 5），
     但 `tool-fs`(read/write/edit)、`tool-fs-search`(grep/glob)、`tool-pwsh` **全缺**，
     因为那些由 `standard.patch.yml` 挂载。正常会话是 **49 个**。
  4. 修法：`setup: async (agentCtx) => { await agentPresets.mount(agentCtx, preset) }`，
     `agentPresets` 走 `optionalService`（软依赖，缺失时不阻塞）。
  5. 回归测试 3 条：header 有 preset、setup 真的调了 mount、mount 拿到了 agentCtx。
  ⚠️ 旧会话修不回来（组合已在创建时定死），只能重建。

## 已完成（更早）

- 消息指针的 seq 写出 0 —— 落账行没带 `append` 返回的序号（已修，有回归测试）
- 回填/room_post 写错房间 —— 只按 cwd 找默认房间（已修，改为按 sessionId 找成员所在房间）
- 空默认房间出现在下拉里 —— 空账本不算房间（已修）
- 空房间无法删除 —— 新增 `delete-room` + 界面按钮（已修）
- 无法拉入已有会话 —— 新增 `add-member`（已修）
- 无法广播 —— 新增 `{mode:'all'}`（已修）
- 无法移除成员 —— 新增 `remove-member`（已修）
- 同模型多实例 —— 本来就是允许的（已加测试固化）
- 长消息完整存储 —— 2825 字符逐字节一致（实测，无需改）
- `room_post` 的 `sourceSeq` 指向中途 narration —— 改用 `finalAnswerOf`（D指导 修）
- `room_read` 读出中途话而不是结论 —— 一级只接受「有 text 且无 tool-call」的消息，
  否则退到按 `(session, turn)` 兜底（2026-10-18 补，有回归测试）
- GET 不存在的 roomId 会建空目录 —— 改为 `virtualRoom` 只读视图，**GET 一律不落盘**
- POST 到不存在的非默认房间 —— 从 500 改为 `404 room-not-found`
- **重启后房间还没被访问过 → `room_post` 写进默认房间** —— 新增 `roomsOfCwd()`，
  按磁盘索引 + 默认房间把同工作区房间全部加载后再匹配成员（这是幽灵房间的第二条成因）
- 投递指针不区分定向/广播、且不告诉成员自己昵称 —— 指针改为三段式：
  `[房间·X] 用户（seq N）` / `投递范围：广播给房间全部 N 位成员 | 只发给你 | 点名了你` / `你的昵称：kimi`
  （2026-10-18，有回归测试）
- 房间消息行看不出投递范围 —— 前端 `targetLabel()` 渲染 `→ kimi` / `广播 → 全员 N 人`（2026-10-18）