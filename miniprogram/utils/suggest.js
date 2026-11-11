/**
 * 动态联想问题的预取与缓存
 *
 * 三层状态，这是不重复请求的关键：
 *   缓存  — 已生成的结果
 *   在途  — 正在生成，防止连点翻页时同一张发两次
 *   队列  — 等待生成，串行跑，并发打云函数容易撞限流
 *
 * 缓存键用「卡片文本 + 原文」而不是「卡组 id + 序号」：
 *   示例卡每次进入阅读页都会重新生成一个 id，用 id 做键永远命中不了，
 *   每次打开都要等一次生成。而同样的一段卡片文本 + 同一页原文，
 *   生成的问答本来就应该一样，与它在哪个卡组里无关。
 *
 * 两条硬规则：
 *   1. 队列只留最近两个。快速连翻时更早的任务已经没人等了，
 *      不丢掉的话，翻六页会排六次请求，最后一次要等前面五次跑完。
 *   2. 预取是后台任务，翻页与朗读都不等它。生成不出来就用兜底三问。
 */

const CACHE_KEY = 'ask_suggest_v2'
const MAX_QUEUE = 2
const MAX_KEYS = 120

let memory = null
let inflight = {}
let queue = []
let running = false
let listener = null

function hash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

function keyOf(cardText, sourceText) {
  return hash(String(cardText || '') + '|' + String(sourceText || '').slice(0, 300))
}

function load() {
  if (memory) return memory
  try {
    memory = wx.getStorageSync(CACHE_KEY) || {}
  } catch (e) {
    memory = {}
  }
  return memory
}

function save() {
  try {
    wx.setStorageSync(CACHE_KEY, memory)
  } catch (e) {}
}

/** 读缓存。命中返回三条问答，未命中返回 null */
function get(key) {
  const c = load()
  const rec = c[key]
  if (rec && rec.items && rec.items.length) return rec.items
  return null
}

function set(key, items) {
  const c = load()
  c[key] = { at: Date.now(), items: items }

  // 攒多了会撑爆 storage，按时间淘汰最旧的一批
  const keys = Object.keys(c)
  if (keys.length > MAX_KEYS) {
    keys.sort(function (a, b) { return (c[a].at || 0) - (c[b].at || 0) })
    for (let i = 0; i < keys.length - MAX_KEYS; i++) delete c[keys[i]]
  }
  save()
}

function callFn(data) {
  return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: 'askCard',
      data: data,
      success: function (res) { resolve(res.result || {}) },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '调用失败'))
      }
    })
  })
}

function drain() {
  if (running || !queue.length) return

  const job = queue.shift()
  running = true
  inflight[job.key] = true

  callFn(Object.assign({ action: 'suggest' }, job.payload))
    .then(function (res) {
      if (!res || !res.ok || !res.items || !res.items.length) return
      set(job.key, res.items)
      if (listener) listener(job.key, res.items)
    })
    .catch(function () {
      // 出题失败不提示：兜底三问一直可用，老人不该知道这里有过一次失败
    })
    .then(function () {
      running = false
      delete inflight[job.key]
      drain()
    })
}

/**
 * 确保这段卡片文本的联想问题在生成队列里。
 * payload: { cardText, anchor, sourceText } —— 注意不传下一步
 */
function ensure(payload) {
  const p = payload || {}
  const key = keyOf(p.cardText, p.sourceText)

  if (!p.cardText) return
  if (get(key)) return
  if (inflight[key]) return
  if (queue.some(function (j) { return j.key === key })) return

  queue.push({ key: key, payload: p })

  // 快速连翻：只留最近两个，前面的直接丢掉
  if (queue.length > MAX_QUEUE) {
    queue.splice(0, queue.length - MAX_QUEUE)
  }

  drain()
}

/** 生成完成时回调，页面据此静默替换 */
function setListener(fn) {
  listener = typeof fn === 'function' ? fn : null
}

/** 离开阅读页：清队列与在途，保留缓存 */
function reset() {
  queue = []
  inflight = {}
}

module.exports = {
  keyOf: keyOf,
  get: get,
  ensure: ensure,
  setListener: setListener,
  reset: reset
}
