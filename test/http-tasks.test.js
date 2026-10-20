// 任务 HTTP 端点测试（阶段 A · 第 4 层）
//
// 重点不是"能通"，而是**边界不能漏**：
//   - 每个任务端点都必须要求 token（漏一个就是越权）
//   - 别人的 taskId 必须 404，且不泄露对象详情
//   - 错误码映射要能让桥接器区分"重试"和"放弃"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RoomWriter, normalizeRow } from '../lib/ledger.js'
import { ensureProtocolEnabled, registerExternalMember, loadProtocolState } from '../lib/room-protocol.js'
import { generateToken, generateRegistrationId } from '../lib/auth.js'
import { createExternalRoutes } from '../lib/http-external.js'
import { TASK_STATE } from '../lib/protocol.js'

// ---------------------------------------------------------------- 夹具

async function withRoom(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-http-'))
  try {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    await writer.open()
    const room = {
      key: `${dir}::default`,
      roomId: 'default',
      cwd: dir,
      name: '测试房间',
      dir,
      writer,
      rows: writer.rows,
      members: new Map(),
      nicks: new Map(),
      protocolLogger: { warn() {}, info() {} },
    }
    await ensureProtocolEnabled(room)

    const tokenA = generateToken()
    const tokenB = generateToken()
    const a = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex-a',
      memberToken: tokenA,
    })
    const b = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex-b',
      memberToken: tokenB,
    })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)

    // 派一条给 A 的任务
    const askMsgId = 'ask-http-1'
    await writer.run(async ({ append }) => {
      const n = normalizeRow({
        kind: 'ask',
        msgId: askMsgId,
        from: '用户',
        text: '查一下工具环境',
        digest: '查工具环境',
        targetMemberIds: [a.memberId],
        deliveryVersion: 2,
        rootAskMsgId: askMsgId,
        parentAskMsgId: null,
        depth: 0,
        taskPolicy: { executionMode: 'read-only', maxAttempts: 3 },
      })
      if (!n.ok) throw new Error(n.error)
      await append(n.row)
    })
    loadProtocolState(room)

    const routes = new Map()
    const api = {
      sendJson(res, status, value) {
        res.writeHead(status)
        res.end(JSON.stringify(value))
      },
      readJsonBody: async (req) => {
        let raw = ''
        for await (const c of req) raw += c
        return JSON.parse(raw || '{}')
      },
      resolveRoom: async () => room,
      instanceId: 'inst-test',
      logger: { warn() {}, info() {} },
    }
    createExternalRoutes(api).register({
      register: (r) => (routes.set(r.path, r.handler), () => {}),
    })

    const call = async (path, { method = 'GET', body, token, query = '' } = {}) => {
      const handler = routes.get(path)
      assert.ok(handler, `${path} 应已注册`)
      const payload = body === undefined ? undefined : body
      const req = {
        method,
        url: `${path}?cwd=${encodeURIComponent(room.cwd)}&room=default${query}`,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (payload !== undefined) yield Buffer.from(JSON.stringify(payload), 'utf8')
        },
      }
      let status = 0
      let text = ''
      const res = {
        writeHead(code) {
          status = code
        },
        end(chunk) {
          if (typeof chunk === 'string') text = chunk
        },
      }
      await handler(req, res)
      return { status, body: text === '' ? null : JSON.parse(text) }
    }

    try {
      return await fn({ room, a, b, tokenA, tokenB, call, askMsgId })
    } finally {
      await writer.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 全端点鉴权

test('所有任务端点都必须要求 token（漏一个就是越权）', async () => {
  await withRoom(async ({ call }) => {
    const endpoints = [
      ['/room/claim', 'POST'],
      ['/room/renew', 'POST'],
      ['/room/complete', 'POST'],
      ['/room/fail', 'POST'],
      ['/room/task', 'GET'],
      ['/room/message', 'GET'],
    ]

    for (const [path, method] of endpoints) {
      const r = await call(path, { method, body: method === 'POST' ? {} : undefined })
      assert.equal(r.status, 401, `${path} 无 token 必须 401，实际 ${r.status}`)
      assert.equal(r.body.error.code, 'unauthorized')
    }
  })
})

test('无效 token 一律 401，不泄露任务是否存在', async () => {
  await withRoom(async ({ call, a }) => {
    const r = await call('/room/claim', {
      method: 'POST',
      token: 'rt_totally-wrong',
      body: { idempotencyKey: 'k1' },
    })
    assert.equal(r.status, 401)
    assert.equal(r.body.error.code, 'unauthorized')
  })
})

// ---------------------------------------------------------------- claim

test('POST /room/claim：领取成功返回任务与租约', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const r = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'claim-1', leaseSeconds: 300 },
    })

    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    assert.ok(r.body.task, '应领到任务')
    assert.equal(r.body.task.text, '查一下工具环境')
    assert.equal(r.body.currentState, TASK_STATE.RUNNING)
    assert.match(r.body.task.leaseId, /^[0-9a-f-]{36}$/)
  })
})

test('POST /room/claim：B 领不到 A 的任务（返回 empty）', async () => {
  await withRoom(async ({ call, tokenB }) => {
    const r = await call('/room/claim', {
      method: 'POST',
      token: tokenB,
      body: { idempotencyKey: 'claim-b' },
    })

    assert.equal(r.status, 200)
    assert.equal(r.body.task, null)
    assert.equal(r.body.reason, 'empty')
  })
})

// ---------------------------------------------------------------- 完整流程

test('claim → renew → complete 全链路 HTTP 打通', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    assert.equal(claim.body.ok, true)
    const { taskId, leaseId, attempt } = claim.body.task

    const renew = await call('/room/renew', {
      method: 'POST',
      token: tokenA,
      body: { taskId, leaseId, attempt, idempotencyKey: 'r1', leaseSeconds: 400 },
    })
    assert.equal(renew.status, 200, JSON.stringify(renew.body))
    assert.ok(renew.body.leaseExpiresAt > claim.body.task.leaseExpiresAt)

    const done = await call('/room/complete', {
      method: 'POST',
      token: tokenA,
      body: {
        taskId,
        leaseId,
        attempt,
        digest: '环境检查完成',
        text: 'read=✓ grep=✓ pwsh=✓',
        idempotencyKey: 'd1',
      },
    })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.state, TASK_STATE.COMPLETED)
    assert.ok(done.body.seq > 0)
  })
})

test('POST /room/complete：重复提交同 key 返回原回执（含 seq）', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId, leaseId, attempt } = claim.body.task
    const payload = {
      taskId,
      leaseId,
      attempt,
      digest: 'd',
      text: 't',
      idempotencyKey: 'done-same',
    }

    const first = await call('/room/complete', { method: 'POST', token: tokenA, body: payload })
    const replay = await call('/room/complete', { method: 'POST', token: tokenA, body: payload })

    assert.equal(replay.status, 200)
    assert.equal(replay.body.duplicate, true)
    assert.equal(replay.body.seq, first.body.seq, '重放必须带 seq')
  })
})

test('POST /room/complete：别人不能替你提交（404 不泄露）', async () => {
  await withRoom(async ({ call, tokenA, tokenB }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId, leaseId, attempt } = claim.body.task

    const stolen = await call('/room/complete', {
      method: 'POST',
      token: tokenB,
      body: { taskId, leaseId, attempt, digest: 'd', text: 't', idempotencyKey: 'steal' },
    })

    assert.equal(stolen.status, 404, '不属于自己的任务按不存在处理')
    assert.equal(stolen.body.error.code, 'not-found')
  })
})

test('POST /room/complete：text 缺失 → 422（业务校验错误不是 409）', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId, leaseId, attempt } = claim.body.task

    const r = await call('/room/complete', {
      method: 'POST',
      token: tokenA,
      body: { taskId, leaseId, attempt, digest: 'd', text: '   ', idempotencyKey: 'k' },
    })
    assert.equal(r.status, 422, JSON.stringify(r.body))
    assert.equal(r.body.error.code, 'invalid-request')
    assert.equal(r.body.error.retryable, false, '业务校验失败不该让桥接器重试')
  })
})

test('POST /room/fail：可重试失败 → 200，任务回队列', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId, leaseId, attempt } = claim.body.task

    const r = await call('/room/fail', {
      method: 'POST',
      token: tokenA,
      body: { taskId, leaseId, attempt, code: 'process-start-failed', retryable: true, idempotencyKey: 'f1' },
    })

    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.state, TASK_STATE.QUEUED)
    assert.ok(r.body.nextEligibleAt > Date.now())
  })
})

// ---------------------------------------------------------------- 状态查询

test('GET /room/task：返回自己的任务状态；缺 taskId → 422', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId } = claim.body.task

    const missing = await call('/room/task', { method: 'GET', token: tokenA })
    assert.equal(missing.status, 422)
    assert.equal(missing.body.error.code, 'invalid-request')

    const ok = await call('/room/task', {
      method: 'GET',
      token: tokenA,
      query: `&taskId=${encodeURIComponent(taskId)}`,
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.task.taskId, taskId)
    assert.equal(ok.body.task.state, TASK_STATE.RUNNING)
    assert.equal(ok.body.task.leaseId, claim.body.task.leaseId)
  })
})

test('GET /room/task：别人的任务 404', async () => {
  await withRoom(async ({ call, tokenA, tokenB }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId } = claim.body.task

    const r = await call('/room/task', {
      method: 'GET',
      token: tokenB,
      query: `&taskId=${encodeURIComponent(taskId)}`,
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'not-found')
  })
})

// ---------------------------------------------------------------- 正文读取

test('GET /room/message：外部 answer 的正文从账本读回（textSource=ledger）', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const { taskId, leaseId, attempt } = claim.body.task
    const done = await call('/room/complete', {
      method: 'POST',
      token: tokenA,
      body: { taskId, leaseId, attempt, digest: 'd', text: '完整正文内容', idempotencyKey: 'k1' },
    })
    assert.equal(done.status, 200)

    const msg = await call('/room/message', {
      method: 'GET',
      token: tokenA,
      query: `&seq=${done.body.seq}`,
    })
    assert.equal(msg.status, 200, JSON.stringify(msg.body))
    assert.equal(msg.body.text, '完整正文内容')
    assert.equal(msg.body.textSource, 'ledger')
    assert.equal(msg.body.kind, 'answer')
    assert.equal(msg.body.replyToMsgId, claim.body.task.askMsgId, 'answer 必须能追溯到原 ask')
  })
})

test('GET /room/message：ask 的正文也能读（人类派单原文）', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const claim = await call('/room/claim', {
      method: 'POST',
      token: tokenA,
      body: { idempotencyKey: 'c1' },
    })
    const msg = await call('/room/message', {
      method: 'GET',
      token: tokenA,
      query: `&seq=${claim.body.task.askSeq}`,
    })
    assert.equal(msg.status, 200, JSON.stringify(msg.body))
    assert.equal(msg.body.text, '查一下工具环境')
    assert.equal(msg.body.kind, 'ask')
    assert.equal(msg.body.textSource, 'ledger')
  })
})

test('GET /room/message：缺 seq / 非法 seq → 422', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const noSeq = await call('/room/message', { method: 'GET', token: tokenA })
    assert.equal(noSeq.status, 422)
    assert.equal(noSeq.body.error.code, 'invalid-request')

    const badSeq = await call('/room/message', {
      method: 'GET',
      token: tokenA,
      query: '&seq=abc',
    })
    assert.equal(badSeq.status, 422)

    const zero = await call('/room/message', { method: 'GET', token: tokenA, query: '&seq=0' })
    assert.equal(zero.status, 422)
  })
})

test('GET /room/message：不存在的 seq → 404', async () => {
  await withRoom(async ({ call, tokenA }) => {
    const r = await call('/room/message', {
      method: 'GET',
      token: tokenA,
      query: '&seq=99999',
    })
    assert.equal(r.status, 404)
  })
})

test('GET /room/message：控制事件按不存在处理（不泄露内部事件）', async () => {
  await withRoom(async ({ room, call, tokenA }) => {
    const control = room.writer.rows.find((r) => r.visibility === 'internal')
    assert.ok(control, '应有内部控制事件')

    const r = await call('/room/message', {
      method: 'GET',
      token: tokenA,
      query: `&seq=${control.seq}`,
    })

    assert.equal(r.status, 404, '控制事件不能通过消息接口读到')
    assert.equal(r.body.error.code, 'not-found')
    // 不能透露这条是控制事件
    assert.ok(!JSON.stringify(r.body).includes('protocol-enabled'))
  })
})
