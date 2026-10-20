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
  /**
   * 统一的「认证 + 读 body + 执行」包装。
   *
   * 所有任务端点的骨架都一样：验 token → 读 body → 调 tasks.js → 映射错误码。
   * 抽出来是为了保证**没有哪个端点漏掉认证**（漏一个就是越权）。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {(ctx: {room: object, member: object, body: object}) => Promise<object>} fn
   */
  async function withMember(req, res, url, fn) {
    const auth = await authenticate(req, url)
    if (auth.ok !== true) {
      sendJson(res, auth.status, auth.body)
      return
    }

    let body = {}
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 422, errorBody('invalid-request', String(error?.message ?? error)))
        return
      }
    }

    const result = await fn({ room: auth.room, member: auth.member, body })
    respond(res, result)
  }

  /**
   * 把 tasks.js 的返回映射成 HTTP 状态码 + **统一错误体**。
   *
   * 错误码到状态码的映射集中在这里，避免每个端点各写一套（不一致就会让
   * 桥接器分不清"重试"和"放弃"）。
   *
   * 错误体统一成 `{ok:false, error:{code,message,retryable}}` —— 与
   * /room/health 等端点的形状一致，桥接器只需写一套解析逻辑。
   *
   * @param {import('node:http').ServerResponse} res
   * @param {object} result
   */
  function respond(res, result) {
    if (result?.ok === true) {
      sendJson(res, 200, result)
      return
    }

    const code = String(result?.code ?? 'internal')
    const message = String(result?.message ?? '')
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'forbidden'
          ? 403
          : code === 'not-found'
            ? 404
            : code === 'write-failed'
              ? 503
              : code === 'invalid-request'
                ? 422
                : // 其余都是状态冲突：lease-lost / task-already-completed /
                  // idempotency-conflict / task-cancelled / task-not-running ...
                  409

    // retryable 决定桥接器能否重试：
    //   - 写账本失败（503）可重试
    //   - 幂等冲突/状态冲突不可重试（重试只会得到同样结果）
    const retryable = code === 'write-failed'
    const body = {
      ok: false,
      error: { code, message, retryable },
      ...(status === 409 ? { code } : {}),
    }
    sendJson(res, status, body)
  }

  // ------------------------------------------------------------ 任务端点

  async function handleClaim(req, res, url) {
    await withMember(req, res, url, async ({ room, member, body }) => {
      const { claimTask } = await import('./tasks.js')
      return claimTask(room, {
        memberId: member.memberId,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        workerId: typeof body.workerId === 'string' ? body.workerId : undefined,
        leaseSeconds: body.leaseSeconds,
      })
    })
  }

  async function handleRenew(req, res, url) {
    await withMember(req, res, url, async ({ room, member, body }) => {
      const { renewTask } = await import('./tasks.js')
      if (typeof body.taskId !== 'string' || typeof body.leaseId !== 'string') {
        return { ok: false, code: 'invalid-request', message: '缺 taskId 或 leaseId' }
      }
      if (typeof body.attempt !== 'number') {
        return { ok: false, code: 'invalid-request', message: '缺 attempt' }
      }
      return renewTask(room, {
        memberId: member.memberId,
        taskId: body.taskId,
        leaseId: body.leaseId,
        attempt: body.attempt,
        leaseSeconds: body.leaseSeconds,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      })
    })
  }

  async function handleComplete(req, res, url) {
    await withMember(req, res, url, async ({ room, member, body }) => {
      const { completeTask } = await import('./tasks.js')
      if (typeof body.taskId !== 'string' || typeof body.leaseId !== 'string') {
        return { ok: false, code: 'invalid-request', message: '缺 taskId 或 leaseId' }
      }
      if (typeof body.attempt !== 'number') {
        return { ok: false, code: 'invalid-request', message: '缺 attempt' }
      }
      return completeTask(room, {
        memberId: member.memberId,
        taskId: body.taskId,
        leaseId: body.leaseId,
        attempt: body.attempt,
        digest: String(body.digest ?? ''),
        text: String(body.text ?? ''),
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      })
    })
  }

  async function handleFail(req, res, url) {
    await withMember(req, res, url, async ({ room, member, body }) => {
      const { failTask } = await import('./tasks.js')
      if (typeof body.taskId !== 'string' || typeof body.leaseId !== 'string') {
        return { ok: false, code: 'invalid-request', message: '缺 taskId 或 leaseId' }
      }
      if (typeof body.attempt !== 'number') {
        return { ok: false, code: 'invalid-request', message: '缺 attempt' }
      }
      return failTask(room, {
        memberId: member.memberId,
        taskId: body.taskId,
        leaseId: body.leaseId,
        attempt: body.attempt,
        code: String(body.code ?? 'unknown'),
        text: typeof body.text === 'string' ? body.text : undefined,
        retryable: body.retryable === true,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      })
    })
  }

  async function handleTask(req, res, url) {
    await withMember(req, res, url, async ({ room, member }) => {
      const { getTask } = await import('./tasks.js')
      const taskId = url.searchParams.get('taskId')
      if (typeof taskId !== 'string' || taskId === '') {
        return { ok: false, code: 'invalid-request', message: '缺 taskId' }
      }
      return getTask(room, { memberId: member.memberId, taskId })
    })
  }

  /**
   * 读消息正文。
   *
   * 优先级（设计文档 §5.10）：
   *   1. 账本自带的 text（外部成员写入的 answer / 人类发的 ask）
   *   2. 内部会话日志（按 (sessionId, sourceSeq) 定位）
   *   3. 只有摘要 → 如实标 digest-only，不猜
   *
   * ⚠️ 只返回**公开行**：内部控制事件与私有字段一律过滤。
   */
  async function handleMessage(req, res, url) {
    await withMember(req, res, url, async ({ room }) => {
      const { isPublicRow, toPublicRow } = await import('./protocol.js')
      const seqParam = url.searchParams.get('seq')
      const seq = Number(seqParam)
      if (!Number.isInteger(seq) || seq < 1) {
        return { ok: false, code: 'invalid-request', message: 'seq 必须是正整数' }
      }

      const row = room.writer.rows.find((r) => r.seq === seq)
      if (row === undefined) return { ok: false, code: 'not-found', message: '没有这条消息' }
      if (!isPublicRow(row)) {
        // 不泄露"这条是控制事件"这一信息，统一按不存在处理
        return { ok: false, code: 'not-found', message: '没有这条消息' }
      }

      const pub = toPublicRow(row)

      // 1) 账本自带正文
      if (typeof row.text === 'string' && row.text !== '') {
        return {
          ok: true,
          seq: row.seq,
          kind: row.kind,
          msgId: row.msgId,
          from: row.from ?? '',
          memberId: row.memberId ?? null,
          replyToMsgId: row.replyToMsgId ?? null,
          text: row.text,
          textSource: 'ledger',
        }
      }

      // 2) 内部会话日志：必须用 (sessionId, sourceSeq) 双键定位
      if (typeof row.session === 'string' && typeof row.sourceSeq === 'number') {
        const body = await readInternalBody(row)
        if (body !== null) {
          return {
            ok: true,
            seq: row.seq,
            kind: row.kind,
            msgId: row.msgId,
            from: row.from ?? '',
            memberId: row.memberId ?? null,
            replyToMsgId: row.replyToMsgId ?? null,
            text: body,
            textSource: 'session',
          }
        }
      }

      // 3) 只有摘要：如实说明，不伪造正文
      return {
        ok: true,
        seq: row.seq,
        kind: row.kind,
        msgId: row.msgId,
        from: pub.from ?? '',
        memberId: pub.memberId ?? null,
        replyToMsgId: pub.replyToMsgId ?? null,
        text: '',
        digest: pub.digest ?? '',
        textSource: 'digest-only',
      }
    })
  }

  /**
   * 从内部会话日志取正文。拿不到返回 null（调用方回落 digest-only）。
   *
   * @param {object} row
   * @returns {Promise<string | null>}
   */
  async function readInternalBody(row) {
    const readBody = deps.readInternalBody
    if (typeof readBody !== 'function') return null
    try {
      return await readBody(row.session, row.sourceSeq)
    } catch {
      return null
    }
  }

  /**
   * 注册全部外部端点。
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
      // ---- 任务端点（阶段 A 第 4 层）----
      make('/room/claim', 'POST', handleClaim),
      make('/room/renew', 'POST', handleRenew),
      make('/room/complete', 'POST', handleComplete),
      make('/room/fail', 'POST', handleFail),
      make('/room/task', 'GET', handleTask),
      make('/room/message', 'GET', handleMessage),
    ]
  }

  return { register, authenticate, roomCoords, isLoopback }
}
