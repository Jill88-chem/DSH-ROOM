// 任务状态机单测（阶段 A · 第 3 层）
//
// 覆盖 Codex 验收表里的 A1/A5/A10/A12/A13/A14，以及三态失败分流。
// 用真实 RoomWriter + 真实账本，不用 stub —— 这一层的 bug 都在"写没写进去"上。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RoomWriter } from '../lib/ledger.js'
import { ensureProtocolEnabled, registerExternalMember, loadProtocolState } from '../lib/room-protocol.js'
import { generateToken, generateRegistrationId } from '../lib/auth.js'
import {
  claimTask,
  renewTask,
  completeTask,
  failTask,
  cancelTask,
  expireLeases,
  getTask,
  clampLease,
  DEFAULT_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  RETRY_DELAYS_MS,
} from '../lib/tasks.js'
import { TASK_STATE, makeTaskId } from '../lib/protocol.js'

// ---------------------------------------------------------------- 场景搭建

/**
 * 造一个已启用协议、已注册一个外部成员、已派一条任务（或两条）的房间。
 */
async function withTaskRoom(fn, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-tasks-'))
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

    const token = generateToken()
    const reg = await registerExternalMember(room, {
      registrationId: generateRegistrationId(),
      nick: 'codex',
      memberToken: token,
    })
    assert.equal(reg.ok, true)

    // 派单：直接写 ask 行（模拟人类派单）
    const askCount = opts.asks ?? 1
    const askMsgIds = []
    for (let i = 0; i < askCount; i += 1) {
      const msgId = `ask-${i + 1}`
      askMsgIds.push(msgId)
      const { normalizeRow } = await import('../lib/ledger.js')
      await writer.run(async ({ append }) => {
        const normalized = normalizeRow({
          kind: 'ask',
          msgId,
          from: '用户',
          text: `任务正文 ${i + 1}`,
          digest: `任务 ${i + 1}`,
          targetMemberIds: [reg.memberId],
          targets: [],
          deliveryVersion: 2,
          rootAskMsgId: msgId,
          parentAskMsgId: null,
          depth: 0,
          taskPolicy: { executionMode: opts.executionMode ?? 'read-only', maxAttempts: opts.maxAttempts ?? 3,
            runTimeoutSeconds: opts.runTimeoutSeconds ?? 1800 },
        })
        if (!normalized.ok) throw new Error(normalized.error)
        await append(normalized.row)
      })
    }
    loadProtocolState(room)

    const ctx = {
      room,
      memberId: reg.memberId,
      token,
      askMsgIds,
      taskId: makeTaskId(room.protocol.roomUid, askMsgIds[0], reg.memberId),
    }

    try {
      return await fn(ctx)
    } finally {
      await writer.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- claim

test('并发 complete 使用相同键只写一个答案，不同键只有一个胜出', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId })
    const spec = { memberId, taskId, leaseId: claim.task.leaseId, attempt: 1, digest: '结果', text: '完整结果', idempotencyKey: 'finish' }
    const results = await Promise.all(Array.from({ length: 8 }, () => completeTask(room, spec)))
    assert.ok(results.every(r => r.ok && r.seq === results[0].seq))
    assert.equal(results.filter(r => !r.duplicate).length, 1)
    assert.equal(room.writer.rows.filter(r => r.kind === 'answer').length, 1)
    assert.equal((await completeTask(room, { ...spec, idempotencyKey: 'other' })).code, 'task-already-completed')
  })
})

test('取消先入队时，并发 complete 不能覆盖 cancelled', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId })
    const [cancel, result] = await Promise.all([
      cancelTask(room, { taskId }),
      completeTask(room, { memberId, taskId, leaseId: claim.task.leaseId, attempt: 1, digest: '结果', text: '结果' }),
    ])
    assert.equal(cancel.ok, true); assert.equal(result.code, 'task-cancelled')
    assert.equal(room.writer.rows.filter(r => r.kind === 'answer').length, 0)
  })
})

test('旧 claim 重放保留原 lease，不能借用新 attempt；过期 fail 被拒绝', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const first = await claimTask(room, { memberId, idempotencyKey: 'old' })
    await room.writer.run(({ append }) => append({ kind: 'system', tag: 'task-renewed', taskId,
      visibility: 'internal', leaseId: first.task.leaseId, attempt: 1,
      leaseExpiresAt: Date.now() - 1, attemptDeadlineAt: Date.now() + 100000 }))
    assert.equal((await failTask(room, { memberId, taskId, leaseId: first.task.leaseId, attempt: 1, code: 'late' })).code, 'lease-lost')
    // The next claim lazily expires the abandoned lease and enforces retry backoff.
    assert.equal((await claimTask(room, { memberId })).task, null)
    assert.equal(room.protocol.tasks.get(taskId).state, 'queued')
    assert.ok(room.protocol.tasks.get(taskId).nextEligibleAt > Date.now())
    await room.writer.run(({ append }) => append({ kind: 'system', tag: 'task-expired', taskId,
      visibility: 'internal', requeue: true, nextEligibleAt: 0 }))
    const second = await claimTask(room, { memberId, idempotencyKey: 'new' })
    assert.equal(second.task.attempt, 2)
    const replay = await claimTask(room, { memberId, idempotencyKey: 'old' })
    assert.equal(replay.leaseValid, false); assert.equal(replay.task.attempt, 1)
    assert.equal(replay.task.leaseId, first.task.leaseId); assert.equal(replay.task.text, '任务正文 1')
    assert.notEqual(replay.task.leaseId, second.task.leaseId)
  })
})

test('硬截止遵循 taskPolicy；写任务租约到期进入 needs_review', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const before = Date.now(); const claim = await claimTask(room, { memberId, leaseSeconds: 300 })
    assert.ok(claim.task.attemptDeadlineAt >= before + 20000 && claim.task.attemptDeadlineAt <= Date.now() + 20000)
    assert.equal(claim.task.leaseExpiresAt, claim.task.attemptDeadlineAt)
    await expireLeases(room, claim.task.attemptDeadlineAt + 1)
    assert.equal(room.protocol.tasks.get(taskId).state, 'needs_review')
  }, { executionMode: 'workspace-write', runTimeoutSeconds: 20 })
})

test('claim：领取后进入 running，返回 leaseId/attempt/期限', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const r = await claimTask(room, { memberId, idempotencyKey: 'c-1', leaseSeconds: 300 })

    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.task.taskId, taskId)
    assert.equal(r.currentState, TASK_STATE.RUNNING)
    assert.equal(r.task.attempt, 1)
    assert.match(r.task.leaseId, /^[0-9a-f-]{36}$/)
    assert.ok(r.task.leaseExpiresAt > r.serverNow)
    assert.ok(r.task.attemptDeadlineAt > r.task.leaseExpiresAt, '单轮上限应晚于租约到期')
    assert.equal(r.task.text, '任务正文 1', '领取响应必须带正文')
  })
})

test('claim：无任务时返回 empty，不写账本', async () => {
  await withTaskRoom(async ({ room, memberId }) => {
    const first = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    assert.equal(first.ok, true)

    const before = room.writer.rows.length
    const second = await claimTask(room, { memberId, idempotencyKey: 'c-2' })
    assert.equal(second.ok, true)
    assert.equal(second.reason, 'member-busy', '同成员已有租约应报 member-busy')
    assert.equal(room.writer.rows.length, before, '空响应不写账本')
  })
})

test('claim：A5 两个桥接器同时 claim，只有一个成功', async () => {
  await withTaskRoom(async ({ room, memberId }) => {
    // 并发发两个不同 key 的 claim（模拟两个桥接器）
    const [a, b] = await Promise.all([
      claimTask(room, { memberId, idempotencyKey: 'bridge-1' }),
      claimTask(room, { memberId, idempotencyKey: 'bridge-2' }),
    ])

    const granted = [a, b].filter((r) => r.ok === true && r.task !== null)
    assert.equal(granted.length, 1, '只能有一个领取成功')

    const denied = [a, b].filter((r) => r.ok === true && r.task === null)
    assert.equal(denied.length, 1)
    assert.equal(denied[0].reason, 'member-busy')
  })
})

test('claim：A12 响应丢失后重放同 key，返回原租约不换任务', async () => {
  await withTaskRoom(async ({ room, memberId }) => {
    const first = await claimTask(room, { memberId, idempotencyKey: 'lost-response' })
    assert.equal(first.ok, true)

    const replay = await claimTask(room, { memberId, idempotencyKey: 'lost-response' })
    assert.equal(replay.ok, true)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.task.taskId, first.task.taskId)
    assert.equal(replay.leaseValid, true, '租约仍有效')
    assert.equal(replay.task.leaseId, first.task.leaseId, '不生成新 leaseId')
  })
})

test('claim：同 key 不同参数 → idempotency-conflict', async () => {
  await withTaskRoom(async ({ room, memberId }) => {
    await claimTask(room, { memberId, idempotencyKey: 'k-same', leaseSeconds: 300 })
    const conflict = await claimTask(room, { memberId, idempotencyKey: 'k-same', leaseSeconds: 600 })

    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'idempotency-conflict')
  })
})

// ---------------------------------------------------------------- renew

test('A14 续租：延长租约，但不能超过单轮上限', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1', leaseSeconds: 300 })
    const { leaseId, attempt } = claim.task
    const cap = claim.task.attemptDeadlineAt

    const renew = await renewTask(room, {
      memberId,
      taskId,
      leaseId,
      attempt,
      idempotencyKey: 'r-1',
      leaseSeconds: 600,
    })
    assert.equal(renew.ok, true, JSON.stringify(renew))
    assert.ok(renew.leaseExpiresAt > claim.task.leaseExpiresAt, '续租应延长')
    assert.ok(renew.leaseExpiresAt <= cap, '不能超过单轮上限')

    // 反复续租也不会突破上限
    let latest = renew
    for (let i = 0; i < 3; i += 1) {
      latest = await renewTask(room, {
        memberId,
        taskId,
        leaseId,
        attempt,
        idempotencyKey: `r-loop-${i}`,
        leaseSeconds: 600,
      })
      assert.equal(latest.ok, true)
      assert.ok(latest.leaseExpiresAt <= cap, `第 ${i} 次续租仍不能超过上限`)
    }

    // 上限一旦过去，续租就被夹在 cap 上（不会回退，也不会突破）
    const task = room.protocol.tasks.get(taskId)
    assert.equal(task.attemptDeadlineAt, cap, '上限本身不该被续租改动')
    assert.ok(latest.leaseExpiresAt <= latest.attemptDeadlineAt)
  })
})

test('renew：leaseId 不匹配 → lease-lost', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    const r = await renewTask(room, {
      memberId,
      taskId,
      leaseId: 'wrong-lease',
      attempt: claim.task.attempt,
      idempotencyKey: 'r-bad',
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'lease-lost')
  })
})

// ---------------------------------------------------------------- complete

test('complete：answer 行即完成凭据，任务转 completed', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    const { leaseId, attempt } = claim.task

    const done = await completeTask(room, {
      memberId,
      taskId,
      leaseId,
      attempt,
      digest: '做完了',
      text: '完整结论正文',
      idempotencyKey: 'done-1',
    })

    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(done.state, TASK_STATE.COMPLETED)
    assert.ok(done.seq > 0)

    const task = room.protocol.tasks.get(taskId)
    assert.equal(task.state, TASK_STATE.COMPLETED)
    assert.equal(task.answerSeq, done.seq)

    // 账本里那条 answer 必须带 text 与 replyToMsgId
    const answerRow = room.writer.rows.find((r) => r.seq === done.seq)
    assert.equal(answerRow.kind, 'answer')
    assert.equal(answerRow.text, '完整结论正文')
    assert.equal(answerRow.replyToMsgId, claim.task.askMsgId)
    assert.equal(answerRow.taskId, taskId)
  })
})

test('A13 complete 幂等：同 key 同内容返回原回执，不同内容 409', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    const base = {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      digest: '结论',
      text: '正文',
      idempotencyKey: 'done-1',
    }

    const first = await completeTask(room, base)
    assert.equal(first.ok, true)

    const replay = await completeTask(room, base)
    assert.equal(replay.ok, true)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.seq, first.seq, '重放返回同一 seq')

    const conflict = await completeTask(room, { ...base, text: '不一样的正文' })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'idempotency-conflict')
  })
})

test('complete：已完成后换新 key 再提交 → task-already-completed', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    await completeTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      digest: 'd',
      text: 't',
      idempotencyKey: 'k1',
    })

    const again = await completeTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      digest: 'd2',
      text: 't2',
      idempotencyKey: 'k2',
    })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'task-already-completed')
  })
})

test('complete：text 必填、digest 单行且不超 200（不静默截断）', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    const base = {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      idempotencyKey: 'kx',
    }

    const noText = await completeTask(room, { ...base, digest: 'd', text: '   ' })
    assert.equal(noText.ok, false)
    assert.equal(noText.code, 'invalid-request')

    const multiLine = await completeTask(room, { ...base, digest: 'a\nb', text: 't' })
    assert.equal(multiLine.ok, false)

    const tooLong = await completeTask(room, { ...base, digest: 'x'.repeat(201), text: 't' })
    assert.equal(tooLong.ok, false)
  })
})

// ---------------------------------------------------------------- fail

test('fail：可重试且未达上限 → 回到 queued 并设置延迟', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })

    const failed = await failTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      code: 'process-start-failed',
      retryable: true,
      idempotencyKey: 'f-1',
    })

    assert.equal(failed.ok, true, JSON.stringify(failed))
    assert.equal(failed.state, TASK_STATE.QUEUED)
    assert.ok(failed.nextEligibleAt >= Date.now() + RETRY_DELAYS_MS[0] - 1000, '应有退避延迟')
  })
})

test('fail：确定性失败 → failed，不再重排', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })

    const failed = await failTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      code: 'schema-mismatch',
      retryable: false,
      idempotencyKey: 'f-1',
    })

    assert.equal(failed.state, TASK_STATE.FAILED)
  })
})

test('fail：结果不确定 → needs_review（不能自动重跑）', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })

    const failed = await failTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      code: 'process-killed',
      retryable: true, // 即使标了可重试，不确定性也不自动重跑
      idempotencyKey: 'f-1',
    })

    assert.equal(failed.state, TASK_STATE.NEEDS_REVIEW)
  })
})

test('fail：次数耗尽 → failed', async () => {
  await withTaskRoom(
    async ({ room, memberId, taskId }) => {
      // 第 1 次失败 -> queued（可重试）
      const claim1 = await claimTask(room, { memberId, idempotencyKey: 'c1' })
      const failed1 = await failTask(room, {
        memberId,
        taskId,
        leaseId: claim1.task.leaseId,
        attempt: claim1.task.attempt,
        code: 'boom',
        retryable: true,
        idempotencyKey: 'f1',
      })
      assert.equal(failed1.state, TASK_STATE.QUEUED, '第 1 次失败应回到队列')

      // 重放后必须仍是 queued —— 这里锁的是"fail 写入的 state 要被重放尊重"
      const mid = room.protocol.tasks.get(taskId)
      assert.equal(mid.state, TASK_STATE.QUEUED, '重放不能把可重试失败判成终结')

      // 抹平退避延迟，免得测试真的等 5 秒：改账本行 + 重放
      const { loadProtocolState: reload } = await import('../lib/room-protocol.js')
      const rowsRef = room.writer.rows
      for (let i = 0; i < rowsRef.length; i += 1) {
        const row = rowsRef[i]
        if (row.tag === 'task-failed' && typeof row.nextEligibleAt === 'number') {
          rowsRef[i] = { ...row, nextEligibleAt: 0 }
        }
      }
      reload(room)

      const claim2 = await claimTask(room, { memberId, idempotencyKey: 'c2' })
      assert.equal(claim2.ok, true, '应能重领：' + JSON.stringify(claim2))
      assert.equal(claim2.task.attempt, 2)

      const failed2 = await failTask(room, {
        memberId,
        taskId,
        leaseId: claim2.task.leaseId,
        attempt: claim2.task.attempt,
        code: 'boom',
        retryable: true,
        idempotencyKey: 'f2',
      })
      assert.equal(failed2.state, TASK_STATE.FAILED, 'maxAttempts=2 时第 2 次失败即终止')
    },
    { maxAttempts: 2 },
  )
})

// ---------------------------------------------------------------- 租约过期

test('A1/A10 租约过期：任务回队列；旧批次提交被拒（lease-lost）', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
    const oldLease = claim.task.leaseId
    const oldAttempt = claim.task.attempt

    // 手工把租约拨到过去
    await room.writer.run(({ append }) => append({ kind: 'system', tag: 'task-renewed', taskId,
      leaseId: oldLease, leaseExpiresAt: Date.now() - 1000 }))

    const swept = await expireLeases(room)
    assert.equal(swept.expired, 1)

    const afterExpire = room.protocol.tasks.get(taskId)
    assert.equal(afterExpire.state, TASK_STATE.QUEUED, '未达上限应回队列')
    await room.writer.run(({ append }) => append({ kind: 'system', tag: 'task-expired', taskId,
      requeue: true, nextEligibleAt: 0 }))

    // 重新领取，拿到新批次
    const reclaim = await claimTask(room, { memberId, idempotencyKey: 'c-2' })
    assert.equal(reclaim.ok, true)
    assert.equal(reclaim.task.attempt, 2)
    assert.notEqual(reclaim.task.leaseId, oldLease)

    // 旧批次提交必须被拒
    const stale = await completeTask(room, {
      memberId,
      taskId,
      leaseId: oldLease,
      attempt: oldAttempt,
      digest: 'd',
      text: 't',
      idempotencyKey: 'stale-1',
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'lease-lost', '过期批次结果不予采纳')

    // 账本里不应出现这条 stale answer
    const answers = room.writer.rows.filter((r) => r.kind === 'answer')
    assert.equal(answers.length, 0)
  })
})

test('A1 次数耗尽后过期：转 failed 而不是无限重排', async () => {
  await withTaskRoom(
    async ({ room, memberId, taskId }) => {
      const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })
      assert.equal(claim.task.attempt, 1)

      await room.writer.run(({ append }) => append({ kind: 'system', tag: 'task-renewed', taskId,
        leaseId: claim.task.leaseId, leaseExpiresAt: Date.now() - 1 }))

      await expireLeases(room)
      assert.equal(room.protocol.tasks.get(taskId).state, TASK_STATE.FAILED)
    },
    { maxAttempts: 1 },
  )
})

// ---------------------------------------------------------------- 取消

test('cancel：取消后不可再完成，也不能重复取消', async () => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const claim = await claimTask(room, { memberId, idempotencyKey: 'c-1' })

    const cancelled = await cancelTask(room, { taskId, reason: 'human-cancel' })
    assert.equal(cancelled.ok, true)

    const again = await cancelTask(room, { taskId })
    assert.equal(again.duplicate, true, '重复取消是幂等的')

    const done = await completeTask(room, {
      memberId,
      taskId,
      leaseId: claim.task.leaseId,
      attempt: claim.task.attempt,
      digest: 'd',
      text: 't',
      idempotencyKey: 'k',
    })
    assert.equal(done.ok, false)
    assert.equal(done.code, 'task-cancelled')
  })
})

// ---------------------------------------------------------------- 查询

test('getTask：只返回自己的任务', async ({}) => {
  await withTaskRoom(async ({ room, memberId, taskId }) => {
    const mine = await getTask(room, { memberId, taskId })
    assert.equal(mine.ok, true)
    assert.equal(mine.task.taskId, taskId)

    const other = await getTask(room, { memberId: 'm-someone-else', taskId })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'not-found')
  })
})

test('claim：非成员或已撤销凭据被拒', async () => {
  await withTaskRoom(async ({ room, memberId }) => {
    const ghost = await claimTask(room, { memberId: 'm-ghost' })
    assert.equal(ghost.ok, false)
    assert.equal(ghost.code, 'forbidden')
  })
})

test('clampLease：夹到 [60, 600]，非法值回默认', () => {
  assert.equal(clampLease(undefined), DEFAULT_LEASE_SECONDS)
  assert.equal(clampLease(NaN), DEFAULT_LEASE_SECONDS)
  assert.equal(clampLease(1), MIN_LEASE_SECONDS)
  assert.equal(clampLease(99999), MAX_LEASE_SECONDS)
  assert.equal(clampLease(300), 300)
})
