// 协议基础层单测：ID 生成 / 公开视图过滤 / 重放 / 任务选择
//
// 全部是纯函数，不需要宿主、不需要 IO。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROTOCOL_VERSION,
  STORAGE_VERSION,
  TASK_STATE,
  CONTROL_TAG,
  VISIBILITY_INTERNAL,
  isControlRow,
  isPublicRow,
  toPublicRow,
  makeTaskId,
  makeMemberId,
  requestHash,
  canonicalize,
  replay,
  pickClaimable,
  activeLeaseOf,
} from '../lib/protocol.js'

// ---------------------------------------------------------------- ID

test('makeTaskId：同一三元组稳定，不同成员不同', () => {
  const a = makeTaskId('room-1', 'ask-1', 'm-1')
  const b = makeTaskId('room-1', 'ask-1', 'm-1')
  const c = makeTaskId('room-1', 'ask-1', 'm-2')
  const d = makeTaskId('room-2', 'ask-1', 'm-1')

  assert.equal(a, b, '同输入必须稳定（重放不能造出新任务）')
  assert.notEqual(a, c, '不同成员必须是不同任务')
  assert.notEqual(a, d, '不同房间必须是不同任务')
  assert.match(a, /^t-[0-9a-f]{32}$/)
})

test('makeMemberId：kind 参与派生，内部/外部不撞', () => {
  const internal = makeMemberId('room-1', 'internal', 'session-abc')
  const external = makeMemberId('room-1', 'external', 'session-abc')
  assert.notEqual(internal, external, '同样的 seed 在不同 kind 下必须是不同成员')
  assert.match(internal, /^m-[0-9a-f]{32}$/)
})

// ---------------------------------------------------------------- 公开视图

test('isControlRow：凭 visibility+tag 判定，缺一不算', () => {
  const base = {
    kind: 'system',
    tag: CONTROL_TAG.TASK_CLAIMED,
    visibility: VISIBILITY_INTERNAL,
  }
  assert.equal(isControlRow(base), true)

  assert.equal(isControlRow({ ...base, visibility: undefined }), false, '缺 visibility 不算控制事件')
  assert.equal(isControlRow({ ...base, tag: 'member' }), false, '普通成员事件不是控制事件')
  assert.equal(isControlRow({ ...base, kind: 'ask' }), false, 'ask 不是控制事件')
})

test('isPublicRow：控制事件与非 KINDS 都被过滤', () => {
  assert.equal(isPublicRow({ kind: 'ask', msgId: 'x' }), true)
  assert.equal(isPublicRow({ kind: 'answer', msgId: 'x' }), true)
  assert.equal(
    isPublicRow({ kind: 'system', tag: CONTROL_TAG.TASK_CLAIMED, visibility: VISIBILITY_INTERNAL }),
    false,
    '内部控制事件不进公开视图',
  )
  assert.equal(isPublicRow({ kind: 'task', msgId: 'x' }), false, '非 KINDS 的 kind 不可见')
  assert.equal(isPublicRow(null), false)
})

test('toPublicRow：剔除凭据摘要与幂等元数据', () => {
  const row = {
    seq: 80,
    kind: 'system',
    tag: CONTROL_TAG.MEMBER_EXTERNAL,
    nick: 'codex',
    tokenHash: 'sha256:secret',
    _internal: 'x',
    idempotency: { key: 'k', hash: 'h', receipt: {} },
    requestHash: 'rh',
  }
  const pub = toPublicRow(row)

  assert.equal(pub.nick, 'codex')
  assert.equal(pub.seq, 80)
  assert.ok(!('tokenHash' in pub), '凭据摘要必须剔除')
  assert.ok(!('_internal' in pub), '下划线私有字段必须剔除')
  assert.ok(!('idempotency' in pub), '幂等元数据必须剔除')
  assert.ok(!('requestHash' in pub), '请求摘要必须剔除')
})

// ---------------------------------------------------------------- 幂等摘要

test('canonicalize：对象键排序、数组保持顺序', () => {
  const a = { b: 1, a: [2, { d: 4, c: 3 }] }
  const b = { a: [2, { c: 3, d: 4 }], b: 1 }
  assert.equal(JSON.stringify(canonicalize(a)), JSON.stringify(canonicalize(b)))

  // 数组顺序必须保持：反序应产生不同摘要
  assert.notEqual(requestHash({ list: [1, 2] }), requestHash({ list: [2, 1] }))
})

test('requestHash：同语义同摘要，忽略 undefined 字段', () => {
  const h1 = requestHash({ taskId: 't', digest: 'd' })
  const h2 = requestHash({ taskId: 't', digest: 'd', extra: undefined })
  assert.equal(h1, h2, 'undefined 字段不该影响摘要')
  assert.notEqual(h1, requestHash({ taskId: 't', digest: 'd2' }))
})

// ---------------------------------------------------------------- 重放

/** 造一份最小可重放账本。 */
function makeRows(roomUid) {
  return [
    {
      seq: 1,
      kind: 'system',
      tag: CONTROL_TAG.PROTOCOL_ENABLED,
      visibility: VISIBILITY_INTERNAL,
      roomUid,
      storageVersion: STORAGE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      memberMap: { 'session-old': 'm-old' },
      at: 1000,
    },
  ]
}

test('replay：protocol-enabled 建立 roomUid 与既有内部成员映射', () => {
  const rows = makeRows('room-1')
  const state = replay(rows)

  assert.equal(state.roomUid, 'room-1')
  assert.equal(state.issues.length, 0)
  const member = state.members.get('m-old')
  assert.ok(member, '既有内部成员应被映射进来')
  assert.equal(member.kind, 'internal')
  assert.equal(member.sessionId, 'session-old')
})

test('replay：外部成员注册与凭据摘要保留在内部状态', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'system',
    tag: CONTROL_TAG.MEMBER_EXTERNAL,
    visibility: VISIBILITY_INTERNAL,
    memberId: 'm-codex',
    nick: 'codex',
    displayName: 'Codex',
    tokenHash: 'sha256:abc',
    at: 2000,
  })

  const state = replay(rows)
  const member = state.members.get('m-codex')
  assert.equal(member.kind, 'external')
  assert.equal(member.nick, 'codex')
  assert.equal(member.tokenHash, 'sha256:abc', '内部状态保留摘要，供认证比对')
})

test('replay：ask 只为外部成员派生 queued 任务，内部成员不进队列', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'system',
    tag: CONTROL_TAG.MEMBER_EXTERNAL,
    visibility: VISIBILITY_INTERNAL,
    memberId: 'm-codex',
    nick: 'codex',
    at: 2000,
  })
  rows.push({
    seq: 3,
    kind: 'ask',
    msgId: 'ask-1',
    from: '用户',
    text: '帮我看看',
    digest: '帮我看看',
    targetMemberIds: ['m-codex', 'm-old'],
    targets: ['session-old'],
    rootAskMsgId: 'ask-1',
    parentAskMsgId: null,
    depth: 0,
    taskPolicy: { executionMode: 'read-only', maxAttempts: 3 },
    at: 3000,
  })

  const state = replay(rows)
  const tasks = [...state.tasks.values()]

  assert.equal(tasks.length, 1, '只为外部成员生成任务')
  assert.equal(tasks[0].memberId, 'm-codex')
  assert.equal(tasks[0].state, TASK_STATE.QUEUED)
  assert.equal(tasks[0].askSeq, 3)
  assert.equal(tasks[0].taskId, makeTaskId('room-1', 'ask-1', 'm-codex'))
})

test('replay：广播给两个外部成员产生两个独立任务', () => {
  const rows = makeRows('room-1')
  for (const [seq, id, nick] of [
    [2, 'm-a', 'codex-a'],
    [3, 'm-b', 'codex-b'],
  ]) {
    rows.push({
      seq,
      kind: 'system',
      tag: CONTROL_TAG.MEMBER_EXTERNAL,
      visibility: VISIBILITY_INTERNAL,
      memberId: id,
      nick,
      at: 1000 + seq,
    })
  }
  rows.push({
    seq: 4,
    kind: 'ask',
    msgId: 'ask-broadcast',
    from: '用户',
    text: '全体注意',
    digest: '全体注意',
    targetMemberIds: ['m-a', 'm-b'],
    depth: 0,
    at: 4000,
  })

  const state = replay(rows)
  assert.equal(state.tasks.size, 2, '两个接收者 = 两个独立任务')
  assert.notEqual(
    makeTaskId('room-1', 'ask-broadcast', 'm-a'),
    makeTaskId('room-1', 'ask-broadcast', 'm-b'),
  )
})

test('replay：claim → renew → answer 的完整生命周期', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'system',
    tag: CONTROL_TAG.MEMBER_EXTERNAL,
    visibility: VISIBILITY_INTERNAL,
    memberId: 'm-codex',
    nick: 'codex',
    at: 2000,
  })
  rows.push({
    seq: 3,
    kind: 'ask',
    msgId: 'ask-1',
    from: '用户',
    text: '查一下',
    digest: '查一下',
    targetMemberIds: ['m-codex'],
    depth: 0,
    at: 3000,
  })

  const taskId = makeTaskId('room-1', 'ask-1', 'm-codex')
  rows.push({
    seq: 4,
    kind: 'system',
    tag: CONTROL_TAG.TASK_CLAIMED,
    visibility: VISIBILITY_INTERNAL,
    taskId,
    memberId: 'm-codex',
    attempt: 1,
    leaseId: 'lease-1',
    leaseExpiresAt: 5000,
    attemptDeadlineAt: 9000,
    at: 4000,
  })

  let state = replay(rows)
  let task = state.tasks.get(taskId)
  assert.equal(task.state, TASK_STATE.RUNNING)
  assert.equal(task.attempt, 1)
  assert.equal(task.leaseId, 'lease-1')

  rows.push({
    seq: 5,
    kind: 'system',
    tag: CONTROL_TAG.TASK_RENEWED,
    visibility: VISIBILITY_INTERNAL,
    taskId,
    leaseId: 'lease-1',
    leaseExpiresAt: 9000,
    at: 5000,
  })

  state = replay(rows)
  task = state.tasks.get(taskId)
  assert.equal(task.leaseExpiresAt, 9000, '续租应延长租约')

  rows.push({
    seq: 6,
    kind: 'answer',
    msgId: 'ans-1',
    from: 'codex',
    taskId,
    memberId: 'm-codex',
    leaseId: 'lease-1',
    attempt: 1,
    digest: '查完了',
    text: '完整结论',
    replyToMsgId: 'ask-1',
    depth: 0,
    at: 6000,
  })

  state = replay(rows)
  task = state.tasks.get(taskId)
  assert.equal(task.state, TASK_STATE.COMPLETED, 'answer 行本身就是完成凭据')
  assert.equal(task.answerSeq, 6)
  assert.equal(task.leaseId, null, '完成后清除租约')
})

test('replay：租约到期按 requeue 标志决定回到 queued 还是 failed', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'system',
    tag: CONTROL_TAG.MEMBER_EXTERNAL,
    visibility: VISIBILITY_INTERNAL,
    memberId: 'm-1',
    nick: 'c1',
    at: 2000,
  })
  rows.push({
    seq: 3,
    kind: 'ask',
    msgId: 'a1',
    from: '用户',
    text: 't',
    digest: 't',
    targetMemberIds: ['m-1'],
    depth: 0,
    at: 3000,
  })
  const taskId = makeTaskId('room-1', 'a1', 'm-1')
  rows.push({
    seq: 4,
    kind: 'system',
    tag: CONTROL_TAG.TASK_CLAIMED,
    visibility: VISIBILITY_INTERNAL,
    taskId,
    memberId: 'm-1',
    attempt: 1,
    leaseId: 'l1',
    leaseExpiresAt: 5000,
    at: 4000,
  })
  rows.push({
    seq: 5,
    kind: 'system',
    tag: CONTROL_TAG.TASK_EXPIRED,
    visibility: VISIBILITY_INTERNAL,
    taskId,
    requeue: true,
    nextEligibleAt: 8000,
    at: 6000,
  })

  let task = replay(rows).tasks.get(taskId)
  assert.equal(task.state, TASK_STATE.QUEUED, '可重试 → 回队列')
  assert.equal(task.nextEligibleAt, 8000)

  rows.push({
    seq: 6,
    kind: 'system',
    tag: CONTROL_TAG.TASK_EXPIRED,
    visibility: VISIBILITY_INTERNAL,
    taskId,
    requeue: false,
    at: 9000,
  })
  task = replay(rows).tasks.get(taskId)
  assert.equal(task.state, TASK_STATE.FAILED, '次数耗尽 → failed')
})

test('replay：损坏事件不中断重放，但记入 issues', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'system',
    tag: CONTROL_TAG.TASK_CLAIMED,
    visibility: VISIBILITY_INTERNAL,
    taskId: 't-unknown',
    at: 2000,
  })
  rows.push({
    seq: 3,
    kind: 'answer',
    msgId: 'ans-x',
    from: 'x',
    taskId: 't-unknown-2',
    digest: 'd',
    at: 3000,
  })

  const state = replay(rows)
  assert.equal(state.tasks.size, 0)
  assert.equal(state.issues.length, 2, '两个未知引用都应记录')
  assert.match(state.issues[0], /task-claimed/)
  assert.match(state.issues[1], /answer/)
})

test('replay：幂等表按 scope|key 索引，跨成员同 key 不碰撞', () => {
  const rows = makeRows('room-1')
  rows.push({
    seq: 2,
    kind: 'answer',
    msgId: 'ans-1',
    from: 'codex-a',
    digest: 'd',
    idempotency: { scope: 'room-1|m-a|complete', key: 'same-key', hash: 'h-a', receipt: { seq: 2 } },
    at: 2000,
  })
  rows.push({
    seq: 3,
    kind: 'answer',
    msgId: 'ans-2',
    from: 'codex-b',
    digest: 'd2',
    idempotency: { scope: 'room-1|m-b|complete', key: 'same-key', hash: 'h-b', receipt: { seq: 3 } },
    at: 3000,
  })

  const state = replay(rows)
  assert.equal(state.idempotency.size, 2, '两个成员用同一个 key 不能互相覆盖')

  const a = state.idempotency.get('room-1|m-a|complete|same-key')
  const b = state.idempotency.get('room-1|m-b|complete|same-key')
  assert.equal(a.hash, 'h-a')
  assert.equal(b.hash, 'h-b')
  assert.deepEqual(a.receipt, { seq: 2 })
  assert.deepEqual(b.receipt, { seq: 3 })
})

// ---------------------------------------------------------------- 任务选择

test('pickClaimable：按 askSeq 升序取最早，跳过未到时间的', () => {
  const tasks = new Map()
  const put = (askSeq, nextEligibleAt) => {
    const id = `t-${askSeq}`
    tasks.set(id, { taskId: id, memberId: 'm-1', state: TASK_STATE.QUEUED, askSeq, nextEligibleAt })
  }
  put(10)
  put(5, 9999) // 未到时间
  put(7)

  const picked = pickClaimable(tasks, 'm-1', 1000)
  assert.equal(picked.taskId, 't-7', '应跳过未到 nextEligibleAt 的 5')
})

test('pickClaimable：只挑本成员的任务', () => {
  const tasks = new Map([
    ['t-a', { taskId: 't-a', memberId: 'm-2', state: TASK_STATE.QUEUED, askSeq: 1 }],
  ])
  assert.equal(pickClaimable(tasks, 'm-1', 1000), null)
})

test('activeLeaseOf：只认未过期的 running', () => {
  const tasks = new Map([
    [
      't-a',
      { taskId: 't-a', memberId: 'm-1', state: TASK_STATE.RUNNING, leaseExpiresAt: 5000 },
    ],
  ])
  assert.ok(activeLeaseOf(tasks, 'm-1', 4000), '未过期应返回')
  assert.equal(activeLeaseOf(tasks, 'm-1', 6000), null, '已过期不算有效租约')
  assert.equal(activeLeaseOf(tasks, 'm-2', 4000), null, '别人不算')
})

// ---------------------------------------------------------------- 内部/外部隔离

test('replay：内部成员收到 ask 不产生任务（走原有 DSH 投递）', () => {
  const rows = [
    {
      seq: 1, kind: 'system', tag: CONTROL_TAG.PROTOCOL_ENABLED,
      visibility: VISIBILITY_INTERNAL, roomUid: 'room-1',
      memberMap: { 'session-a': 'm-a', 'session-b': 'm-b' }, at: 1000,
    },
    {
      seq: 2, kind: 'ask', msgId: 'ask-x', from: '用户', text: '给内部成员的',
      digest: 'd', targetMemberIds: ['m-a', 'm-b'], targets: ['session-a', 'session-b'],
      depth: 0, at: 2000,
    },
  ]
  const state = replay(rows)
  assert.equal(state.tasks.size, 0, 'MVP 内部成员不进 claim 队列')
  assert.equal(state.issues.length, 0)
})

test('replay：混合广播只为外部成员生成任务', () => {
  const rows = [
    {
      seq: 1, kind: 'system', tag: CONTROL_TAG.PROTOCOL_ENABLED,
      visibility: VISIBILITY_INTERNAL, roomUid: 'room-1',
      memberMap: { 'session-a': 'm-a' }, at: 1000,
    },
    {
      seq: 2, kind: 'system', tag: CONTROL_TAG.MEMBER_EXTERNAL,
      visibility: VISIBILITY_INTERNAL, memberId: 'm-ext', nick: 'codex', at: 2000,
    },
    {
      seq: 3, kind: 'ask', msgId: 'ask-y', from: '用户', text: '混合',
      digest: 'd', targetMemberIds: ['m-a', 'm-ext'], depth: 0, at: 3000,
    },
  ]
  const state = replay(rows)
  assert.equal(state.tasks.size, 1)
  assert.equal([...state.tasks.values()][0].memberId, 'm-ext')
})

test('replay：已有有效租约时不应再被选中领取', () => {
  const rows = [
    {
      seq: 1, kind: 'system', tag: CONTROL_TAG.PROTOCOL_ENABLED,
      visibility: VISIBILITY_INTERNAL, roomUid: 'room-1', memberMap: {}, at: 1000,
    },
    {
      seq: 2, kind: 'system', tag: CONTROL_TAG.MEMBER_EXTERNAL,
      visibility: VISIBILITY_INTERNAL, memberId: 'm-1', nick: 'c', at: 2000,
    },
    {
      seq: 3, kind: 'ask', msgId: 'a1', from: '用户', text: 't', digest: 't',
      targetMemberIds: ['m-1'], depth: 0, at: 3000,
    },
  ]
  const taskId = makeTaskId('room-1', 'a1', 'm-1')
  rows.push({
    seq: 4, kind: 'system', tag: CONTROL_TAG.TASK_CLAIMED,
    visibility: VISIBILITY_INTERNAL, taskId, memberId: 'm-1', attempt: 1,
    leaseId: 'l1', leaseExpiresAt: 35000, at: 4000,
  })

  const state = replay(rows)
  assert.equal(pickClaimable(state.tasks, 'm-1', 5000), null, '已有租约不能再领')
  assert.ok(activeLeaseOf(state.tasks, 'm-1', 5000), '应识别出有效租约')
  // 租约过期后可以再领
  assert.ok(activeLeaseOf(state.tasks, 'm-1', 40000) === null, '过期后租约失效')
})
