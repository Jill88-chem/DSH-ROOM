// 外部接入单测（阶段 A · 第 2 层）
//
// 覆盖：凭据生成/比对、Bearer 解析、注册幂等、昵称占用、撤销、
//       以及 /room/health /room/self /room/register 的鉴权边界。
//
// 这里用**真实 RoomWriter + 真实账本**，不用 stub —— 因为这一层最容易出
// "以为写进去了其实没写"的问题。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RoomWriter } from '../lib/ledger.js'
import {
  generateToken,
  generateRegistrationId,
  hashToken,
  tokenMatches,
  parseBearer,
  findMemberByToken,
  validateExternalNick,
} from '../lib/auth.js'
import { validateNick } from '../lib/decide.js'
import {
  loadProtocolState,
  ensureProtocolEnabled,
  registerExternalMember,
  revokeExternalMember,
  protocolSummary,
  issueEnrollmentToken,
} from '../lib/room-protocol.js'
import { createExternalRoutes, capabilities } from '../lib/http-external.js'
import { PROTOCOL_VERSION, makeMemberId } from '../lib/protocol.js'

// ---------------------------------------------------------------- 工具

async function withRoom(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-auth-'))
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
    }
    try {
      return await fn(room)
    } finally {
      await writer.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一个假的 res，收集状态码与 JSON。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(code) {
      this.status = code
    },
    end(chunk) {
      if (typeof chunk === 'string' && chunk !== '') this.body = JSON.parse(chunk)
    },
  }
}

/** 造一个假的 req。 */
function fakeReq({ method = 'GET', url = '/', headers = {}, body, remote = '127.0.0.1' } = {}) {
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  return req
}

// ---------------------------------------------------------------- 凭据

test('并发注册只消费一次入房凭据，原请求可重放但修改内容不行', async () => {
  await withRoom(async room => {
    await ensureProtocolEnabled(room)
    const issued = await issueEnrollmentToken(room)
    const original = { registrationId: generateRegistrationId(), memberToken: generateToken(), nick: 'codex',
      requireEnrollment: true, enrollmentTokenHash: hashToken(issued.enrollmentToken) }
    const other = { ...original, registrationId: generateRegistrationId(), memberToken: generateToken(), nick: 'other' }
    const results = await Promise.all([registerExternalMember(room, original), registerExternalMember(room, other)])
    assert.equal(results[0].ok, true); assert.equal(results[1].code, 'unauthorized')
    assert.equal((await registerExternalMember(room, original)).duplicate, true)
    assert.equal((await registerExternalMember(room, { ...original, displayName: 'changed' })).code, 'idempotency-conflict')
    await revokeExternalMember(room, results[0].memberId)
    assert.equal((await registerExternalMember(room, original)).code, 'unauthorized')
  })
})

test('generateToken：每次不同，长度足够', () => {
  const a = generateToken()
  const b = generateToken()
  assert.notEqual(a, b)
  assert.match(a, /^rt_[0-9a-f]{64}$/, '256 位随机 = 64 个十六进制字符')
})

test('hashToken / tokenMatches：只存摘要，比对恒定时间', () => {
  const token = generateToken()
  const hash = hashToken(token)

  assert.match(hash, /^sha256:[0-9a-f]{64}$/)
  assert.ok(!hash.includes(token), '摘要里不能含明文')
  assert.equal(tokenMatches(hash, token), true)
  assert.equal(tokenMatches(hash, generateToken()), false)
  assert.equal(tokenMatches(hash, ''), false)
  assert.equal(tokenMatches(undefined, token), false)
})

test('parseBearer：严格解析，非法格式返回 null', () => {
  assert.equal(parseBearer('Bearer rt_abc'), 'rt_abc')
  assert.equal(parseBearer('bearer rt_abc'), 'rt_abc', '大小写不敏感')
  assert.equal(parseBearer('  Bearer   rt_abc  '), 'rt_abc')
  assert.equal(parseBearer('rt_abc'), null, '缺 Bearer 前缀')
  assert.equal(parseBearer('Basic rt_abc'), null)
  assert.equal(parseBearer('Bearer'), null, '只有前缀')
  assert.equal(parseBearer(undefined), null)
  assert.equal(parseBearer(''), null)
})

test('validateExternalNick：复用既有规则并禁止保留词', () => {
  assert.equal(validateExternalNick('codex', validateNick).ok, true)
  assert.equal(validateExternalNick('all', validateNick).ok, false, 'all 是广播保留词')
  assert.equal(validateExternalNick('所有人', validateNick).ok, false)
  assert.equal(validateExternalNick('用户', validateNick).ok, false)
  assert.equal(validateExternalNick('system', validateNick).ok, false)
  assert.equal(validateExternalNick('a b', validateNick).ok, false, '空格非法')
})

// ---------------------------------------------------------------- 启用协议

test('ensureProtocolEnabled：首次启用写 roomUid，重复调用不重写', async () => {
  await withRoom(async (room) => {
    loadProtocolState(room)
    assert.equal(room.protocol.enabled, false, '初始未启用')

    const before = room.writer.rows.length
    const p1 = await ensureProtocolEnabled(room)
    assert.equal(p1.enabled, true)
    assert.match(p1.roomUid, /^[0-9a-f-]{36}$/)
    assert.equal(room.writer.rows.length, before + 1, '只写一条 protocol-enabled')

    const p2 = await ensureProtocolEnabled(room)
    assert.equal(p2.roomUid, p1.roomUid, 'roomUid 稳定')
    assert.equal(room.writer.rows.length, before + 1, '重复调用不再写账本')
  })
})

test('protocol-enabled 是内部事件，不进公开视图', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const row = room.writer.rows.at(-1)
    assert.equal(row.visibility, 'internal')
    const { isPublicRow } = await import('../lib/protocol.js')
    assert.equal(isPublicRow(row), false, '控制事件不能出现在房间页')
  })
})

// ---------------------------------------------------------------- 注册

test('registerExternalMember：分配稳定 memberId，只存摘要', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const regId = generateRegistrationId()
    const token = generateToken()

    const result = await registerExternalMember(room, {
      registrationId: regId,
      nick: 'codex',
      displayName: 'Codex',
      memberToken: token,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(
      result.memberId,
      makeMemberId(room.protocol.roomUid, 'external', regId + ':' + hashToken(token)),
      'memberId 由 registrationId + tokenHash 共同派生（防冒名）',
    )
    assert.equal(result.nick, 'codex')

    // 账本里不能出现明文 token
    const row = room.writer.rows.at(-1)
    const serialized = JSON.stringify(row)
    assert.ok(!serialized.includes(token), '账本绝不能存明文 token')
    assert.equal(row.tokenHash, hashToken(token))

    // 公开视图不能泄露摘要
    const { toPublicRow } = await import('../lib/protocol.js')
    const pub = toPublicRow(row)
    assert.ok(!('tokenHash' in pub), '公开视图剔除摘要')
  })
})

test('registerExternalMember：同 registrationId + 同 token 重放返回同一 memberId', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const regId = generateRegistrationId()
    const token = generateToken()

    const first = await registerExternalMember(room, {
      registrationId: regId,
      nick: 'codex',
      memberToken: token,
    })
    const countAfterFirst = room.writer.rows.length

    const second = await registerExternalMember(room, {
      registrationId: regId,
      nick: 'codex',
      memberToken: token,
    })

    assert.equal(second.ok, true)
    assert.equal(second.memberId, first.memberId, '必须返回同一个 memberId')
    assert.equal(second.duplicate, true)
    assert.equal(room.writer.rows.length, countAfterFirst, '重放不写账本')
  })
})

test('registerExternalMember：同 registrationId 但换 token 不认（防冒名）', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const regId = generateRegistrationId()
    const realToken = generateToken()

    const first = await registerExternalMember(room, {
      registrationId: regId,
      nick: 'codex',
      memberToken: realToken,
    })
    assert.equal(first.ok, true)

    // 攻击者拿到 registrationId，但用**自己的** token 注册
    const impostor = await registerExternalMember(room, {
      registrationId: regId,
      nick: 'codex2',
      memberToken: generateToken(),
    })

    // 能注册（昵称不同），但**绝不能**拿到原成员的 memberId
    assert.equal(impostor.ok, true)
    assert.equal(impostor.duplicate, false, '换 token 不算重放')
    assert.notEqual(impostor.memberId, first.memberId, '不能顶替原身份')
  })
})

test('registerExternalMember：昵称占用被拒', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: generateToken(),
    })

    const dup = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: generateToken(),
    })
    assert.equal(dup.ok, false)
    assert.equal(dup.code, 'nick-taken')
  })
})

test('registerExternalMember：协议未启用时拒绝', async () => {
  await withRoom(async (room) => {
    loadProtocolState(room)
    const r = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: generateToken(),
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'protocol-disabled')
  })
})

test('revokeExternalMember：撤销后 token 失效，memberId 与昵称保留', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const token = generateToken()
    const reg = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: token,
    })

    assert.ok(findMemberByToken(room.protocol.members, token), '撤销前能查到')

    const revoked = await revokeExternalMember(room, reg.memberId)
    assert.equal(revoked.ok, true)

    assert.equal(findMemberByToken(room.protocol.members, token), null, '撤销后查不到')
    const member = room.protocol.members.get(reg.memberId)
    assert.equal(member.nick, 'codex', '昵称保留')
  })
})

// ---------------------------------------------------------------- HTTP 路由

test('GET /room/health：无需 token，不泄露房间详情', async () => {
  await withRoom(async (room) => {
    const routes = new Map()
    const routesApi = {
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
    const handler = createExternalRoutes(routesApi)
    handler.register({ register: (r) => (routes.set(r.path, r.handler), () => {}) })

    const res = fakeRes()
    await routes.get('/room/health')(fakeReq({ url: '/room/health' }), res)

    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.protocolVersion, PROTOCOL_VERSION)
    assert.equal(res.body.instanceId, 'inst-test')
    assert.ok(Array.isArray(res.body.capabilities))
    assert.ok(!('members' in res.body), 'health 不能泄露成员')
    assert.ok(!('rows' in res.body), 'health 不能泄露消息')
  })
})

test('GET /room/self：无 token → 401；有效 token → 返回自身身份', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const token = generateToken()
    const reg = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: token,
    })

    const routes = new Map()
    const api = {
      sendJson(res, status, value) {
        res.writeHead(status)
        res.end(JSON.stringify(value))
      },
      readJsonBody: async () => ({}),
      resolveRoom: async () => room,
      instanceId: 'inst-test',
      logger: { warn() {}, info() {} },
    }
    createExternalRoutes(api).register({ register: (r) => (routes.set(r.path, r.handler), () => {}) })

    const url = `/room/self?cwd=${encodeURIComponent(room.cwd)}&room=default`

    const anon = fakeRes()
    await routes.get('/room/self')(fakeReq({ url }), anon)
    assert.equal(anon.status, 401)
    assert.equal(anon.body.error.code, 'unauthorized')

    const authed = fakeRes()
    await routes.get('/room/self')(
      fakeReq({ url, headers: { authorization: `Bearer ${token}` } }),
      authed,
    )
    assert.equal(authed.status, 200)
    assert.equal(authed.body.memberId, reg.memberId)
    assert.equal(authed.body.nick, 'codex')
    assert.equal(authed.body.roomUid, room.protocol.roomUid)
    assert.ok(!JSON.stringify(authed.body).includes(token), '响应不能回显 token')
  })
})

test('GET /room/self：非环回来源 → 403', async () => {
  await withRoom(async (room) => {
    const routes = new Map()
    const api = {
      sendJson(res, status, value) {
        res.writeHead(status)
        res.end(JSON.stringify(value))
      },
      readJsonBody: async () => ({}),
      resolveRoom: async () => room,
      instanceId: 'i',
      logger: { warn() {}, info() {} },
    }
    createExternalRoutes(api).register({ register: (r) => (routes.set(r.path, r.handler), () => {}) })

    const res = fakeRes()
    await routes.get('/room/health')(
      fakeReq({ url: '/room/health', remote: '10.0.0.9' }),
      res,
    )
    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'forbidden-remote')
  })
})

test('POST /room/register：成功注册，响应含 memberId 但不含 token', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    const token = generateToken()
    const enrollment = await issueEnrollmentToken(room)

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
      instanceId: 'i',
      logger: { warn() {}, info() {} },
    }
    createExternalRoutes(api).register({ register: (r) => (routes.set(r.path, r.handler), () => {}) })

    const res = fakeRes()
    await routes.get('/room/register')(
      fakeReq({
        method: 'POST',
        url: '/room/register',
        headers: { authorization: `Bearer ${enrollment.enrollmentToken}` },
        body: {
          cwd: room.cwd,
          room: 'default',
          registrationId: generateRegistrationId(),
          nick: 'codex',
          displayName: 'Codex',
          memberToken: token,
        },
      }),
      res,
    )

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.match(res.body.memberId, /^m-[0-9a-f]{32}$/)
    assert.equal(res.body.duplicate, false)
    assert.ok(!JSON.stringify(res.body).includes(token), '响应绝不返回 token')
  })
})

test('capabilities：协议未启用时不宣告 externalTasks', () => {
  assert.deepEqual(capabilities({ protocol: { enabled: false } }), ['messageRead'])
  assert.ok(capabilities({ protocol: { enabled: true } }).includes('externalTasks'))
})

test('protocolSummary：只输出成员概要，不含摘要字段', async () => {
  await withRoom(async (room) => {
    await ensureProtocolEnabled(room)
    await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: generateToken(),
    })

    const summary = protocolSummary(room)
    assert.equal(summary.enabled, true)
    assert.equal(summary.members.length, 1)
    assert.equal(summary.members[0].nick, 'codex')

    const serialized = JSON.stringify(summary)
    assert.ok(!serialized.includes('sha256:'), '摘要不能出现在对外视图')
  })
})
