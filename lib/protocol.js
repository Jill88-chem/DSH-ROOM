// 房间协议基础层（阶段 A · 第 1 层）
//
// 职责：
//   1. 稳定 ID：roomUid / memberId / taskId 的生成规则
//   2. 协议事件构造：task-claimed / task-renewed / task-completed ... 的规范化
//   3. 重放：从账本行重建「成员表 + 任务表 + 幂等表」
//
// ⚠️ 本模块**不碰 IO、不碰 ctx**，全部是纯函数，这样可以直接单测。
//    写账本、读 ctx 的事留给 index.js。

import { createHash } from 'node:crypto'
import { KINDS } from './ledger.js'

/** 协议版本。健康检查与账本 `system/protocol-enabled` 都记这个值。 */
export const PROTOCOL_VERSION = 2

/** 存储版本（账本布局版本，与协议版本分开演进）。 */
export const STORAGE_VERSION = 2

/** 控制事件的可见性标记：不进入 room_read / 摘要 / SSE 公共通知。 */
export const VISIBILITY_INTERNAL = 'internal'

/** 任务状态。与设计文档 §4.2 的状态机一一对应。 */
export const TASK_STATE = /** @type {const} */ ({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  NEEDS_REVIEW: 'needs_review',
})

/** 控制事件的 tag 集合。 */
export const CONTROL_TAG = /** @type {const} */ ({
  PROTOCOL_ENABLED: 'protocol-enabled',
  MEMBER_EXTERNAL: 'member-external',
  MEMBER_RENAMED: 'member-renamed',
  ENROLLMENT_ISSUED: 'enrollment-issued',
  TASK_CLAIMED: 'task-claimed',
  TASK_RENEWED: 'task-renewed',
  TASK_FAILED: 'task-failed',
  TASK_EXPIRED: 'task-expired',
  TASK_CANCELLED: 'task-cancelled',
})

/** 所有控制事件 tag（供读取视图过滤）。 */
export const CONTROL_TAGS = new Set(Object.values(CONTROL_TAG))

/** 是否为控制事件（内部可见，不当作人类消息展示）。 */
export function isControlRow(row) {
  return (
    row !== null &&
    typeof row === 'object' &&
    row.kind === 'system' &&
    typeof row.tag === 'string' &&
    CONTROL_TAGS.has(row.tag) &&
    row.visibility === VISIBILITY_INTERNAL
  )
}

/**
 * 判断一行是否应当出现在「公开读取视图」里。
 *
 * 公开视图 = room_read / 摘要 / SSE 通知使用的行集合。
 * 控制事件、以及带私有元数据的行（凭据摘要等）都必须被过滤掉。
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isPublicRow(row) {
  if (row === null || typeof row !== 'object') return false
  if (!KINDS.includes(row.kind)) return false
  if (row.visibility === VISIBILITY_INTERNAL || isControlRow(row)) return false
  return true
}

/**
 * 剔除行里的私有字段，返回可安全外发的副本。
 *
 * 私有字段以 `_` 开头，或命中 PRIVATE_FIELDS 列表。
 * 这是**唯一的序列化出口**：任何 HTTP / SSE 响应都应经过它。
 *
 * @param {object} row
 * @returns {object}
 */
export const PRIVATE_FIELDS = new Set([
  'tokenHash',
  'enrollmentHash',
  'enrollmentTokenHash',
  'registrationHash',
  'registrationId',
  'requestHash',
  'idempotencyKey',
  'leaseId',
  // 幂等回执里含 requestHash 与接收方内部信息，属于服务端状态，外发会泄露协议细节
  'idempotency',
  'private',
])

export function toPublicRow(row) {
  if (row === null || typeof row !== 'object') return row
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_')) continue
    if (PRIVATE_FIELDS.has(key)) continue
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------- ID 生成

/** 稳定小写十六进制摘要。 */
function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * 计算 taskId。
 *
 * 设计文档 §2.1：taskId 由 (roomUid, askMsgId, memberId) 三元组确定，
 * 取规范化 JSON 的 SHA-256，加前缀 `t-`。
 *
 * **为什么是确定性 ID**：同一个 (ask, member) 无论重放多少次都必须得到同一个
 * taskId，否则重放会造出重复任务。
 *
 * @param {string} roomUid
 * @param {string} askMsgId
 * @param {string} memberId
 * @returns {string}
 */
export function makeTaskId(roomUid, askMsgId, memberId) {
  const canonical = JSON.stringify([roomUid, askMsgId, memberId])
  return `t-${sha256Hex(canonical).slice(0, 32)}`
}

/**
 * 计算成员的稳定 ID。
 *
 * 内部成员（DSH 会话）与外部成员共用一套：都由 roomUid + sessionId|nick 派生。
 * **内部成员用 sessionId 派生而不是直接用 sessionId**，这样两套 id 空间可以混合放进
 * `targetMemberIds`，同时不破坏旧账本的 `targets`（仍是 sessionId）。
 *
 * @param {string} roomUid
 * @param {'internal'|'external'} kind
 * @param {string} seed - internal: sessionId; external: 注册时生成的随机值
 * @returns {string}
 */
export function makeMemberId(roomUid, kind, seed) {
  const canonical = JSON.stringify([roomUid, kind, seed])
  return `m-${sha256Hex(canonical).slice(0, 32)}`
}

/**
 * 计算请求摘要（幂等用）。
 *
 * 设计文档 §5.2：递归排序对象键、保持数组顺序、UTF-8 编码后 SHA-256；
 * 排除 idempotencyKey 本身，排除服务端生成的时间与 seq。
 *
 * @param {object} body
 * @returns {string}
 */
export function requestHash(body) {
  return sha256Hex(JSON.stringify(canonicalize(body)))
}

/** 递归排序对象键；数组保持原序。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------- 重放

/**
 * 重放账本，重建协议状态。
 *
 * 输入是账本行数组（已按 seq 升序）。输出：
 *   - roomUid：从 `protocol-enabled` 事件取；没有则该房间未启用协议
 *   - members：memberId → 成员视图
 *   - tasks：taskId → 任务视图
 *   - idempotency：幂等键 → 回执
 *   - issues：重放过程中发现的问题（缺成员、未知 task 等）
 *
 * **不做 IO，不校验文件完整性**——文件级修复由 RoomWriter 负责。
 *
 * @param {object[]} rows
 * @returns {{
 *   roomUid: string | null,
 *   members: Map<string, object>,
 *   tasks: Map<string, object>,
 *   idempotency: Map<string, object>,
 *   sessionToMember: Map<string, string>,
 *   issues: string[],
 * }}
 */
export function replay(rows) {
  /** @type {string | null} */
  let roomUid = null
  /** @type {Map<string, object>} */
  const members = new Map()
  /** @type {Map<string, object>} */
  const tasks = new Map()
  /** @type {Map<string, object>} */
  const idempotency = new Map()
  /** @type {Map<string, string>} */
  const sessionToMember = new Map()
  /** @type {string[]} */
  const issues = []
  const enrollments = new Map()

  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue

    // --- 协议启用：分配 roomUid + 既有内部成员映射 ---
    if (row.kind === 'system' && row.tag === CONTROL_TAG.PROTOCOL_ENABLED) {
      roomUid = typeof row.roomUid === 'string' ? row.roomUid : null
      const mapping = row.memberMap
      if (mapping !== null && typeof mapping === 'object') {
        for (const [sessionId, memberId] of Object.entries(mapping)) {
          if (typeof memberId !== 'string') continue
          sessionToMember.set(sessionId, memberId)
          const previous = [...members.values()].find(member => member.kind === 'internal' && member.sessionId === sessionId)
          if (previous) members.delete(previous.memberId)
          members.set(memberId, {
            ...previous,
            memberId,
            kind: 'internal',
            sessionId,
            nick: previous?.nick ?? null,
            displayName: previous?.displayName ?? null,
            status: previous?.status ?? 'active',
          })
        }
      }
      continue
    }

    // --- 成员：内部（旧格式 system/member）---
    if (row.kind === 'system' && row.tag === 'member' && typeof row.session === 'string') {
      const memberId = sessionToMember.get(row.session) ?? makeMemberId(roomUid ?? '', 'internal', row.session)
      sessionToMember.set(row.session, memberId)
      const existing = members.get(memberId)
      members.set(memberId, {
        memberId,
        kind: 'internal',
        sessionId: row.session,
        nick: typeof row.nick === 'string' ? row.nick : existing?.nick ?? null,
        displayName: typeof row.nick === 'string' ? row.nick : existing?.displayName ?? null,
        route: row.route ?? existing?.route ?? null,
        status: 'active',
      })
      continue
    }

    if (row.kind === 'system' && row.tag === CONTROL_TAG.ENROLLMENT_ISSUED) {
      enrollments.set(row.enrollmentTokenHash, { expiresAt: row.expiresAt, consumedBy: null })
      continue
    }

    // --- 成员：外部 ---
    if (row.kind === 'system' && row.tag === CONTROL_TAG.MEMBER_EXTERNAL) {
      if (typeof row.memberId !== 'string') {
        issues.push(`seq ${row.seq}: member-external 缺 memberId`)
        continue
      }
      members.set(row.memberId, {
        memberId: row.memberId,
        kind: 'external',
        nick: typeof row.nick === 'string' ? row.nick : null,
        displayName: typeof row.displayName === 'string' ? row.displayName : row.nick ?? null,
        route: row.route ?? null,
        status: 'active',
        registeredAt: typeof row.at === 'number' ? row.at : null,
        // 注册幂等的关键：响应丢失后客户端用同一 registrationId 重发，
        // 必须能找回原成员。只凭昵称不能恢复身份（设计文档 §5.4）。
        registrationId: typeof row.registrationId === 'string' ? row.registrationId : null,
        // 凭据摘要保存在账本里，但不进公开视图（toPublicRow 会剔除）
        tokenHash: row.tokenHash,
        registrationHash: row.registrationHash,
        enrollmentTokenHash: row.enrollmentTokenHash,
      })
      const enrollment = enrollments.get(row.enrollmentTokenHash)
      if (enrollment) enrollment.consumedBy = row.memberId
      continue
    }

    // --- 成员移除（内部旧格式）---
    if (row.kind === 'system' && row.tag === 'member-remove' && typeof row.session === 'string') {
      const memberId = sessionToMember.get(row.session)
      if (memberId !== undefined) {
        const member = members.get(memberId)
        if (member !== undefined) member.status = 'removed'
      }
      continue
    }

    // --- 改名 / 凭据状态变更 ---
    if (row.kind === 'system' && row.tag === CONTROL_TAG.MEMBER_RENAMED) {
      const member = members.get(row.memberId)
      if (member === undefined) {
        issues.push(`seq ${row.seq}: member-renamed 指向未知成员 ${row.memberId}`)
        continue
      }
      if (typeof row.nick === 'string') member.nick = row.nick
      if (typeof row.displayName === 'string') member.displayName = row.displayName
      // 撤销凭据：保留 memberId 与昵称，只改状态（不能靠抢昵称恢复身份）
      if (row.status === 'revoked') member.status = 'revoked'
      continue
    }

    // --- ask：为每个外部接收者派生 queued 任务 ---
    if (row.kind === 'ask') {
      const targets = Array.isArray(row.targetMemberIds) ? row.targetMemberIds : []
      for (const memberId of targets) {
        const member = members.get(memberId)
        // MVP：只有外部成员进入 claim 队列（设计文档 §2.3）
        if (member === undefined || member.kind !== 'external') continue
        const taskId = makeTaskId(roomUid ?? '', row.msgId, memberId)
        tasks.set(taskId, {
          taskId,
          roomUid,
          askSeq: row.seq,
          askMsgId: row.msgId,
          memberId,
          state: TASK_STATE.QUEUED,
          text: typeof row.text === 'string' ? row.text : '',
          from: typeof row.from === 'string' ? row.from : '',
          executionMode: row.taskPolicy?.executionMode ?? 'read-only',
          maxAttempts: row.taskPolicy?.maxAttempts ?? 3,
          runTimeoutSeconds: row.taskPolicy?.runTimeoutSeconds ?? 1800,
          attempt: 0,
          leaseId: null,
          leaseExpiresAt: null,
          attemptDeadlineAt: null,
          rootAskMsgId: row.rootAskMsgId ?? row.msgId,
          parentAskMsgId: row.parentAskMsgId ?? null,
          depth: typeof row.depth === 'number' ? row.depth : 0,
          nextEligibleAt: null,
          answerSeq: null,
          lastError: null,
        })
      }
      continue
    }

    // --- 任务控制事件 ---
    if (row.kind === 'system' && typeof row.taskId === 'string' && CONTROL_TAGS.has(row.tag)) {
      const task = tasks.get(row.taskId)
      if (task === undefined) {
        // 控制事件先于 ask 出现属于账本损坏；记录但不中断（重放要尽量可恢复）
        issues.push(`seq ${row.seq}: ${row.tag} 指向未知任务 ${row.taskId}`)
        continue
      }
      applyTaskEvent(task, row, issues)
      continue
    }

    // --- answer：同时充当任务完成凭据 ---
    if (row.kind === 'answer' && typeof row.taskId === 'string') {
      const task = tasks.get(row.taskId)
      if (task === undefined) {
        issues.push(`seq ${row.seq}: answer 指向未知任务 ${row.taskId}`)
        continue
      }
      task.state = TASK_STATE.COMPLETED
      task.answerSeq = row.seq
      task.leaseId = null
      task.leaseExpiresAt = null
    }
  }

  // 幂等表从账本行的 idempotency 元数据重建。
  //
  // ⚠️ 键是 `scope|key` 而不是裸 `key`：幂等键的作用域是
  //    (roomUid, memberId, action, idempotencyKey)，两个成员的 claim 可能用同一个
  //    key 字符串（桥接器各自生成随机 key，撞了也不该互相干扰）。
  //    只用 key 会互相覆盖，表现为"我明明没提交过，却拿到别人的回执"。
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const meta = row.idempotency
    if (meta === null || typeof meta !== 'object') continue
    if (typeof meta.key !== 'string') continue
    const scope = typeof meta.scope === 'string' ? meta.scope : ''
    // 回执里的 seq 在写入前无法得知（append 才返回序号），所以这里用**本行自己的 seq**
    // 补齐。不补的话幂等重放返回的回执缺 seq，调用方无法定位到那条 answer
    // （实测：complete 重放返回 duplicate:true 但没有 seq）。
    const receipt =
      meta.receipt !== null && typeof meta.receipt === 'object'
        ? { ...meta.receipt, seq: typeof meta.receipt.seq === 'number' ? meta.receipt.seq : row.seq }
        : meta.receipt
    idempotency.set(`${scope}|${meta.key}`, {
      scope,
      key: meta.key,
      hash: meta.hash,
      receipt,
    })
  }

  return { roomUid, members, tasks, idempotency, sessionToMember, enrollments, issues }
}

/**
 * 把一条任务控制事件应用到任务视图。
 *
 * @param {object} task
 * @param {object} row
 * @param {string[]} issues
 */
function applyTaskEvent(task, row, issues) {
  switch (row.tag) {
    case CONTROL_TAG.TASK_CLAIMED:
      task.state = TASK_STATE.RUNNING
      task.attempt = typeof row.attempt === 'number' ? row.attempt : task.attempt + 1
      task.leaseId = typeof row.leaseId === 'string' ? row.leaseId : null
      task.leaseExpiresAt = typeof row.leaseExpiresAt === 'number' ? row.leaseExpiresAt : null
      task.attemptDeadlineAt =
        typeof row.attemptDeadlineAt === 'number' ? row.attemptDeadlineAt : task.attemptDeadlineAt
      break

    case CONTROL_TAG.TASK_RENEWED:
      if (task.leaseId !== row.leaseId) {
        issues.push(`seq ${row.seq}: task-renewed 的 leaseId 与当前不一致`)
        break
      }
      if (typeof row.leaseExpiresAt === 'number') task.leaseExpiresAt = row.leaseExpiresAt
      // 单轮上限也可能在续租时被重申（宿主会夹到 min(now+租期, 原上限)），
      // 不更新的话后续续租会拿旧上限去夹，表现为"越续越短"。
      if (typeof row.attemptDeadlineAt === 'number') task.attemptDeadlineAt = row.attemptDeadlineAt
      break

    case CONTROL_TAG.TASK_FAILED: {
      // 三态分流：调用方在事件里写明去向（queued / failed / needs_review），
      // 重放必须尊重它——只认 NEEDS_REVIEW 会把"可重试"误判成终结性失败，
      // 表现为 fail 返回 queued 但重放后变成 failed（实测踩过）。
      const declared = row.state
      task.state =
        declared === TASK_STATE.QUEUED || declared === TASK_STATE.NEEDS_REVIEW
          ? declared
          : TASK_STATE.FAILED
      task.leaseId = null
      task.leaseExpiresAt = null
      if (typeof row.nextEligibleAt === 'number') task.nextEligibleAt = row.nextEligibleAt
      if (typeof row.code === 'string') task.lastError = row.code
      break
    }

    case CONTROL_TAG.TASK_EXPIRED:
      // 到期后按策略回到 queued（可重试）或 failed（次数耗尽）
      task.state = row.state === TASK_STATE.NEEDS_REVIEW ? TASK_STATE.NEEDS_REVIEW
        : row.requeue === false ? TASK_STATE.FAILED : TASK_STATE.QUEUED
      task.leaseId = null
      task.leaseExpiresAt = null
      if (typeof row.nextEligibleAt === 'number') task.nextEligibleAt = row.nextEligibleAt
      break

    case CONTROL_TAG.TASK_CANCELLED:
      task.state = TASK_STATE.CANCELLED
      task.leaseId = null
      task.leaseExpiresAt = null
      break

    default:
      break
  }
}

/**
 * 从重放结果里挑出某成员当前可领取的任务。
 *
 * 排序规则（设计文档 §5.6）：askSeq 升序；跳过未到 nextEligibleAt 的。
 *
 * @param {Map<string, object>} tasks
 * @param {string} memberId
 * @param {number} now
 * @returns {object | null}
 */
export function pickClaimable(tasks, memberId, now) {
  /** @type {object | null} */
  let best = null
  for (const task of tasks.values()) {
    if (task.memberId !== memberId) continue
    if (task.state !== TASK_STATE.QUEUED) continue
    if (typeof task.nextEligibleAt === 'number' && task.nextEligibleAt > now) continue
    if (best === null || task.askSeq < best.askSeq) best = task
  }
  return best
}

/**
 * 该成员是否已持有有效租约（MVP：每成员最多一个）。
 *
 * @param {Map<string, object>} tasks
 * @param {string} memberId
 * @param {number} now
 * @returns {object | null}
 */
export function activeLeaseOf(tasks, memberId, now) {
  for (const task of tasks.values()) {
    if (task.memberId !== memberId) continue
    if (task.state !== TASK_STATE.RUNNING) continue
    if (typeof task.leaseExpiresAt !== 'number') continue
    if (task.leaseExpiresAt > now) return task
  }
  return null
}
