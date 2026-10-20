/**
 * 账本文件级测试：半行截断、串行写入、去重临界区、重启续写。
 * 覆盖设计文档 §4.5 与崩溃窗口 W10。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RoomWriter, foldLedger, normalizeRow } from '../lib/ledger.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('RoomWriter: 全新账本 seq 从 1 开始', async () => {
  await withTempDir(async (dir) => {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    const { rows } = await writer.open()
    writer.setRows(rows)
    assert.equal(rows.length, 0)
    assert.equal(writer.nextSeq, 1)
    await writer.close()
  })
})

test('RoomWriter: 写入后可读回，seq 连续', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'ledger.jsonl')
    const writer = new RoomWriter(path)
    const { rows } = await writer.open()
    writer.setRows(rows)

    const seq1 = await writer.run(({ append }) =>
      append({ kind: 'ask', msgId: 'm1', text: 'a', digest: 'a' }),
    )
    const seq2 = await writer.run(({ append }) =>
      append({ kind: 'ask', msgId: 'm2', text: 'b', digest: 'b' }),
    )
    await writer.close()

    assert.equal(seq1, 1)
    assert.equal(seq2, 2)

    const raw = await readFile(path, 'utf8')
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).msgId, 'm1')
    assert.equal(JSON.parse(lines[1]).seq, 2)
  })
})

test('崩溃窗口 W10: 末尾半行被丢弃，seq 不跳号', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'ledger.jsonl')
    await writeFile(path, '{"kind":"ask","msgId":"m1","seq":1}\n{"kind":"ask","msgId":"m2","se', 'utf8')

    const writer = new RoomWriter(path)
    const { rows, truncatedBytes } = await writer.open()
    writer.setRows(rows)

    assert.equal(rows.length, 1, '只应保留 1 条完整行')
    assert.ok(truncatedBytes > 0, '应报告截断字节数')
    assert.equal(writer.nextSeq, 2, 'seq 应从完整行之后继续')

    const seq = await writer.run(({ append }) => append({ kind: 'note', msgId: 'm3', digest: 'x' }))
    await writer.close()

    assert.equal(seq, 2)

    const raw = await readFile(path, 'utf8')
    // 截断后再写：文件里不能残留半行。
    for (const line of raw.trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line), `不应有不可解析的行: ${line}`)
    }
  })
})

test('并发写入被串行化，seq 无重复无跳跃', async () => {
  await withTempDir(async (dir) => {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    const { rows } = await writer.open()
    writer.setRows(rows)

    const tasks = []
    for (let i = 0; i < 50; i += 1) {
      tasks.push(writer.run(({ append }) => append({ kind: 'note', msgId: `m${i}`, digest: `d${i}` })))
    }
    const seqs = await Promise.all(tasks)
    await writer.close()

    assert.equal(new Set(seqs).size, 50, 'seq 不应重复')
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1))
  })
})

test('去重检查与写入在同一临界区：并发同 turn 只写一条 answer', async () => {
  await withTempDir(async (dir) => {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    const { rows } = await writer.open()
    writer.setRows(rows)

    const key = 'sess#7'
    async function attempt(id) {
      return writer.run(async ({ rows: current, append }) => {
        if (foldLedger(current).answers.get(key) !== undefined) return 'duplicate'
        const row = normalizeRow({
          kind: 'answer',
          msgId: id,
          session: 'sess',
          turn: 7,
          digest: 'done',
        })
        assert.equal(row.ok, true)
        await append(row.row)
        return 'written'
      })
    }

    const results = await Promise.all([attempt('a1'), attempt('a2'), attempt('a3')])
    await writer.close()

    assert.equal(results.filter((r) => r === 'written').length, 1, '只应有一条写入')
    assert.equal(results.filter((r) => r === 'duplicate').length, 2)
  })
})

test('重启后从账本重建视图', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'ledger.jsonl')

    const first = new RoomWriter(path)
    const opened = await first.open()
    first.setRows(opened.rows)
    await first.run(({ append }) =>
      append({ kind: 'ask', msgId: 'm1', text: '原始指令', digest: 'd', targets: ['s1'] }),
    )
    await first.run(({ append }) =>
      append({ kind: 'answer', msgId: 'a1', session: 's1', turn: 1, digest: 'ok', sourceSeq: 42 }),
    )
    await first.close()

    const second = new RoomWriter(path)
    const reopened = await second.open()
    const folded = foldLedger(reopened.rows)
    await second.close()

    assert.equal(folded.asks.size, 1)
    assert.equal(folded.asks.get('m1')?.text, '原始指令', '人类原文必须完整保留')
    assert.equal(folded.answers.get('s1#1')?.sourceSeq, 42)
  })
})

test('人类原文不截断（T8 的存储侧）', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'ledger.jsonl')
    const long = '很长的指令。'.repeat(2000) // 12000 字符

    const writer = new RoomWriter(path)
    const { rows } = await writer.open()
    writer.setRows(rows)

    const normalized = normalizeRow({
      kind: 'ask',
      msgId: 'm-long',
      text: long,
      digest: '短摘要',
      targets: ['s1'],
    })
    assert.equal(normalized.ok, true)
    await writer.run(({ append }) => append(normalized.row))
    await writer.close()

    const reread = new RoomWriter(path)
    const reopened = await reread.open()
    const folded = foldLedger(reopened.rows)
    await reread.close()

    assert.equal(folded.asks.get('m-long')?.text.length, long.length, '长度必须逐字节保持')
    assert.equal(folded.asks.get('m-long')?.text, long)
  })
})

test('损坏行被跳过，前后完整行仍可读', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'ledger.jsonl')
    await writeFile(
      path,
      '{"kind":"ask","msgId":"m1","seq":1}\nBROKEN LINE\n{"kind":"note","msgId":"m2","seq":2}\n',
      'utf8',
    )
    const writer = new RoomWriter(path)
    const { rows } = await writer.open()
    await writer.close()
    assert.deepEqual(rows.map((r) => r.seq), [1, 2])
  })
})

test('foldLedger 记忆化：同一个数组未变时复用结果，追加后重建', () => {
  const rows = [
    { seq: 1, kind: 'ask', msgId: 'm1', targets: ['s1'] },
    { seq: 2, kind: 'answer', session: 's1', turn: 1, digest: 'a' },
  ]
  const first = foldLedger(rows)
  const second = foldLedger(rows)
  assert.equal(first, second, '未变化时应返回同一个对象（记忆化生效）')

  rows.push({ seq: 3, kind: 'answer', session: 's1', turn: 2, digest: 'b' })
  const third = foldLedger(rows)
  assert.notEqual(third, first, '行数变化后应重建')
  assert.equal(third.answers.size, 2)
})

test('watch：追加落盘后通知订阅者，取消订阅后不再通知', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-watch-'))
  try {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    await writer.open()

    const seen = []
    const unsubscribe = writer.watch((row) => seen.push({ seq: row.seq, kind: row.kind }))

    await writer.run(({ append }) => append({ kind: 'note', msgId: 'm1', digest: 'a' }))
    await writer.run(({ append }) => append({ kind: 'ask', msgId: 'm2', digest: 'b' }))
    assert.deepEqual(seen, [
      { seq: 1, kind: 'note' },
      { seq: 2, kind: 'ask' },
    ])

    unsubscribe()
    await writer.run(({ append }) => append({ kind: 'note', msgId: 'm3', digest: 'c' }))
    assert.equal(seen.length, 2, '取消订阅后不应再收到')

    await writer.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('watch：订阅者抛错不影响账本写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-watch2-'))
  try {
    const writer = new RoomWriter(join(dir, 'ledger.jsonl'))
    await writer.open()
    writer.watch(() => {
      throw new Error('订阅者炸了')
    })

    const seq = await writer.run(({ append }) => append({ kind: 'note', msgId: 'x', digest: 'x' }))
    assert.equal(seq, 1, '写入仍应成功并返回序号')
    assert.equal(writer.rows.length, 1)

    await writer.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
