/**
 * dsh-room — 判定纯函数。
 *
 * 设计文档 §5.2（最终回答）、§5.3（摘要兜底）、§5.6（完成判定）。
 * 全部无副作用、不依赖 cordis，可直接用 node --test 覆盖。
 */

/** 摘要上限，与账本一致。 */
export const DIGEST_CAP = 200

/**
 * 取一个 turn 内「最终回答」的文本。
 *
 * 规则（设计文档 §5.2，实测 turn 1 有 38 步）：
 *   1. 从最后一条 assistant/message 往前找
 *   2. 遇到含 tool-call 的消息**立即停止**（说明该轮以工具调用收尾）
 *   3. 找第一条「有可见 text 且无 tool-call」的
 *
 * @param {object[]} messages - 该 turn 内的 assistant/message 事件（按 seq 升序）
 * @returns {{ event: object, text: string } | null}
 */
export function finalAnswerOf(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const event = messages[i]
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue

    const hasToolCall = content.some((block) => block?.type === 'tool-call')
    if (hasToolCall) return null // 最后一步还在调工具 → 本轮不是正常收尾

    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (text !== '') return { event, text }
  }
  return null
}

/**
 * 判定一个 turn 是否「正常完成」。
 *
 * 设计文档 §5.6：不能只看"有文本、无工具调用"。必须同时满足：
 *   1. turn/end.reason.kind === 'completed'（实测样本只有 completed / aborted）
 *   2. 没有中断标记
 *   3. 有可用的最终文本
 *
 * @param {object | null | undefined} turnEnd - `turn/end` 事件
 * @param {object[]} messages - 该 turn 内的 assistant/message 事件
 * @returns {{ ok: boolean, why?: string, final?: { event: object, text: string } }}
 */
export function isCompletedTurn(turnEnd, messages) {
  if (turnEnd === undefined || turnEnd === null) return { ok: false, why: 'no-turn-end' }

  const reason = turnEnd?.data?.reason?.kind
  if (reason !== 'completed') return { ok: false, why: reason ?? 'no-reason' }

  // 中断痕迹：样本里 assistant/message 没有 interrupted 字段（795 条全无），
  // 只能从 turn/end 本体与 repair 合成的标记看。
  if (turnEnd?.data?.interrupted === true) return { ok: false, why: 'interrupted' }
  if (turnEnd?.data?.reason?.interrupted === true) return { ok: false, why: 'interrupted' }

  const final = finalAnswerOf(messages)
  if (final === null) return { ok: false, why: 'no-text' }

  return { ok: true, final }
}

/**
 * 从 markdown 自动提取一句摘要（设计文档 §5.3 第 3 档）。
 *
 * v1 的"取首个非空行"会取到 `## 结论` 这种标记符，所以这里：
 *   1. 跳过标题行、分隔线、空列表项
 *   2. 取第一条正文的**首句**（到 。！？.!? 为止）
 *   3. 退化：首条非噪声行，剥掉 markdown 装饰
 *
 * @param {string} markdown
 * @returns {string | null} 提取失败返回 null（调用方不得伪造摘要）
 */
export function autoDigest(markdown) {
  if (typeof markdown !== 'string') return null

  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const isNoise = (line) =>
    /^#{1,6}\s/.test(line) || // 标题
    /^[-*_]{3,}$/.test(line) || // 分隔线
    /^[-*+]\s*$/.test(line) || // 空列表项
    /^\d+[.)]\s*$/.test(line) || // 空有序列表项
    /^```/.test(line) || // 代码围栏
    /^>/.test(line) // 引用块标记（保留内容更好，但先跳过纯标记）

  const candidates = lines.filter((line) => !isNoise(line))
  if (candidates.length === 0) return null

  // 优先取首句（至少 8 个字符，避免 "是。" 这种碎片）
  for (const line of candidates) {
    const cleaned = stripInlineMarkdown(line)
    const match = cleaned.match(/^(.{8,}?[。！？.!?])/)
    if (match !== null) return clip(match[1], DIGEST_CAP)
  }

  // 退化：首条非噪声行
  return clip(stripInlineMarkdown(candidates[0]), DIGEST_CAP)
}

/**
 * 去掉行内 markdown 装饰（加粗、斜体、行内代码、链接）。
 * @param {string} line
 */
export function stripInlineMarkdown(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 截断到上限，并保证结果仍是单行。
 * @param {string} text
 * @param {number} cap
 */
export function clip(text, cap) {
  const flat = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= cap) return flat
  return flat.slice(0, cap - 1) + '…'
}

/**
 * 解析正文里的 @昵称。
 *
 * 设计文档 §16：
 *   - 昵称字符集 `[^\s@，,。；;：:]`，长度 1–32
 *   - 代码围栏（```）与行内代码（`…`）内的 @ **不解析**
 *   - 长昵称优先（避免 `@ab` 抢走 `@abc`）
 *
 * @param {string} text
 * @param {string[]} knownNicks - 房间内已知昵称，长优先自动排序
 * @returns {string[]} 去重后的昵称
 */
export function parseMentions(text, knownNicks = []) {
  const src = stripCode(String(text ?? ''))
  const known = [...new Set(knownNicks)]
    .filter((nick) => typeof nick === 'string' && nick !== '')
    .sort((a, b) => b.length - a.length)

  const found = []
  let cursor = 0
  while (cursor < src.length) {
    const at = src.indexOf('@', cursor)
    if (at === -1) break
    const rest = src.slice(at + 1)

    let hit = null
    for (const nick of known) {
      if (rest.startsWith(nick)) {
        hit = nick
        break
      }
    }
    if (hit === null) {
      const token = rest.match(/^([^\s@，,。；;：:]{1,32})/)
      hit = token === null ? null : token[1]
    }
    if (hit === null) {
      cursor = at + 1
      continue
    }
    if (!found.includes(hit)) found.push(hit)
    cursor = at + 1 + hit.length
  }
  return found
}

/**
 * 把代码围栏与行内代码替换为等长空格，保持索引不变。
 * @param {string} text
 */
export function stripCode(text) {
  let out = text.replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
  out = out.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
  return out
}

/**
 * 校验昵称。
 * @param {string} nick
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateNick(nick) {
  if (typeof nick !== 'string') return { ok: false, error: 'nick-not-string' }
  const trimmed = nick.trim()
  if (trimmed === '') return { ok: false, error: 'nick-empty' }
  if (trimmed.length > 32) return { ok: false, error: 'nick-too-long' }
  if (/[\s@，,。；;：:]/.test(trimmed)) return { ok: false, error: 'nick-bad-char' }
  return { ok: true }
}
