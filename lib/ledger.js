/**
 * dsh-room — 账本（ledger）。
 *
 * 设计文档 §4.2 / §4.5：
 *   - append-only JSONL，一行一条事件，`seq` 严格递增
 *   - 每个房间**只有一个串行写入器**：seq 分配、追加、去重检查都在同一个临界区
 *   - 启动时丢弃末尾半行，从最后一条完整行续写
 *   - 本模块不依赖 cordis，便于用 node --test 直接测
 *
 * 人类输入是**权威副本**（`kind:'ask'` 的 `text` 存全文，不截断）；
 * AI 回答只存摘要 + `sourceSeq` 指针，全文留在会话日志里。
 */

import { open as openFile, readFile, mkdir, access, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 账本事件类型。 */
export const KINDS = /** @type {const} */ (['ask', 'answer', 'note', 'system'])

/** 单条消息正文上限（人类输入）。超出拒绝，不静默截断。 */
export const TEXT_CAP = 200_000

/** 摘要上限。 */
export const DIGEST_CAP = 200

/**
 * 单房间串行写入器。
 *
 * 所有写操作排队执行；`run()` 返回的 Promise 在**写入并 fsync 完成**后才 resolve，
 * 因此调用方 await 它可以拿到真正的持久性确认（设计文档 §4.5.3）。
 */
export class RoomWriter {
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve()
  /** @type {import('node:fs/promises').FileHandle | null} */
  #handle = null
  /** @type {number} 下一条事件的 seq。 */
  #nextSeq = 1
  /** @type {string} */
  #path
  /** @type {Set<(row: object) => void>} 追加成功后的订阅者（SSE 推送用）。 */
  #watchers = new Set()

  /**
   * @param {string} ledgerPath - ledger.jsonl 的绝对路径
   */
  constructor(ledgerPath) {
    this.#path = ledgerPath
  }

  /**
   * 订阅账本追加。
   *
   * 只在**落盘成功之后**通知——推送出去的内容必须是已经持久的，
   * 否则客户端会先看到一条"可能不存在"的消息。
   *
   * @param {(row: object) => void} fn
   * @returns {() => void} 取消订阅
   */
  watch(fn) {
    this.#watchers.add(fn)
    return () => {
      this.#watchers.delete(fn)
    }
  }

  /** 当前可用的下一个 seq（只读快照，可能被并发的 run 推进）。 */
  get nextSeq() {
    return this.#nextSeq
  }

  /**
   * 打开账本：建目录、读已有内容、修复末尾半行、定位续写偏移。
   *
   * 修复策略：**不使用 ftruncate**——受限环境（如 DSH 的 workspace-write 沙箱）会拒绝
   * `ftruncate`（EPERM）。改为"读好前缀 → 写临时文件 → rename 覆盖"，这是原子的，
   * 且只依赖普通写与 rename。
   *
   * 半行**必须真正从文件里消失**，不能只补一个换行：否则损坏行会永久留在账本里，
   * 每次启动都要跳过它。
   *
   * @returns {Promise<{ rows: object[], truncatedBytes: number }>}
   */
  async open() {
    await mkdir(dirname(this.#path), { recursive: true })

    let raw = ''
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error
      raw = ''
    }

    const { rows, goodLength } = parseLedger(raw)
    this.#nextSeq = rows.length === 0 ? 1 : (rows[rows.length - 1].seq ?? 0) + 1
    this.#rows = rows

    const goodText = raw.slice(0, goodLength)
    const truncatedBytes = Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(goodText, 'utf8')

    if (truncatedBytes > 0) {
      await this.#repair(goodText)
    }

    this.#handle = await openFile(this.#path, 'a+')
    return { rows, truncatedBytes }
  }

  /**
   * 原子重写账本为"仅含完整行"的内容。
   * @param {string} goodText
   */
  async #repair(goodText) {
    const temp = `${this.#path}.repair-${process.pid}`
    await writeFile(temp, goodText, 'utf8')
    await rename(temp, this.#path)
  }

  /** 关闭句柄。 */
  async close() {
    const handle = this.#handle
    this.#handle = null
    if (handle !== null) await handle.close()
  }

  /**
   * 在临界区内执行一次写入。
   *
   * `fn` 收到当前 rows 的只读视图与 `append`，返回 Promise。
   * 这样"先检查再写"（去重）也在同一临界区，不会两个并发写都通过检查。
   *
   * @template T
   * @param {(ctx: { rows: object[], append: (row: object) => Promise<number> }) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const next = this.#tail.then(async () => {
      const rows = this.rows
      const append = async (row) => {
        const seq = this.#nextSeq
        this.#nextSeq += 1
        const line = JSON.stringify({ ...row, seq }) + '\n'
        const handle = this.#handle
        if (handle === null) throw new Error('ledger not open')
        await handle.write(line)
        // 持久性屏障：设计文档 §4.5.3 要求"返回即已落盘"。
        await handle.datasync()
        const stored = { ...row, seq }
        this.#rows.push(stored)
        // 落盘之后才通知订阅者（SSE）。订阅者异常不能影响写入结果。
        for (const watcher of this.#watchers) {
          try {
            watcher(stored)
          } catch {
            // 推送失败与账本无关，忽略
          }
        }
        return seq
      }
      return fn({ rows, append })
    })
    // 单点失败不阻断后继写入。
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** @type {object[]} */
  #rows = []

  /** 已加载的行（内存视图，随 append 增长）。 */
  get rows() {
    return this.#rows
  }

  /**
   * 由 `open()` 填入初始行。内部使用。
   * @param {object[]} rows
   */
  setRows(rows) {
    this.#rows = rows
  }
}

/**
 * 解析 JSONL：返回所有完整行，并给出"最后一个完整行"的字节长度。
 * 末尾没有换行符的半行会被丢弃。
 *
 * @param {string} raw
 * @returns {{ rows: object[], goodLength: number }}
 */
export function parseLedger(raw) {
  const rows = []
  let cursor = 0
  let goodLength = 0
  while (cursor < raw.length) {
    const nl = raw.indexOf('\n', cursor)
    if (nl === -1) break // 末尾半行：丢弃
    const line = raw.slice(cursor, nl)
    cursor = nl + 1
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      // 损坏行：跳过，但不推进 goodLength（由启动扫描告警）
      continue
    }
    if (typeof row?.seq !== 'number') continue
    rows.push(row)
    goodLength = cursor
  }
  return { rows, goodLength }
}

/**
 * 校验并规范化一条待写入的账本行。
 * 返回 `{ ok: true, row }` 或 `{ ok: false, error }`。
 *
 * @param {object} input
 * @returns {{ ok: true, row: object } | { ok: false, error: string }}
 */
export function normalizeRow(input) {
  const kind = input?.kind
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown-kind:${String(kind)}` }

  const msgId = input.msgId
  if (typeof msgId !== 'string' || msgId === '') return { ok: false, error: 'missing-msgId' }

  const digest = typeof input.digest === 'string' ? input.digest : ''
  if (digest.includes('\n') || digest.includes('\r')) return { ok: false, error: 'digest-multiline' }
  if (digest.length > DIGEST_CAP) return { ok: false, error: 'digest-too-long' }

  /** @type {object} */
  const row = {
    at: typeof input.at === 'number' ? input.at : Date.now(),
    kind,
    msgId,
    from: typeof input.from === 'string' ? input.from : '',
    digest,
  }

  // 人类原文：只有 ask 必须带，且不截断。
  if (kind === 'ask') {
    const text = input.text
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'missing-text' }
    if (text.length > TEXT_CAP) return { ok: false, error: 'text-too-long' }
    row.text = text
  }

  if (Array.isArray(input.targets)) {
    const targets = input.targets.filter((t) => typeof t === 'string' && t !== '')
    if (targets.length === 0) return { ok: false, error: 'empty-targets' }
    row.targets = targets
  }

  if (Array.isArray(input.mentions)) {
    row.mentions = input.mentions.filter((m) => typeof m === 'string' && m !== '')
  }

  if (typeof input.session === 'string' && input.session !== '') row.session = input.session
  if (typeof input.turn === 'number') row.turn = input.turn
  if (typeof input.sourceSeq === 'number') row.sourceSeq = input.sourceSeq
  if (typeof input.artifact === 'string' && input.artifact !== '') row.artifact = input.artifact
  if (typeof input.artifactState === 'string') row.artifactState = input.artifactState
  if (input.route !== undefined && input.route !== null) row.route = input.route
  if (input.partial === true) row.partial = true
  if (typeof input.tag === 'string') row.tag = input.tag
  if (typeof input.parentMessageId === 'string') row.parentMessageId = input.parentMessageId
  if (typeof input.rootRequestId === 'string') row.rootRequestId = input.rootRequestId
  if (typeof input.depth === 'number') row.depth = input.depth

  // ---- 协议 v2 字段（阶段 A）----
  //
  // 这些字段只由宿主内部写入，不来自模型工具调用，所以逐个显式搬运而不做通用透传
  // ——账本是安全边界，不能让任意字段流进去。
  //
  // ⚠️ 白名单漏字段的后果是**静默丢数据**：账本行写进去了，但重放时读不到，
  //    表现为"protocol-enabled 写了但 roomUid 永远是 null"（实测踩过）。
  if (typeof input.visibility === 'string') row.visibility = input.visibility
  if (typeof input.roomUid === 'string') row.roomUid = input.roomUid
  if (typeof input.memberId === 'string') row.memberId = input.memberId
  if (typeof input.taskId === 'string') row.taskId = input.taskId
  if (typeof input.nick === 'string') row.nick = input.nick
  if (typeof input.displayName === 'string') row.displayName = input.displayName
  if (typeof input.registrationId === 'string') row.registrationId = input.registrationId
  if (typeof input.tokenHash === 'string') row.tokenHash = input.tokenHash
  if (typeof input.enrollmentTokenHash === 'string') row.enrollmentTokenHash = input.enrollmentTokenHash
  if (typeof input.leaseId === 'string') row.leaseId = input.leaseId
  if (typeof input.attempt === 'number') row.attempt = input.attempt
  if (typeof input.leaseExpiresAt === 'number') row.leaseExpiresAt = input.leaseExpiresAt
  if (typeof input.attemptDeadlineAt === 'number') row.attemptDeadlineAt = input.attemptDeadlineAt
  if (typeof input.nextEligibleAt === 'number') row.nextEligibleAt = input.nextEligibleAt
  if (typeof input.state === 'string') row.state = input.state
  if (typeof input.code === 'string') row.code = input.code
  if (typeof input.requeue === 'boolean') row.requeue = input.requeue
  if (typeof input.status === 'string') row.status = input.status
  if (typeof input.actorType === 'string') row.actorType = input.actorType
  if (typeof input.deliveryVersion === 'number') row.deliveryVersion = input.deliveryVersion
  if (typeof input.parentAskMsgId === 'string') row.parentAskMsgId = input.parentAskMsgId
  if (typeof input.rootAskMsgId === 'string') row.rootAskMsgId = input.rootAskMsgId
  if (typeof input.replyToMsgId === 'string') row.replyToMsgId = input.replyToMsgId
  if (Array.isArray(input.targetMemberIds)) {
    row.targetMemberIds = input.targetMemberIds.filter((t) => typeof t === 'string' && t !== '')
  }
  if (input.taskPolicy !== null && typeof input.taskPolicy === 'object') {
    row.taskPolicy = {
      executionMode:
        input.taskPolicy.executionMode === 'workspace-write' ? 'workspace-write' : 'read-only',
      maxAttempts: typeof input.taskPolicy.maxAttempts === 'number' ? input.taskPolicy.maxAttempts : 3,
      runTimeoutSeconds:
        typeof input.taskPolicy.runTimeoutSeconds === 'number'
          ? input.taskPolicy.runTimeoutSeconds
          : 1800,
    }
  }
  if (input.memberMap !== null && typeof input.memberMap === 'object' && !Array.isArray(input.memberMap)) {
    /** @type {Record<string, string>} */
    const map = {}
    for (const [key, value] of Object.entries(input.memberMap)) {
      if (typeof value === 'string') map[key] = value
    }
    row.memberMap = map
  }
  if (typeof input.storageVersion === 'number') row.storageVersion = input.storageVersion
  if (typeof input.protocolVersion === 'number') row.protocolVersion = input.protocolVersion
  if (typeof input.activationSeq === 'number') row.activationSeq = input.activationSeq
  if (input.idempotency !== null && typeof input.idempotency === 'object') {
    const meta = input.idempotency
    if (typeof meta.key === 'string') {
      row.idempotency = {
        key: meta.key,
        ...(typeof meta.hash === 'string' ? { hash: meta.hash } : {}),
        ...(meta.receipt === undefined ? {} : { receipt: meta.receipt }),
      }
    }
  }

  return { ok: true, row }
}

/**
 * 从账本行重建房间视图。
 * 纯函数，不触碰磁盘——恢复路径必须能独立测试。
 *
 * @param {object[]} rows
 * @returns {{
 *   asks: Map<string, object>,
 *   answers: Map<string, object>,
 *   deliveredMsgIds: Set<string>,
 * }}
 */
export function foldLedger(rows) {
  // 账本是 append-only，所以「同一个数组 + 同样的长度」必然得到同样的折叠结果。
  // recover / backfill 会反复调用它，加一层记忆化把 O(n) 摊薄成"只在新增行时重建"。
  const memo = foldMemo.get(rows)
  if (memo !== undefined && memo.length === rows.length) return memo.value

  /** @type {Map<string, object>} */
  const asks = new Map()
  /** @type {Map<string, object>} */
  const answers = new Map()
  /** @type {Set<string>} */
  const deliveredMsgIds = new Set()

  for (const row of rows) {
    if (row.kind === 'ask' && row.msgId && !asks.has(row.msgId)) {
      asks.set(row.msgId, row)
      for (const target of row.targets ?? []) deliveredMsgIds.add(row.msgId)
    }
    if (row.kind === 'answer' && typeof row.session === 'string' && typeof row.turn === 'number') {
      answers.set(`${row.session}#${row.turn}`, row)
    }
  }

  const value = { asks, answers, deliveredMsgIds }
  foldMemo.set(rows, { length: rows.length, value })
  return value
}

/** rows 数组 → 最近一次折叠结果。用 WeakMap 避免持有数组导致账本无法回收。 */
const foldMemo = new WeakMap()

/**
 * 计算某个 `(msgId, target)` 的去重键。
 * @param {string} msgId
 * @param {string} targetSessionId
 */
export function deliveryKey(msgId, targetSessionId) {
  return `${msgId}@${targetSessionId}`
}

/**
 * 检查路径是否存在（产物 pending → ready 的判定用）。
 * @param {string} path
 */
export async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 房间目录下的产物目录。
 * @param {string} roomDir
 */
export function artifactsDir(roomDir) {
  return join(roomDir, 'artifacts')
}
