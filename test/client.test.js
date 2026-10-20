/**
 * 客户端半侧的渲染冒烟测试。
 *
 * `lib/client.js` 是浏览器用的闭包工厂（`window.__ModuleLoader__.load`），
 * 只依赖 `react`。本机 profile 里的 react 是断链的 junction，所以这里用一个
 * **极简 React 桩**：createElement 返回普通对象树，useState 返回初值，
 * useEffect 不执行。足够抓到：
 *   - 模块级引用错误（h / useState 拼错）
 *   - 渲染路径里的未定义变量（例如漏定义的 modelOptGroups）
 *   - 空态分支崩溃
 *
 * 不测交互与数据分支——那要 DOM + fetch，留给真机验证。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 极简 React 桩。 */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef() {
    return { current: undefined }
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
}

/** 把元素树摊平成文本，方便断言。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'type' in node) {
    const type = node.type
    if (typeof type === 'function') {
      // 函数组件：直接调用（hooks 由桩接管）。
      return textOf(type(node.props))
    }
    return textOf(node.children)
  }
  return ''
}

/** 在受控 window 下加载客户端模块。 */
async function loadClient() {
  const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

  /** @type {any} */
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }

  // 用 Function 求值；`require` 由我们注入。
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(globalThis.window, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`意外的依赖: ${name}`)
  })

  assert.ok(captured !== null, 'client.js 应调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-room')

  const mod = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`意外的依赖: ${name}`)
  })
  return mod
}

/** 注册并取回组件。 */
async function mount() {
  const mod = await loadClient()
  let component = null
  const ctx = {
    slots: {
      inject(_name, cb) {
        cb()
      },
      register(spec, Comp) {
        assert.equal(spec.name, 'conversation.view')
        assert.equal(spec.id, 'room')
        assert.equal(typeof spec.label, 'function')
        assert.equal(spec.label(), '房间')
        component = Comp
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.ok(component !== null, '应注册一个 conversation.view 组件')
  return component
}

test('client: 模块形状（inject / apply）', async () => {
  const mod = await loadClient()
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('client: 初始渲染不崩，且含关键 UI', async () => {
  const RoomView = await mount()
  const tree = RoomView({})
  const text = textOf(tree)

  assert.ok(text.includes('房间'), `应有标题，实际: ${text.slice(0, 200)}`)
  assert.ok(text.includes('添加成员'), '应有「添加成员」按钮')
  assert.ok(text.includes('发给'), '应有收件人选择器')
})

test('client: 元素树结构可遍历（没有返回 undefined 的子树）', async () => {
  const RoomView = await mount()
  const tree = RoomView({})

  let nodes = 0
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (typeof n === 'object' && 'type' in n) {
      nodes += 1
      assert.ok(n.type !== undefined, '元素必须有 type')
      walk(n.children)
    }
  }
  walk(tree)
  assert.ok(nodes > 3, `元素数应大于 3，实际 ${nodes}`)
})
