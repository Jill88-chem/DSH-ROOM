// 任务状态机（阶段 A · 第 3 层）
//
// 职责：claim / renew / complete / fail / cancel 的**原子状态转换**。
//
// 设计要点（来自与 Codex 的协议评审）：
//   1. 每个操作 = 一次账本写入（单条事件），不写第二个文件
//   2. `complete` 写的 `answer` 行**同时就是完成凭据**
//   3. 所有状态判定与写入在**同一个 RoomWriter 临界区**内完成，
//      否则两个并发 claim 会领到同一任务
//   4. 时间一律由宿主判断（`Date.now()`），不信客户端
//   5. 过期批次的提交必须被拒（leaseId + attempt 双重校验）

import { randomUUID } from 'node:crypto'

import {
  TASK_STATE,
  CONTROL_TAG,
  VISIBILITY_INTERNAL,
  makeTaskId,
  pickClaimable,
  activeLeaseOf,
  requestHash,
  replay,
} from './protocol.js'
import { normalizeRow } from './ledger.js'
import { loadProtocolState, withRoomWrite } from './room-protocol.js'

/** 默认租约时长（秒）。设计文档 §4.3。 */
export const DEFAULT_LEASE_SECONDS = 300

/** 允许请求的租约范围（秒）。 */
export const MIN_LEASE_SECONDS = 60
export const MAX_LEASE_SECONDS = 600

/** 默认单轮执行上限（秒）。租约可以续，但一轮不能无限延长。 */
export const DEFAULT_ATTEMPT_DEADLINE_SECONDS = 1800

/** 失败后重排队的基础延迟。设计文档 §4.2：第 1/2 次失败分别延迟 5s/30s。 */
export const RETRY_DELAYS_MS = [5_000, 30_000]

/** 统一的失败结果形状。 */
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

/** 记录一条内部写账本失败，返回统一错误。 */
function writeFailed(error) {
  return fail('write-failed', `账本写入失败：${String(error?.message ?? error)}`, {
    retryable: true,
  })
}

/**
 * 把一次幂等请求的结果记到行上。
 *
 * 幂等键作用域为 `(roomUid, memberId, action, idempotencyKey)`（设计文档 §5.2）。
 *
 * @param {string} roomUid
 * @param {string} memberId
 * @param {string} action
 * @param {string} key
 * @param {object} body - 参与 requestHash 的语义请求体
 * @param {object} receipt - 成功回执
 */
function idempotencyMeta(roomUid, memberId, action, key, body, receipt) {
  return {
    scope: `${roomUid}|${memberId}|${action}`,
    key,
    hash: requestHash(body),
    receipt,
  }
}

/**
 * 在房间内查找某幂等键的既有回执。
 *
 * 表键是 `scope|key`（见 protocol.js 的 replay），直接查表即可——
 * 遍历会随账本增长变成 O(n)，而幂等检查在每次请求上都要做。
 *
 * @param {object} room
 * @param {string} scope
 * @param {string} key
 * @param {string} hash
 * @returns {{kind: 'replay', receipt: object} | {kind: 'conflict'} | {kind: 'miss'}}
 */
function lookupIdempotency(room, scope, key, hash) {
  const entry = room.protocol.idempotency.get(`${scope}|${key}`)
  if (entry === undefined) return { kind: 'miss' }
  if (entry.hash === hash) return { kind: 'replay', receipt: entry.receipt }
  return { kind: 'conflict' }
}

/** 确保协议状态已加载且是最新的。 */
function ensureState(room) {
  if (room.protocol === undefined) loadProtocolState(room)
  const lastSeq = room.writer.rows.length === 0 ? 0 : room.writer.rows[room.writer.rows.length - 1].seq
  if (room.protocol.replayedTo !== lastSeq) loadProtocolState(room)
  return room.protocol
}

function taskWrite(room, operation, spec) {
  return withRoomWrite(room, async locked => {
    const member = spec?.memberId ? locked.protocol.members.get(spec.memberId) : null
    if (member && member.status !== 'active') return fail('unauthorized', '凭据已撤销')
    if (member && member.kind !== 'external') return fail('forbidden', '只有外部成员可以执行任务')
    return operation(locked, spec)
  }).catch(writeFailed)
}

export const claimTask = (room, spec) => taskWrite(room, claimTaskLocked, spec)
export const renewTask = (room, spec) => taskWrite(room, renewTaskLocked, spec)
export const completeTask = (room, spec) => taskWrite(room, completeTaskLocked, spec)
export const failTask = (room, spec) => taskWrite(room, failTaskLocked, spec)
export const cancelTask = (room, spec) => taskWrite(room, cancelTaskLocked, spec)
export const expireLeases = (room, now = Date.now()) => withRoomWrite(room, locked => expireLeasesLocked(locked, now))

// ---------------------------------------------------------------- claim

/**
 * 原子领取一个任务。
 *
 * 同一成员在 MVP 只允许持有一个有效租约（设计文档 §4.3）。
 *
 * @param {object} room
 * @param {{
 *   memberId: string,
 *   idempotencyKey?: string,
 *   workerId?: string,
 *   leaseSeconds?: number,
 * }} spec
 * @returns {Promise<object>}
 */
async function claimTaskLocked(room, spec) {
  const state = ensureState(room)
  const member = state.members.get(spec.memberId)
  if (member === undefined || member.kind !== 'external') {
    return fail('forbidden', '只有外部成员可以领取任务')
  }
  if (member.status !== 'active') return fail('unauthorized', '凭据已撤销')

  const now = Date.now()
  const leaseSeconds = clampLease(spec.leaseSeconds)

  // 幂等重放：同 key 返回原领取凭据（设计文档 §5.6）
  const scope = `${state.roomUid}|${spec.memberId}|claim`
  const key = typeof spec.idempotencyKey === 'string' ? spec.idempotencyKey : ''
  if (key !== '') {
    const lookup = lookupIdempotency(room, scope, key, requestHash({ leaseSeconds, workerId: spec.workerId ?? null }))
    if (lookup.kind === 'conflict') return fail('idempotency-conflict', '同一幂等键对应不同请求')
    if (lookup.kind === 'replay') {
      // 重放不续租、不换任务，但反映当前真实状态
      const task = state.tasks.get(lookup.receipt.taskId)
      const leaseValid = task?.state === TASK_STATE.RUNNING && task.leaseId === lookup.receipt.leaseId
        && task.attempt === lookup.receipt.attempt && task.leaseExpiresAt > now && task.attemptDeadlineAt > now
      return {
        ok: true,
        duplicate: true,
        serverNow: now,
        leaseValid,
        currentState: task?.state ?? TASK_STATE.CANCELLED,
        task: task === undefined ? null : { ...publicTaskView(task), text: task.text, ...lookup.receipt },
      }
    }
  }

  // Expiration is part of claiming, so abandoned leases are recoverable without a separate scheduler.
  await expireLeasesLocked(room, now)

  // 已有有效租约 -> member-busy（不算错误，桥接器隔一会儿再问）
  const held = activeLeaseOf(state.tasks, spec.memberId, now)
  if (held !== null) {
    return { ok: true, task: null, reason: 'member-busy', nextPollMs: 2000, serverNow: now }
  }

  // ⚠️ 选任务 + 判次数 + 写 claim 必须在**同一个临界区**内完成。
  //
  // 分开写的话：两个并发 claim 都读到 state=queued，都通过检查，都写一条
  // task-claimed —— 同一任务被两个执行器领走，且账本里有两份领取凭据。
  // （实测踩过：并发 claim 两次都返回了同一 taskId，账本出现 2 条 task-claimed。）

  /** @type {{kind: 'busy'|'empty'} | {kind: 'ok', taskId: string, leaseId: string, attempt: number, leaseExpiresAt: number, attemptDeadlineAt: number}} */
  let outcome = { kind: 'empty' }

  try {
    await room.writer.run(async ({ append, rows }) => {
      // 临界区内重新折叠：用的是最新 rows，而不是进临界区前的快照
      const fresh = replay(rows)
      const heldNow = activeLeaseOf(fresh.tasks, spec.memberId, Date.now())
      if (heldNow !== null) {
        outcome = { kind: 'busy' }
        return
      }

      const pickedNow = pickClaimable(fresh.tasks, spec.memberId, Date.now())
      if (pickedNow === null) {
        outcome = { kind: 'empty' }
        return
      }

      const attemptNow = pickedNow.attempt + 1
      if (attemptNow > pickedNow.maxAttempts) {
        // 次数耗尽：写一条 failed，本次不领取
        const exhausted = normalizeRow({
          kind: 'system',
          msgId: randomUUID(),
          tag: CONTROL_TAG.TASK_FAILED,
          visibility: VISIBILITY_INTERNAL,
          digest: `任务 ${pickedNow.taskId.slice(0, 8)} 执行次数耗尽`,
          taskId: pickedNow.taskId,
          memberId: spec.memberId,
          state: TASK_STATE.FAILED,
          code: 'attempts-exhausted',
          attempt: pickedNow.attempt,
        })
        if (exhausted.ok) await append(exhausted.row)
        outcome = { kind: 'empty' }
        return
      }

      const nextLeaseId = randomUUID()
      const nowInLock = Date.now()
      const timeout = Number.isSafeInteger(pickedNow.runTimeoutSeconds) && pickedNow.runTimeoutSeconds > 0
        ? Math.min(pickedNow.runTimeoutSeconds, DEFAULT_ATTEMPT_DEADLINE_SECONDS) : DEFAULT_ATTEMPT_DEADLINE_SECONDS
      const nextDeadline = nowInLock + timeout * 1000
      const nextLeaseExpiresAt = Math.min(nowInLock + leaseSeconds * 1000, nextDeadline)

      const normalized = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: CONTROL_TAG.TASK_CLAIMED,
        visibility: VISIBILITY_INTERNAL,
        digest: `${member.nick ?? spec.memberId} 领取任务 ${pickedNow.taskId.slice(0, 8)}`,
        taskId: pickedNow.taskId,
        memberId: spec.memberId,
        attempt: attemptNow,
        leaseId: nextLeaseId,
        leaseExpiresAt: nextLeaseExpiresAt,
        attemptDeadlineAt: nextDeadline,
        ...(spec.workerId === undefined ? {} : { workerId: String(spec.workerId) }),
        ...(key === ''
          ? {}
          : {
              idempotency: idempotencyMeta(
                fresh.roomUid ?? state.roomUid,
                spec.memberId,
                'claim',
                key,
                { leaseSeconds, workerId: spec.workerId ?? null },
                {
                  taskId: pickedNow.taskId,
                  leaseId: nextLeaseId,
                  attempt: attemptNow,
                  leaseExpiresAt: nextLeaseExpiresAt,
                  attemptDeadlineAt: nextDeadline,
                  renewAfterMs: Math.max(10_000, Math.floor(leaseSeconds * 1000 * 0.5)),
                },
              ),
            }),
      })
      if (!normalized.ok) throw new Error(`claim-invalid:${normalized.error}`)
      await append(normalized.row)

      outcome = {
        kind: 'ok',
        taskId: pickedNow.taskId,
        leaseId: nextLeaseId,
        attempt: attemptNow,
        leaseExpiresAt: nextLeaseExpiresAt,
        attemptDeadlineAt: nextDeadline,
      }
    })
  } catch (error) {
    return writeFailed(error)
  }

  if (outcome.kind === 'busy') {
    return { ok: true, task: null, reason: 'member-busy', nextPollMs: 2000, serverNow: now }
  }
  if (outcome.kind === 'empty') {
    ensureState(room)
    return { ok: true, task: null, reason: 'empty', nextPollMs: 2000, serverNow: now }
  }

  ensureState(room)
  const task = room.protocol.tasks.get(outcome.taskId)

  return {
    ok: true,
    duplicate: false,
    serverNow: now,
    leaseValid: true,
    currentState: TASK_STATE.RUNNING,
    task: {
      ...publicTaskView(task),
      text: task.text,
      leaseId: outcome.leaseId,
      attempt: outcome.attempt,
      leaseExpiresAt: outcome.leaseExpiresAt,
      attemptDeadlineAt: outcome.attemptDeadlineAt,
      renewAfterMs: Math.max(10_000, Math.floor(leaseSeconds * 1000 * 0.5)),
    },
  }
}

// ---------------------------------------------------------------- renew

/**
 * 续租。
 *
 * 只能延长到 `attemptDeadlineAt` 封顶——防止一轮任务靠续租无限续命。
 *
 * @param {object} room
 * @param {{ memberId: string, taskId: string, leaseId: string, attempt: number, idempotencyKey?: string, leaseSeconds?: number }} spec
 * @returns {Promise<object>}
 */
async function renewTaskLocked(room, spec) {
  const state = ensureState(room)
  const task = state.tasks.get(spec.taskId)
  if (task === undefined) return fail('not-found', '任务不存在或不属于你')
  if (task.memberId !== spec.memberId) return fail('not-found', '任务不存在或不属于你')

  const now = Date.now()

  // 已完成的幂等重放：返回原回执（设计文档 §5.2）
  const scope = `${state.roomUid}|${spec.memberId}|renew`
  const key = typeof spec.idempotencyKey === 'string' ? spec.idempotencyKey : ''
  const leaseSeconds = clampLease(spec.leaseSeconds)
  const bodyForHash = { taskId: spec.taskId, leaseId: spec.leaseId, attempt: spec.attempt, leaseSeconds }
  if (key !== '') {
    const lookup = lookupIdempotency(room, scope, key, requestHash(bodyForHash))
    if (lookup.kind === 'conflict') return fail('idempotency-conflict', '同一幂等键对应不同请求')
    if (lookup.kind === 'replay') {
      return { ok: true, duplicate: true, serverNow: now, ...lookup.receipt }
    }
  }

  if (task.state !== TASK_STATE.RUNNING) {
    return fail('task-not-running', `任务当前状态为 ${task.state}`)
  }
  if (task.leaseId !== spec.leaseId || task.attempt !== spec.attempt) {
    return fail('lease-lost', '该执行批次已失去租约')
  }
  if (task.leaseExpiresAt <= now || task.attemptDeadlineAt <= now) {
    return fail('lease-lost', '租约已过期')
  }

  const cap =
    typeof task.attemptDeadlineAt === 'number' ? task.attemptDeadlineAt : now + DEFAULT_ATTEMPT_DEADLINE_SECONDS * 1000
  const nextExpiry = Math.min(now + leaseSeconds * 1000, cap)

  /** @type {object | null} */
  let receipt = null
  try {
    await room.writer.run(async ({ append }) => {
      const normalized = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: CONTROL_TAG.TASK_RENEWED,
        visibility: VISIBILITY_INTERNAL,
        digest: `续租 ${task.taskId.slice(0, 8)}`,
        taskId: task.taskId,
        memberId: spec.memberId,
        attempt: spec.attempt,
        leaseId: spec.leaseId,
        leaseExpiresAt: nextExpiry,
        attemptDeadlineAt: cap,
        ...(key === ''
          ? {}
          : {
              idempotency: idempotencyMeta(state.roomUid, spec.memberId, 'renew', key, bodyForHash, {
                leaseId: spec.leaseId,
                attempt: spec.attempt,
                leaseExpiresAt: nextExpiry,
                attemptDeadlineAt: cap,
              }),
            }),
      })
      if (!normalized.ok) throw new Error(`renew-invalid:${normalized.error}`)
      await append(normalized.row)
      receipt = { leaseId: spec.leaseId, attempt: spec.attempt, leaseExpiresAt: nextExpiry, attemptDeadlineAt: cap }
    })
  } catch (error) {
    return writeFailed(error)
  }

  ensureState(room)
  return { ok: true, duplicate: false, serverNow: now, ...receipt }
}

// ---------------------------------------------------------------- complete

/**
 * 提交结果。
 *
 * **`answer` 行本身就是完成凭据**——不另写 complete 事件，
 * 这样"写 answer"和"标记完成"是同一个原子动作，没有中间态。
 *
 * @param {object} room
 * @param {{
 *   memberId: string,
 *   taskId: string,
 *   leaseId: string,
 *   attempt: number,
 *   digest: string,
 *   text: string,
 *   idempotencyKey?: string,
 * }} spec
 * @returns {Promise<object>}
 */
async function completeTaskLocked(room, spec) {
  const state = ensureState(room)
  const task = state.tasks.get(spec.taskId)
  if (task === undefined || task.memberId !== spec.memberId) {
    return fail('not-found', '任务不存在或不属于你')
  }

  const member = state.members.get(spec.memberId)
  const now = Date.now()

  const scope = `${state.roomUid}|${spec.memberId}|complete`
  const key = typeof spec.idempotencyKey === 'string' ? spec.idempotencyKey : ''
  const bodyForHash = {
    taskId: spec.taskId,
    leaseId: spec.leaseId,
    attempt: spec.attempt,
    digest: spec.digest,
    text: spec.text,
  }
  if (key !== '') {
    const lookup = lookupIdempotency(room, scope, key, requestHash(bodyForHash))
    if (lookup.kind === 'conflict') return fail('idempotency-conflict', '同一幂等键对应不同内容')
    if (lookup.kind === 'replay') {
      return { ok: true, duplicate: true, serverNow: now, ...lookup.receipt }
    }
  }

  // 已完成：新 key 再提交 -> 明确冲突，不能覆盖既有答案
  if (task.state === TASK_STATE.COMPLETED) {
    return fail('task-already-completed', '任务已完成，不能重复提交', { answerSeq: task.answerSeq })
  }
  if (task.state === TASK_STATE.CANCELLED || task.state === TASK_STATE.FAILED) {
    return fail(`task-${task.state}`, `任务当前状态为 ${task.state}`)
  }
  if (task.state !== TASK_STATE.RUNNING) {
    return fail('task-not-running', `任务当前状态为 ${task.state}`)
  }
  if (task.leaseId !== spec.leaseId || task.attempt !== spec.attempt) {
    return fail('lease-lost', '该执行批次已失去租约，结果不予采纳')
  }
  if (task.leaseExpiresAt <= now || task.attemptDeadlineAt <= now) {
    return fail('lease-lost', '租约已过期，结果不予采纳')
  }

  if (typeof spec.text !== 'string' || spec.text.trim() === '') {
    return fail('invalid-request', 'text 必填且去除首尾空白后非空')
  }
  if (Buffer.byteLength(spec.text, 'utf8') > 1024 * 1024) {
    return fail('invalid-request', 'text 超过 1 MiB 上限')
  }
  if (typeof spec.digest !== 'string' || spec.digest.trim() === '') {
    return fail('invalid-request', 'digest 必填')
  }
  if ([...spec.digest].length > 200) return fail('invalid-request', 'digest 超过 200 字符')
  if (/[\r\n]/.test(spec.digest)) return fail('invalid-request', 'digest 必须单行')

  const answerMsgId = randomUUID()
  /** @type {{seq: number, msgId: string} | null} */
  let written = null

  try {
    await room.writer.run(async ({ append }) => {
      const normalized = normalizeRow({
        kind: 'answer',
        msgId: answerMsgId,
        from: member?.nick ?? spec.memberId,
        memberId: spec.memberId,
        taskId: spec.taskId,
        leaseId: spec.leaseId,
        attempt: spec.attempt,
        digest: spec.digest.trim(),
        text: spec.text,
        replyToMsgId: task.askMsgId,
        rootAskMsgId: task.rootAskMsgId,
        parentAskMsgId: task.parentAskMsgId,
        depth: task.depth,
        ...(key === ''
          ? {}
          : {
              idempotency: idempotencyMeta(state.roomUid, spec.memberId, 'complete', key, bodyForHash, {
                taskId: spec.taskId,
                state: TASK_STATE.COMPLETED,
                msgId: answerMsgId,
              }),
            }),
      })
      if (!normalized.ok) throw new Error(`complete-invalid:${normalized.error}`)
      const seq = await append(normalized.row)
      written = { seq, msgId: answerMsgId }
    })
  } catch (error) {
    return writeFailed(error)
  }

  ensureState(room)
  return {
    ok: true,
    duplicate: false,
    taskId: spec.taskId,
    state: TASK_STATE.COMPLETED,
    seq: written.seq,
    msgId: written.msgId,
    serverNow: now,
  }
}

// ---------------------------------------------------------------- fail

/**
 * 上报执行失败。
 *
 * 三态分流（设计文档 §4.2）：
 *   - 可重试且未达上限 → queued（设置 nextEligibleAt）
 *   - 确定性失败或次数耗尽 → failed
 *   - 结果不确定（如进程被强杀）→ needs_review
 *
 * @param {object} room
 * @param {{
 *   memberId: string,
 *   taskId: string,
 *   leaseId: string,
 *   attempt: number,
 *   code: string,
 *   text?: string,
 *   retryable?: boolean,
 *   idempotencyKey?: string,
 * }} spec
 * @returns {Promise<object>}
 */
async function failTaskLocked(room, spec) {
  const state = ensureState(room)
  const task = state.tasks.get(spec.taskId)
  if (task === undefined || task.memberId !== spec.memberId) {
    return fail('not-found', '任务不存在或不属于你')
  }

  const now = Date.now()
  const member = state.members.get(spec.memberId)

  const scope = `${state.roomUid}|${spec.memberId}|fail`
  const key = typeof spec.idempotencyKey === 'string' ? spec.idempotencyKey : ''
  const bodyForHash = {
    taskId: spec.taskId,
    leaseId: spec.leaseId,
    attempt: spec.attempt,
    code: spec.code,
    retryable: spec.retryable === true,
    text: spec.text ?? '',
  }
  if (key !== '') {
    const lookup = lookupIdempotency(room, scope, key, requestHash(bodyForHash))
    if (lookup.kind === 'conflict') return fail('idempotency-conflict', '同一幂等键对应不同请求')
    if (lookup.kind === 'replay') return { ok: true, duplicate: true, serverNow: now, ...lookup.receipt }
  }

  if (task.state === TASK_STATE.COMPLETED) {
    return fail('task-already-completed', '任务已完成，不能再报失败')
  }
  if (task.state === TASK_STATE.CANCELLED || task.state === TASK_STATE.FAILED)
    return fail(`task-${task.state}`, `任务当前状态为 ${task.state}`)
  if (task.state !== TASK_STATE.RUNNING) {
    return fail('task-not-running', `任务当前状态为 ${task.state}`)
  }
  if (task.leaseId !== spec.leaseId || task.attempt !== spec.attempt) {
    return fail('lease-lost', '该执行批次已失去租约')
  }
  if (task.leaseExpiresAt <= now || task.attemptDeadlineAt <= now)
    return fail('lease-lost', '租约或本轮执行期限已过期')

  // 决定去向
  const retryable = spec.retryable === true
  const canRetry = retryable && task.attempt < task.maxAttempts
  const isUncertain = ['process-killed', 'result-uncertain'].includes(spec.code)
    || task.executionMode !== 'read-only' && spec.code === 'execution-interrupted'

  let nextState
  let nextEligibleAt = null
  if (isUncertain) {
    nextState = TASK_STATE.NEEDS_REVIEW
  } else if (canRetry) {
    nextState = TASK_STATE.QUEUED
    const delay = RETRY_DELAYS_MS[Math.min(task.attempt - 1, RETRY_DELAYS_MS.length - 1)]
    nextEligibleAt = now + delay
  } else {
    nextState = TASK_STATE.FAILED
  }

  /** @type {object | null} */
  let receipt = null
  try {
    await room.writer.run(async ({ append }) => {
      const normalized = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: CONTROL_TAG.TASK_FAILED,
        visibility: VISIBILITY_INTERNAL,
        digest: `${member?.nick ?? spec.memberId} 执行失败：${String(spec.code ?? 'unknown').slice(0, 60)}`,
        taskId: spec.taskId,
        memberId: spec.memberId,
        attempt: spec.attempt,
        leaseId: spec.leaseId,
        code: String(spec.code ?? 'unknown').slice(0, 80),
        state: nextState,
        ...(nextEligibleAt === null ? {} : { nextEligibleAt }),
        ...(key === ''
          ? {}
          : {
              idempotency: idempotencyMeta(state.roomUid, spec.memberId, 'fail', key, bodyForHash, {
                taskId: spec.taskId,
                state: nextState,
                ...(nextEligibleAt === null ? {} : { nextEligibleAt }),
              }),
            }),
      })
      if (!normalized.ok) throw new Error(`fail-invalid:${normalized.error}`)
      await append(normalized.row)
      receipt = { taskId: spec.taskId, state: nextState, ...(nextEligibleAt === null ? {} : { nextEligibleAt }) }
    })
  } catch (error) {
    return writeFailed(error)
  }

  ensureState(room)
  return { ok: true, duplicate: false, serverNow: now, ...receipt }
}

// ---------------------------------------------------------------- cancel

/**
 * 取消任务（宿主管理入口，不是外部成员权限）。
 *
 * @param {object} room
 * @param {{ taskId: string, reason?: string, idempotencyKey?: string }} spec
 * @returns {Promise<object>}
 */
async function cancelTaskLocked(room, spec) {
  const state = ensureState(room)
  const task = state.tasks.get(spec.taskId)
  if (task === undefined) return fail('not-found', '任务不存在')

  if (task.state === TASK_STATE.CANCELLED) {
    return { ok: true, duplicate: true, taskId: task.taskId, state: TASK_STATE.CANCELLED }
  }
  if (task.state === TASK_STATE.COMPLETED) {
    return fail('task-already-completed', '任务已完成，不能取消')
  }

  const now = Date.now()
  try {
    await room.writer.run(async ({ append }) => {
      const normalized = normalizeRow({
        kind: 'system',
        msgId: randomUUID(),
        tag: CONTROL_TAG.TASK_CANCELLED,
        visibility: VISIBILITY_INTERNAL,
        digest: `任务 ${task.taskId.slice(0, 8)} 已取消`,
        taskId: task.taskId,
        memberId: task.memberId,
        ...(task.leaseId === null ? {} : { leaseId: task.leaseId }),
        ...(typeof spec.reason === 'string' ? { code: spec.reason.slice(0, 80) } : {}),
      })
      if (!normalized.ok) throw new Error(`cancel-invalid:${normalized.error}`)
      await append(normalized.row)
    })
  } catch (error) {
    return writeFailed(error)
  }

  ensureState(room)
  return { ok: true, duplicate: false, taskId: task.taskId, state: TASK_STATE.CANCELLED, serverNow: now }
}

// ---------------------------------------------------------------- expire

/**
 * 扫描并把到期租约转回队列。
 *
 * 由宿主定时调用（或在 claim 前惰性调用）。**不删除结果**，只是让任务可被重领。
 *
 * @param {object} room
 * @param {number} [now]
 * @returns {Promise<{expired: number}>}
 */
async function expireLeasesLocked(room, now = Date.now()) {
  const state = ensureState(room)
  const stale = []
  for (const task of state.tasks.values()) {
    if (task.state !== TASK_STATE.RUNNING) continue
    if (typeof task.leaseExpiresAt !== 'number') continue
    if (task.leaseExpiresAt > now && task.attemptDeadlineAt > now) continue
    stale.push(task)
  }
  if (stale.length === 0) return { expired: 0 }

  for (const task of stale) {
    const canRetry = task.executionMode === 'read-only' && task.attempt < task.maxAttempts
    const nextState = task.executionMode !== 'read-only' ? TASK_STATE.NEEDS_REVIEW
      : canRetry ? TASK_STATE.QUEUED : TASK_STATE.FAILED
    try {
      await room.writer.run(async ({ append }) => {
        const normalized = normalizeRow({
          kind: 'system',
          msgId: randomUUID(),
          tag: CONTROL_TAG.TASK_EXPIRED,
          visibility: VISIBILITY_INTERNAL,
          digest: `任务 ${task.taskId.slice(0, 8)} 租约到期`,
          taskId: task.taskId,
          memberId: task.memberId,
          attempt: task.attempt,
          requeue: canRetry,
          state: nextState,
          ...(canRetry ? { nextEligibleAt: now + RETRY_DELAYS_MS[Math.min(task.attempt - 1, RETRY_DELAYS_MS.length - 1)] } : {}),
        })
        if (!normalized.ok) throw new Error(`expire-invalid:${normalized.error}`)
        await append(normalized.row)
      })
    } catch (error) {
      room.protocolLogger?.warn?.('room: 回收过期租约失败', error)
    }
  }

  ensureState(room)
  return { expired: stale.length }
}

// ---------------------------------------------------------------- 查询

/**
 * 任务对外视图（不含内部私有字段）。
 *
 * @param {object} task
 * @returns {object}
 */
export function publicTaskView(task) {
  if (task === null || task === undefined) return null
  return {
    taskId: task.taskId,
    askSeq: task.askSeq,
    askMsgId: task.askMsgId,
    memberId: task.memberId,
    state: task.state,
    from: task.from,
    digest: task.text === '' ? '' : task.text.slice(0, 200),
    rootAskMsgId: task.rootAskMsgId,
    parentAskMsgId: task.parentAskMsgId,
    depth: task.depth,
    executionMode: task.executionMode,
    attempt: task.attempt,
    leaseId: task.leaseId,
    leaseExpiresAt: task.leaseExpiresAt,
    attemptDeadlineAt: task.attemptDeadlineAt,
    nextEligibleAt: task.nextEligibleAt,
    answerSeq: task.answerSeq,
  }
}

/**
 * 查任务状态（供桥接器恢复时对账）。
 *
 * @param {object} room
 * @param {{ memberId: string, taskId: string }} spec
 * @returns {Promise<object>}
 */
export async function getTask(room, spec) {
  const state = ensureState(room)
  const task = state.tasks.get(spec.taskId)
  if (task === undefined || task.memberId !== spec.memberId) {
    return fail('not-found', '任务不存在或不属于你')
  }
  return { ok: true, serverNow: Date.now(), task: publicTaskView(task) }
}

/** 把请求的租约秒数夹到合法区间。 */
export function clampLease(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n)) return DEFAULT_LEASE_SECONDS
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, Math.round(n)))
}

/**
 * 创建任务：把 ask 的接收者展开成 queued 任务。
 *
 * **注意**：任务本身不落账——它是从 `ask.targetMemberIds` 重放出来的。
 * 这里只返回将要生成的 taskId 列表，供调用方回执。
 *
 * @param {object} room
 * @param {{ askSeq: number, askMsgId: string, targetMemberIds: string[] }} ask
 * @returns {string[]}
 */
export function tasksOfAsk(room, ask) {
  const state = ensureState(room)
  return ask.targetMemberIds
    .map((memberId) => makeTaskId(state.roomUid ?? '', ask.askMsgId, memberId))
    .filter((taskId) => state.tasks.has(taskId))
}
