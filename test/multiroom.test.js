/**
 * 多房间测试：一个工作区里可以有多个独立房间，各自账本、各自成员。
 * 覆盖：建房间、房间隔离、默认房间向后兼容、索引落盘。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'

import { apply } from '../lib/index.js'
import { trackDisposer, disposeHosts } from './lifecycle.js'

/** 最小假宿主（与 host.test.js 同构，但更小）。 */
function makeHost(cwd) {
  const listeners = []
  const tools = new Map()
  const routes = new Map()
  const agentsById = new Map()
  const logs = new Map()
  /** sessionId → 标题，模拟宿主的 sessionTitle 服务。 */
  const titles = new Map()
  /** sessionId → agents.create 收到的 meta，用于断言 agentPreset 等字段。 */
  const createMetas = new Map()
  /** preset 挂载记录，用于断言 setup 真的调了 mount。 */
  const mountedPresets = []

  const sessions = {
    get(id) {
      const log = logs.get(id)
      if (log === undefined) return undefined
      return {
        id,
        get seq() { return log.length },
        eventAt(seq) { return log[seq] },
        header: { cwd },
        requestHeader() { return { config: { provider: 'p', model: 'm' } } },
      }
    },
  }

  function makeAgent(sessionId, route) {
    return {
      id: sessionId,
      status: 'idle',
      route,
      injects: [],
      followups: [],
      inject(m) { this.injects.push(m) },
      followup(m) { this.followups.push(m); this.status = 'running' },
      get session() { return sessions.get(sessionId) },
    }
  }

  const agents = {
    list: () => [...agentsById.values()],
    get: (id) => agentsById.get(id),
    async create({ sessionId, agentOptions, meta, setup }) {
      logs.set(sessionId, [])
      createMetas.set(sessionId, meta ?? {})
      const agent = makeAgent(sessionId, agentOptions)
      agentsById.set(sessionId, agent)
      // 真实宿主会在发布前调用 setup；这里同样调用，以便断言 mount 被执行。
      if (typeof setup === 'function') await setup({ id: 'fake-agent-ctx' }, agent)
      return { agent }
    },
    resume({ resumeSessionId, agentOptions }) {
      const agent = makeAgent(resumeSessionId, agentOptions)
      agentsById.set(resumeSessionId, agent)
      return Promise.resolve({ agent })
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(t) { tools.set(t.name, t) } },
    agents,
    sessions,
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    on(event, fn) { if (event === 'session/event') listeners.push(fn) },
    effect(fn) { const d = fn(); trackDisposer(cwd, d); return () => d?.() },
    workspaceRegistry: { list: () => [{ path: cwd, title: 'test' }] },
    sessionQuery: { readSession: () => Promise.resolve({ events: [] }) },
    sessionController: {
      modelCatalog: () => Promise.resolve({
        groups: [{ id: 'p', name: '测试', models: [{ id: 'm' }, { id: 'm2' }] }],
        failures: [],
      }),
    },
    sessionTitle: {
      get: (session) => {
        const t = titles.get(session?.id)
        return t === undefined ? undefined : { title: t }
      },
      rename: (session, title) => {
        titles.set(session.id, title)
        return { title }
      },
    },
    agentPresets: {
      mount: async (agentCtx, preset) => {
        mountedPresets.push({ agentCtx, preset })
        return { id: preset }
      },
    },
    // 模拟 cordis 反射层：插件用 ctx.get('sessionTitle') 做可选依赖。
    get(name) {
      return this[name]
    },
  }

  /** 往某会话日志追加一条事件，并同步广播给插件监听器。 */
  function pushEvent(sessionId, event) {
    const log = logs.get(sessionId) ?? []
    const seq = log.length
    const full = { ...event, seq }
    log.push(full)
    logs.set(sessionId, log)
    for (const fn of listeners) {
      try {
        fn(sessions.get(sessionId), full)
      } catch {
        // 监听器异常不影响测试驱动
      }
    }
    return full
  }

  return { ctx, tools, routes, agents, logs, pushEvent, titles, createMetas, mountedPresets }
}

/** 用真实 handler 发一次请求。 */
async function call(host, { url, method = 'GET', body }) {
  const handler = host.routes.get('/room')
  assert.ok(handler, '/room 应已注册')

  let status = 0
  let payload = ''
  const req = {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = {
    writeHead(code) { status = code },
    end(chunk) { payload += chunk ?? '' },
  }
  await handler(req, res)
  return { status, json: payload === '' ? null : JSON.parse(payload) }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-multi-'))
  try {
    return await fn(dir)
  } finally {
    await disposeHosts(dir)
    await rm(dir, { recursive: true, force: true })
  }
}

const enc = encodeURIComponent

test('创建房间：返回 roomId，并写进 rooms.json', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const r = await call(host, {
      url: `/room?cwd=${enc(cwd)}`,
      method: 'POST',
      body: { action: 'create-room', cwd, name: '审查室' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.roomId)

    const index = JSON.parse(await readFile(join(cwd, '.dsh', 'room', 'rooms.json'), 'utf8'))
    assert.equal(index.length, 1)
    assert.equal(index[0].name, '审查室')
    assert.equal(index[0].id, r.json.roomId)
  })
})

test('房间名不能重复、不能为空', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const mk = (name) => call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST', body: { action: 'create-room', cwd, name },
    })

    assert.equal((await mk('A')).json.ok, true)
    assert.equal((await mk('A')).json.error, 'room-name-taken')
    assert.equal((await mk('  ')).json.error, 'room-name-empty')
  })
})

test('多个房间相互隔离：成员与消息各自独立', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 默认房间建一个成员
    const m1 = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`,
      method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    assert.equal(m1.json.ok, true, JSON.stringify(m1.json))

    // 新房间建另一个成员
    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST', body: { action: 'create-room', cwd, name: 'B' },
    })
    assert.equal(room.json.ok, true)
    const rid = room.json.roomId

    const m2 = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`,
      method: 'POST',
      body: { action: 'create-member', nick: 'glm', provider: 'p', model: 'm2' },
    })
    assert.equal(m2.json.ok, true, JSON.stringify(m2.json))

    // 各自只看到自己的成员
    const a = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    const b = await call(host, { url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}` })
    assert.deepEqual(a.json.members.map((m) => m.nick), ['kimi'])
    assert.deepEqual(b.json.members.map((m) => m.nick), ['glm'])

    // 各自的账本文件是分开的
    const aLedger = await readFile(join(cwd, '.dsh', 'room', 'ledger.jsonl'), 'utf8')
    const bLedger = await readFile(join(cwd, '.dsh', 'room', 'rooms', rid, 'ledger.jsonl'), 'utf8')
    assert.ok(aLedger.includes('kimi'))
    assert.ok(!aLedger.includes('glm'))
    assert.ok(bLedger.includes('glm'))
    assert.ok(!bLedger.includes('kimi'))
  })
})

test('清单同时列出默认房间与额外房间', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`,
      method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST', body: { action: 'create-room', cwd, name: 'B' },
    })

    const list = await call(host, { url: '/room' })
    const ids = list.json.rooms.map((r) => r.roomId).sort()
    assert.deepEqual(ids, ['default', room.json.roomId].sort())
    assert.ok(list.json.rooms.every((r) => r.cwd === realpathSync.native(cwd)))
  })
})

test('向后兼容：只有旧 ledger.jsonl 时，默认房间照常出现', async () => {
  await withTempDir(async (cwd) => {
    const dir = join(cwd, '.dsh', 'room')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'ledger.jsonl'),
      JSON.stringify({ seq: 1, kind: 'system', msgId: 'x', tag: 'member', nick: 'kimi', session: 's1', digest: 'kimi 加入房间' }) + '\n',
      'utf8',
    )

    const host = makeHost(cwd)
    apply(host.ctx)

    const list = await call(host, { url: '/room' })
    assert.equal(list.json.rooms.length, 1)
    assert.equal(list.json.rooms[0].roomId, 'default')

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    assert.deepEqual(room.json.members.map((m) => m.nick), ['kimi'])
  })
})

test('陌生 roomId 不会读到别的房间数据', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`,
      method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })

    const other = await call(host, { url: `/room?cwd=${enc(cwd)}&room=nonexistent` })
    assert.equal(other.json.ok, true)
    assert.deepEqual(other.json.members, [])
    assert.deepEqual(other.json.rows, [])
  })
})

// ---------------------------------------------------------------- 广播

test('@所有人：一条消息投递给全部成员', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const b = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'create-member', nick: 'glm', provider: 'p', model: 'm2' },
    })

    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'post', text: '两位好', target: { mode: 'all' } },
    })
    assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
    assert.equal(posted.json.delivered.length, 2)
    assert.deepEqual(
      posted.json.delivered.sort(),
      [a.json.sessionId, b.json.sessionId].sort(),
    )

    // 两边都真的收到了注入
    const agentA = host.agents.get(a.json.sessionId)
    const agentB = host.agents.get(b.json.sessionId)
    assert.equal(agentA.injects.length + agentA.followups.length, 1)
    assert.equal(agentB.injects.length + agentB.followups.length, 1)

    // 账本里 targets 冻结为两个 sessionId
    const room = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    const ask = room.json.rows.find((r) => r.kind === 'ask')
    assert.equal(ask.targets.length, 2)
  })
})

test('空房间广播：明确报错，不静默成功', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'post', text: '有人吗', target: { mode: 'all' } },
    })
    assert.equal(posted.json.ok, false)
    assert.equal(posted.json.error, 'no-members')
  })
})

// ---------------------------------------------------------------- 加入既有会话

test('加入既有会话：复用它的 sessionId 与路由，并写进成员表', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 先造一个"已有会话"（模拟正在对话的那个）
    const { agent } = await host.ctx.agents.create({
      sessionId: 'session-existing-1',
      meta: { cwd },
      agentOptions: { provider: 'p', model: 'm' },
    })
    agent.status = 'idle'

    const added = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-existing-1', nick: '我' },
    })
    assert.equal(added.json.ok, true, JSON.stringify(added.json))
    assert.equal(added.json.sessionId, 'session-existing-1')
    assert.equal(added.json.route.provider, 'p')

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    assert.deepEqual(room.json.members.map((m) => m.nick), ['我'])
    assert.ok(!room.json.candidates.some((c) => c.sessionId === 'session-existing-1'),
      '已加入的会话不应再出现在候选里')
  })
})

test('加入既有会话：重复加入是幂等的', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    await host.ctx.agents.create({
      sessionId: 'session-x', meta: { cwd }, agentOptions: { provider: 'p', model: 'm' },
    })

    const first = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-x', nick: 'A' },
    })
    const second = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-x', nick: 'B' },
    })
    assert.equal(first.json.ok, true)
    assert.equal(second.json.alreadyMember, true)
    assert.equal(second.json.nick, 'A', '不应改名')

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.equal(room.json.members.length, 1)
  })
})

test('加入既有会话：未知会话被拒绝', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const r = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-nope', nick: 'A' },
    })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error, 'unknown-session')
  })
})

// ---------------------------------------------------------------- 移除成员

test('移除成员：成员表更新，账本留 member-remove，之后广播只发剩下的人', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const b = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'glm', provider: 'p', model: 'm2' },
    })

    const removed = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'remove-member', sessionId: b.json.sessionId },
    })
    assert.equal(removed.json.ok, true)
    assert.equal(removed.json.nick, 'glm')

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.deepEqual(room.json.members.map((m) => m.nick), ['kimi'])
    assert.ok(room.json.rows.some((r) => r.tag === 'member-remove' && r.session === b.json.sessionId))

    // 广播只投给剩下的人
    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '还在吗', target: { mode: 'all' } },
    })
    assert.deepEqual(posted.json.delivered, [a.json.sessionId])

    // 被移除的成员不再收到注入
    const agentB = host.agents.get(b.json.sessionId)
    assert.equal(agentB.injects.length + agentB.followups.length, 0)
  })
})

test('移除成员：移除后可以再以新昵称加入', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'remove-member', sessionId: a.json.sessionId },
    })
    const again = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: a.json.sessionId, nick: 'kimi2' },
    })
    assert.equal(again.json.ok, true)

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.deepEqual(room.json.members.map((m) => m.nick), ['kimi2'])
  })
})

// ---------------------------------------------------------------- 同模型多实例

test('同一供应商的同一模型可以重复建成员（不同昵称）', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const mk = (nick) => call(host, {
      url: `/room?cwd=${enc(cwd)}`,
      method: 'POST',
      body: { action: 'create-member', nick, provider: 'p', model: 'm' },
    })

    const a = await mk('reviewer-A')
    const b = await mk('reviewer-B')
    assert.equal(a.json.ok, true, JSON.stringify(a.json))
    assert.equal(b.json.ok, true, JSON.stringify(b.json))
    assert.notEqual(a.json.sessionId, b.json.sessionId, '应是两个独立会话')
    assert.deepEqual(a.json.route, b.json.route, '路由相同是允许的')

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.equal(room.json.members.length, 2)
    assert.deepEqual(room.json.members.map((m) => m.route.model), ['m', 'm'])

    // 广播时两个同模型成员各收一份，互不影响
    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '两位评审', target: { mode: 'all' } },
    })
    assert.equal(posted.json.delivered.length, 2)
    const agentA = host.agents.get(a.json.sessionId)
    const agentB = host.agents.get(b.json.sessionId)
    assert.equal(agentA.injects.length + agentA.followups.length, 1)
    assert.equal(agentB.injects.length + agentB.followups.length, 1)
  })
})

test('同模型重复建成员：昵称仍然必须唯一', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const mk = (nick) => call(host, {
      url: `/room?cwd=${enc(cwd)}`,
      method: 'POST',
      body: { action: 'create-member', nick, provider: 'p', model: 'm' },
    })

    assert.equal((await mk('same')).json.ok, true)
    const dup = await mk('same')
    assert.equal(dup.json.ok, false)
    assert.equal(dup.json.error, 'nick-taken')
  })
})

test('同模型的不同会话可以分别加入；同一个会话不能重复加入', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 两个独立会话，路由相同
    await host.ctx.agents.create({
      sessionId: 'session-a', meta: { cwd }, agentOptions: { provider: 'p', model: 'm' },
    })
    await host.ctx.agents.create({
      sessionId: 'session-b', meta: { cwd }, agentOptions: { provider: 'p', model: 'm' },
    })

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-a', nick: 'A' },
    })
    const b = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-b', nick: 'B' },
    })
    assert.equal(a.json.ok, true)
    assert.equal(b.json.ok, true)

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.equal(room.json.members.length, 2, '两个同模型会话都能进')
    assert.deepEqual(room.json.members.map((m) => m.route.model), ['m', 'm'])

    // 同一个会话再拉一次：幂等，不新增
    const again = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'add-member', sessionId: 'session-a', nick: 'A2' },
    })
    assert.equal(again.json.alreadyMember, true)
    const room2 = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    assert.equal(room2.json.members.length, 2, '重复加入不新增成员')
  })
})


// ---------------------------------------------------------------- 指针正确性

test('投递指针里的 seq 必须是真实序号，不能是 0', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })

    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '各位好', target: { mode: 'all' } },
    })
    assert.equal(posted.json.ok, true, JSON.stringify(posted.json))

    const agent = host.agents.get(a.json.sessionId)
    const message = agent.injects.concat(agent.followups)[0]
    assert.ok(message, '应收到一条投递')

    const text = message.content.map((b) => b.text).join('')
    assert.ok(
      text.includes(`（seq ${posted.json.seq}）`),
      `指针应带真实 seq=${posted.json.seq}，实际: ${text.split('\n')[0]}`,
    )
    assert.ok(!text.includes('（seq 0）'), '不得写出 seq 0')
    assert.ok(text.includes(`room_read({ seq: ${posted.json.seq} })`), '读全文指令也要用真实 seq')

    // source 里的 seq 同样必须是真实的
    assert.equal(message.source.seq, posted.json.seq)
  })
})

test('room_read(seq) 能按指针里的序号取回人类原文', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '很长的指令'.repeat(50), target: { mode: 'all' } },
    })

    // 用成员身份调用 room_read
    const tool = host.tools.get('room_read')
    const agent = host.agents.get(a.json.sessionId)
    const read = await tool.execute({ seq: posted.json.seq }, { agent })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.ok(read.text.includes('很长的指令'.repeat(50)), '应能取回完整原文')
  })
})

// ---------------------------------------------------------------- 删除房间 / 空房间

test('空房间不出现在清单里（默认房间的空账本不算房间）', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 仅仅"读一次"默认房间：会创建空账本文件
    const empty = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    assert.equal(empty.json.ok, true)
    assert.equal(empty.json.rows.length, 0)

    // 但清单里不应该出现它
    const list = await call(host, { url: '/room' })
    assert.equal(list.json.rooms.length, 0, '空默认房间不应被列出')
  })
})

test('删除空房间：目录与索引项一起消失', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '临时室' },
    })
    const rid = room.json.roomId
    assert.ok(await exists_(join(cwd, '.dsh', 'room', 'rooms', rid)))

    const del = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'delete-room' },
    })
    assert.equal(del.json.ok, true, JSON.stringify(del.json))
    assert.ok(!(await exists_(join(cwd, '.dsh', 'room', 'rooms', rid))), '目录应被删除')

    const list = await call(host, { url: '/room' })
    assert.equal(list.json.rooms.length, 0)
  })
})

test('删除非空房间默认被拒绝，force 才删', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })

    const refused = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'delete-room' },
    })
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error, 'room-not-empty')

    const forced = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=default`, method: 'POST',
      body: { action: 'delete-room', force: true },
    })
    assert.equal(forced.json.ok, true, JSON.stringify(forced.json))
  })
})

/** 本地 exists（避免再引入依赖）。 */
async function exists_(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 回填到正确房间

test('回填写进成员所在的房间，而不是默认房间', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 建一个额外房间，并在里面建成员
    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '工作间' },
    })
    const rid = room.json.roomId
    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId

    // 人发一条定向消息
    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'post', text: '干活', target: { mode: 'member', sessionId: sid } },
    })
    assert.equal(posted.json.ok, true)

    // 模拟该会话跑完一轮。
    // ⚠️ 必须走 pushEvent：直接改 logs 数组不会通知插件监听器，
    //    于是 turnInputIds 里没有 msgId，回填会被判成"不是房间的 turn"。
    const delivered = host.agents.get(sid).injects.concat(host.agents.get(sid).followups)[0]
    assert.ok(delivered, '应收到投递')

    host.pushEvent(sid, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(sid, { type: 'user/message', data: { id: delivered.id } })
    host.pushEvent(sid, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '干完了。' }] } },
    })
    host.pushEvent(sid, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // 等事件链落地
    await new Promise((r) => setTimeout(r, 50))

    const inRoom = await call(host, { url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}` })
    const answers = inRoom.json.rows.filter((r) => r.kind === 'answer')
    assert.equal(answers.length, 1, `房间内应有 1 条 answer，实际 rows=${JSON.stringify(inRoom.json.rows.map((r) => r.kind))}`)
    assert.match(answers[0].digest, /干完了/)

    // 默认房间不应被写入
    const inDefault = await call(host, { url: `/room?cwd=${enc(cwd)}&room=default` })
    assert.equal(inDefault.json.rows.filter((r) => r.kind === 'answer').length, 0,
      '默认房间不应收到回填')
  })
})

// ---------------------------------------------------------------- room_post 的 sourceSeq / room_read 兜底

/** 造一条 assistant/message 事件（本文件内联，避免依赖 decide.test.js 的辅助函数）。 */
function assistantEvent(turn, step, blocks) {
  return { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: blocks } } }
}

test('room_post(answer) 的 sourceSeq 指向最终回答，不是中途 narration', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId
    const agent = host.agents.get(sid)

    // 人发一条定向消息，让这一轮被判定为「房间的 turn」
    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '给个结论', target: { mode: 'member', sessionId: sid } },
    })
    assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
    const delivered = agent.injects.concat(agent.followups)[0]
    assert.ok(delivered, '应收到投递')

    host.pushEvent(sid, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(sid, { type: 'user/message', data: { id: delivered.id } })
    // step 1：中途 narration + 工具调用
    host.pushEvent(sid, assistantEvent(1, 1, [
      { type: 'text', text: '我先在账本里查一下。' },
      { type: 'tool-call', name: 'room_read' },
    ]))
    // step 2：纯 tool-call，没有 text 块（旧逻辑会把这个 seq 当成 sourceSeq → 读出空正文）
    host.pushEvent(sid, assistantEvent(1, 2, [{ type: 'tool-call', name: 'bash' }]))

    // AI 在工具步骤里发布最终结果
    const postTool = host.tools.get('room_post')
    const wrote = await postTool.execute({ kind: 'answer', digest: '结论：没有官方复刻。' }, { agent })
    assert.equal(wrote.ok, true, JSON.stringify(wrote))

    // step 3：工具步骤之后的最终可见回答
    host.pushEvent(sid, assistantEvent(1, 3, [
      { type: 'reasoning', text: '整理一下' },
      { type: 'text', text: '## 结论\n\n没有官方复刻。' },
    ]))

    const read = await host.tools.get('room_read').execute({ seq: wrote.seq }, { agent })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.match(read.text, /没有官方复刻/, `应取到最终回答，实际: ${JSON.stringify(read.text)}`)
  })
})

test('room_read(seq)：answer 行没有 sourceSeq 时按 (session, turn) 兜底', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId
    const agent = host.agents.get(sid)

    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '干活', target: { mode: 'member', sessionId: sid } },
    })
    assert.equal(posted.json.ok, true)

    // 跑一轮完整 turn（不带 room_post，交宿主自动回填）
    host.pushEvent(sid, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(sid, { type: 'user/message', data: { id: agent.injects.concat(agent.followups)[0].id } })
    host.pushEvent(sid, assistantEvent(1, 1, [{ type: 'text', text: '第 1 步的过渡话。' }]))
    host.pushEvent(sid, assistantEvent(1, 2, [{ type: 'text', text: '干活完成：账本已核。' }]))
    host.pushEvent(sid, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 50))

    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    const answer = room.json.rows.find((r) => r.kind === 'answer')
    assert.ok(answer, `应有自动回填的 answer，实际: ${JSON.stringify(room.json.rows)}`)
    assert.ok(answer.sourceSeq !== undefined, '自动回填应带 sourceSeq')

    // 手工把账本里的 sourceSeq 抹掉，模拟"老账本 / 源码尚未写入"的情形
    const ledgerPath = join(cwd, '.dsh', 'room', 'ledger.jsonl')
    const lines = (await readFile(ledgerPath, 'utf8')).split('\n').filter((l) => l !== '')
    const patched = lines.map((line) => {
      const row = JSON.parse(line)
      if (row.kind === 'answer') delete row.sourceSeq
      return JSON.stringify(row)
    })
    await writeFile(ledgerPath, patched.join('\n') + '\n', 'utf8')

    // 另起一个宿主重新加载账本，确保读到的是磁盘上的无 sourceSeq 版本
    await disposeHosts(cwd)
    const host2 = makeHost(cwd)
    apply(host2.ctx)
    // 复用同一个 sessionId 的会话日志与 agent（agent 的 cwd 靠 host2.makeAgent 挂上）
    host2.logs.set(sid, [...host.logs.get(sid)])
    const { agent: agent2 } = await host2.agents.create({ sessionId: sid, agentOptions: {} })

    const read = await host2.tools.get('room_read').execute({ seq: answer.seq }, { agent: agent2 })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.match(
      read.text,
      /干活完成：账本已核/,
      `没有 sourceSeq 时应按 (session,turn) 兜底取最终回答，实际: ${JSON.stringify(read.text)}`,
    )
  })
})

test('room_read(seq)：sourceSeq 指向「中途叙述」时跳过它，返回最终回答', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId
    const agent = host.agents.get(sid)

    const posted = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '审查一下', target: { mode: 'member', sessionId: sid } },
    })
    assert.equal(posted.json.ok, true, JSON.stringify(posted.json))

    host.pushEvent(sid, { type: 'turn/start', data: { turn: 1 } })
    host.pushEvent(sid, { type: 'user/message', data: { id: agent.injects.concat(agent.followups)[0].id } })

    // step 1：有 text 但也有 tool-call —— 这是"中途叙述"，不是结论
    const narration = host.pushEvent(sid, assistantEvent(1, 1, [
      { type: 'text', text: '我先深入审查一下这个插件。' },
      { type: 'tool-call', name: 'bash' },
    ]))

    const postTool = host.tools.get('room_post')
    const wrote = await postTool.execute({ kind: 'answer', digest: '审查完成：有 3 个问题。' }, { agent })
    assert.equal(wrote.ok, true, JSON.stringify(wrote))

    // step 3：真正的最终回答（无 tool-call）
    host.pushEvent(sid, assistantEvent(1, 3, [
      { type: 'text', text: '## 审查结论\n\n1. 幽灵房间\n2. 缺类型守卫\n3. depth 未用' },
    ]))

    // 伪造一条"老账本"：sourceSeq 指向中途叙述（旧代码就是这么写的）
    const ledgerPath = join(cwd, '.dsh', 'room', 'ledger.jsonl')
    const lines = (await readFile(ledgerPath, 'utf8')).split('\n').filter((l) => l !== '')
    const patched = lines.map((line) => {
      const row = JSON.parse(line)
      if (row.kind === 'answer') row.sourceSeq = narration.seq
      return JSON.stringify(row)
    })
    await writeFile(ledgerPath, patched.join('\n') + '\n', 'utf8')

    // 新宿主重新加载账本
    await disposeHosts(cwd)
    const host2 = makeHost(cwd)
    apply(host2.ctx)
    // ⚠️ 先 create 再灌日志：makeAgent 的 create 会把该 session 的日志清空。
    const { agent: agent2 } = await host2.agents.create({ sessionId: sid, agentOptions: {} })
    host2.logs.set(sid, [...host.logs.get(sid)])

    const read = await host2.tools.get('room_read').execute({ seq: wrote.seq }, { agent: agent2 })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.match(
      read.text,
      /审查结论/,
      `应跳过中途叙述、返回最终回答，实际: ${JSON.stringify(read.text)}`,
    )
    assert.ok(
      !/我先深入审查一下/.test(read.text),
      `不应返回中途叙述，实际: ${JSON.stringify(read.text)}`,
    )
  })
})

// ---------------------------------------------------------------- 幽灵房间

test('GET 不存在的房间：返回空视图，但不在磁盘上建目录', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const ghost = await call(host, { url: `/room?cwd=${enc(cwd)}&room=deadbeef` })
    assert.equal(ghost.json.ok, true)
    assert.equal(ghost.json.exists, false, '不存在的房间应标记 exists:false')
    assert.deepEqual(ghost.json.rows, [])
    assert.deepEqual(ghost.json.members, [])

    // 关键：磁盘上不能出现这个房间的目录
    const dir = join(cwd, '.dsh', 'room', 'rooms', 'deadbeef')
    let made = true
    try {
      await stat(dir)
    } catch {
      made = false
    }
    assert.equal(made, false, `GET 不应创建目录: ${dir}`)
  })
})

test('POST 到不存在的非默认房间：404 room-not-found', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const r = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=deadbeef`, method: 'POST',
      body: { action: 'post', text: '在吗', target: { mode: 'all' } },
    })
    assert.equal(r.status, 404)
    assert.equal(r.json.error, 'room-not-found')

    // 也不该因为这次 POST 建出目录
    const dir = join(cwd, '.dsh', 'room', 'rooms', 'deadbeef')
    let made = true
    try {
      await stat(dir)
    } catch {
      made = false
    }
    assert.equal(made, false, 'POST 失败的房间不应留下目录')
  })
})

test('重启后房间尚未被访问过：room_post 仍写进成员所在的房间，不落默认房间', async () => {
  await withTempDir(async (cwd) => {
    // ---- 第一个宿主：建房间 + 成员 + 一条消息
    const host1 = makeHost(cwd)
    apply(host1.ctx)

    const room = await call(host1, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '工作室' },
    })
    const rid = room.json.roomId
    const m = await call(host1, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId

    // ---- 第二个宿主：内存里没有任何房间（模拟重启后还没打开过房间页）
    await disposeHosts(cwd)
    const host2 = makeHost(cwd)
    apply(host2.ctx)

    const log = [...(host1.logs.get(sid) ?? [])]
    const { agent } = await host2.agents.resume({ resumeSessionId: sid, agentOptions: { provider: 'p', model: 'm' } })
    host2.logs.set(sid, log)
    host2.pushEvent(sid, { type: 'turn/start', data: { turn: 1 } })
    host2.pushEvent(sid, assistantEvent(1, 1, [{ type: 'text', text: '好的。' }]))

    const postTool = host2.tools.get('room_post')
    const wrote = await postTool.execute({ digest: '重启后写回执' }, { agent })
    assert.equal(wrote.ok, true, JSON.stringify(wrote))

    // 应当落在命名房间
    const inRoom = await call(host2, { url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}` })
    assert.ok(
      inRoom.json.rows.some((r) => r.digest === '重启后写回执'),
      `应写进「工作室」，实际 rows=${JSON.stringify(inRoom.json.rows.map((r) => r.digest))}`,
    )

    // 默认房间不应被创建
    let defaultLedger = true
    try {
      await stat(join(cwd, '.dsh', 'room', 'ledger.jsonl'))
    } catch {
      defaultLedger = false
    }
    assert.equal(defaultLedger, false, '不应在默认房间留下账本')
  })
})

// ---------------------------------------------------------------- 指针携带投递范围与昵称

test('投递指针写明「投递范围」和「你的昵称」', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const b = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'glm', provider: 'p', model: 'm2' },
    })

    const text = (sessionId) => {
      const agent = host.agents.get(sessionId)
      const m = agent.injects.concat(agent.followups)[0]
      return m.content.map((x) => x.text).join('')
    }

    // 1) 广播
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '全体注意', target: { mode: 'all' } },
    })
    assert.match(text(a.json.sessionId), /广播给房间全部 2 位成员/)
    assert.match(text(a.json.sessionId), /你的昵称：kimi/)
    assert.match(text(b.json.sessionId), /你的昵称：glm/)

    // 2) 定向（GUI 下拉选单人，mentions 为空）
    host.agents.get(b.json.sessionId).injects.length = 0
    host.agents.get(b.json.sessionId).followups.length = 0
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '只给你', target: { mode: 'member', sessionId: b.json.sessionId } },
    })
    assert.match(text(b.json.sessionId), /只发给你/)
    assert.ok(
      !/广播/.test(text(b.json.sessionId)),
      `定向消息不应说成广播: ${text(b.json.sessionId)}`,
    )

    // 3) 点名（走 mentioned 模式）
    host.agents.get(a.json.sessionId).injects.length = 0
    host.agents.get(a.json.sessionId).followups.length = 0
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '@kimi 你说', target: { mode: 'mentioned' } },
    })
    assert.match(text(a.json.sessionId), /点名了你/)
  })
})

// ---------------------------------------------------------------- 派单署名

test('room_post(to)：以自己昵称署名派单，并只投给目标', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'lead', provider: 'p', model: 'm' },
    })
    const b = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm2' },
    })

    const postTool = host.tools.get('room_post')
    const agent = host.agents.get(a.json.sessionId)

    const sent = await postTool.execute(
      { digest: '派单：算 1+1', to: 'kimi', text: '请计算 1+1，只回一行。' },
      { agent },
    )
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.delivered.length, 1)
    assert.deepEqual(sent.delivered, [b.json.sessionId])

    // 账本署名必须是 lead，不是"用户"
    const room = await call(host, { url: `/room?cwd=${enc(cwd)}` })
    const ask = room.json.rows.filter((r) => r.kind === 'ask').pop()
    assert.equal(ask.from, 'lead')
    assert.equal(ask.text, '请计算 1+1，只回一行。')

    // 目标真的收到了；发送者自己没收到
    assert.equal(host.agents.get(b.json.sessionId).injects.length + host.agents.get(b.json.sessionId).followups.length, 1)
    assert.equal(agent.injects.length + agent.followups.length, 0)
  })
})

test('room_post(to:all)：广播给其他成员，不投给自己', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const mk = (nick) => call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick, provider: 'p', model: 'm' },
    })
    const a = await mk('lead')
    const b = await mk('x')
    const c = await mk('y')

    const sent = await host.tools.get('room_post').execute(
      { digest: '全体注意', to: 'all', text: '全体注意，5 分钟后汇报。' },
      { agent: host.agents.get(a.json.sessionId) },
    )
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.delivered.length, 2)
    assert.deepEqual(sent.delivered.sort(), [b.json.sessionId, c.json.sessionId].sort())
    assert.ok(!sent.delivered.includes(a.json.sessionId), '不应投给自己')
  })
})

test('room_post(to)：未知昵称、发给自己都被拒绝', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'lead', provider: 'p', model: 'm' },
    })
    const tool = host.tools.get('room_post')
    const agent = host.agents.get(a.json.sessionId)

    const unknown = await tool.execute({ digest: 'x', to: 'nobody', text: 'hi' }, { agent })
    assert.equal(unknown.ok, false)
    assert.match(unknown.error, /unknown-member/)

    const self = await tool.execute({ digest: 'x', to: 'lead', text: 'hi' }, { agent })
    assert.equal(self.ok, false)
    assert.equal(self.error, 'cannot-send-to-self')

    const noText = await tool.execute({ digest: 'x', to: 'lead' }, { agent })
    assert.equal(noText.ok, false)
    assert.equal(noText.error, 'missing-text')
  })
})

// ---------------------------------------------------------------- 房间改名

test('rename-room：改名后清单里是新名字，重名被拒', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const a = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '甲' },
    })
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '乙' },
    })

    const r = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(a.json.roomId)}`, method: 'POST',
      body: { action: 'rename-room', name: '甲改' },
    })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))

    const list = await call(host, { url: '/room' })
    const names = list.json.rooms.map((x) => x.name)
    assert.ok(names.includes('甲改'), `清单应含新名字: ${names}`)
    assert.ok(!names.includes('甲'))

    const dup = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(a.json.roomId)}`, method: 'POST',
      body: { action: 'rename-room', name: '乙' },
    })
    assert.equal(dup.json.ok, false)
    assert.equal(dup.json.error, 'room-name-taken')
  })
})

// ---------------------------------------------------------------- 会话标题

test('建成员时把会话标题设成「房间名·昵称」，侧栏不再全是未命名', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '工作室' },
    })
    const rid = room.json.roomId
    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })

    assert.equal(host.titles.get(m.json.sessionId), '工作室·kimi')
  })
})

test('房间加载时给老成员补标题（历史遗留的未命名会话）', async () => {
  await withTempDir(async (cwd) => {
    // 第一个宿主：建房间 + 成员
    const host1 = makeHost(cwd)
    apply(host1.ctx)
    const room = await call(host1, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '旧室' },
    })
    const rid = room.json.roomId
    const m = await call(host1, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'glm', provider: 'p', model: 'm' },
    })

    // 第二个宿主：内存清空，等价于"重启后标题丢了"（titles 是新的空 Map）
    await disposeHosts(cwd)
    const host2 = makeHost(cwd)
    apply(host2.ctx)
    host2.logs.set(m.json.sessionId, [...(host1.logs.get(m.json.sessionId) ?? [])])

    // 打开房间 → 触发 hydrate 后的标题校准
    await call(host2, { url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}` })
    assert.equal(host2.titles.get(m.json.sessionId), '旧室·glm')
  })
})

test('会话已有自定义标题时，自动命名不得覆盖', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    const sid = m.json.sessionId
    // 用户手动改名
    host.titles.set(sid, '我的KIMI')

    // 再触发一次投递（会走 syncSessionTitle）
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '在吗', target: { mode: 'member', sessionId: sid } },
    })

    assert.equal(host.titles.get(sid), '我的KIMI', '用户自己起的名字不能被覆盖')
  })
})

// ---------------------------------------------------------------- SSE

test('SSE：注册了 /room/events，收到 hello/ready 与账本 change', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    assert.equal(m.json.ok, true)

    const handler = host.routes.get('/room/events')
    assert.ok(handler, '/room/events 应已注册')

    // 假的 ServerResponse：记录 writeHead / write / 事件
    const frames = []
    let ended = false
    const listeners = {}
    const res = {
      status: 0,
      headers: null,
      writeHead(code, headers) { this.status = code; this.headers = headers },
      flushHeaders() {},
      write(chunk) { frames.push(String(chunk)); return true },
      end() { ended = true },
      on(name, fn) { listeners[name] = fn },
    }

    const req = { url: `/room/events?cwd=${enc(cwd)}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    await handler(req, res)

    // 等异步的 roomFor + 订阅就位
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    assert.equal(res.headers['x-accel-buffering'], 'no', '必须显式禁止中间层缓冲')
    assert.ok(frames.some((f) => f.includes('event: hello')), '应推 hello')
    assert.ok(frames.some((f) => f.includes('event: ready')), '应推 ready')

    // 发一条新消息 → 应触发 change
    const before = frames.length
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '推我', target: { mode: 'member', sessionId: m.json.sessionId } },
    })
    await new Promise((r) => setTimeout(r, 60))

    const changeFrames = frames.slice(before).filter((f) => f.includes('event: change'))
    assert.ok(changeFrames.length >= 1, `应推 change，实际: ${JSON.stringify(frames.slice(before))}`)
    assert.match(changeFrames[0], /"kind":"ask"/)

    // 断开 → 不应再推
    listeners.close?.()
    const afterClose = frames.length
    await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'post', text: '断开后', target: { mode: 'member', sessionId: m.json.sessionId } },
    })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(frames.length, afterClose, '断开后不应继续推送')
  })
})

test('SSE：缺 cwd 返回 400；非环回来源返回 403', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)
    const handler = host.routes.get('/room/events')

    const make = () => {
      const res = {
        status: 0, body: '',
        writeHead(code) { this.status = code },
        flushHeaders() {},
        write(chunk) { this.body += chunk; return true },
        end(chunk) { if (chunk) this.body += chunk },
        on() {},
      }
      return res
    }

    const r1 = make()
    await handler({ url: '/room/events', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, r1)
    assert.equal(r1.status, 400)
    assert.match(r1.body, /missing-cwd/)

    const r2 = make()
    await handler(
      { url: `/room/events?cwd=${enc(cwd)}`, headers: {}, socket: { remoteAddress: '10.0.0.9' } },
      r2,
    )
    assert.equal(r2.status, 403)
    assert.match(r2.body, /forbidden-remote/)
  })
})

// ---------------------------------------------------------------- agentPreset

test('建成员必须带 agentPreset，否则成员会退化成只有 room_* 工具', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    assert.equal(m.json.ok, true, JSON.stringify(m.json))

    const meta = host.createMetas.get(m.json.sessionId)
    assert.ok(meta, '应记录 create 的 meta')
    assert.equal(
      meta.agentPreset,
      'standard',
      `成员会话必须带 preset，否则拿不到标准工具集；实际 meta=${JSON.stringify(meta)}`,
    )
  })
})

test('建成员时优先跟随同房间已有成员的 preset', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    // 先手工放一个带自定义 preset 的成员进房间
    const room = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-room', cwd, name: '定制室' },
    })
    const rid = room.json.roomId
    const first = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'a', provider: 'p', model: 'm' },
    })
    // 模拟该会话的 header 带自定义 preset
    const originalGet = host.ctx.sessions.get
    host.ctx.sessions.get = (id) => {
      const s = originalGet(id)
      if (s !== undefined && id === first.json.sessionId) {
        return { ...s, header: { ...s.header, agentPreset: 'anchored-standard' } }
      }
      return s
    }

    const second = await call(host, {
      url: `/room?cwd=${enc(cwd)}&room=${enc(rid)}`, method: 'POST',
      body: { action: 'create-member', nick: 'b', provider: 'p', model: 'm' },
    })
    assert.equal(second.json.ok, true, JSON.stringify(second.json))
    assert.equal(
      host.createMetas.get(second.json.sessionId).agentPreset,
      'anchored-standard',
      '应跟随同房间已有成员的 preset',
    )
  })
})

test('建成员必须在 setup 里真正 mount preset（只写 header 不够）', async () => {
  await withTempDir(async (cwd) => {
    const host = makeHost(cwd)
    apply(host.ctx)

    const m = await call(host, {
      url: `/room?cwd=${enc(cwd)}`, method: 'POST',
      body: { action: 'create-member', nick: 'kimi', provider: 'p', model: 'm' },
    })
    assert.equal(m.json.ok, true, JSON.stringify(m.json))

    // header 标记
    assert.equal(host.createMetas.get(m.json.sessionId).agentPreset, 'standard')

    // 真正的挂载：缺少这一步，成员会拿到默认组合（无 read/grep/pwsh）
    const mount = host.mountedPresets.find((x) => x.preset === 'standard')
    assert.ok(
      mount !== undefined,
      `必须在 setup 里调 agentPresets.mount；实际挂载记录=${JSON.stringify(host.mountedPresets)}`,
    )
    assert.ok(mount.agentCtx, 'mount 必须拿到 agent setup 的 context')
  })
})
