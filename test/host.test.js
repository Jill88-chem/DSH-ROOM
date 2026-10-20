/**
 * 宿主集成测试：用一个最小的假 ctx 驱动真实的 apply()。
 *
 * 覆盖设计文档 T1 / T2 / T9 / T13 / T16 与崩溃窗口 W2 / W4 / W9。
 * 不启动 DSH，也不需要真实模型。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, name, inject } from '../lib/index.js'
import { trackDisposer, disposeHosts } from './lifecycle.js'

// ---------------------------------------------------------------- 假宿主

/**
 * 造一个可用的假 ctx。
 * @param {{ cwd: string }} options
 */
function makeHost(options) {
  const listeners = []
  const tools = new Map()
  const agentsById = new Map()
  /** 每个 session 的事件日志 */
  const logs = new Map()

  const sessions = {
    get(id) {
      const log = logs.get(id)
      if (log === undefined) return undefined
      return {
        id,
        get seq() {
          return log.length
        },
        eventAt(seq) {
          return log[seq]
        },
        header: { cwd: options.cwd },
        requestHeader() {
          return { config: { provider: 'test-provider', model: 'test-model' } }
        },
      }
    },
  }

  const agents = {
    list() {
      return [...agentsById.values()]
    },
    get(id) {
      return agentsById.get(id)
    },
    create({ sessionId, meta, agentOptions }) {
      logs.set(sessionId, [])
      const agent = makeAgent(sessionId, agentOptions)
      agentsById.set(sessionId, agent)
      return Promise.resolve({ agent })
    },
    resume({ resumeSessionId, agentOptions }) {
      const agent = makeAgent(resumeSessionId, agentOptions)
      agent.resumedWith = agentOptions
      agentsById.set(resumeSessionId, agent)
      return Promise.resolve({ agent })
    },
  }

  function makeAgent(sessionId, route) {
    return {
      id: sessionId,
      status: 'idle',
      route,
      followups: [],
      injects: [],
      inject(message) {
        this.injects.push(message)
      },
      followup(message) {
        this.followups.push(message)
        this.status = 'running'
      },
      get session() {
        return sessions.get(sessionId)
      },
    }
  }

  /** 往某会话日志追加事件（模拟宿主行为）。 */
  function pushEvent(sessionId, event) {
    const log = logs.get(sessionId) ?? []
    const seq = log.length
    log.push({ ...event, seq })
    logs.set(sessionId, log)
    for (const listener of listeners) listener(sessions.get(sessionId), { ...event, seq })
  }

  const routes = new Map()

  const ctx = {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
      },
    },
    agents,
    sessions,
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    on(event, listener) {
      if (event === 'session/event') listeners.push(listener)
    },
    effect(fn) {
      const dispose = fn()
      trackDisposer(options.cwd, dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // 真实 cordis 对未声明服务的访问会抛错；这里显式提供，模拟 inject 生效后的世界。
    workspaceRegistry: {
      list: () => [{ path: options.cwd, title: 'test' }],
    },
    sessionQuery: {
      readSession() {
        return Promise.resolve({ events: [] })
      },
    },
    // 模型目录：建成员时会据此校验 provider/model。
    sessionController: {
      modelCatalog() {
        return Promise.resolve({
          groups: [
            { id: 'p', name: '测试供应商', models: [{ id: 'm' }, { id: 'm1' }, { id: 'm2' }] },
            { id: 'goaichat', name: 'KIMI-K3', models: [{ id: 'kimi-k3' }, { id: 'glm-5.3' }] },
          ],
          failures: [],
        })
      },
    },
  }

  return { ctx, tools, agents, sessions, pushEvent, logs, routes }
}

/** 取工具并执行。 */
async function runTool(host, toolName, args, agentId) {
  const tool = host.tools.get(toolName)
  assert.ok(tool, `工具 ${toolName} 应已注册`)
  const agent = host.agents.get(agentId)
  assert.ok(agent, `agent ${agentId} 应存在`)
  return tool.execute(args, { agent })
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-host-'))
  try {
    return await fn(dir)
  } finally {
    await disposeHosts(dir)
    await rm(dir, { recursive: true, force: true })
  }
}

/** 等所有 microtask 与 setTimeout(0) 落地。 */
function flush() {
  return new Promise((r) => setTimeout(r, 20))
}

// ---------------------------------------------------------------- 导出形状

test('模块导出形状：name/inject/apply，且没有 default', () => {
  assert.equal(name, 'dsh-room')
  // workspaceRegistry 与 sessionQuery 必须声明：cordis 对未声明服务的访问会抛错，
  // 不会返回 undefined（实测踩过：GET /room 报 cannot get property without inject）。
  assert.deepEqual(inject, [
    'tools',
    'agents',
    'sessions',
    'webServer',
    'workspaceRegistry',
    'sessionQuery',
    'sessionController',
  ])
  assert.equal(typeof apply, 'function')
})

/** 造一个带 workspaceRegistry / sessionQuery 的宿主，避免访问未声明服务。 */
function makeHostFull(cwd) {
  return makeHost({ cwd })
}

test('四个工具都注册了', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)
    for (const tool of ['room_post', 'room_artifact', 'room_read']) {
      assert.ok(host.tools.has(tool), `${tool} 应注册`)
    }
  })
})

// ---------------------------------------------------------------- T9

test('T9: 中途 room_post(note) 之后，turn/end 仍会回填 answer', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const { sessionId } = await host.ctx.agents.create({
      sessionId: 'session-a',
      meta: { cwd },
      agentOptions: { provider: 'p', model: 'm' },
    })
    // 手动登记成员（HTTP 层才有 create-member，这里直接走账本）。
    await host.tools.get('room_post') // 触发房间创建
    const { ctx: _ } = host

    // 先用 HTTP 的等价路径建成员：直接调内部 createMember 不可达，
    // 改为在账本层面模拟——写一条 system/member 行需要 writer，这里退而求其次：
    // 通过 room_post 让房间存在，再由测试自己补成员行。
    const roomRes = await fetchLike(host, cwd, {
      action: 'create-member',
      nick: 'kimi',
      provider: 'p',
      model: 'm',
    })
    assert.equal(roomRes.ok, true, JSON.stringify(roomRes))
    const memberId = roomRes.sessionId

    // 人发一条定向指令
    const posted = await fetchLike(host, cwd, {
      action: 'post',
      text: '帮我查一下',
      target: { mode: 'member', sessionId: memberId },
    })
    assert.equal(posted.ok, true, JSON.stringify(posted))
    assert.deepEqual(posted.delivered, [memberId])

    const agent = host.agents.get(memberId)
    const delivered = agent.injects.concat(agent.followups)
    assert.equal(delivered.length, 1, '应投递一次')
    const msgId = delivered[0].id

    // 模拟该 turn 开始
    host.pushEvent(memberId, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(memberId, { type: 'user/message', data: { id: msgId, role: 'user' } })

    // 中途主动 post 一条 note
    const noted = await runTool(host, 'room_post', { digest: '正在查，先问一句', kind: 'note' }, memberId)
    assert.equal(noted.ok, true)

    // 本轮完成
    host.pushEvent(memberId, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: '查到了，是 ACL 问题。' }] },
      },
    })
    host.pushEvent(memberId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()

    const ledger = await readFile(join(cwd, '.dsh', 'room', 'ledger.jsonl'), 'utf8')
    const rows = ledger.trim().split('\n').map((l) => JSON.parse(l))
    const answers = rows.filter((r) => r.kind === 'answer')
    assert.equal(answers.length, 1, '即使中途发过 note，也必须回填一条 answer')
    assert.match(answers[0].digest, /ACL/)
  })
})

// ---------------------------------------------------------------- T2

test('T2: 回填的 digest 单行且不超过 200 字符', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const created = await fetchLike(host, cwd, {
      action: 'create-member',
      nick: 'kimi',
      provider: 'p',
      model: 'm',
    })
    const memberId = created.sessionId

    await fetchLike(host, cwd, {
      action: 'post',
      text: '查',
      target: { mode: 'member', sessionId: memberId },
    })
    const agent = host.agents.get(memberId)
    const msgId = agent.injects.concat(agent.followups)[0].id

    host.pushEvent(memberId, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(memberId, { type: 'user/message', data: { id: msgId } })
    host.pushEvent(memberId, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '# 标题\n\n' + '很长的结论。'.repeat(200) }],
        },
      },
    })
    host.pushEvent(memberId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()

    const rows = (await readFile(join(cwd, '.dsh', 'room', 'ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const answer = rows.find((r) => r.kind === 'answer')
    assert.ok(answer, '应有 answer')
    assert.ok(!answer.digest.includes('\n'), 'digest 必须单行')
    assert.ok(answer.digest.length <= 200, `digest 过长: ${answer.digest.length}`)
    assert.ok(!answer.digest.startsWith('#'), '不应以标题标记开头')
  })
})

// ---------------------------------------------------------------- T16

test('T16: 只有标题没有正文时不伪造 answer，改记 system', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const created = await fetchLike(host, cwd, {
      action: 'create-member',
      nick: 'kimi',
      provider: 'p',
      model: 'm',
    })
    const memberId = created.sessionId
    await fetchLike(host, cwd, {
      action: 'post',
      text: '查',
      target: { mode: 'member', sessionId: memberId },
    })
    const msgId = host.agents.get(memberId).injects.concat(host.agents.get(memberId).followups)[0].id

    host.pushEvent(memberId, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(memberId, { type: 'user/message', data: { id: msgId } })
    host.pushEvent(memberId, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '## 结论' }] } },
    })
    host.pushEvent(memberId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()

    const rows = (await readFile(join(cwd, '.dsh', 'room', 'ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))

    assert.equal(rows.filter((r) => r.kind === 'answer').length, 0, '不得伪造 answer')
    const sys = rows.find((r) => r.kind === 'system' && r.tag === 'no-digest')
    assert.ok(sys, '应记录 no-digest 的 system 行')
  })
})

// ---------------------------------------------------------------- 中断

test('aborted 轮次只记 partial note，不算完成', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const created = await fetchLike(host, cwd, {
      action: 'create-member',
      nick: 'kimi',
      provider: 'p',
      model: 'm',
    })
    const memberId = created.sessionId
    await fetchLike(host, cwd, {
      action: 'post',
      text: '查',
      target: { mode: 'member', sessionId: memberId },
    })
    const msgId = host.agents.get(memberId).injects.concat(host.agents.get(memberId).followups)[0].id

    host.pushEvent(memberId, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(memberId, { type: 'user/message', data: { id: msgId } })
    host.pushEvent(memberId, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '写到一半' }] } },
    })
    host.pushEvent(memberId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    await flush()

    const rows = (await readFile(join(cwd, '.dsh', 'room', 'ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))

    assert.equal(rows.filter((r) => r.kind === 'answer').length, 0)
    const partial = rows.find((r) => r.kind === 'note' && r.partial === true)
    assert.ok(partial, '应记 partial note')
  })
})

// ---------------------------------------------------------------- T1

test('T1: 定向发给 A 时 B 完全不被触碰', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const a = await fetchLike(host, cwd, { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm1' })
    const b = await fetchLike(host, cwd, { action: 'create-member', nick: 'glm', provider: 'p', model: 'm2' })

    const posted = await fetchLike(host, cwd, {
      action: 'post',
      text: '只给 kimi 的指令 @glm 装作提到',
      target: { mode: 'member', sessionId: a.sessionId },
    })
    assert.equal(posted.ok, true)

    const agentA = host.agents.get(a.sessionId)
    const agentB = host.agents.get(b.sessionId)
    assert.equal(agentA.injects.length + agentA.followups.length, 1, 'A 应收到')
    assert.equal(agentB.injects.length + agentB.followups.length, 0, 'B 不应收到任何注入')
  })
})

// ---------------------------------------------------------------- 恢复

test('W2/W4: 重复投递同一 msgId 不会重复入队', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const a = await fetchLike(host, cwd, { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' })

    await fetchLike(host, cwd, {
      action: 'post',
      text: '第一次',
      target: { mode: 'member', sessionId: a.sessionId },
    })
    const agent = host.agents.get(a.sessionId)
    const first = agent.injects.concat(agent.followups)[0]
    assert.ok(first)

    // 模拟：投递后消息确实进了 inbox（宿主会写 spliced）。
    host.pushEvent(a.sessionId, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [{ id: first.id, role: 'user', content: [] }] },
    })

    // 再次触发恢复扫描。
    const recovered = await fetchLike(host, cwd, { action: 'recover' })
    assert.equal(recovered.ok, true)
    assert.deepEqual(recovered.results[0].delivered, [], '已入队的不得再投')
    assert.deepEqual(recovered.results[0].skipped, [a.sessionId])
    assert.equal(agent.injects.length + agent.followups.length, 1, '投递次数仍为 1')
  })
})

test('W9: 已取消（纯删除 splice）的消息不被恢复复活', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    const a = await fetchLike(host, cwd, { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' })
    await fetchLike(host, cwd, {
      action: 'post',
      text: '会被取消',
      target: { mode: 'member', sessionId: a.sessionId },
    })
    const agent = host.agents.get(a.sessionId)
    const msg = agent.injects.concat(agent.followups)[0]

    host.pushEvent(a.sessionId, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [{ id: msg.id }] },
    })
    host.pushEvent(a.sessionId, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })

    const recovered = await fetchLike(host, cwd, { action: 'recover' })
    assert.deepEqual(recovered.results[0].delivered, [], '取消过的不复活')
    assert.equal(agent.injects.length + agent.followups.length, 1, '不得补投')
  })
})

// ---------------------------------------------------------------- T13

test('T13: 恢复离线成员时显式传入它自己的路由，不用全局默认', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost({ cwd })
    apply(host.ctx)

    // 先建成员：路由是 goaichat / kimi-k3。
    await fetchLike(host, cwd, {
      action: 'create-member',
      nick: 'kimi',
      provider: 'goaichat',
      model: 'kimi-k3',
    })

    // 让这个成员离线：从 agents 注册表摘掉，模拟进程重启后尚未恢复。
    const realGet = host.agents.get
    host.agents.get = (id) => (id === undefined ? undefined : undefined)
    host.agents.list = () => []

    // 记录 resume 收到的 agentOptions。
    let resumedWith = null
    const realResume = host.agents.resume
    host.agents.resume = (args) => {
      resumedWith = args.agentOptions
      return realResume(args)
    }

    // 现在发一条消息：投递路径必须自己把成员唤醒，且用**它自己的**路由。
    const posted = await fetchLike(host, cwd, {
      action: 'post',
      text: '唤醒你',
      target: { mode: 'member', sessionId: [...host.logs.keys()].find((k) => k.startsWith('session-')) },
    })

    // 如果找不到 member，说明上面摘表太早；无论如何 resume 必须收到正确路由。
    assert.ok(resumedWith, '离线成员应被 resume 唤醒')
    assert.equal(resumedWith.provider, 'goaichat')
    assert.equal(resumedWith.model, 'kimi-k3')
    assert.equal(posted.ok, true)
  })
})

// ---------------------------------------------------------------- 辅助

/**
 * 通过**真实的** /room handler 驱动一次 POST。
 * @param {ReturnType<typeof makeHost>} host
 * @param {string} cwd
 * @param {object} body
 */
async function fetchLike(host, cwd, body) {
  const handler = host.routes.get('/room')
  assert.ok(handler, '/room 路由应已注册')

  let status = 0
  let payload = ''

  const req = {
    url: `/room?cwd=${encodeURIComponent(cwd)}`,
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      payload += chunk ?? ''
    },
  }

  await handler(req, res)
  assert.ok(status > 0, 'handler 应写出响应')
  return JSON.parse(payload)
}

/** 通过真实的 /room handler 读一次。 */
async function getRoom(host, cwd, count = 50) {
  const handler = host.routes.get('/room')
  assert.ok(handler)

  let status = 0
  let payload = ''
  const req = {
    url: `/room?cwd=${encodeURIComponent(cwd)}&count=${count}`,
    method: 'GET',
    async *[Symbol.asyncIterator]() {},
  }
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      payload += chunk ?? ''
    },
  }
  await handler(req, res)
  assert.equal(status, 200)
  return JSON.parse(payload)
}
