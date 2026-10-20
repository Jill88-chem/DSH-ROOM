// 外部成员凭据（阶段 A · 第 2 层）
//
// 职责：
//   1. memberToken / enrollmentToken 的生成与哈希比对
//   2. Bearer 头解析
//   3. 请求身份解析（token → member）
//
// ⚠️ 只存**摘要**，不存明文（设计文档 §5.1、§5.4）。
//    本模块不碰 IO，token 与成员状态的存取由调用方负责。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** memberToken 的最小熵（字节）。设计文档要求"至少 256 位"。 */
export const TOKEN_BYTES = 32

/** enrollmentToken 只在注册时用一次，给同样的强度。 */
export const ENROLLMENT_BYTES = 32

/**
 * 生成一个不透明随机凭据。
 *
 * @param {number} [bytes]
 * @returns {string} 形如 `rt_<hex>`（room token）
 */
export function generateToken(bytes = TOKEN_BYTES) {
  return `rt_${randomBytes(bytes).toString('hex')}`
}

/** 生成注册会话 ID（客户端也要持久化，用于响应丢失后重放）。 */
export function generateRegistrationId() {
  return `reg_${randomBytes(16).toString('hex')}`
}

/**
 * 计算凭据摘要。
 *
 * 用 SHA-256 而不是 bcrypt：token 是 256 位随机值，本身就是高熵的，
 * 不需要慢哈希抗暴力；这里要的是"恒定时间比对"和"不存明文"。
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return `sha256:${createHash('sha256').update(String(token), 'utf8').digest('hex')}`
}

/**
 * 恒定时间比对两个摘要。
 *
 * @param {string} aHash - 期望值（已存摘要）
 * @param {string} bToken - 待验明文 token
 * @returns {boolean}
 */
export function tokenMatches(aHash, bToken) {
  if (typeof aHash !== 'string' || typeof bToken !== 'string') return false
  const a = Buffer.from(aHash, 'utf8')
  const b = Buffer.from(hashToken(bToken), 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * 从 `Authorization` 头解析 Bearer 凭据。
 *
 * @param {string | undefined | null} header
 * @returns {string | null}
 */
export function parseBearer(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match === null ? null : match[1]
}

/**
 * 校验昵称是否可用于外部成员。
 *
 * 复用现有规则（无空格、无 @、长度上限），并额外禁止与保留词冲突。
 *
 * @param {string} nick
 * @param {(nick: string) => {ok: boolean, error?: string}} validateNick
 * @returns {{ok: boolean, error?: string}}
 */
export function validateExternalNick(nick, validateNick) {
  const base = validateNick(nick)
  if (!base.ok) return base
  const lowered = nick.toLowerCase()
  const reserved = new Set(['all', '所有人', '用户', '系统', 'system', 'room'])
  if (reserved.has(lowered)) return { ok: false, error: 'nick-reserved' }
  return { ok: true }
}

/**
 * 请求身份解析结果。供 HTTP 层统一处理。
 *
 * @typedef {{
 *   ok: true,
 *   member: object,
 *   roomUid: string,
 * } | {
 *   ok: false,
 *   status: number,
 *   code: string,
 *   message: string,
 * }} AuthResult
 */

/**
 * 按 memberToken 在房间内查成员。
 *
 * 遍历外部成员比对摘要。成员数量在 MVP 是几个到几十个，线性比对完全够用；
 * 不建索引是为了避免"索引与账本不一致"这一类 bug。
 *
 * @param {Map<string, object>} members
 * @param {string} token
 * @returns {object | null}
 */
export function findMemberByToken(members, token) {
  if (typeof token !== 'string' || token === '') return null
  for (const member of members.values()) {
    if (member.kind !== 'external') continue
    if (member.status !== 'active') continue
    if (tokenMatches(member.tokenHash, token)) return member
  }
  return null
}

/**
 * 统一的认证失败响应体。
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, error: {code: string, message: string, retryable: boolean}}}
 */
export function authError(code, message) {
  return { ok: false, error: { code, message, retryable: false } }
}

/**
 * 标准化错误响应体（HTTP 层统一用）。
 *
 * @param {string} code
 * @param {string} message
 * @param {boolean} [retryable]
 * @returns {{ok: false, error: {code: string, message: string, retryable: boolean}}}
 */
export function errorBody(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } }
}
