/**
 * dsh-room — 浏览器半。
 *
 * 手写闭包工厂（与 dsh-groupchat 同形态）：宿主原样送出本文件，浏览器通过
 * window.__ModuleLoader__ 注册。只依赖平台共享的 react。
 *
 * M1 只做三件事：
 *   1. 房间消息列表（含未就绪产物标记）
 *   2. 「发给」选择器（member 模式，无默认值——设计文档 §5.1.1）
 *   3. 发送 + 拉取
 */

window.__ModuleLoader__.load({
  id: 'dsh-room',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var POLL_MS = 4000

    var KIND_LABEL = { ask: '指令', answer: '回答', note: '进展', system: '系统' }
    var KIND_COLOR = {
      ask: '#378ADD',
      answer: '#1D9E75',
      note: '#BA7517',
      system: '#8A8A8E',
    }

    function basename(p) {
      var s = String(p || '').replace(/[\\/]+$/, '')
      var parts = s.split(/[\\/]/)
      return parts[parts.length - 1] || s
    }

    function styles() {
      return {
        root: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          fontSize: '13px',
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
          flex: '0 0 auto',
        },
        title: { fontWeight: 600, fontSize: '13px' },
        muted: { color: 'var(--dsw-alias-text-secondary, #8A8A8E)', fontSize: '11px' },
        list: { flex: '1 1 auto', overflowY: 'auto', padding: '8px 12px', minHeight: 0 },
        row: { display: 'flex', gap: '8px', padding: '6px 0', alignItems: 'flex-start' },
        seq: { minWidth: '34px', fontSize: '11px', color: '#8A8A8E', fontVariantNumeric: 'tabular-nums' },
        badge: {
          fontSize: '10px',
          padding: '1px 5px',
          borderRadius: '4px',
          color: '#fff',
          flex: '0 0 auto',
          lineHeight: '16px',
        },
        body: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
        who: { fontWeight: 600, marginRight: '6px' },
        scope: { fontSize: '11px', color: '#378ADD', marginRight: '6px' },
        artifact: { fontSize: '11px', color: '#378ADD' },
        composer: {
          flex: '0 0 auto',
          padding: '8px 12px',
          borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        },
        composerRow: { display: 'flex', gap: '6px', alignItems: 'center' },
        select: {
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: 'inherit',
          maxWidth: '140px',
        },
        input: {
          flex: '1 1 auto',
          fontSize: '13px',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: 'inherit',
          minWidth: 0,
        },
        sendBtn: {
          fontSize: '12px',
          padding: '5px 12px',
          borderRadius: '6px',
          border: 'none',
          background: '#378ADD',
          color: '#fff',
          cursor: 'pointer',
        },
        error: { fontSize: '11px', color: '#E24B4A', margin: 0 },
        empty: { color: '#8A8A8E', fontSize: '12px', padding: '16px 0', textAlign: 'center' },
        addBtn: {
          fontSize: '12px',
          padding: '3px 10px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          marginLeft: 'auto',
        },
        panel: {
          flex: '0 0 auto',
          padding: '10px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          background: 'var(--dsw-alias-bg-secondary, rgba(0,0,0,.02))',
        },
        panelRow: { display: 'flex', gap: '6px', alignItems: 'center' },
        panelLabel: { fontSize: '11px', color: '#8A8A8E', minWidth: '52px' },
        panelInput: {
          flex: '1 1 auto',
          fontSize: '12px',
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: 'inherit',
          minWidth: 0,
        },
        panelSelect: {
          flex: '1 1 auto',
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: 'inherit',
          minWidth: 0,
        },
        hint: { fontSize: '11px', color: '#8A8A8E', margin: 0, lineHeight: 1.5 },
        panelTitle: {
          fontSize: '11px',
          fontWeight: 600,
          color: '#8A8A8E',
          margin: '4px 0 0',
        },
        memberRowText: { flex: '1 1 auto', fontSize: '12px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
        removeBtn: {
          fontSize: '11px',
          lineHeight: '18px',
          padding: '0 7px',
          borderRadius: '5px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
          background: 'transparent',
          color: '#E24B4A',
          cursor: 'pointer',
        },
      }
    }

    function RoomView() {
      var s = styles()

      var [roomsList, setRoomsList] = useState(null) // GET /room 的 rooms[]
      var [sel, setSel] = useState('') // "cwd::roomId"
      var [data, setData] = useState(null)
      var [error, setError] = useState('')
      var [draft, setDraft] = useState('')
      var [to, setTo] = useState('') // 空 = 未选；无默认值
      var [adding, setAdding] = useState(false) // 展开「添加成员」面板
      var [newNick, setNewNick] = useState('')
      var [newRoute, setNewRoute] = useState('') // "provider␟model"
      var [newRoomName, setNewRoomName] = useState('') // 非空 = 先建一个新房间
      var [busy, setBusy] = useState(false)
      var [roomsWs, setRoomsWs] = useState([]) // 房间清单接口带回的工作区列表
      var [roomsCatalog, setRoomsCatalog] = useState([]) // 房间清单接口带回的模型目录
      var [newCwd, setNewCwd] = useState('') // 空态下"建在哪个工作区"
      var [joinTarget, setJoinTarget] = useState('') // 加入已有会话：sessionId
      var [joinNick, setJoinNick] = useState('') // 加入已有会话：昵称
      var [renameTo, setRenameTo] = useState('') // 房间改名
      var mounted = useRef(true)
      var pendingPost = useRef(null)

      function memberKey(member) {
        return member.kind === 'external' ? 'external:' + member.memberId : member.sessionId
      }

      // 从 "cwd::roomId" 拆出当前房间。
      var selParts = sel.split('::')
      var cwd = selParts[0] || ''
      var roomId = selParts[1] || ''

      useEffect(function () {
        mounted.current = true
        return function () { mounted.current = false }
      }, [])

      /** 房间请求的 URL（cwd + room 两个参数）。 */
      function roomUrl(extra) {
        return '/room?cwd=' + encodeURIComponent(cwd) +
          '&room=' + encodeURIComponent(roomId || 'default') +
          (extra || '')
      }

      // 1. 房间清单：进页面 / 新建后刷新。
      function loadRooms() {
        fetch('/room', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            if (!json || json.ok !== true) {
              setError((json && json.error) || 'rooms-failed')
              return
            }
            var list = json.rooms || []
            setRoomsList(list)
            setRoomsWs(json.workspaces || [])
            setRoomsCatalog(json.modelGroups || [])
            if (cwd === '' && list.length > 0) setSel(list[0].key)
            else if (cwd === '' && (json.workspaces || []).length > 0) setNewCwd(json.workspaces[0].path)
          })
          .catch(function () { if (mounted.current) setError('network') })
      }

      useEffect(function () { loadRooms() }, [])

      /**
       * 2. 房间内容：SSE 优先，连不上降级为轮询。
       *
       * 为什么保留轮询：EventSource 在部分环境（代理拦截、休眠唤醒）会静默失败，
       * 而轮询虽然慢但绝对不会"看不到新消息"。两条路互为兜底。
       */
      useEffect(function () {
        if (cwd === '') return
        var timer = null
        var stopped = false
        var source = null

        function reload() {
          fetch(roomUrl('&count=80'), { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json() })
            .then(function (json) {
              if (stopped || !mounted.current) return
              if (!json || json.ok !== true) {
                setError((json && json.error) || 'read-failed')
                return
              }
              setError('')
              setData(json)
            })
            .catch(function () {
              if (!stopped && mounted.current) setError('network')
            })
        }

        function startPolling() {
          if (stopped || timer !== null) return
          function tick() {
            reload()
            timer = setTimeout(tick, POLL_MS)
          }
          tick()
        }

        function stopPolling() {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        }

        // 先拉一次，保证首屏不空等。
        reload()

        // EventSource 不可用（老环境/被禁用）→ 直接轮询。
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
          startPolling()
        } else {
          try {
            source = new window.EventSource(
              '/room/events?cwd=' + encodeURIComponent(cwd) +
              '&room=' + encodeURIComponent(roomId || 'default'),
            )
            source.addEventListener('ready', function () {
              if (stopped) return
              // 通道打通 → 关掉轮询；后续靠 change 事件触发拉取。
              stopPolling()
              reload()
            })
            source.addEventListener('change', function () {
              if (stopped) return
              reload()
            })
            source.addEventListener('error', function () {
              if (stopped) return
              // 断线：降级轮询兜底。EventSource 自己会尝试重连，
              // 重连成功后 ready 会再次触发，从而关掉轮询。
              startPolling()
            })
          } catch (_) {
            startPolling()
          }
        }

        return function () {
          stopped = true
          stopPolling()
          try {
            source && source.close()
          } catch (_) {
            // 忽略
          }
        }
      }, [sel])

      /** 发一条消息：to = sessionId 或 '__all__'（广播）。 */
      function send() {
        if (draft.trim() === '') return
        if (to === '') {
          setError('先选一个收件人')
          return
        }
        var target = to === '__all__'
          ? { mode: 'all' }
          : to.indexOf('external:') === 0 ? { mode: 'protocol' } : { mode: 'member', sessionId: to }
        var request = { action: 'post', text: draft, target: target }
        if (to.indexOf('external:') === 0) request.targetMemberIds = [to.slice('external:'.length)]
        var signature = JSON.stringify(request)
        if (!pendingPost.current || pendingPost.current.signature !== signature)
          pendingPost.current = { signature: signature, key: crypto.randomUUID() }
        request.idempotencyKey = pendingPost.current.key
        fetch(roomUrl(''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            if (!json || json.ok !== true) {
              setError((json && json.error) || 'send-failed')
              return
            }
            setError('')
            setDraft('')
            pendingPost.current = null
          })
          .catch(function () { if (mounted.current) setError('network') })
      }

      /** 把一个既有会话拉进当前房间。 */
      function joinMember() {
        if (joinTarget === '') { setError('先选一个会话'); return }
        var nick = joinNick.trim()
        if (nick === '') { setError('给它起个昵称'); return }
        setBusy(true)
        fetch(roomUrl(''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add-member', sessionId: joinTarget, nick: nick }),
        })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            setBusy(false)
            if (!json || json.ok !== true) {
              setError((json && json.error) || 'join-failed')
              return
            }
            setError('')
            setJoinTarget('')
            setJoinNick('')
            setAdding(false)
          })
          .catch(function () {
            if (!mounted.current) return
            setBusy(false)
            setError('network')
          })
      }

      /** 把一个成员移出房间（不销毁会话）。 */
      function removeMember(member) {
        if (busy) return
        setBusy(true)
        fetch(roomUrl(''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(member.kind === 'external' ? { action: 'revoke-external', memberId: member.memberId }
            : { action: 'remove-member', sessionId: member.sessionId }),
        })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            setBusy(false)
            if (!json || json.ok !== true) {
              setError((json && json.error) || 'remove-failed')
              return
            }
            setError('')
            if (to === memberKey(member)) setTo('')
          })
          .catch(function () {
            if (!mounted.current) return
            setBusy(false)
            setError('network')
          })
      }

      /** 先建房间（如果填了名字），再建成员。 */
      function createMember() {
        var nick = newNick.trim()
        if (nick === '') { setError('先给成员起个名字'); return }
        if (newRoute === '') { setError('先选一个模型'); return }

        var targetCwd = cwd || newCwd
        if (targetCwd === '') { setError('先选一个工作区'); return }

        var parts = newRoute.split('\u241F')
        setBusy(true)

        // 需要新房间时先建它，拿到 roomId 再建成员。
        var roomPromise = newRoomName.trim() === ''
          ? Promise.resolve({ ok: true, roomId: roomId || 'default', cwd: targetCwd })
          : fetch('/room?cwd=' + encodeURIComponent(targetCwd), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'create-room', cwd: targetCwd, name: newRoomName.trim() }),
            }).then(function (r) { return r.json() })

        roomPromise
          .then(function (roomJson) {
            if (!roomJson || roomJson.ok !== true) {
              throw new Error((roomJson && roomJson.error) || 'create-room-failed')
            }
            var rid = roomJson.roomId || 'default'
            var rcwd = roomJson.cwd || targetCwd
            return fetch('/room?cwd=' + encodeURIComponent(rcwd) + '&room=' + encodeURIComponent(rid), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'create-member',
                nick: nick,
                provider: parts[0],
                model: parts[1],
              }),
            }).then(function (r) { return r.json() }).then(function (j) {
              return { json: j, rid: rid, cwd: rcwd }
            })
          })
          .then(function (res) {
            if (!mounted.current) return
            setBusy(false)
            if (!res.json || res.json.ok !== true) {
              setError((res.json && res.json.error) || 'create-failed')
              return
            }
            setError('')
            setNewNick('')
            setNewRoomName('')
            setAdding(false)
            setSel(res.cwd + '::' + res.rid)
            loadRooms()
          })
          .catch(function (e) {
            if (!mounted.current) return
            setBusy(false)
            setError(String((e && e.message) || 'network'))
          })
      }

      /** 删除当前房间（只允许空房间）。 */
      function deleteRoom() {        if (busy) return
        setBusy(true)
        fetch(roomUrl(''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete-room' }),
        })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            setBusy(false)
            if (!json || json.ok !== true) {
              setError(
                json && json.error === 'room-not-empty'
                  ? '房间还有消息，不能删。'
                  : (json && json.error) || 'delete-failed',
              )
              return
            }
            setError('')
            setData(null)
            setSel('')
            setTo('')
            loadRooms()
          })
          .catch(function () {
            if (!mounted.current) return
            setBusy(false)
            setError('network')
          })
      }

      /** 给当前房间改名。 */
      function renameRoom() {
        var name = renameTo.trim()
        if (name === '') { setError('房间名不能为空'); return }
        if (busy) return
        setBusy(true)
        fetch(roomUrl(''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'rename-room', name: name }),
        })
          .then(function (r) { return r.json() })
          .then(function (json) {
            if (!mounted.current) return
            setBusy(false)
            if (!json || json.ok !== true) {
              setError((json && json.error) || 'rename-failed')
              return
            }
            setError('')
            setRenameTo('')
            loadRooms()
          })
          .catch(function () {
            if (!mounted.current) return
            setBusy(false)
            setError('network')
          })
      }

      var members = (data && data.members) || []
      var rows = (data && data.rows) || []
      var modelGroups = (data && data.modelGroups && data.modelGroups.length > 0)
        ? data.modelGroups
        : roomsCatalog

      var roomOptions = (roomsList || []).map(function (r) {
        var label = r.workspace === r.name ? r.name : (r.workspace + ' · ' + r.name)
        return h('option', { key: r.key, value: r.key }, label)
      })

      var memberOptions = members.map(function (m) {
        var route = m.route || {}
        var label = m.nick + (route.model ? ' · ' + route.model : '') + (m.online ? '' : '（离线）')
        return h('option', { key: memberKey(m), value: memberKey(m) }, label)
      })

      // 「加入已有会话」的候选：同工作区、还没进房间的实时会话。
      var candidates = (data && data.candidates) || []
      var candidateOptions = candidates.map(function (c) {
        var short = String(c.sessionId).replace(/^session-/, '').slice(0, 8)
        var label = (c.title || ('会话 ' + short)) + (c.model ? ' · ' + c.model : '')
        return h('option', { key: c.sessionId, value: c.sessionId }, label)
      })

      /**
       * 消息行上的投递范围标签（用户反馈 #25：定向/广播在界面里长得一样）。
       * 只对 ask 行显示；answer/note 是某个成员的产出，没有"投给谁"的概念。
       */
      function targetLabel(row) {
        if (row === null || row === undefined || row.kind !== 'ask') return null
        var t = row.targetMemberIds && row.targetMemberIds.length ? row.targetMemberIds : row.targets
        if (!Array.isArray(t) || t.length === 0) return null
        if (t.length > 1) return '广播 → 全员 ' + t.length + ' 人'
        var id = t[0]
        var hit = null
        for (var i = 0; i < members.length; i += 1) {
          if (members[i].sessionId === id || members[i].memberId === id) { hit = members[i]; break }
        }
        return '→ ' + (hit !== null ? hit.nick : String(id).slice(0, 14))
      }

      // 模型下拉：按 provider（供应商）分组，数据来自宿主的模型目录。
      var modelOptGroups = modelGroups.map(function (group) {
        return h('optgroup', { key: group.id, label: group.name || group.id },
          (group.models || []).map(function (m) {
            return h('option', {
              key: group.id + '\u241F' + m.id,
              value: group.id + '\u241F' + m.id,
            }, m.name || m.id)
          })
        )
      })

      /** 「昵称 + 模型 + 新房间名」三行表单，空态和房间内共用。 */
      function memberForm(showRoomName) {
        return [
          h('div', { key: 'nick', style: s.panelRow },
            h('span', { style: s.panelLabel }, '昵称'),
            h('input', {
              style: s.panelInput,
              placeholder: '如 kimi、glm、reviewer（不含空格与 @）',
              value: newNick,
              onChange: function (e) { setNewNick(e.target.value) },
            })
          ),
          h('div', { key: 'model', style: s.panelRow },
            h('span', { style: s.panelLabel }, '模型'),
            h('select', {
              style: s.panelSelect,
              value: newRoute,
              onChange: function (e) { setNewRoute(e.target.value) },
            },
              h('option', { value: '' },
                modelGroups.length === 0 ? '（宿主还没提供模型目录）' : '选一个供应商的模型…'),
              modelOptGroups
            )
          ),
          showRoomName
            ? h('div', { key: 'room', style: s.panelRow },
                h('span', { style: s.panelLabel }, '新房间'),
                h('input', {
                  style: s.panelInput,
                  placeholder: '填名字 = 新建一个房间（留空 = 用当前房间）',
                  value: newRoomName,
                  onChange: function (e) { setNewRoomName(e.target.value) },
                })
              )
            : null,
          h('div', { key: 'actions', style: s.panelRow },
            h('span', { style: s.panelLabel }, ''),
            h('button', {
              style: Object.assign({}, s.sendBtn, busy ? { opacity: 0.6 } : {}),
              onClick: busy ? function () {} : createMember,
            }, busy ? '创建中…' : '创建成员'),
            h('button', {
              style: Object.assign({}, s.addBtn, { marginLeft: '6px' }),
              onClick: function () { setAdding(false); setNewNick(''); setNewRoute(''); setNewRoomName('') },
            }, '取消')
          )
        ]
      }

      var addPanel = adding && cwd !== ''
        ? h('div', { style: s.panel },
            h('p', { style: s.panelTitle }, '新建成员'),
            memberForm(true),
            modelGroups.length === 0
              ? h('p', { style: Object.assign({}, s.hint, { color: '#BA7517' }) },
                  '没拿到模型目录：先在「设置 → 模型」里配好一个 provider 和 API key，再回来。')
              : null,

            h('p', { style: s.panelTitle }, '加入已有会话'),
            h('div', { style: s.panelRow },
              h('span', { style: s.panelLabel }, '会话'),
              h('select', {
                style: s.panelSelect,
                value: joinTarget,
                onChange: function (e) { setJoinTarget(e.target.value) },
              },
                h('option', { value: '' },
                  candidateOptions.length === 0 ? '（没有可加入的会话）' : '选一个正在运行的会话…'),
                candidateOptions
              )
            ),
            h('div', { style: s.panelRow },
              h('span', { style: s.panelLabel }, '昵称'),
              h('input', {
                style: s.panelInput,
                placeholder: '给这个会话在房间里起个名字',
                value: joinNick,
                onChange: function (e) { setJoinNick(e.target.value) },
              })
            ),
            h('div', { style: s.panelRow },
              h('span', { style: s.panelLabel }, ''),
              h('button', {
                style: Object.assign({}, s.sendBtn, busy ? { opacity: 0.6 } : {}),
                onClick: busy ? function () {} : joinMember,
              }, busy ? '处理中…' : '加入房间'),
              h('button', {
                style: Object.assign({}, s.addBtn, { marginLeft: '6px' }),
                onClick: function () { setAdding(false); setNewNick(''); setNewRoute(''); setNewRoomName('') },
              }, '完成')
            ),

            h('p', { style: s.panelTitle }, '成员（点 ✕ 移出房间，不删会话）'),
            members.length === 0
              ? h('p', { style: s.hint }, '还没有成员。')
              : members.map(function (m) {
                  var route = m.route || {}
                  return h('div', { key: memberKey(m), style: s.panelRow },
                    h('span', { style: s.memberRowText },
                      m.nick + '  ' + (route.model || '') + (m.online ? '' : '（离线）')),
                    h('button', {
                      style: Object.assign({}, s.removeBtn, busy ? { opacity: 0.4 } : {}),
                      title: '移出房间',
                      onClick: busy ? function () {} : function () { removeMember(m) },
                    }, '✕')
                  )
                }),

            h('p', { style: s.hint },
              '成员是独立会话，用自己的模型。房间只把「发给它」的消息投递过去，' +
              '其余成员看不到。模型按供应商分组，与 DSH 自己的模型选择器同源。'),

            h('p', { style: s.panelTitle }, '房间'),
            h('div', { style: s.panelRow },
              h('span', { style: s.panelLabel }, '改名'),
              h('input', {
                style: s.panelInput,
                placeholder: '新房间名（≤40 字）',
                value: renameTo,
                onChange: function (e) { setRenameTo(e.target.value) },
              }),
              h('button', {
                style: Object.assign({}, s.addBtn, { marginLeft: '6px' }, busy ? { opacity: 0.5 } : {}),
                onClick: busy ? function () {} : renameRoom,
              }, '改名')
            ),

            rows.length === 0
              ? h('div', { style: s.panelRow },
                  h('span', { style: s.panelLabel }, ''),
                  h('button', {
                    style: Object.assign({}, s.removeBtn, busy ? { opacity: 0.4 } : {}),
                    title: '只有空房间能删',
                    onClick: busy ? function () {} : deleteRoom,
                  }, '删除这个空房间')
                )
              : null,

            error !== '' ? h('p', { style: s.error }, error) : null
          )
        : null

      // 还没有任何房间：给工作区选择 + 建房间/建成员入口。
      if (roomsList !== null && roomsList.length === 0) {
        return h('div', { style: s.root, 'data-room-root': '1' },
          h('div', { style: s.header },
            h('span', { style: s.title }, '房间'),
            h('span', { style: s.muted }, '还没有房间'),
            h('button', {
              style: s.addBtn,
              onClick: function () { setAdding(!adding); setError('') },
            }, adding ? '收起' : '＋ 新建房间')
          ),
          adding
            ? h('div', { style: s.panel },
                h('div', { style: s.panelRow },
                  h('span', { style: s.panelLabel }, '工作区'),
                  h('select', {
                    style: s.panelSelect,
                    value: newCwd,
                    onChange: function (e) { setNewCwd(e.target.value) },
                  }, roomsWs.map(function (w) {
                    return h('option', { key: w.path, value: w.path }, w.name)
                  }))
                ),
                memberForm(true),
                h('p', { style: s.hint }, '填「新房间」的名字就会同时建出房间和第一个成员。'),
                error !== '' ? h('p', { style: s.error }, error) : null
              )
            : h('div', { style: s.list },
                h('div', { style: s.empty },
                  roomsWs.length === 0
                    ? '没有可用的工作区。先在 DSH 里打开一个项目，再回到这里。'
                    : '还没有房间。点右上角「＋ 新建房间」，选工作区、起个名字就能建第一个。'
                )
              )
        )
      }

      return h('div', { style: s.root, 'data-room-root': '1' },
        h('div', { style: s.header },
          h('span', { style: s.title }, '房间'),
          (roomsList || []).length > 1
            ? h('select', {
                style: s.select,
                value: sel,
                onChange: function (e) { setSel(e.target.value); setData(null) },
              }, roomOptions)
            : h('span', { style: s.muted }, (data && data.name) || basename(cwd) || '—'),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' } },
            h('span', { style: s.muted }, members.length + ' 位成员'),
            h('button', {
              style: s.addBtn,
              onClick: function () { setAdding(!adding); setError('') },
            }, adding ? '收起' : '＋ 添加成员')
          )
        ),

        addPanel,

        h('div', { style: s.list },
          rows.length === 0
            ? h('div', { style: s.empty }, members.length === 0
                ? '还没有成员。点右上角「＋ 添加成员」。'
                : '还没有消息。选一个收件人，把指令发出去。')
            : rows.map(function (row) {
                var color = KIND_COLOR[row.kind] || '#8A8A8E'
                var scope = targetLabel(row)
                return h('div', { key: row.seq, style: s.row },
                  h('span', { style: s.seq }, '#' + row.seq),
                  h('span', { style: Object.assign({}, s.badge, { background: color }) },
                    KIND_LABEL[row.kind] || row.kind),
                  h('div', { style: s.body },
                    h('span', { style: s.who }, row.from || '—'),
                    scope !== null ? h('span', { style: s.scope }, scope) : null,
                    h('span', {}, row.digest || ''),
                    row.partial ? h('span', { style: s.muted }, '（中断，未完成）') : null,
                    row.artifact
                      ? h('div', { style: s.artifact },
                          '产物 ' + row.artifact +
                          (row.artifactState === 'pending' ? '（未就绪）' : ''))
                      : null
                  )
                )
              })
        ),

        h('div', { style: s.composer },
          h('div', { style: s.composerRow },
            h('select', {
              style: s.select,
              value: to,
              onChange: function (e) { setTo(e.target.value) },
              title: '发给谁（必选）',
            },
              h('option', { value: '' }, '发给…'),
              h('option', { value: '__all__' }, '所有人（广播）'),
              memberOptions
            ),
            h('input', {
              style: s.input,
              placeholder: to === ''
                ? '先选收件人，再输入指令…'
                : to === '__all__'
                  ? '输入指令，回车广播给全部成员'
                  : '输入指令，回车发送',
              value: draft,
              onChange: function (e) { setDraft(e.target.value) },
              onKeyDown: function (e) {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
              },
            }),
            h('button', { style: s.sendBtn, onClick: send }, '发送')
          ),
          error !== '' ? h('p', { style: s.error }, error) : null
        )
      )
    }

    var exports = {}
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'room',
          order: 40,
          label: function () { return '房间' },
        }, RoomView)
      })
    }
    return exports
  },
})
