/**
 * 纯函数测试：判定与账本。
 * 不依赖 DSH，直接 `node --test test/`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  finalAnswerOf,
  isCompletedTurn,
  autoDigest,
  parseMentions,
  validateNick,
  clip,
} from '../lib/decide.js'

import { parseLedger, normalizeRow, foldLedger, deliveryKey } from '../lib/ledger.js'

/** 造一条 assistant/message 事件。 */
function msg(seq, blocks, extra = {}) {
  return { type: 'assistant/message', seq, data: { message: { content: blocks }, ...extra } }
}

// ---------------------------------------------------------------- 最终回答

test('finalAnswerOf: 38 步轮次取最后一步，不是"我先搜一下"', () => {
  const messages = [
    msg(1, [
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '我先在网络上搜索一下。' },
      { type: 'tool-call', name: 'web_search' },
    ]),
  ]
  for (let seq = 2; seq <= 37; seq += 1) {
    messages.push(msg(seq, [{ type: 'reasoning', text: 'x' }, { type: 'tool-call', name: 'web_search' }]))
  }
  messages.push(msg(38, [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '## 结论\n\n没有官方复刻。' }]))

  const final = finalAnswerOf(messages)
  assert.ok(final, '应能找到最终回答')
  assert.equal(final.text, '## 结论\n\n没有官方复刻。')
  assert.equal(final.event.seq, 38)
})

test('finalAnswerOf: 单步轮次直接命中', () => {
  const messages = [msg(1, [{ type: 'text', text: '只有一句话。' }])]
  assert.equal(finalAnswerOf(messages)?.text, '只有一句话。')
})

test('finalAnswerOf: 最后一步仍在调工具 → 返回 null（异常收尾）', () => {
  const messages = [
    msg(1, [{ type: 'text', text: '中间话' }]),
    msg(2, [{ type: 'tool-call', name: 'bash' }]),
  ]
  assert.equal(finalAnswerOf(messages), null)
})

test('finalAnswerOf: 空批次返回 null', () => {
  assert.equal(finalAnswerOf([]), null)
  assert.equal(finalAnswerOf(null), null)
})

test('finalAnswerOf: 只有 reasoning 没有 text → null', () => {
  const messages = [msg(1, [{ type: 'reasoning', text: '想了很久但没说' }])]
  assert.equal(finalAnswerOf(messages), null)
})

// ---------------------------------------------------------------- 完成判定

test('isCompletedTurn: completed + 文本 → ok', () => {
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const result = isCompletedTurn(turnEnd, [msg(1, [{ type: 'text', text: '完成。' }])])
  assert.equal(result.ok, true)
  assert.equal(result.final?.text, '完成。')
})

test('isCompletedTurn: aborted 即使有半截文本也不算完成', () => {
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'aborted' } } }
  const result = isCompletedTurn(turnEnd, [msg(1, [{ type: 'text', text: '写到一半被打断' }])])
  assert.equal(result.ok, false)
  assert.equal(result.why, 'aborted')
})

test('isCompletedTurn: 没有 turn/end → 不算完成', () => {
  const result = isCompletedTurn(null, [msg(1, [{ type: 'text', text: 'x' }])])
  assert.equal(result.ok, false)
  assert.equal(result.why, 'no-turn-end')
})

test('isCompletedTurn: completed 但无文本 → no-text', () => {
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const result = isCompletedTurn(turnEnd, [msg(1, [{ type: 'tool-call', name: 'x' }])])
  assert.equal(result.ok, false)
  assert.equal(result.why, 'no-text')
})

// ---------------------------------------------------------------- 摘要兜底

test('autoDigest: 首行是 ## 结论 时不会取到标记符', () => {
  const md = '## 结论\n\n**没有官方复刻。** 光荣特库摩近期没有任何立项。\n\n后续细节…'
  const digest = autoDigest(md)
  assert.ok(digest, '应能提取')
  assert.ok(!digest.startsWith('#'), `不应以标题开头，实际: ${digest}`)
  assert.match(digest, /没有官方复刻/)
})

test('autoDigest: 跳过分隔线与空列表项', () => {
  const md = '---\n\n- \n\n1. \n\n这是一段真正的正文，应该被选中。'
  const digest = autoDigest(md)
  assert.ok(digest)
  assert.match(digest, /正文/)
})

test('autoDigest: 只有标题时返回 null（调用方不得伪造）', () => {
  assert.equal(autoDigest('## 结论'), null)
  assert.equal(autoDigest('# 标题\n\n## 小标题'), null)
  assert.equal(autoDigest(''), null)
})

test('autoDigest: 结果单行且不超长', () => {
  const md = '这是一段很长很长的正文'.repeat(100)
  const digest = autoDigest(md)
  assert.ok(digest)
  assert.ok(!digest.includes('\n'))
  assert.ok(digest.length <= 200)
})

// ---------------------------------------------------------------- @ 解析

test('parseMentions: 长昵称优先（@ab 不会把 @abc 切成 ab + c）', () => {
  // 按出现顺序返回，但 "@ab" 不匹配 "@abc" 时的切分必须吃掉整个 abc。
  assert.deepEqual(parseMentions('@ab 和 @abc 都看看', ['ab', 'abc']), ['ab', 'abc'])
  // 单独的 @abc 必须解析成 abc 而不是 ab
  assert.deepEqual(parseMentions('@abc 看一下', ['ab', 'abc']), ['abc'])
})

test('parseMentions: 代码块内的 @ 不解析', () => {
  const text = '正常 @kimi\n```\n@glm 这行不算\n```\n'
  assert.deepEqual(parseMentions(text, ['kimi', 'glm']), ['kimi'])
})

test('parseMentions: 行内代码内的 @ 不解析', () => {
  assert.deepEqual(parseMentions('看 `@glm` 不算，但 @kimi 算', ['kimi', 'glm']), ['kimi'])
})

test('parseMentions: 去重', () => {
  assert.deepEqual(parseMentions('@kimi @kimi @kimi', ['kimi']), ['kimi'])
})

test('validateNick: 拒绝空格与保留分隔符', () => {
  assert.equal(validateNick('kimi').ok, true)
  assert.equal(validateNick('a b').ok, false)
  assert.equal(validateNick('@kimi').ok, false)
  assert.equal(validateNick('').ok, false)
  assert.equal(validateNick('x'.repeat(33)).ok, false)
})

test('clip: 单行化并截断', () => {
  assert.equal(clip('a\n\nb', 100), 'a b')
  assert.ok(clip('x'.repeat(300), 200).length <= 200)
})

// ---------------------------------------------------------------- 账本

test('parseLedger: 丢弃末尾半行', () => {
  const raw = '{"seq":1,"kind":"ask"}\n{"seq":2,"kind":"ask"}\n{"seq":3,"kind":"as'
  const { rows, goodLength } = parseLedger(raw)
  assert.equal(rows.length, 2)
  assert.equal(goodLength, raw.indexOf('\n{"seq":3') + 1)
})

test('parseLedger: 跳过损坏行但保留前后完整行', () => {
  const raw = '{"seq":1,"kind":"ask"}\nNOT JSON\n{"seq":2,"kind":"note"}\n'
  const { rows } = parseLedger(raw)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.seq), [1, 2])
})

test('normalizeRow: ask 必须带非空 text', () => {
  assert.equal(normalizeRow({ kind: 'ask', msgId: 'm1' }).ok, false)
  assert.equal(normalizeRow({ kind: 'ask', msgId: 'm1', text: '   ' }).ok, false)
  assert.equal(normalizeRow({ kind: 'ask', msgId: 'm1', text: '真的指令' }).ok, true)
})

test('normalizeRow: digest 必须单行且不超长', () => {
  assert.equal(normalizeRow({ kind: 'note', msgId: 'm', digest: 'a\nb' }).ok, false)
  assert.equal(normalizeRow({ kind: 'note', msgId: 'm', digest: 'x'.repeat(201) }).ok, false)
  assert.equal(normalizeRow({ kind: 'note', msgId: 'm', digest: 'ok' }).ok, true)
})

test('normalizeRow: 未知 kind 拒绝', () => {
  assert.equal(normalizeRow({ kind: 'bogus', msgId: 'm' }).ok, false)
})

test('normalizeRow: 空 targets 拒绝（防止"发给人但没目标"）', () => {
  assert.equal(normalizeRow({ kind: 'ask', msgId: 'm', text: 'x', targets: [] }).ok, false)
  assert.equal(normalizeRow({ kind: 'ask', msgId: 'm', text: 'x', targets: ['s1'] }).ok, true)
})

test('foldLedger: answer 按 (session, turn) 去重键归并', () => {
  const rows = [
    { seq: 1, kind: 'ask', msgId: 'm1', targets: ['s1'], text: 'hi' },
    { seq: 2, kind: 'answer', msgId: 'a1', session: 's1', turn: 3, digest: 'done' },
  ]
  const folded = foldLedger(rows)
  assert.equal(folded.asks.size, 1)
  assert.equal(folded.answers.get('s1#3')?.digest, 'done')
  assert.ok(folded.deliveredMsgIds.has('m1'))
})

test('deliveryKey: 逐接收者键', () => {
  assert.equal(deliveryKey('m1', 's1'), 'm1@s1')
  assert.notEqual(deliveryKey('m1', 's1'), deliveryKey('m1', 's2'))
})
