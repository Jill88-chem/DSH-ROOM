/**
 * dsh-room — host half.
 *
 * 设计文档：见仓库 docs/ 目录（v3）
 *
 * 核心约束（§5.1，顺序不可交换）：
 *   P0 校验 → P1 解析并冻结 targets → P2 落账 → P3 持久性屏障 → P4 逐目标投递
 *
 * 恢复**只读 targets**，绝不重新解析昵称、正文或下拉框。
 * 投递状态由会话日志推导（§5.0），账本只提供"意图 + 确认"。
 */

import { randomUUID } from 'node:crypto'
import { join, resolve, basename } from 'node:path'
import { mkdir, writeFile, rename, readFile, rm, stat } from 'node:fs/promises'

import { RoomWriter, normalizeRow, foldLedger, artifactsDir, exists } from './ledger.js'
import {
  isCompletedTurn,
  finalAnswerOf,
  autoDigest,
  parseMentions,
  validateNick,
  clip,
  DIGEST_CAP,
} from './decide.js'

/** Cordis 插件名，必须与 cordis.patch.yml 的 row name 一致。 */
export const name = 'dsh-room'

/** 需要的服务。
 *
 * cordis 对**未声明**的服务访问会直接抛 `cannot get property "X" without inject`，
 * 而不是返回 undefined，所以凡是代码里访问到的服务都必须列在这里（"软依赖"写法对它无效）。
 * 缺失的服务只会让对应能力降级，不会阻止插件加载。
 */
export const inject = [
  'tools',
  'agents',
  'sessions',
  'webServer',
  'workspaceRegistry', // 把新成员挂进工作区侧栏；缺失时该步骤降级
  'sessionQuery', // 非实时会话的历史读取（room_read 的 answer 正文）
  'sessionController', // 模型目录：建成员时列出可选的 provider / model
]

/**
 * 取一个**可选**服务。
 *
 * 为什么不写进 `inject`：写进去就是"硬依赖"，服务缺失会让整个插件加载失败，
 * 房间标签直接消失。标题只是可读性优化，不值得冒这个险。
 * `ctx.get(name)` 走的是反射层，不受 inject 约束，缺失时返回 undefined。
 *
 * @param {string} name
 */
function optionalService(ctx, name) {
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}

/** 房间目录名（相对工作区）。 */
const ROOM_DIR = '.dsh/room'

/** 默认房间的 id：沿用旧布局 `<ws>/.dsh/room/ledger.jsonl`。 */
const DEFAULT_ROOM_ID = 'default'

/** 人类消息正文上限。 */
const TEXT_CAP = 200_000

/** 投递消息的体积红线（§8.2 C1）。 */
const INJECT_TOKEN_HINT = 300

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /**
   * 房间 key（工作区绝对路径）→ Room。
   * Room = {
   *   key, cwd, name, dir, writer, rows, members, nicks, truncatedBytes
   * }
   * Member = { sessionId, nick, route, agent|null }
   */
  const rooms = new Map()

  // ------------------------------------------------------------ 模型目录

  /**
   * 宿主提供的模型目录（按 provider 分组）。建成员的下拉框就用它，
   * 这样"可选哪个厂商/模型"永远跟 DSH 自己的模型选择器一致。
   *
   * 形状：`{ groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }], failures }`
   * 只在拿到非空结果时缓存——一次失败不应让选择器永久空着。
   * @type {{ groups: object[], failures?: object[] } | null}
   */
  let modelCatalog = null

  async function getModelCatalog() {
    if (modelCatalog !== null) return modelCatalog
    let catalog = null
    try {
      catalog = await ctx.sessionController?.modelCatalog?.()
    } catch (error) {
      ctx.logger.warn('room: 模型目录加载失败', error)
      return null
    }
    if ((catalog?.groups?.length ?? 0) > 0) modelCatalog = catalog
    return catalog
  }

  /** 在目录里定位 `{provider, model}`；找不到返回 undefined。 */
  function findCatalogEntry(catalog, provider, model) {
    const group = catalog?.groups?.find((g) => g.id === provider)
    const entry = group?.models?.find((m) => m.id === model)
    return entry === undefined ? undefined : { group, entry }
  }

  // ------------------------------------------------------------ 房间生命周期

  /**
   * 取得（必要时创建并加载）某个工作区里的一个房间。
   *
   * 存储布局（向后兼容 v1）：
   *   <ws>/.dsh/room/ledger.jsonl             ← 默认房间（旧数据就在这里）
   *   <ws>/.dsh/room/rooms.json               ← 额外房间的索引 [{id,name,createdAt}]
   *   <ws>/.dsh/room/rooms/<id>/ledger.jsonl  ← 额外房间
   *
   * @param {string} cwd - 工作区绝对路径
   * @param {string} [roomId] - 房间 id，省略或 `'default'` 即默认房间
   */
  async function roomFor(cwd, roomId = DEFAULT_ROOM_ID) {
    const abs = resolve(cwd)
    const id = normalizeRoomId(roomId)
    const cacheKey = `${abs}::${id}`
    const cached = rooms.get(cacheKey)
    if (cached !== undefined) return cached

    const base = join(abs, ROOM_DIR)
    const dir = id === DEFAULT_ROOM_ID ? base : join(base, 'rooms', id)
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    const opened = await writer.open()
    writer.setRows(opened.rows)

    const room = {
      key: cacheKey,
      roomId: id,
      cwd: abs,
      name: id === DEFAULT_ROOM_ID ? basename(abs) : await roomDisplayName(abs, id),
      dir,
      writer,
      rows: opened.rows,
      members: new Map(),
      nicks: new Map(),
      truncatedBytes: opened.truncatedBytes,
    }

    if (opened.truncatedBytes > 0) {
      ctx.logger.warn(
        `room: 丢弃了 ${opened.truncatedBytes} 字节的末尾半行（${dir}）——上次写入可能被中断`,
      )
    }

    rooms.set(cacheKey, room)
    await hydrateMembers(room)
    // 房间加载后统一校准一次标题：老成员的会话可能还是"未命名"，
    // 或者名字来自别的房间。syncSessionTitle 内部有"已一致就跳过"的判断。
    for (const member of room.members.values()) syncSessionTitle(room, member)
    return room
  }

  /** 房间 id 白名单化：默认房间固定为 `default`，其余用短 uuid。 */
  function normalizeRoomId(raw) {
    const s = String(raw ?? '').trim()
    if (s === '' || s === DEFAULT_ROOM_ID) return DEFAULT_ROOM_ID
    return s.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 32) || DEFAULT_ROOM_ID
  }

  /** 读 `<ws>/.dsh/room/rooms.json`（不存在返回空数组）。 */
  async function readRoomIndex(cwd) {
    const file = join(resolve(cwd), ROOM_DIR, 'rooms.json')
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 原子写 `rooms.json`。 */
  async function writeRoomIndex(cwd, entries) {
    const base = join(resolve(cwd), ROOM_DIR)
    await mkdir(base, { recursive: true })
    const file = join(base, 'rooms.json')
    const temp = `${file}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(entries, null, 2), 'utf8')
    await rename(temp, file)
  }

  /** 额外房间的显示名；索引里没有就退回 id。 */
  async function roomDisplayName(cwd, roomId) {
    const entries = await readRoomIndex(cwd)
    return entries.find((e) => e.id === roomId)?.name ?? roomId
  }

  /**
   * 新建一个额外房间。
   * @param {string} cwd
   * @param {string} name
   * @returns {Promise<{ roomId: string, name: string }>}
   */
  async function createRoom(cwd, name) {
    const abs = resolve(cwd)
    const label = String(name ?? '').trim()
    if (label === '') throw new Error('room-name-empty')
    if (label.length > 40) throw new Error('room-name-too-long')

    const entries = await readRoomIndex(abs)
    if (entries.some((e) => e.name === label)) throw new Error('room-name-taken')

    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    entries.push({ id, name: label, createdAt: Date.now() })
    await writeRoomIndex(abs, entries)

    // 立刻建立目录与空账本，避免第一次打开时目录不存在。
    await mkdir(join(abs, ROOM_DIR, 'rooms', id, 'artifacts'), { recursive: true })
    return { roomId: id, name: label, cwd: abs }
  }

  /**
   * 给房间改名。
   *
   * 名字存在 `rooms.json` 的索引项里；**默认房间也可以改名**——它的索引项 id 就是 `default`，
   * 这样不必为"默认房间叫什么"再造第二套存储。
   *
   * @param {string} cwd
   * @param {string} roomId
   * @param {string} name
   */
  async function renameRoom(cwd, roomId, name) {
    const abs = resolve(cwd)
    const id = normalizeRoomId(roomId)
    const label = String(name ?? '').trim()
    if (label === '') throw new Error('room-name-empty')
    if ([...label].length > 40) throw new Error('room-name-too-long')

    const entries = await readRoomIndex(abs)
    if (entries.some((e) => e.id !== id && e.name === label)) throw new Error('room-name-taken')

    const existing = entries.find((e) => e.id === id)
    if (existing !== undefined) existing.name = label
    else entries.push({ id, name: label, createdAt: Date.now() })

    await writeRoomIndex(abs, entries)

    // 内存里的缓存也同步，免得分页期间名字还是旧的。
    const cached = rooms.get(`${abs}::${id}`)
    if (cached !== undefined) cached.name = label

    return { roomId: id, name: label, cwd: abs, renamed: true }
  }

  /**
   * 把账本里的成员事件折叠成成员表。
   *
   * 两种事件按**发生顺序**处理，所以"加入 → 移除 → 再加入"能正确收敛：
   *   system/member        = 加入
   *   system/member-remove = 移除
   *
   * @param {any} room
   */
  async function hydrateMembers(room) {
    for (const row of room.rows) {
      if (row.kind !== 'system') continue
      if (typeof row.session !== 'string') continue

      if (row.tag === 'member-remove') {
        const existing = room.members.get(row.session)
        if (existing !== undefined) room.nicks.delete(existing.nick)
        room.members.delete(row.session)
        continue
      }

      if (row.tag !== 'member') continue
      if (typeof row.nick !== 'string') continue

      const route = row.route ?? (await routeOfSession(row.session))
      room.members.set(row.session, {
        sessionId: row.session,
        nick: row.nick,
        route,
        agent: ctx.agents?.get?.(row.session) ?? null,
        addedAt: typeof row.at === 'number' ? row.at : 0,
      })
      room.nicks.set(row.nick, row.session)
    }
  }

  /**
   * 从会话日志回查该会话**实际使用**的路由（§9.4 第 2 档）。
   *
   * 回退顺序（实测调整过）：
   *   1. `session.requestHeader()` —— 最后一次请求头
   *   2. 日志里的 `request/context` / `request/header` / `model/selection`
   *   3. `agent.options` —— **最后兜底**
   *
   * 第 3 项绝不能优先：它是 agent **创建时**的路由，用户中途切过模型后就过期了。
   * 实测踩过：本会话创建于 `workbuddy-cn/deepseek-v4.1-flash`，后来切到
   * `deepseek-official/deepseek-flash`，但 `agent.options` 仍返回前者。
   *
   * @param {string} sessionId
   */
  async function routeOfSession(sessionId) {
    // 1. 当前请求头
    try {
      const session = ctx.sessions?.get?.(sessionId)
      const config = session?.requestHeader?.()?.config
      if (config !== undefined && config !== null) {
        return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
      }
    } catch {
      // 继续
    }

    // 从后往前找最后一个带路由的事件。
    try {
      const session = ctx.sessions?.get?.(sessionId)
      const total = session?.seq ?? 0
      for (let seq = total - 1; seq >= 0; seq -= 1) {
        let event
        try {
          event = session.eventAt(seq)
        } catch {
          continue
        }
        if (event === undefined || event === null) continue

        if (event.type === 'request/context') {
          const d = event.data ?? {}
          if (d.provider !== undefined && d.model !== undefined) {
            return { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort }
          }
        }
        if (event.type === 'request/header') {
          const c = event.data?.header?.config
          if (c?.provider !== undefined && c?.model !== undefined) {
            return { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort }
          }
        }
        if (event.type === 'model/selection') {
          const d = event.data ?? {}
          if (d.provider !== undefined && d.model !== undefined) {
            return { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort }
          }
        }
      }
    } catch {
      // 落到下一档
    }

    // 3. 兜底：agent 创建时的路由（可能已过期）
    try {
      const agent = ctx.agents?.get?.(sessionId)
      const opts = agent?.options
      if (opts?.provider !== undefined && opts?.model !== undefined) {
        return { provider: opts.provider, model: opts.model, reasoningEffort: opts.reasoningEffort }
      }
    } catch {
      // 放弃
    }

    return undefined
  }

  // ------------------------------------------------------------ 会话日志读取

  /**
   * 读某会话的事件。返回 `null` 表示**读不到**（区别于"读到但为空"）。
   * @param {string} sessionId
   * @param {{ types?: string[] }} [filter]
   * @returns {Promise<object[] | null>}
   */
  async function readEvents(sessionId, filter = {}) {
    const types = filter.types

    const live = ctx.sessions?.get?.(sessionId)
    if (live !== undefined && live !== null) {
      const out = []
      const total = live.seq ?? 0
      for (let seq = 0; seq < total; seq += 1) {
        let event
        try {
          event = live.eventAt(seq)
        } catch {
          continue
        }
        if (event === undefined || event === null) continue
        if (types !== undefined && !types.includes(event.type)) continue
        out.push(event)
      }
      return out
    }

    try {
      const snapshot = await ctx.sessionQuery?.readSession?.(sessionId)
      const events = snapshot?.events ?? snapshot?.log?.events ?? []
      return types === undefined ? events : events.filter((e) => types.includes(e.type))
    } catch (error) {
      ctx.logger.warn(`room: 读取会话 ${sessionId} 失败`, error)
      return null
    }
  }

  /**
   * 判定 `(msgId, target)` 的投递状态（§5.0.1）。
   * @param {string} targetSessionId
   * @param {string} msgId
   * @returns {Promise<'D0'|'D1'|'D2'|'D3'|'D4'|'unknown'>}
   */
  async function deliveryState(targetSessionId, msgId) {
    const events = await readEvents(targetSessionId)
    if (events === null) return 'unknown'

    let insertedAt = -1
    let removedAfterInsert = false
    let consumed = false

    for (const event of events) {
      const data = event.data ?? {}
      if (event.type === 'agent/inbox/spliced') {
        const inserted = Array.isArray(data.inserted) ? data.inserted : []
        if (inserted.some((m) => m?.id === msgId) && insertedAt < 0) insertedAt = event.seq
        const isDelete = inserted.length === 0 && Number(data.removedCount) > 0
        if (isDelete && insertedAt >= 0 && event.seq > insertedAt) removedAfterInsert = true
      }
      if (event.type === 'user/message' && data.id === msgId) consumed = true
    }

    if (consumed) return 'D3'
    if (insertedAt < 0) return 'D0'
    // D2（领取）与 D4（取消）在日志层不完全可分；§5.0.1 兜底：按 D4，不补投。
    if (removedAfterInsert) return 'D4'
    return 'D1'
  }

  // ------------------------------------------------------------ 投递

  /**
   * 构造投递消息：只给指针（§D2），约 150 token。
   *
   * ⚠️ 宿主用 `snapshotJsonValue` 校验消息能否无损 JSON 化，**任何 `undefined` 字段都会
   * 让整条消息被拒**（报 `carries non-JSON-serializable data`）。所以这里每个字段都必须
   * 有确定的值，绝不能把可能缺失的账本字段直接透传。
   *
   * ⚠️ 必须告诉收件人**三件事**，否则它只能靠猜（真实踩过：两个同模型成员广播后都答
   *    "我是 deepseek-v4-flash"，因为没人告诉它房间昵称）：
   *      1. 自己在这个房间叫什么
   *      2. 这条是广播、点名，还是只发给它
   *      3. 怎么读全文
   *
   * @param {any} room
   * @param {object} row
   * @param {{ addressed?: boolean, nick?: string }} opts
   */
  function pointerMessage(room, row, opts) {
    const digest = typeof row.digest === 'string' && row.digest !== '' ? row.digest : '（无摘要，请用 room_read 查看）'
    const from = typeof row.from === 'string' && row.from !== '' ? row.from : '有人'
    const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : Date.now()
    const hasSeq = typeof row.seq === 'number' && Number.isFinite(row.seq)
    const seq = hasSeq ? row.seq : 0
    const nick = typeof opts?.nick === 'string' && opts.nick !== '' ? opts.nick : null
    const targets = Array.isArray(row.targets) ? row.targets : []
    const addressed = opts?.addressed === true

    if (!hasSeq) {
      // 不要静默写 seq 0：下游 room_read({seq:0}) 一定失败，而且很难查。
      ctx.logger.warn(`room: 投递行缺少 seq（msgId=${row.msgId}），指针里的 seq 会是 0`)
    }

    // 投递范围必须显式写出来——GUI 下拉选单人时 mentions 往往不含昵称，
    // 只靠 addressed 会退化成"看不出区别"。
    const scope = addressed
      ? '点名了你'
      : targets.length > 1
        ? `广播给房间全部 ${targets.length} 位成员`
        : '只发给你'

    const lines = [
      `[房间 · ${room.name}] ${from}（seq ${seq}）`,
      `投递范围：${scope}`,
    ]
    if (nick !== null) lines.push(`你的昵称：${nick}`)
    lines.push(`摘要：${digest}`)
    if (typeof row.artifact === 'string' && row.artifact !== '') lines.push(`产物：${row.artifact}`)
    lines.push(`要全文：room_read({ seq: ${seq} })`)

    return {
      id: row.msgId, // 用账本 msgId，才能让会话日志与账本对齐（§2.5）
      role: 'user',
      source: { kind: 'room', room: room.name, seq, from, at },
      content: [{ type: 'text', text: lines.join('\n') }],
    }
  }

  /**
   * 估算注入体积（字符数 / 1.6，够用于红线检查）。
   * @param {object} message
   */
  function roughTokens(message) {
    const text = message?.content?.map((b) => b.text ?? '').join('') ?? ''
    return Math.ceil(text.length / 1.6)
  }

  /**
   * 投递前自检：消息必须能无损 JSON 化，否则宿主会在 append 时拒绝整条消息。
   *
   * 退化实现（宿主工具缺失时）：JSON.stringify 后比对是否有 `undefined` 漏出。
   * @param {object} message
   * @returns {string | null} 失败原因，成功返回 null
   */
  function selfCheckMessage(message) {
    const seen = new Set()
    /** @returns {string | null} */
    function walk(value, path) {
      if (value === null) return null
      const type = typeof value
      if (type === 'string' || type === 'boolean') return null
      if (type === 'number') {
        return Number.isFinite(value) ? null : `${path}: 非有限数字`
      }
      if (type === 'undefined') return `${path}: undefined`
      if (type !== 'object') return `${path}: 不可序列化的 ${type}`
      if (seen.has(value)) return `${path}: 循环引用`
      seen.add(value)
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          const problem = walk(value[i], `${path}[${i}]`)
          if (problem !== null) return problem
        }
        return null
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return `${path}: 非普通对象（${proto?.constructor?.name ?? 'null'}）`
      }
      for (const key of Object.keys(value)) {
        const problem = walk(value[key], `${path}.${key}`)
        if (problem !== null) return problem
      }
      return null
    }
    return walk(message, 'message')
  }

  /**
   * 按冻结的 targets 投递（§5.1 P4）。逐目标、幂等。
   * @param {any} room
   * @param {object} row
   */
  async function deliver(room, row) {
    const delivered = []
    const skipped = []
    const failed = []
    /** 失败原因，随响应返回，避免只能翻日志。 */
    const errors = []

    for (const target of row.targets ?? []) {
      const member = room.members.get(target)
      if (member === undefined) {
        failed.push(target)
        errors.push({ target, error: 'unknown-member' })
        continue
      }

      const state = await deliveryState(target, row.msgId)
      if (state === 'D1' || state === 'D2' || state === 'D3' || state === 'D4') {
        // 已入队 / 已领取 / 已消费 / 已被取消 → 一律不再插入。
        skipped.push(target)
        continue
      }

      // 每次都以注册表为准：member.agent 可能是重启前的失效句柄。
      let agent = ctx.agents?.get?.(target) ?? null
      if (agent === null || agent === undefined) {
        member.agent = null
        try {
          agent = await resumeMember(member)
        } catch (error) {
          const message = String(error?.message ?? error)
          ctx.logger.warn(`room: 恢复成员 ${member.nick} 失败`, error)
          failed.push(target)
          errors.push({ target, stage: 'resume', error: message })
          continue
        }
      }

      // 用户在会话里换了模型时，房间记录的路由会过期。这里以**活 agent 的实际路由**为准，
      // 免得下次离线恢复把它切回旧模型（§9.4：绝不静默换模型）。
      try {
        const live = agent?.options
        if (
          live?.provider !== undefined &&
          live?.model !== undefined &&
          (member.route?.provider !== live.provider || member.route?.model !== live.model)
        ) {
          ctx.logger.info(
            `room: 成员 ${member.nick} 的模型已变为 ${live.provider}/${live.model}，同步房间记录`,
          )
          member.route = { provider: live.provider, model: live.model }
        }
      } catch {
        // 拿不到就沿用旧记录
      }

      try {
        // 用户可能在会话里换过模型；标题也可能被自动命名覆盖。每次投递前同步一次。
        syncSessionTitle(room, member)

        const message = pointerMessage(room, row, {
          addressed: Array.isArray(row.mentions) && row.mentions.includes(member.nick),
          nick: member.nick,
        })

        const tokens = roughTokens(message)
        if (tokens > INJECT_TOKEN_HINT) {
          ctx.logger.warn(`room: 注入体积约 ${tokens} token，超过红线 ${INJECT_TOKEN_HINT}`)
        }

        // 宿主会用同一个规则校验；先自检，把失败挡在 append 之前并给出可读原因。
        const problem = selfCheckMessage(message)
        if (problem !== null) {
          failed.push(target)
          errors.push({ target, stage: 'self-check', error: problem })
          continue
        }

        const status = agent.status
        if (status === 'running') agent.inject(message)
        else agent.followup(message)

        member.agent = agent
        delivered.push(target)
      } catch (error) {
        const message = String(error?.message ?? error)
        ctx.logger.warn(`room: 投递到 ${member.nick} 失败`, error)
        failed.push(target)
        errors.push({ target, stage: 'deliver', error: message })
      }
    }

    return { delivered, skipped, failed, ...(errors.length === 0 ? {} : { errors }) }
  }

  /**
   * 恢复离线成员。**绝不静默换模型**（§9.4）。
   * @param {any} member
   */
  async function resumeMember(member) {
    const route = member.route ?? (await routeOfSession(member.sessionId))
    if (route?.provider === undefined || route?.model === undefined) {
      throw new Error(`成员 ${member.nick} 没有可用路由，拒绝用全局默认模型顶替`)
    }
    const agentOptions = { provider: route.provider, model: route.model }
    if (route.reasoningEffort !== undefined) agentOptions.reasoningEffort = route.reasoningEffort

    const handle = await ctx.agents.resume({ resumeSessionId: member.sessionId, agentOptions })
    return handle.agent
  }

  // ------------------------------------------------------------ 回填

  /**
   * 跟踪每个 turn 的事件，供回填与范围判定使用。
   * 进程本地缓存；重启后由会话日志重建，仅作加速，不作正确性依据。
   */
  const turnAssistant = new Map() // `${sessionId}#${turn}` → events[]
  const turnInputIds = new Map() // `${sessionId}#${turn}` → Set<msgId>
  const currentTurn = new Map() // sessionId → turn

  /**
   * 一个 turn 结束时回填（§5.1 A1–A4）。
   * @param {any} room
   * @param {{ sessionId: string, turn: number, turnEnd: object|null, messages: object[], inputIds: Set<string> }} input
   */
  async function backfill(room, input) {
    const { sessionId, turn, turnEnd, messages, inputIds } = input
    const member = room.members.get(sessionId)
    if (member === undefined) return { skipped: 'not-a-member' }

    // §5.5：只回填消费过房间投递的 turn。
    const roomMsgIds = new Set()
    for (const row of room.rows) {
      if (row.kind !== 'ask' || !Array.isArray(row.targets)) continue
      if (row.targets.includes(sessionId)) roomMsgIds.add(row.msgId)
    }
    if (roomMsgIds.size > 0) {
      let touched = false
      for (const id of inputIds) {
        if (roomMsgIds.has(id)) {
          touched = true
          break
        }
      }
      if (!touched) return { skipped: 'not-room-turn' }
    } else {
      return { skipped: 'no-room-asks' }
    }

    const verdict = isCompletedTurn(turnEnd, messages)

    if (!verdict.ok) {
      // 未正常完成：有半截文本就记 note(partial)，不冒充成功、不触发投递。
      if (verdict.why === 'aborted' || verdict.why === 'interrupted') {
        const raw = softFinalText(messages)
        if (raw !== null) {
          const seq = await room.writer.run(async ({ append }) => {
            const normalized = normalizeRow({
              kind: 'note',
              msgId: randomUUID(),
              from: member.nick,
              session: sessionId,
              turn,
              digest: clip(raw, DIGEST_CAP),
              partial: true,
              tag: 'partial',
            })
            return normalized.ok ? append(normalized.row) : undefined
          })
          return { partial: true, seq }
        }
      }
      return { skipped: verdict.why }
    }

    const final = verdict.final
    const digest = autoDigest(final.text)
    const dedupeKey = `${sessionId}#${turn}`

    return room.writer.run(async ({ rows, append }) => {
      // A3：去重检查与写入在同一临界区（§4.5.1）。
      if (foldLedger(rows).answers.get(dedupeKey) !== undefined) return { skipped: 'duplicate' }

      if (digest === null) {
        // 摘要提取失败：不伪造（T16）。
        const sysRow = normalizeRow({
          kind: 'system',
          msgId: randomUUID(),
          from: member.nick,
          session: sessionId,
          turn,
          tag: 'no-digest',
          digest: `${member.nick} 第 ${turn} 轮无可用摘要，未回填`,
        })
        if (sysRow.ok) await append(sysRow.row)
        return { skipped: 'no-digest' }
      }

      const normalized = normalizeRow({
        kind: 'answer',
        msgId: randomUUID(),
        from: member.nick,
        session: sessionId,
        turn,
        sourceSeq: final.event.seq,
        digest,
        route: member.route,
      })
      if (!normalized.ok) return { skipped: normalized.error }
      return { seq: await append(normalized.row) }
    })
  }

  /** 宽松版最终文本：轮次被中止时取最后一条有文本的消息。 */
  function softFinalText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const content = messages[i]?.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      if (text !== '') return text
    }
    return null
  }

  // ------------------------------------------------------------ 事件接线

  /**
   * turn 临时状态的兜底清理：正常路径由 turn/end 与 agent/status=idle 清理，
   * 这里再给一层条数上限，防止异常路径把进程内存撑爆。
   */
  const TURN_MAP_CAP = 400
  function pruneTurnMaps() {
    while (turnAssistant.size > TURN_MAP_CAP) {
      const oldest = turnAssistant.keys().next().value
      if (oldest === undefined) break
      turnAssistant.delete(oldest)
      turnInputIds.delete(oldest)
    }
    while (turnInputIds.size > TURN_MAP_CAP) {
      const oldest = turnInputIds.keys().next().value
      if (oldest === undefined) break
      turnInputIds.delete(oldest)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const data = event?.data ?? {}
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return

      if (type === 'turn/start' && typeof data.turn === 'number') {
        currentTurn.set(sessionId, data.turn)
        turnAssistant.set(`${sessionId}#${data.turn}`, [])
        turnInputIds.set(`${sessionId}#${data.turn}`, new Set())
        pruneTurnMaps()
        return
      }

      // 会话被中断/杀掉时不会有 turn/end，这两个 Map 会永久残留。
      // 见到 idle 就把该会话所有 turn 的临时状态清掉。
      if (type === 'agent/status' && (data.status === 'idle' || data.status === 'disposed')) {
        for (const key of [...turnAssistant.keys()]) {
          if (key.startsWith(`${sessionId}#`)) turnAssistant.delete(key)
        }
        for (const key of [...turnInputIds.keys()]) {
          if (key.startsWith(`${sessionId}#`)) turnInputIds.delete(key)
        }
        return
      }

      if (type === 'assistant/message' && typeof data.turn === 'number') {
        const key = `${sessionId}#${data.turn}`
        const list = turnAssistant.get(key)
        if (list !== undefined) list.push(event)
        return
      }

      if (type === 'user/message' && typeof data.id === 'string') {
        const turn = currentTurn.get(sessionId)
        if (turn === undefined) return
        const key = `${sessionId}#${turn}`
        let set = turnInputIds.get(key)
        if (set === undefined) {
          set = new Set()
          turnInputIds.set(key, set)
        }
        set.add(data.id)
        return
      }

      if (type === 'turn/end' && typeof data.turn === 'number') {
        const key = `${sessionId}#${data.turn}`
        const messages = turnAssistant.get(key) ?? []
        const inputIds = turnInputIds.get(key) ?? new Set()
        void finishTurn(session, data.turn, event, messages, inputIds)
      }
    } catch (error) {
      ctx.logger.warn('room: session/event 处理失败', error)
    }
  })

  /**
   * turn/end → 找出这个 turn 属于哪个房间 → 回填。
   *
   * ⚠️ 不能只按 cwd 找房间：一个工作区可以有多个房间，`roomFor(cwd)` 落的是
   * **默认房间**，于是把回答写到了没人看的空房间里（真实踩过：房间页永远没有返回）。
   * 正确做法是按 sessionId 找它实际所在的房间，再由 `backfill` 校验 inputIds。
   */
  async function finishTurn(session, turn, turnEnd, messages, inputIds) {
    const key = `${session.id}#${turn}`
    const cwd = session.header?.cwd
    try {
      if (typeof cwd !== 'string' || cwd === '') return
      const abs = resolve(cwd)

      // 该会话所在的所有房间（可能不止一个）。
      // 注意：必须把同工作区的房间**从磁盘加载出来**再判断，否则进程刚重启、
      // 房间还没被 http 访问过时，内存里只有默认房间，结果又写错地方。
      const candidates = (await roomsOfCwd(abs)).filter((room) => room.members.has(session.id))

      if (candidates.length === 0) {
        ctx.logger.warn(`room: ${session.id} 不属于任何房间，跳过回填`)
        return
      }

      let wrote = false
      for (const room of candidates) {
        const result = await backfill(room, {
          sessionId: session.id,
          turn,
          turnEnd,
          messages,
          inputIds,
        })
        if (result?.seq !== undefined) {
          wrote = true
          ctx.logger.info(`room: ${session.id} 第 ${turn} 轮已回填到「${room.name}」seq=${result.seq}`)
        }
      }

      if (!wrote) {
        ctx.logger.warn(
          `room: 第 ${turn} 轮未回填（候选房间 ${candidates.length} 个）` +
            ` msgs=${messages.length} inputs=${inputIds.size}`,
        )
      }
    } catch (error) {
      ctx.logger.warn('room: 回填失败', error)
    } finally {
      turnAssistant.delete(key)
      turnInputIds.delete(key)
    }
  }

  // ------------------------------------------------------------ 工具

  function requireAgent(exec) {
    const agent = exec?.agent
    if (agent === undefined || agent === null) throw new Error('room 工具需要一个发起调用的 agent')
    return agent
  }

  async function roomOfAgent(agent) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') throw new Error('这个会话没有工作目录，进不了房间')

    const abs = resolve(cwd)
    // 优先返回这个 agent **实际所在的**房间（同工作区可能有好几个房间）。
    // 必须含"从磁盘按需加载"：进程重启后房间还没被 http 访问过时，
    // 只看内存会找不到，退回默认房间就会写错地方。
    for (const room of await roomsOfCwd(abs)) {
      if (room.members.has(agent.id)) return room
    }
    return roomFor(abs)
  }

  function textOutput(render) {
    return {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    }
  }

  ctx.tools.register({
    name: 'room_post',
    description:
      '往房间账本写一条消息（多个 AI 与人类共用）。' +
      'digest 是一句话摘要（≤200 字符、单行），别贴全文——全文放产物文件，artifact 传路径。' +
      'kind 默认 note（进度/求助，本轮结束时仍会自动回填最终回答）；' +
      '只有明确发布本轮最终结果时才用 answer。' +
      '**派活给某个成员**：传 to（昵称，或 "all" 广播），把指令放 text 里。',
    parameters: {
      type: 'object',
      properties: {
        digest: { type: 'string', description: '一句话摘要，≤200 字符，必须单行。' },
        kind: {
          type: 'string',
          enum: ['note', 'answer'],
          description: 'note（默认）/ answer。带 to 时忽略，按派单处理。',
        },
        artifact: { type: 'string', description: '产物路径（由 room_artifact 分配）。' },
        mentions: { type: 'array', items: { type: 'string' }, description: '要点名的成员昵称。' },
        to: {
          type: 'string',
          description: '派单对象：成员昵称，或 "all" = 广播给其他所有成员。省略则只写账本、不投递。',
        },
        text: { type: 'string', description: '带 to 时必填：发给对方的指令正文（≤1000 字符）。' },
      },
      required: ['digest'],
    },
    output: textOutput((v) => {
      if (!v.ok) return `写入失败：${v.error}`
      if (v.delivered !== undefined) {
        const parts = [`已派单（seq ${v.seq}）`]
        if (v.delivered.length > 0) parts.push(`投递给 ${v.delivered.length} 位`)
        if (v.skipped.length > 0) parts.push(`跳过 ${v.skipped.length}（已投过）`)
        if (v.failed.length > 0) parts.push(`失败 ${v.failed.length}`)
        return parts.join('，')
      }
      return `已写入房间（seq ${v.seq}，kind=${v.kind}）${v.warning === 'artifact-missing' ? '；产物文件还不存在，已标为未就绪' : ''}`
    }),
    async execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const room = await roomOfAgent(agent)
        const member = room.members.get(agent.id)

        const digest = String(args.digest ?? '')
        const kind = args.kind === 'answer' ? 'answer' : 'note'
        const mentions = Array.isArray(args.mentions)
          ? args.mentions.filter((m) => typeof m === 'string')
          : []

        // ---- 派单分支：带 to 时写一条 ask，并以**自己的昵称**署名后投递 ----
        const to = typeof args.to === 'string' && args.to.trim() !== '' ? args.to.trim() : null
        if (to !== null) {
          const text = String(args.text ?? '').trim()
          if (text === '') return { ok: false, error: 'missing-text' }
          if (text.length > 1000) return { ok: false, error: 'text-too-long' }
          if (member === undefined) return { ok: false, error: 'not-room-member' }

          let targets
          if (to === 'all' || to === '所有人') {
            targets = [...room.members.keys()].filter((id) => id !== agent.id)
          } else {
            const id = room.nicks.get(to)
            if (id === undefined) return { ok: false, error: `unknown-member:${to}` }
            if (id === agent.id) return { ok: false, error: 'cannot-send-to-self' }
            targets = [id]
          }
          if (targets.length === 0) return { ok: false, error: 'no-target' }

          const msgId = randomUUID()
          const written = await room.writer.run(async ({ append }) => {
            const normalized = normalizeRow({
              kind: 'ask',
              msgId,
              from: member.nick, // ★ 署名是派单者，不再是"用户"
              text,
              digest: clip(text, DIGEST_CAP),
              targets,
              mentions: parseMentions(text, [...room.nicks.keys()]),
              depth: (Number(args.depth) || 0) + 1 <= 3 ? (Number(args.depth) || 0) + 1 : 3,
            })
            if (!normalized.ok) return { ok: false, error: normalized.error }
            const seq = await append(normalized.row)
            return { ok: true, seq, row: { ...normalized.row, seq } }
          })
          if (!written.ok) return written

          const delivery = await deliver(room, written.row)
          return { ok: true, seq: written.seq, kind: 'ask', ...delivery }
        }

        let artifact
        let artifactState
        if (typeof args.artifact === 'string' && args.artifact !== '') {
          artifact = args.artifact
          artifactState = (await exists(join(room.dir, artifact))) ? 'ready' : 'pending'
        }

        const turn = currentTurn.get(agent.id)

        // `answer` 必须带 sourceSeq：room_read(seq) 靠它从会话日志取回正文（§6.4.3）。
        // 不带的 answer 只能显示 digest，读不到全文——这是 v1 实测发现的缺口。
        //
        // ⚠️ 不能直接取 turnAssistant 的最后一条：room_post 几乎总是在**工具步骤**里被调用，
        //    而工具步骤之后的下一步才是"最终的可见回答"。取最后一条会拿到
        //    「我先去查一下」这种中途 narration，甚至拿到只有 tool-call 没有 text 的步骤，
        //    于是 room_read 返回空正文（真实踩过：room_read(34) 读出来是中途的巡检说明）。
        //    正确做法：复用 finalAnswerOf 的规则，从后往前找「有 text 且无 tool-call」的那条。
        let sourceSeq
        if (kind === 'answer' && turn !== undefined) {
          const collected = turnAssistant.get(`${agent.id}#${turn}`) ?? []
          const final = finalAnswerOf(collected)
          if (final !== null && typeof final.event?.seq === 'number') sourceSeq = final.event.seq
        }

        const result = await room.writer.run(async ({ rows, append }) => {
          // kind=answer 与自动回填共用 (session, turn) 去重键（§5.1.2）：
          // 同一轮重复发布只保留第一条，避免账本里出现两条"最终结果"。
          if (kind === 'answer' && turn !== undefined) {
            const key = `${agent.id}#${turn}`
            const existing = foldLedger(rows).answers.get(key)
            if (existing !== undefined) {
              return { ok: true, seq: existing.seq, kind, duplicate: true }
            }
          }

          const normalized = normalizeRow({
            kind,
            msgId: randomUUID(),
            from: member?.nick ?? '成员',
            session: agent.id,
            ...(turn === undefined ? {} : { turn }),
            ...(sourceSeq === undefined ? {} : { sourceSeq }),
            digest,
            mentions,
            ...(artifact === undefined ? {} : { artifact, artifactState }),
            route: member?.route,
          })
          if (!normalized.ok) return { ok: false, error: normalized.error }
          return { ok: true, seq: await append(normalized.row), kind }
        })

        if (result.duplicate === true) {
          return { ok: true, seq: result.seq, kind, note: '这一轮已有 answer，未重复写入' }
        }
        if (kind === 'answer' && sourceSeq === undefined) {
          return { ...result, warning: 'no-source-seq' }
        }
        return result.ok && artifactState === 'pending' ? { ...result, warning: 'artifact-missing' } : result
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  ctx.tools.register({
    name: 'room_artifact',
    description:
      '申请一个产物文件路径。**先调用它拿路径，再把内容写进去**——自己编路径会撞名覆盖别人的产物。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '短横线小写英文描述，如 b8-recovery。' },
      },
      required: ['slug'],
    },
    output: textOutput((v) => (v.ok ? `产物路径：${v.path}（把内容写到这里）` : `分配失败：${v.error}`)),
    async execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const room = await roomOfAgent(agent)

        const slug =
          String(args.slug ?? 'note')
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'note'

        const id = randomUUID().replace(/-/g, '').slice(0, 6)
        const rel = `artifacts/${id}-${slug}.md`
        const abs = join(room.dir, rel)

        if (await exists(abs)) return { ok: false, error: 'artifact-collision' }

        await mkdir(artifactsDir(room.dir), { recursive: true })
        return { ok: true, path: rel, absolute: abs }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  /** 取一条 assistant/message 事件里的可见文本（只拼 text 块，忽略 reasoning / tool-call）。 */
  function textOfEvent(event) {
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  /** 这条 assistant 消息是否还在调工具（有 tool-call 块）。 */
  function hasToolCall(event) {
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) return false
    return content.some((b) => b?.type === 'tool-call')
  }

  /**
   * 取一条 `answer` 行的正文（§6.4.3）。
   *
   * 三级兜底，任何一级拿不到就退到下一级：
   *   1. `row.sourceSeq` → 按 seq 精确取回那一步
   *   2. 退化为「本 turn 内的 assistant/message」→ 跑 finalAnswerOf 取最终回答
   *      （覆盖：老账本里 sourceSeq 缺失，或 sourceSeq 指向的行已被压缩/删掉）
   *   3. 仍失败 → 返回 null，由调用方回落到 `row.digest`
   *
   * ⚠️ 第 1 级取到的文本可能不可用，两种情况都必须继续往下一级走：
   *    ① 文本为空（sourceSeq 指向纯 tool-call 步骤）；
   *    ② 文本非空但**同时带 tool-call**（那是"我这就去查一下"式的中途叙述，
   *       用户要看的是最终回答）。
   *    第 ② 种正是"room_read 读出一句中途话、而不是完整结论"的根因。
   *
   * @param {object} room
   * @param {object} row - 账本里的 answer 行
   * @returns {Promise<{ text: string, via: 'sourceSeq' | 'turn' } | null>}
   */
  async function answerBodyOf(room, row) {
    if (typeof row.session !== 'string' || row.session === '') return null
    // §6.4.5：只允许读本房间成员。
    if (!room.members.has(row.session)) throw new Error('not-room-session')

    const all = await readEvents(row.session, { types: ['assistant/message'] })
    if (all === null) return null

    // 1) sourceSeq 精确命中——只接受「有文本且不是中途叙述」
    if (typeof row.sourceSeq === 'number') {
      const exact = all.find((e) => e.seq === row.sourceSeq)
      const text = textOfEvent(exact)
      if (text !== '' && !hasToolCall(exact)) return { text, via: 'sourceSeq' }
    }

    // 2) 按 (session, turn) 兜底
    if (typeof row.turn === 'number') {
      const inTurn = all.filter((e) => e.data?.turn === row.turn)
      const final = finalAnswerOf(inTurn)
      if (final !== null) return { text: final.text, via: 'turn' }
      // finalAnswerOf 在"最后一步还在调工具"时返回 null；退化为最后一条有文本的
      const loose = softFinalText(inTurn)
      if (loose !== null) return { text: loose, via: 'turn' }
    }

    // 3) 交给调用方回落到 digest
    return null
  }

  ctx.tools.register({
    name: 'room_read',
    description:
      '读房间账本。传 count 读最近几条摘要（默认 10，上限 100）；传 seq 读某一条正文；' +
      '正文很长时会给出可续读的提示。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '读最近几条摘要，默认 10，上限 100。' },
        seq: { type: 'integer', description: '读这一条的正文。' },
      },
    },
    output: textOutput((v) => (v.ok ? v.text : `读取失败：${v.error}`)),
    async execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const room = await roomOfAgent(agent)

        if (typeof args.seq === 'number') {
          const row = room.writer.rows.find((r) => r.seq === args.seq)
          if (row === undefined) return { ok: false, error: 'seq-not-found' }

          // ask：账本自带原文（权威副本，不截断）。
          if (row.kind === 'ask') {
            return { ok: true, text: `#${row.seq} ${row.from}\n${row.text ?? ''}` }
          }

          // answer：先按 sourceSeq 精确取回，失败再按 (session, turn) 兜底，最后回落 digest。
          if (row.kind === 'answer') {
            const body = await answerBodyOf(room, row)
            if (body !== null) {
              return { ok: true, text: paginate(`#${row.seq} ${row.from}\n${body.text}`) }
            }
          }

          return { ok: true, text: `#${row.seq} ${row.from}\n${row.digest ?? ''}` }
        }

        const count = Math.min(Math.max(Number(args.count ?? 10) | 0, 1), 100)
        const tail = room.writer.rows.slice(-count)
        if (tail.length === 0) return { ok: true, text: '（房间还没有消息）' }
        const lines = tail.map((row) => {
          const bits = [`#${row.seq}`, `[${row.kind}]`, row.from]
          if (row.digest) bits.push(`— ${row.digest}`)
          if (row.artifact) {
            bits.push(`（产物 ${row.artifact}${row.artifactState === 'pending' ? ' 未就绪' : ''}）`)
          }
          return bits.join(' ')
        })
        return { ok: true, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  /** 长正文分页（§6.4.2）。 */
  function paginate(text) {
    const PAGE = 8000
    if (text.length <= PAGE) return text
    return `${text.slice(0, PAGE)}\n…（还有 ${text.length - PAGE} 字符，请用文件工具读产物，或分段询问）`
  }

  // ------------------------------------------------------------ 成员创建

  /**
   * 创建成员会话并入房。M1 只支持新建（§5.5）。
   * @param {any} room
   * @param {{ nick: string, provider: string, model: string, reasoningEffort?: string }} spec
   */
  async function createMember(room, spec) {
    const checked = validateNick(spec.nick)
    if (!checked.ok) throw new Error(checked.error)
    if (room.nicks.has(spec.nick)) throw new Error('nick-taken')
    if (!spec.provider || !spec.model) throw new Error('missing-route')

    // 校验组合确实在宿主目录里——否则会建出一个"能建不能跑"的成员。
    // 目录为空（没配任何 provider）时跳过校验，让错误在真正运行时暴露。
    const catalog = await getModelCatalog()
    if (catalog !== null && (catalog.groups?.length ?? 0) > 0) {
      const found = findCatalogEntry(catalog, spec.provider, spec.model)
      if (found === undefined) throw new Error(`unknown-route:${spec.provider}/${spec.model}`)
    }

    const sessionId = `session-${randomUUID()}`
    const route = { provider: spec.provider, model: spec.model }
    if (spec.reasoningEffort !== undefined) route.reasoningEffort = spec.reasoningEffort

    // ⚠️ 两件事必须**同时**做，少一件成员就是残废的：
    //
    //   ① `meta.agentPreset` —— 写进 session header，作为"这个会话从哪个 preset 起步"的
    //      持久记录。不写的话重启后无法重建正确的组合。
    //   ② `setup` 里调 `agentPresets.mount(agentCtx, preset)` —— **真正把 preset 的插件树
    //      挂到 agent 上**。只写 header 是不够的：header 只是记录，不会触发挂载。
    //
    // 实测踩坑（2026-10-20）：只写 header 不 mount，成员拿到 31 个工具（MCP + Team 全套），
    // 但 `tool-fs`(read/write/edit)、`tool-fs-search`(grep/glob)、`tool-pwsh` 全部缺失
    // ——因为那些是 preset patch 挂的，而默认组合不含它们。成员于是"看不见文件"，
    // 只能靠 MCP 索引瞎猜（D指导 连续 4 条报工具不可用）。
    const preset = spec.agentPreset ?? (await pickAgentPreset(room))
    const agentPresets = optionalService(ctx, 'agentPresets')

    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: room.cwd, ...(preset === undefined ? {} : { agentPreset: preset }) },
      agentOptions: { ...route },
      ...(preset === undefined || agentPresets?.mount === undefined
        ? {}
        : {
            // setup 的回调契约：只做组合，不驱动 agent。
            setup: async (agentCtx) => {
              await agentPresets.mount(agentCtx, preset)
            },
          }),
    })
    const agent = handle.agent

    try {
      const ws = ctx.workspaceRegistry?.list?.().find((w) => resolve(w.path) === room.cwd)
      if (ws !== undefined) await ws.attachSession(agent.id)
    } catch (error) {
      ctx.logger.warn('room: 附加会话到工作区失败', error)
    }

    // ⚠️ 落账失败时必须回收会话，否则会留下"会话已建、账本无记录"的孤儿：
    //    房间看不到它，但它会出现在侧栏并占用模型额度。
    try {
      await room.writer.run(async ({ append }) => {
        const row = normalizeRow({
          kind: 'system',
          msgId: randomUUID(),
          tag: 'member',
          nick: spec.nick,
          session: agent.id,
          digest: `${spec.nick} 加入房间`,
          route,
        })
        if (!row.ok) throw new Error(`member-row-invalid:${row.error}`)
        await append({ ...row.row, nick: spec.nick })
      })
    } catch (error) {
      ctx.logger.warn(`room: 成员 ${spec.nick} 落账失败，回收会话 ${agent.id}`, error)
      try {
        await handle.dispose?.()
      } catch (disposeError) {
        ctx.logger.warn('room: 回收孤儿会话失败', disposeError)
      }
      throw error
    }

    room.members.set(agent.id, { sessionId: agent.id, nick: spec.nick, route, agent })
    room.nicks.set(spec.nick, agent.id)
    syncSessionTitle(room, { sessionId: agent.id, nick: spec.nick })
    return { sessionId: agent.id, nick: spec.nick, route }
  }

  /**
   * 决定新成员会话该用哪个 agent preset。
   *
   * 优先级：
   *   1. 房间里已有成员用的 preset（保持同一房间内成员能力一致）
   *   2. `RoomWriter` 所在宿主记录的、本会话 agent 的 preset（跟随调用者）
   *   3. `'standard'`（DSH 默认完整工具集）
   *
   * @param {any} room
   * @returns {Promise<string | undefined>}
   */
  async function pickAgentPreset(room) {
    // 1) 同房间已有成员
    for (const member of room.members.values()) {
      try {
        const session = ctx.sessions?.get?.(member.sessionId)
        const preset = session?.header?.agentPreset
        if (typeof preset === 'string' && preset !== '') return preset
      } catch {
        // 继续
      }
    }
    // 2) / 3)
    return 'standard'
  }

  /**
   * 把一个**已有会话**拉进房间（M5）。
   *
   * 与新建成员的区别：
   *   - 复用它的历史与上下文（这正是"保留我在房间里"要的效果）
   *   - 路由优先取该会话最后一次请求头；取不到时才要求调用方显式给 provider/model
   *
   * @param {any} room
   * @param {{ sessionId: string, nick: string, provider?: string, model?: string }} spec
   */
  async function addExistingMember(room, spec) {
    const checked = validateNick(spec.nick)
    if (!checked.ok) throw new Error(checked.error)
    if (room.nicks.has(spec.nick)) throw new Error('nick-taken')
    if (typeof spec.sessionId !== 'string' || spec.sessionId === '') throw new Error('missing-sessionId')

    // 已经在这个房间里了就不重复加。
    const existing = room.members.get(spec.sessionId)
    if (existing !== undefined) {
      return { sessionId: spec.sessionId, nick: existing.nick, route: existing.route, alreadyMember: true }
    }

    const session = ctx.sessions?.get?.(spec.sessionId)
    if (session === undefined || session === null) throw new Error('unknown-session')

    // 会话必须属于同一个工作区，否则它的 cwd 与房间不一致，产物路径会对不上。
    const sessionCwd = session.header?.cwd
    if (typeof sessionCwd === 'string' && sessionCwd !== '' && resolve(sessionCwd) !== room.cwd) {
      throw new Error('session-in-other-workspace')
    }

    let route
    if (typeof spec.provider === 'string' && spec.provider !== '' &&
        typeof spec.model === 'string' && spec.model !== '') {
      route = { provider: spec.provider, model: spec.model }
    } else {
      route = await routeOfSession(spec.sessionId)
    }
    if (route?.provider === undefined || route?.model === undefined) {
      throw new Error('session-route-unknown')
    }

    await room.writer.run(async ({ append }) => {
      const row = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: 'member',
        nick: spec.nick,
        session: spec.sessionId,
        digest: `${spec.nick} 加入房间（既有会话）`,
        route,
      })
      if (row.ok) await append({ ...row.row, nick: spec.nick })
    })

    const agent = ctx.agents?.get?.(spec.sessionId) ?? null
    room.members.set(spec.sessionId, {
      sessionId: spec.sessionId,
      nick: spec.nick,
      route,
      agent,
      addedAt: Date.now(),
    })
    room.nicks.set(spec.nick, spec.sessionId)
    syncSessionTitle(room, { sessionId: spec.sessionId, nick: spec.nick })
    return { sessionId: spec.sessionId, nick: spec.nick, route, reusedSession: true }
  }

  /**
   * 删除一个房间（目录 + 索引项）。
   *
   * 只允许删**空房间**（没有任何消息）。非空房间要显式 `force` —— 账本是唯一副本，
   * 删掉就没了，所以默认拒绝。
   *
   * @param {string} cwd
   * @param {string} roomId
   * @param {{ force?: boolean }} [opts]
   */
  async function deleteRoom(cwd, roomId, opts = {}) {
    const abs = resolve(cwd)
    const id = normalizeRoomId(roomId)

    const cacheKey = `${abs}::${id}`
    const cached = rooms.get(cacheKey)
    const rowCount = cached?.rows?.length ?? 0
    if (rowCount > 0 && opts.force !== true) throw new Error('room-not-empty')

    const dir = id === DEFAULT_ROOM_ID ? join(abs, ROOM_DIR) : join(abs, ROOM_DIR, 'rooms', id)

    // 先关写入器，否则 Windows 上目录删不掉。
    if (cached !== undefined) {
      try {
        await cached.writer.close()
      } catch {
        // 忽略
      }
      rooms.delete(cacheKey)
    }

    if (id === DEFAULT_ROOM_ID) {
      // 默认房间没有独立目录：只删账本与产物，保留 base 目录本身。
      await rm(join(dir, 'ledger.jsonl'), { force: true })
      await rm(join(dir, 'artifacts'), { recursive: true, force: true })
    } else {
      await rm(dir, { recursive: true, force: true })
      const entries = await readRoomIndex(abs)
      const next = entries.filter((e) => e.id !== id)
      if (next.length !== entries.length) await writeRoomIndex(abs, next)
    }

    return { roomId: id, cwd: abs, deleted: true }
  }

  /**
   * 把成员移出房间。只写一条 `system/member-remove`，**不销毁会话**。
   * @param {any} room
   * @param {{ sessionId?: string, nick?: string }} spec
   */
  async function removeMember(room, spec) {
    let sessionId = typeof spec.sessionId === 'string' && spec.sessionId !== '' ? spec.sessionId : undefined
    if (sessionId === undefined && typeof spec.nick === 'string' && spec.nick !== '') {
      sessionId = room.nicks.get(spec.nick)
    }
    if (sessionId === undefined) throw new Error('unknown-member')

    const member = room.members.get(sessionId)
    if (member === undefined) throw new Error('unknown-member')

    await room.writer.run(async ({ append }) => {
      const row = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: 'member-remove',
        nick: member.nick,
        session: sessionId,
        digest: `${member.nick} 被移出房间`,
      })
      if (row.ok) await append({ ...row.row, nick: member.nick })
    })

    room.members.delete(sessionId)
    room.nicks.delete(member.nick)
    return { sessionId, nick: member.nick, removed: true }
  }

  // ------------------------------------------------------------ 房间枚举

  /**
   * 列出所有房间（跨工作区、含每个工作区里的多个房间）。
   *
   * 规则：只因**磁盘上已有账本**或索引里有记录才出现，不因为"看了一眼"就建目录。
   */
  async function listRooms() {
    const out = []
    const seen = new Set()
    const push = (entry) => {
      if (seen.has(entry.key)) return
      seen.add(entry.key)
      out.push(entry)
    }

    for (const room of rooms.values()) {
      // 空房间（0 条消息）不列出来，避免"看了一眼就在下拉里留下一个空房间"。
      // 例外：额外房间由用户显式创建，即使还空着也保留（否则刚建完就消失）。
      if (room.rows.length === 0 && room.roomId === DEFAULT_ROOM_ID) continue
      push({
        key: room.key,
        cwd: room.cwd,
        roomId: room.roomId,
        name: room.name,
        workspace: basename(room.cwd),
        rows: room.rows.length,
      })
    }

    for (const ws of ctx.workspaceRegistry?.list?.() ?? []) {
      const abs = resolve(ws.path)
      const base = join(abs, ROOM_DIR)
      const index = await readRoomIndex(abs)
      // 默认房间也可以被改名：名字存在索引项 id=default 里。
      const defaultEntry = index.find((e) => e.id === DEFAULT_ROOM_ID)

      // 默认房间只在账本**非空**时出现。空账本文件常常是 GET 顺手创建的，
      // 把它当成一个房间会让下拉里多出一个没有名字的空房间。
      const ledger = join(base, 'ledger.jsonl')
      if (await exists(ledger)) {
        let size = 0
        try {
          size = (await stat(ledger)).size
        } catch {
          size = 0
        }
        if (size > 0) {
          push({
            key: `${abs}::${DEFAULT_ROOM_ID}`,
            cwd: abs,
            roomId: DEFAULT_ROOM_ID,
            name: defaultEntry?.name ?? basename(abs),
            workspace: basename(abs),
            rows: null,
            title: ws.title ?? null,
          })
        }
      }

      for (const entry of index) {
        if (entry.id === DEFAULT_ROOM_ID) continue
        push({
          key: `${abs}::${entry.id}`,
          cwd: abs,
          roomId: entry.id,
          name: entry.name,
          workspace: basename(abs),
          rows: null,
        })
      }
    }

    return out
  }

  // ------------------------------------------------------------ HTTP

  function sendJson(res, status, value) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (raw.length > 256 * 1024) throw new Error('body-too-large')
    return JSON.parse(raw || '{}')
  }

  /**
   * 同工作区里、还没进这个房间的会话——「加入已有会话」下拉的数据源。
   *
   * 只列实时会话：离线/归档会话即使拉进来也要重建，且其 cwd 未必可靠；
   * M5 阶段先支持"把正在用的会话拉进房间"这一条主路径。
   *
   * @param {any} room
   */
  function candidateSessions(room) {
    const out = []
    for (const agent of ctx.agents?.list?.() ?? []) {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string') continue
      if (room.members.has(sessionId)) continue
      const session = ctx.sessions?.get?.(sessionId)
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '' && resolve(cwd) !== room.cwd) continue
      const config = session?.requestHeader?.()?.config
      out.push({
        sessionId,
        title: session?.header?.title ?? null,
        model: config?.model ?? null,
        provider: config?.provider ?? null,
        online: true,
      })
    }
    return out
  }

  function roomPayload(room, count, catalog) {
    return {
      ok: true,
      key: room.key,
      name: room.name,
      roomId: room.roomId,
      cwd: room.cwd,
      members: [...room.members.values()].map((m) => ({
        sessionId: m.sessionId,
        nick: m.nick,
        route: m.route,
        online: (m.agent ?? ctx.agents?.get?.(m.sessionId)) != null,
      })),
      // 可加入的既有会话（同工作区、尚未在房间里）。
      candidates: candidateSessions(room),
      // 不经过 writer 的空视图（房间在磁盘上还不存在时用）。
      rows: (room.writer !== undefined ? room.writer.rows : (room.rows ?? [])).slice(-count),
      // 房间是否真实存在于磁盘。前端据此区分"空房间"与"不存在的房间"。
      exists: room.exists !== false,
      isDefault: room.roomId === DEFAULT_ROOM_ID,
      // 建成员下拉框的数据源：按 provider 分组，直接来自宿主模型目录。
      modelGroups: catalog?.groups ?? [],
      modelFailures: catalog?.failures ?? [],
    }
  }

  /** 房间是否已在磁盘上存在（有账本文件）。 */
  async function roomExists(cwd, roomId) {
    const abs = resolve(cwd)
    const id = normalizeRoomId(roomId)
    const dir = id === DEFAULT_ROOM_ID ? join(abs, ROOM_DIR) : join(abs, ROOM_DIR, 'rooms', id)
    return exists(join(dir, 'ledger.jsonl'))
  }

  /** 磁盘上不存在的房间：只读空视图，**绝不落盘**。 */
  async function virtualRoom(cwd, roomId) {
    const abs = resolve(cwd)
    const id = normalizeRoomId(roomId)
    return {
      key: `${abs}::${id}`,
      roomId: id,
      cwd: abs,
      name: id === DEFAULT_ROOM_ID ? basename(abs) : await roomDisplayName(abs, id),
      dir: id === DEFAULT_ROOM_ID ? join(abs, ROOM_DIR) : join(abs, ROOM_DIR, 'rooms', id),
      writer: undefined,
      rows: [],
      members: new Map(),
      nicks: new Map(),
      exists: false,
    }
  }

  /**
   * 给成员会话打上可辨认的标题（侧栏显示 `房间名·昵称`）。
   *
   * 不做的话侧栏里所有成员都是"未命名"，人类根本分不清在跟谁对话
   * （用户实测反馈）。标题是 log-backed 的 `session/title` 事件，会持久化。
   *
   * ⚠️ **只在会话还没有标题时才命名**。用户手动改过的名字是人的决定，
   *    自动逻辑没有资格覆盖它（第一版每次投递都强行改回带前缀的名字，
   *    把用户刚改好的「D指导」「KIMI」冲掉了——真实踩过）。
   *
   * @param {any} room
   * @param {{ sessionId: string, nick: string }} member
   */
  function syncSessionTitle(room, member) {
    try {
      // 可选服务：拿不到就静默跳过（标题不是功能，缺了不影响房间可用性）。
      const service = optionalService(ctx, 'sessionTitle')
      if (service?.rename === undefined) return

      const session = ctx.sessions?.get?.(member.sessionId)
      if (session === undefined || session === null) return

      // 已有标题 → 尊重现状，一个字都不动。
      const current = service.get?.(session)
      if (typeof current?.title === 'string' && current.title.trim() !== '') return

      service.rename(session, `${room.name}·${member.nick}`)
    } catch (error) {
      // 标题只是可读性优化，绝不能因为它让投递/建成员失败。
      ctx.logger.warn(`room: 设置会话标题失败（${member.nick}）`, error)
    }
  }

  /**
   * 某个工作区下的**所有**房间，必要时从磁盘加载。
   *
   * 为什么需要它：`rooms` 只是进程内缓存。宿主重启后，直到有人通过 `/room` 打开过某个房间，
   * 它都不在内存里。此时若要判断"这个会话属于哪个房间"，只看内存就会漏掉命名房间，
   * 退回默认房间 → 把回答写到没人看的幽灵房间里（真实踩过两次）。
   *
   * 只加载**磁盘上存在账本**的房间，不会因为调用而建目录。
   *
   * @param {string} cwd
   */
  async function roomsOfCwd(cwd) {
    const abs = resolve(cwd)
    const out = []
    const seen = new Set()

    for (const room of rooms.values()) {
      if (room.cwd !== abs) continue
      out.push(room)
      seen.add(room.roomId)
    }

    let ids = []
    try {
      ids = await readRoomIndex(abs)
    } catch {
      ids = []
    }
    const all = [DEFAULT_ROOM_ID, ...ids.map((e) => e.id)]
    for (const id of all) {
      if (seen.has(id)) continue
      if (!(await roomExists(abs, id))) continue
      try {
        out.push(await roomFor(abs, id))
      } catch (error) {
        ctx.logger.warn(`room: 加载房间 ${id} 失败`, error)
      }
    }
    return out
  }

  const disposeRoute = ctx.webServer?.register?.({
    kind: 'exact',
    path: '/room',
    async handler(req, res) {
      try {
        // ---- 来源校验 ----
        // /room 能读写账本、能创建会话（真实花钱），不只是只读接口。
        // 只接受环回地址；带 Origin 的请求还必须是环回来源，挡掉网页跨站调用。
        const remote = req.socket?.remoteAddress ?? ''
        const loopbackRemote =
          remote === '' ||
          remote === '127.0.0.1' ||
          remote === '::1' ||
          remote === '::ffff:127.0.0.1'
        if (!loopbackRemote) {
          return sendJson(res, 403, { ok: false, error: 'forbidden-remote' })
        }
        const origin = req.headers?.origin
        if (typeof origin === 'string' && origin !== '') {
          let originHost = ''
          try {
            originHost = new URL(origin).hostname
          } catch {
            originHost = ''
          }
          if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '::1') {
            return sendJson(res, 403, { ok: false, error: 'forbidden-origin' })
          }
        }

        const url = new URL(req.url ?? '/room', 'http://localhost')
        const cwdParam = url.searchParams.get('cwd')

        // ---- 参数类型守卫 ----
        // 客户端/壳把查询串处理坏掉时（例如 & 被吃掉导致参数变成对象），
        // 这里宁可明确报 400，也不要让后续 resolve() 抛错变成 500。
        if (cwdParam !== null && typeof cwdParam !== 'string') {
          return sendJson(res, 400, { ok: false, error: 'invalid-cwd' })
        }
        const roomParamRaw = url.searchParams.get('room')
        if (roomParamRaw !== null && typeof roomParamRaw !== 'string') {
          return sendJson(res, 400, { ok: false, error: 'invalid-room' })
        }

        if (req.method === 'GET' && (cwdParam === null || cwdParam === '')) {
          return sendJson(res, 200, {
            ok: true,
            rooms: await listRooms(),
            workspaces: (ctx.workspaceRegistry?.list?.() ?? []).map((ws) => ({
              path: resolve(ws.path),
              name: basename(ws.path),
              title: ws.title ?? null,
            })),
            // 空态下也要能选模型，所以目录随清单一起给（不打开任何房间）。
            modelGroups: (await getModelCatalog())?.groups ?? [],
          })
        }

        if (cwdParam === null || cwdParam === '') {
          return sendJson(res, 400, { ok: false, error: 'missing-cwd' })
        }

        // 新建房间必须在 roomFor 之前处理：目标房间还不存在。
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body.action === 'create-room') {
            const created = await createRoom(String(body.cwd ?? cwdParam ?? ''), String(body.name ?? ''))
            return sendJson(res, 200, { ok: true, ...created })
          }
          // 必须 await：直接 return promise 会让 reject 绕过下面的 catch。
          return await handleRoomAction(res, url, cwdParam, body)
        }

        const roomIdParam = url.searchParams.get('room') ?? DEFAULT_ROOM_ID

        // GET 一个磁盘上还不存在的房间：返回空视图，**不建目录、不建账本**。
        // 否则"看一眼"就会在磁盘上留下幽灵房间（TODO P3）。
        if (req.method === 'GET' && !(await roomExists(cwdParam, roomIdParam))) {
          const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 50) | 0, 1), 200)
          const ghost = await virtualRoom(cwdParam, roomIdParam)
          return sendJson(res, 200, roomPayload(ghost, count, await getModelCatalog()))
        }

        const room = await roomFor(cwdParam, roomIdParam)
        if (req.method === 'GET') {
          const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 50) | 0, 1), 200)
          return sendJson(res, 200, roomPayload(room, count, await getModelCatalog()))
        }
        return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      } catch (error) {
        ctx.logger.warn('room: /room 处理失败', error)
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  /**
   * 房间内的动作（post / create-member / recover）。
   * 单独抽出来，让 handler 保持"先分流、后解析"的形状。
   */
  async function handleRoomAction(res, url, cwdParam, body) {
    const roomIdParam = url.searchParams.get('room') ?? DEFAULT_ROOM_ID

    // 往一个**不存在且非默认**的房间发消息：明确 404，而不是隐式建出空房间再报 unknown-member。
    // 默认房间保持"首次写入即创建"的旧语义（空房间广播仍报 no-members，信息量更大）。
    if (
      body.action === 'post' &&
      normalizeRoomId(roomIdParam) !== DEFAULT_ROOM_ID &&
      !(await roomExists(cwdParam, roomIdParam))
    ) {
      return sendJson(res, 404, { ok: false, error: 'room-not-found' })
    }

    const room = await roomFor(cwdParam, roomIdParam)

    if (body.action === 'post') {
          const text = String(body.text ?? '')
          if (text.trim() === '') return sendJson(res, 400, { ok: false, error: 'empty-text' })
          if (text.length > TEXT_CAP) return sendJson(res, 400, { ok: false, error: 'text-too-long' })

          // P1：解析并冻结 targets，绝不留给恢复时重新解析。
          const target = body.target
          const nicks = [...room.nicks.keys()]
          let targets = []
          if (target?.mode === 'member' && typeof target.sessionId === 'string') {
            if (!room.members.has(target.sessionId)) {
              return sendJson(res, 400, { ok: false, error: 'unknown-member' })
            }
            targets = [target.sessionId]
          } else if (target?.mode === 'all') {
            // @所有人：发给当前全部成员。空房间明确报错，而不是静默成功。
            targets = [...room.members.keys()]
            if (targets.length === 0) return sendJson(res, 400, { ok: false, error: 'no-members' })
          } else if (target?.mode === 'mentioned') {
            const mentioned = parseMentions(text, nicks)
            // 正文写 @所有人 等价于广播。
            if (mentioned.some((n) => n === '所有人' || n === 'all')) {
              targets = [...room.members.keys()]
            } else {
              if (mentioned.length === 0) return sendJson(res, 400, { ok: false, error: 'no-mention' })
              targets = mentioned.map((n) => room.nicks.get(n)).filter((id) => typeof id === 'string')
            }
            if (targets.length === 0) return sendJson(res, 400, { ok: false, error: 'no-resolved-target' })
          } else {
            return sendJson(res, 400, { ok: false, error: 'missing-target' })
          }

          const mentions = parseMentions(text, nicks)
          const msgId = randomUUID()

          // P2：落账（先有完整意图，再投递）。
          const written = await room.writer.run(async ({ append }) => {
            const normalized = normalizeRow({
              kind: 'ask',
              msgId,
              from: '用户',
              text,
              digest: clip(text, DIGEST_CAP),
              targets,
              mentions,
              depth: 0,
            })
            if (!normalized.ok) return { ok: false, error: normalized.error }
            const seq = await append(normalized.row)
            // ⚠️ 必须把 seq 补回行对象：append 只返回序号，不会改写入参。
            //    漏了这一步，投递时 pointerMessage 拿到 seq=undefined，就会写出
            //    "seq 0"，下游 room_read({seq:0}) 直接失败（真实踩过）。
            return { ok: true, seq, row: { ...normalized.row, seq } }
          })
          if (!written.ok) return sendJson(res, 400, written)

          // P4：逐目标投递。
          const result = await deliver(room, written.row)
          return sendJson(res, 200, { ok: true, seq: written.seq, ...result })
        }

        if (body.action === 'create-member') {
          const created = await createMember(room, {
            nick: String(body.nick ?? ''),
            provider: String(body.provider ?? ''),
            model: String(body.model ?? ''),
            reasoningEffort:
              body.reasoningEffort === undefined ? undefined : String(body.reasoningEffort),
          })
          return sendJson(res, 200, { ok: true, ...created })
        }

        if (body.action === 'add-member') {
          const added = await addExistingMember(room, {
            sessionId: String(body.sessionId ?? ''),
            nick: String(body.nick ?? ''),
            ...(body.provider === undefined ? {} : { provider: String(body.provider) }),
            ...(body.model === undefined ? {} : { model: String(body.model) }),
          })
          return sendJson(res, 200, { ok: true, ...added })
        }

        if (body.action === 'remove-member') {
          const removed = await removeMember(room, {
            ...(body.sessionId === undefined ? {} : { sessionId: String(body.sessionId) }),
            ...(body.nick === undefined ? {} : { nick: String(body.nick) }),
          })
          return sendJson(res, 200, { ok: true, ...removed })
        }

        if (body.action === 'rename-room') {
          const renamed = await renameRoom(room.cwd, room.roomId, String(body.name ?? ''))
          return sendJson(res, 200, { ok: true, ...renamed })
        }

        if (body.action === 'delete-room') {
          // 删除当前房间（空房间直接删；非空需 force）。
          const deleted = await deleteRoom(room.cwd, room.roomId, {
            force: body.force === true,
          })
          return sendJson(res, 200, { ok: true, ...deleted })
        }

        if (body.action === 'recover') {
          // 恢复扫描：只补未投递的 ask，绝不重新解析 targets。
          const results = []
          for (const ask of foldLedger(room.writer.rows).asks.values()) {
            results.push({ seq: ask.seq, ...(await deliver(room, ask)) })
          }
          return sendJson(res, 200, { ok: true, results })
        }

    return sendJson(res, 400, { ok: false, error: 'unknown-action' })
  }

  // ------------------------------------------------------------ SSE 推送

  /** 心跳间隔：中间层（代理/Electron）常在 30~60s 断开空闲连接。 */
  const SSE_HEARTBEAT_MS = 25_000

  /**
   * `GET /room/events?cwd=&room=` —— 账本变化推送（SSE）。
   *
   * 只推**序号**，不推正文：客户端收到 seq 后自己按现有接口拉增量。
   * 这样推送体积恒定（一条事件几十字节），也避免两套数据格式漂移。
   *
   * 断线由客户端负责重连（EventSource 自带），服务端只保证：
   *   - 连接建立时先推一条 `hello`（客户端据此知道通道已通）
   *   - 每次账本落盘后推 `change`
   *   - 客户端断开即清理订阅（不留悬挂的 listener）
   */
  const disposeEvents = ctx.webServer?.register?.({
    kind: 'exact',
    path: '/room/events',
    handler(req, res) {
      // SSE 也必须做来源校验：它会持续占着连接。
      const remote = req.socket?.remoteAddress ?? ''
      const loopback =
        remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden-remote' }))
        return
      }

      const url = new URL(req.url ?? '/room/events', 'http://localhost')
      const cwd = url.searchParams.get('cwd')
      const roomId = url.searchParams.get('room') ?? DEFAULT_ROOM_ID
      if (typeof cwd !== 'string' || cwd === '') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing-cwd' }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 明确告诉中间层不要缓冲（nginx/Electron 代理都认这个头）
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()

      const send = (event, data) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          // 写失败说明连接已断，close 回调会负责清理
        }
      }

      // 先自报家门：客户端收到 hello 就知道通道可用，可以关掉轮询降级。
      send('hello', { roomId, seq: 0 })

      let unsubscribe = null
      let closed = false

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        try {
          unsubscribe?.()
        } catch {
          // 忽略
        }
      }

      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          res.write(': ping\n\n')
        } catch {
          cleanup()
        }
      }, SSE_HEARTBEAT_MS)
      // 心跳不应阻止进程退出
      heartbeat.unref?.()

      // 房间可能还没加载过：异步取，拿到后订阅。
      void (async () => {
        try {
          const room = await roomFor(cwd, roomId)
          if (closed) return
          send('ready', { roomId: room.roomId, seq: room.writer.nextSeq - 1 })
          unsubscribe = room.writer.watch((row) => {
            if (closed) return
            send('change', { seq: row.seq, kind: row.kind })
          })
        } catch (error) {
          send('error', { error: String(error?.message ?? error) })
          cleanup()
          try {
            res.end()
          } catch {
            // 忽略
          }
        }
      })()

      res.on('close', cleanup)
      res.on('error', cleanup)
    },
  })

  // ------------------------------------------------------------ 清理

  ctx.effect(() => () => {
    try {
      disposeRoute?.()
    } catch (error) {
      ctx.logger.warn('room: 路由清理失败', error)
    }
    try {
      disposeEvents?.()
    } catch (error) {
      ctx.logger.warn('room: SSE 路由清理失败', error)
    }
    for (const room of rooms.values()) {
      void room.writer.close().catch(() => {})
    }
    rooms.clear()
  })

  // ------------------------------------------------------------ 启动恢复

  // 恢复扫描延后执行，避免把仍在排队中的投递误判为丢失（§4.5.3）。
  void (async () => {
    try {
      await new Promise((resolve_) => setTimeout(resolve_, 1500))
      for (const room of rooms.values()) {
        for (const ask of foldLedger(room.rows).asks.values()) {
          await deliver(room, ask)
        }
      }
    } catch (error) {
      ctx.logger.warn('room: 启动恢复扫描失败', error)
    }
  })()
}
