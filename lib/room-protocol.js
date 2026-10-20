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
} from './protocol.js'
import { normalizeRow } from './ledger.js'

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
export async function ensureProtocolEnabled(room, opts = {}) {
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
