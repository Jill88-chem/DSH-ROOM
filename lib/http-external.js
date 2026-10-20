// 外部接入 HTTP 路由（阶段 A · 第 2 层）
//
// 端点：
//   GET  /room/health    — 无需鉴权，报告协议版本与能力
//   GET  /room/self      — 需 memberToken，返回自身身份
//   POST /room/register  — 需 enrollmentToken，注册外部成员
//
// ⚠️ 本模块只做「协议与鉴权」，不碰账本写入的细节——
//    落账交给 room-protocol.js，读账本交给调用方传入的 roomFor。

import { PROTOCOL_VERSION } from './protocol.js'
import {
  parseBearer,
  findMemberByToken,
  hashToken,
  tokenMatches,
  errorBody,
} from './auth.js'
import { registerExternalMember } from './room-protocol.js'

/** 该房间宣告支持的能力。阶段 A 只有这三项。 */
export function capabilities(room) {
  const list = ['externalTasks', 'leaseRenewal', 'messageRead']
  if (room?.protocol?.enabled === true) return list
  // 协议未启用的房间不宣告 externalTasks
  return ['messageRead']
}

/**
 * 构造 /room/health /room/self /room/register 三个路由的 handler。
 *
 * @param {{
 *   sendJson: (res, status, value) => void,
 *   readJsonBody: (req) => Promise<object>,
 *   resolveRoom: (cwd: string, roomId: string) => Promise<object>,
 *   instanceId: string,
 *   logger: any,
 * }} deps
 */
export function createExternalRoutes(deps) {
  const { sendJson, readJsonBody, resolveRoom, instanceId, logger } = deps

  /** 来源校验：只允许环回。 */
  function isLoopback(req) {
    const remote = req.socket?.remoteAddress ?? ''
    const loopback =
      remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) return false
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin !== '') {
      try {
        const host = new URL(origin).hostname
        return host === '127.0.0.1' || host === 'localhost' || host === '::1'
      } catch {
        return false
      }
    }
    return true
  }

  /** 从查询串解析房间坐标。 */
  function roomCoords(url) {
    const cwd = url.searchParams.get('cwd')
    const room = url.searchParams.get('room') ?? 'default'
    if (typeof cwd !== 'string' || cwd === '') return null
    if (typeof room !== 'string' || room === '') return null
    return { cwd, room }
  }

  /**
   * 认证：从 Bearer 头找外部成员。
   * @returns {Promise<{ok: true, room: object, member: object} | {ok: false, status: number, body: object}>}
   */
  async function authenticate(req, url) {
    const token = parseBearer(req.headers?.authorization)
    if (token === null) {
      return { ok: false, status: 401, body: errorBody('unauthorized', '缺少 Bearer 凭据') }
    }

    const coords = roomCoords(url)
    if (coords === null) {
      return { ok: false, status: 422, body: errorBody('invalid-request', '缺 cwd 或 room 参数') }
    }

    let room
    try {
      room = await resolveRoom(coords.cwd, coords.room)
    } catch (error) {
      logger?.warn?.('room: 外部路由解析房间失败', error)
      return { ok: false, status: 404, body: errorBody('not-found', '房间不存在') }
    }

    // 协议未启用的房间不提供外部接入：不泄露"房间存在但没启用"
    if (room?.protocol?.enabled !== true) {
      return { ok: false, status: 404, body: errorBody('not-found', '房间不存在') }
    }

    const member = findMemberByToken(room.protocol.members, token)
    if (member === null) {
      return { ok: false, status: 401, body: errorBody('unauthorized', '凭据无效或已撤销') }
    }

    return { ok: true, room, member }
  }

  // ------------------------------------------------------------ health

  async function handleHealth(req, res, url) {
    // health 不需要 token，但也不返回任何房间/成员/任务详情
    const coords = roomCoords(url)
    let caps = ['messageRead']
    let roomUid = null

    if (coords !== null) {
      try {
        const room = await resolveRoom(coords.cwd, coords.room)
        if (room?.protocol?.enabled === true) {
          caps = capabilities(room)
          roomUid = room.protocol.roomUid
        }
      } catch {
        // health 不因房间不存在而失败：它报告的是"服务本身活着"
      }
    }

    sendJson(res, 200, {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      instanceId,
      ready: true,
      capabilities: caps,
      ...(roomUid === null ? {} : { roomUid }),
    })
  }

  // ------------------------------------------------------------ self

  async function handleSelf(req, res, url) {
    const auth = await authenticate(req, url)
    if (auth.ok !== true) {
      sendJson(res, auth.status, auth.body)
      return
    }

    const { room, member } = auth
    sendJson(res, 200, {
      ok: true,
      roomUid: room.protocol.roomUid,
      roomKey: room.key,
      memberId: member.memberId,
      nick: member.nick,
      displayName: member.displayName,
      kind: member.kind,
      status: member.status,
      permissions: ['claim', 'renew', 'complete', 'fail', 'task', 'message'],
      serverNow: Date.now(),
    })
  }

  // ------------------------------------------------------------ register

  async function handleRegister(req, res, url) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 422, errorBody('invalid-request', String(error?.message ?? error)))
      return
    }

    const coords = roomCoords(url)
    const cwd = typeof body.cwd === 'string' ? body.cwd : coords?.cwd
    const roomParam = typeof body.room === 'string' ? body.room : coords?.room
    if (typeof cwd !== 'string' || cwd === '' || typeof roomParam !== 'string' || roomParam === '') {
      sendJson(res, 422, errorBody('invalid-request', '缺 cwd 或 room'))
      return
    }

    let room
    try {
      room = await resolveRoom(cwd, roomParam)
    } catch (error) {
      logger?.warn?.('room: 注册时解析房间失败', error)
      sendJson(res, 404, errorBody('not-found', '房间不存在'))
      return
    }

    if (room?.protocol?.enabled !== true) {
      sendJson(res, 404, errorBody('not-found', '房间不存在'))
      return
    }

    // enrollmentToken：MVP 允许由宿主本地配置提供；缺省时退化为"只校验 Bearer 存在"
    const enrollment = parseBearer(req.headers?.authorization)
    const enrollmentHash = enrollment === null ? null : hashToken(enrollment)

    const result = await registerExternalMember(room, {
      registrationId: String(body.registrationId ?? ''),
      nick: String(body.nick ?? ''),
      displayName:
        typeof body.displayName === 'string' ? body.displayName : String(body.nick ?? ''),
      route: body.route ?? null,
      memberToken: String(body.memberToken ?? ''),
      ...(enrollmentHash === null ? {} : { enrollmentTokenHash: enrollmentHash }),
    })

    if (result.ok !== true) {
      const status =
        result.code === 'nick-taken' ? 409 : result.code === 'protocol-disabled' ? 404 : 422
      sendJson(res, status, errorBody(result.code, result.message))
      return
    }

    sendJson(res, 200, {
      ok: true,
      roomUid: result.roomUid,
      memberId: result.memberId,
      nick: result.nick,
      protocolVersion: PROTOCOL_VERSION,
      duplicate: result.duplicate === true,
    })
  }

  /**
   * 路由分发。返回 disposer 数组。
   *
   * @param {{ register: (route: object) => () => void }} webServer
   * @returns {Array<() => void>}
   */
  function register(webServer) {
    if (webServer?.register === undefined) return []

    const make = (path, method, handler) => {
      const dispose = webServer.register({
        kind: 'exact',
        path,
        async handler(req, res) {
          try {
            if (!isLoopback(req)) {
              sendJson(res, 403, errorBody('forbidden-remote', '只接受本机访问'))
              return
            }
            if (req.method !== method) {
              sendJson(res, 405, errorBody('method-not-allowed', `只支持 ${method}`))
              return
            }
            const url = new URL(req.url ?? path, 'http://localhost')
            await handler(req, res, url)
          } catch (error) {
            logger?.warn?.(`room: ${path} 处理失败`, error)
            sendJson(res, 500, errorBody('internal', String(error?.message ?? error)))
          }
        },
      })
      return dispose
    }

    return [
      make('/room/health', 'GET', handleHealth),
      make('/room/self', 'GET', handleSelf),
      make('/room/register', 'POST', handleRegister),
    ]
  }

  return { register, authenticate, roomCoords, isLoopback }
}
