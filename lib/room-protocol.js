// 房间协议状态（阶段 A · 第 1 层：宿主侧接线）
//
// protocol.js 是纯逻辑，本模块负责：
//   1. 首次启用协议：写 `system/protocol-enabled` 并分配 roomUid
//   2. 从账本重放协议状态，挂到 room 对象上
//   3. 提供「只读快照」给 HTTP 层用
//
// ⚠️ 本模块**不做 HTTP、不注册工具**，只管理 room.protocol 这一个字段。

import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  STORAGE_VERSION,
  VISIBILITY_INTERNAL,
  CONTROL_TAG,
  replay,
  makeMemberId,
  requestHash,
} from './protocol.js'
import {
  generateToken,
  hashToken,
  tokenMatches,
  validateExternalNick,
} from './auth.js'
import { normalizeRow } from './ledger.js'
import { validateNick } from './decide.js'

/** room.protocol 的初始形状。 */
function emptyProtocol() {
  return {
    enabled: false,
    roomUid: null,
    members: new Map(),
    tasks: new Map(),
    idempotency: new Map(),
    sessionToMember: new Map(),
    issues: [],
    /** 协议状态最后重放到哪个 seq。 */
    replayedTo: 0,
  }
}

/** Run checks, idempotency lookup and append under the same ledger lock. */
export function withRoomWrite(room, operation) {
  return room.writer.run(async transaction => {
    const scoped = { ...room, protocol: undefined, writer: {
      get rows() { return transaction.rows },
      run: operation => operation(transaction),
    } }
    loadProtocolState(scoped)
    try { return await operation(scoped) }
    finally { loadProtocolState(room) }
  })
}

/**
 * 从账本重建协议状态，并挂到 `room.protocol`。
 *
 * **幂等**：重复调用只做重放，不写账本。启用动作由 `ensureProtocolEnabled` 负责。
 *
 * @param {object} room
 * @returns {object} room.protocol
 */
export function loadProtocolState(room) {
  const state = replay(room.writer.rows)

  room.protocol = {
    enabled: state.roomUid !== null,
    roomUid: state.roomUid,
    members: state.members,
    tasks: state.tasks,
    idempotency: state.idempotency,
    sessionToMember: state.sessionToMember,
    enrollments: state.enrollments,
    issues: state.issues,
    replayedTo: room.writer.rows.length === 0 ? 0 : room.writer.rows[room.writer.rows.length - 1].seq,
  }

  if (state.issues.length > 0) {
    // 重放问题必须可观测，但不阻断服务（设计文档 §3.4 只要求中间损坏时停止服务，
    // 未知引用属于可降级情形）。
    for (const issue of state.issues.slice(0, 5)) {
      room.protocolLogger?.warn?.(`room: 协议重放异常 — ${issue}`)
    }
  }

  return room.protocol
}

/**
 * 确保房间已启用协议。
 *
 * 已启用则直接返回现有状态；否则追加一条 `system/protocol-enabled`，
 * 记录 roomUid、存储版本、以及既有内部成员的 sessionId→memberId 映射
 * （设计文档 §2.3：重启从该事件恢复，不重新分配 ID）。
 *
 * @param {object} room
 * @param {{ logger?: any }} [opts]
 * @returns {Promise<object>} room.protocol
 */
export function ensureProtocolEnabled(room, opts = {}) {
  return withRoomWrite(room, locked => enableProtocolLocked(locked, opts))
}

async function enableProtocolLocked(room, opts = {}) {
  if (room.protocol === undefined) loadProtocolState(room)
  if (room.protocol.enabled) return room.protocol

  const roomUid = randomUUID()

  // 既有内部成员：按当前折叠结果生成映射
  /** @type {Record<string, string>} */
  const memberMap = {}
  for (const member of room.members.values()) {
    if (typeof member.sessionId !== 'string') continue
    memberMap[member.sessionId] = makeMemberId(roomUid, 'internal', member.sessionId)
  }

  await room.writer.run(async ({ append }) => {
    const normalized = normalizeRow({
      kind: 'system',
      msgId: randomUUID(),
      tag: CONTROL_TAG.PROTOCOL_ENABLED,
      visibility: VISIBILITY_INTERNAL,
      digest: '启用房间协议 v2',
      roomUid,
      storageVersion: STORAGE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      memberMap,
      // 启用时刻已在账本里的最大 seq；重放时用于校验
      activationSeq: room.writer.rows.length,
    })
    if (!normalized.ok) throw new Error(`protocol-enabled-invalid:${normalized.error}`)
    await append(normalized.row)
  })

  opts.logger?.info?.(`room: 已为「${room.name}」启用协议 v${PROTOCOL_VERSION}（roomUid=${roomUid}）`)

  // 启用后立即重放，让内存状态与新账本一致
  return loadProtocolState(room)
}

/**
 * 把协议状态对齐到最新账本。
 *
 * 每次写账本之后调用（或按需调用）。当前实现是全量重放，
 * 因为 MVP 账本规模小（<1e4 行）；后续可换成增量。
 *
 * @param {object} room
 * @returns {object} room.protocol
 */
export function refreshProtocolState(room) {
  if (room.protocol === undefined) return loadProtocolState(room)

  const lastSeq =
    room.writer.rows.length === 0 ? 0 : room.writer.rows[room.writer.rows.length - 1].seq
  if (room.protocol.replayedTo === lastSeq) return room.protocol

  return loadProtocolState(room)
}

/**
 * 按 sessionId 找成员的 memberId（内部成员）。
 *
 * @param {object} room
 * @param {string} sessionId
 * @returns {string | null}
 */
export function memberIdOfSession(room, sessionId) {
  if (room.protocol === undefined) loadProtocolState(room)
  return room.protocol.sessionToMember.get(sessionId) ?? null
}

/**
 * 按 memberId 找成员视图。
 *
 * @param {object} room
 * @param {string} memberId
 * @returns {object | null}
 */
export function memberById(room, memberId) {
  if (room.protocol === undefined) loadProtocolState(room)
  return room.protocol.members.get(memberId) ?? null
}

/** 供 HTTP 层输出：房间协议摘要（不含任何凭据）。 */
export function protocolSummary(room) {
  const protocol = room.protocol === undefined ? loadProtocolState(room) : room.protocol
  return {
    enabled: protocol.enabled,
    roomUid: protocol.roomUid,
    protocolVersion: PROTOCOL_VERSION,
    members: [...protocol.members.values()].map((m) => ({
      memberId: m.memberId,
      kind: m.kind,
      nick: m.nick,
      displayName: m.displayName,
      status: m.status,
    })),
    taskCounts: countTaskStates(protocol.tasks),
  }
}

/** 统计各状态任务数量。 */
export function countTaskStates(tasks) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const task of tasks.values()) {
    counts[task.state] = (counts[task.state] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------- 外部成员注册

/**
 * 注册一个外部成员。
 *
 * 设计文档 §5.4：
 *   - 客户端先持久化 registrationId + memberToken，再发请求
 *   - 宿主只存摘要
 *   - 响应丢失时重发同一请求，返回同一个 memberId（不重新分配）
 *
 * @param {object} room
 * @param {{
 *   registrationId: string,
 *   nick: string,
 *   displayName?: string,
 *   route?: object,
 *   memberToken: string,
 *   enrollmentTokenHash?: string,
 * }} spec
 * @returns {Promise<
 *   {ok: true, memberId: string, nick: string, roomUid: string, duplicate: boolean} |
 *   {ok: false, code: string, message: string}
 * >}
 */
export function registerExternalMember(room, spec) {
  return withRoomWrite(room, locked => registerExternalMemberLocked(locked, spec))
}

async function registerExternalMemberLocked(room, spec) {
  if (room.protocol === undefined) loadProtocolState(room)
  if (!room.protocol.enabled) {
    return { ok: false, code: 'protocol-disabled', message: '房间尚未启用协议 v2' }
  }

  const nickCheck = validateExternalNick(spec.nick, validateNick)
  if (!nickCheck.ok) return { ok: false, code: nickCheck.error, message: '昵称不合法或已保留' }

  const nick = spec.nick.trim()
  const registrationId = String(spec.registrationId ?? '')
  const memberToken = String(spec.memberToken ?? '')

  if (registrationId === '') return { ok: false, code: 'missing-registration-id', message: '缺 registrationId' }
  if (memberToken === '') return { ok: false, code: 'missing-member-token', message: '缺 memberToken' }

  const tokenHash = hashToken(memberToken)
  const roomUid = room.protocol.roomUid
  const registrationHash = requestHash({ registrationId, nick, displayName: spec.displayName ?? nick,
    route: spec.route ?? null, tokenHash, enrollmentTokenHash: spec.enrollmentTokenHash })

  // --- 幂等重放：同 registrationId + 同 token 摘要 -> 原回执 ---
  for (const member of room.protocol.members.values()) {
    if (member.kind !== 'external') continue
    if (member.registrationId === registrationId && tokenMatches(member.tokenHash, memberToken)) {
      if (member.status !== 'active') return { ok: false, code: 'unauthorized', message: '凭据已撤销' }
      if (member.registrationHash && member.registrationHash !== registrationHash)
        return { ok: false, code: 'idempotency-conflict', message: '注册重放必须使用原请求与原入房凭据' }
      return { ok: true, memberId: member.memberId, nick: member.nick, roomUid, duplicate: true }
    }
  }

  if (spec.requireEnrollment === true) {
    const enrollment = room.protocol.enrollments.get(spec.enrollmentTokenHash)
    if (!enrollment || enrollment.consumedBy || enrollment.expiresAt <= Date.now())
      return { ok: false, code: 'unauthorized', message: '入房凭据无效、已使用或已过期' }
  }
  if ([...room.protocol.members.values()].some(member => member.tokenHash === tokenHash))
    return { ok: false, code: 'token-taken', message: '成员凭据已被使用' }

  // --- 昵称唯一性：同房间内 active 的外部/内部成员都不能撞 ---
  const nickTaken = [...room.protocol.members.values()].some(
    (m) => typeof m.nick === 'string' && m.nick.toLowerCase() === nick.toLowerCase(),
  )
  if (nickTaken) return { ok: false, code: 'nick-taken', message: `昵称「${nick}」已被占用` }

  // --- 分配 memberId 并落账 ---
  //
  // ⚠️ memberId 由 **registrationId + tokenHash** 共同派生，不能只用 registrationId：
  //    否则别人拿到你的 registrationId 就能用自己的 token 注册出同一个 memberId，
  //    等于冒名顶替（幂等重放只认"同 registrationId **且** 同 token"）。
  const memberId = makeMemberId(roomUid, 'external', `${registrationId}:${tokenHash}`)

  await room.writer.run(async ({ append }) => {
    const normalized = normalizeRow({
      kind: 'system',
      msgId: randomUUID(),
      tag: CONTROL_TAG.MEMBER_EXTERNAL,
      visibility: VISIBILITY_INTERNAL,
      digest: `${nick} 以外部成员接入`,
      memberId,
      nick,
      displayName: spec.displayName ?? nick,
      route: spec.route ?? null,
      registrationId,
      tokenHash,
      registrationHash,
      ...(spec.enrollmentTokenHash === undefined
        ? {}
        : { enrollmentTokenHash: spec.enrollmentTokenHash }),
    })
    if (!normalized.ok) throw new Error(`member-external-invalid:${normalized.error}`)
    await append(normalized.row)
  })

  loadProtocolState(room)
  return { ok: true, memberId, nick, roomUid, duplicate: false }
}

/**
 * 撤销外部成员凭据（本地管理入口用）。
 *
 * 保留 memberId，只把 status 置为 revoked —— 设计文档 §5.4
 * "不能通过重新抢占昵称取得原成员身份"。
 *
 * @param {object} room
 * @param {string} memberId
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
export function revokeExternalMember(room, memberId) {
  return withRoomWrite(room, locked => revokeExternalMemberLocked(locked, memberId))
}

async function revokeExternalMemberLocked(room, memberId) {
  if (room.protocol === undefined) loadProtocolState(room)
  const member = room.protocol.members.get(memberId)
  if (member === undefined || member.kind !== 'external') {
    return { ok: false, code: 'unknown-member' }
  }

  await room.writer.run(async ({ append }) => {
    const normalized = normalizeRow({
      kind: 'system',
      msgId: randomUUID(),
      tag: CONTROL_TAG.MEMBER_RENAMED,
      visibility: VISIBILITY_INTERNAL,
      digest: `${member.nick ?? memberId} 凭据已撤销`,
      memberId,
      status: 'revoked',
    })
    if (!normalized.ok) throw new Error(`revoke-invalid:${normalized.error}`)
    await append(normalized.row)
  })

  loadProtocolState(room)
  return { ok: true }
}

/** Trusted local management only; the plaintext is returned once, never written. */
export function issueEnrollmentToken(room) {
  return withRoomWrite(room, async locked => {
    if (!locked.protocol.enabled) return { ok: false, code: 'protocol-disabled' }
    const token = generateToken()
    const expiresAt = Date.now() + 60 * 60 * 1000
    const normalized = normalizeRow({ kind: 'system', msgId: randomUUID(),
      tag: CONTROL_TAG.ENROLLMENT_ISSUED, visibility: VISIBILITY_INTERNAL,
      digest: '签发一次性入房凭据', enrollmentTokenHash: hashToken(token), expiresAt })
    if (!normalized.ok) throw new Error(normalized.error)
    await locked.writer.run(({ append }) => append(normalized.row))
    return { ok: true, enrollmentToken: token, expiresAt }
  })
}
