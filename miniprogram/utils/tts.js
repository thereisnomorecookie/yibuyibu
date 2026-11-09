/**
 * 语音合成适配层
 *
 * 对外只暴露一个入口：传入文本与语速，返回可播放的本地路径，并缓存供下次复用。
 * 内部两种实现：
 *   cloud  — 云函数 tts 调腾讯云合成（任何正式 AppID 可用，支持语速）
 *   plugin — 微信同声传译插件（仅已认证小程序可用，免密钥，不支持语速）
 *
 * 为什么 cloud 优先（P1-3 调整，原来相反）：
 *   1. 语速、音色、稳定性都只有云函数版能给；
 *   2. 插件唯一优势是免密钥，而云函数版成本极低；
 *   3. 若不调换，认证一通过就会自动选中插件，语速功能静默失效。
 *
 * cloud 失败时自动用 plugin 兜底（连续失败 2 次后彻底切到 plugin），
 * 保证"哪怕云函数欠费，也还有声音"。代价是兜底时语速失效，这一点如实记录。
 */

let plugin = null
let provider = 'none'

try {
  plugin = requirePlugin('WechatSI')
} catch (e) {
  plugin = null
}

// 优先云函数；没有 wx.cloud 时才退回插件
provider = wx.cloud ? 'cloud' : (plugin ? 'plugin' : 'none')

const INDEX_KEY = 'tts_index'
const CLOUD_FAIL_LIMIT = 2
let cloudFailCount = 0
let audioCtx = null

// 页面层统一用 .catch(function () {}) 兜底，错误不会向上暴露，
// 因此在这里集中记录：既供自检页读取，也避免失败时无任何反馈。
let lastError = null
let lastMeta = null
let notified = false

function msgOf(err) {
  if (!err) return '未知错误'
  const s = err.errMsg || err.msg || err.message || String(err)
  return String(s).split('\n')[0].trim()
}

function noteError(stage, err) {
  const msg = msgOf(err)
  const hint = (err && err.hint) || ''

  lastError = { stage: stage, msg: msg, hint: hint, at: Date.now() }

  // 一次会话只提示一次：语音不可用时给出提示，避免界面看起来无响应
  if (!notified) {
    notified = true
    try {
      wx.showToast({ title: '语音没接通，字还能看', icon: 'none', duration: 2500 })
    } catch (e) {}
  }

  return msg
}

function hash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

/** 语速归一到腾讯云可接受区间；不传就是 0 */
function normalizeSpeed(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.min(2, Math.max(-2, n))
}

/**
 * 缓存键必须带语速。
 * 只按文本做键的话，慢速请求会命中正常速度的音频，
 * 用户点了三次"再念一遍"却一点没慢，还以为是 bug。
 */
function keyOf(text, speed) {
  return hash(text + '|' + speed)
}

function readIndex() {
  try {
    return wx.getStorageSync(INDEX_KEY) || {}
  } catch (e) {
    return {}
  }
}

function writeIndex(idx) {
  try {
    wx.setStorageSync(INDEX_KEY, idx)
  } catch (e) {}
}

function fileExists(path) {
  if (!path) return false
  try {
    wx.getFileSystemManager().accessSync(path)
    return true
  } catch (e) {
    return false
  }
}

function localPathFor(key) {
  return wx.env.USER_DATA_PATH + '/tts_' + key + '.mp3'
}

function play(src) {
  return new Promise(function (resolve, reject) {
    if (!audioCtx) {
      audioCtx = wx.createInnerAudioContext()
      // 不遵循静音键：真机常处于静音状态，否则会被误判为无音频输出
      audioCtx.obeyMuteSwitch = false
    }
    try {
      audioCtx.stop()
      if (audioCtx.offEnded) audioCtx.offEnded()
      if (audioCtx.offError) audioCtx.offError()
    } catch (e) {}

    let settled = false
    audioCtx.onEnded(function () {
      if (settled) return
      settled = true
      resolve()
    })
    audioCtx.onError(function (err) {
      if (settled) return
      settled = true
      noteError('play', err)
      reject(err)
    })
    audioCtx.src = src
    audioCtx.play()
  })
}

function synthByPlugin(text, key) {
  return new Promise(function (resolve, reject) {
    if (!plugin) return reject(new Error('插件不可用'))
    plugin.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: text,
      success: function (res) {
        if (res.retcode !== 0 || !res.filename) {
          return reject(new Error(noteError('plugin/api', { message: 'retcode=' + res.retcode })))
        }
        const url = res.filename
        const target = localPathFor(key)
        // 尽力存本地；存不下就先播远程，下次再合成
        wx.downloadFile({
          url: url,
          success: function (d) {
            if (d.statusCode !== 200) return resolve(url)
            try {
              wx.getFileSystemManager().saveFileSync(d.tempFilePath, target)
              resolve(target)
            } catch (e) {
              resolve(url)
            }
          },
          fail: function () { resolve(url) }
        })
      },
      fail: function (err) {
        reject(new Error(noteError('plugin/invoke', { message: (err && err.msg) || '插件调用失败' })))
      }
    })
  })
}

function synthByCloud(text, key, speed) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud) {
      return reject(new Error(noteError('cloud/init', { message: '当前基础库没有 wx.cloud' })))
    }

    wx.cloud.callFunction({
      name: 'tts',
      data: { text: text, speed: speed },
      success: function (res) {
        const r = res.result || {}

        if (!r.ok || !r.audio) {
          // 云函数已把腾讯云的 code 翻成人话，这里原样往上抛
          const e = new Error(r.error || '云函数合成失败')
          e.code = r.code
          e.requestId = r.requestId
          e.hint = r.hint || ''
          return reject(new Error(noteError('cloud/api', e)))
        }

        lastMeta = { voice: r.voice, voiceKind: r.voiceKind, bytes: r.bytes }

        const target = localPathFor(key)
        try {
          wx.getFileSystemManager().writeFileSync(target, r.audio, 'base64')
          resolve(target)
        } catch (e) {
          reject(new Error(noteError('cloud/write', { message: '音频写本地文件失败：' + msgOf(e) })))
        }
      },
      fail: function (err) {
        reject(new Error(noteError('cloud/invoke', err)))
      }
    })
  })
}

/**
 * 合成。cloud 失败时用 plugin 兜底，不让"云函数挂了"变成"完全没声音"。
 * 注意：plugin 没有语速参数，兜底播出来是正常速度，慢速会失效。
 * 连续失败达到阈值后本次会话彻底切到 plugin，避免每句话都先等一次云函数超时。
 */
function synth(text, key, speed) {
  if (provider === 'cloud') {
    return synthByCloud(text, key, speed).catch(function (err) {
      cloudFailCount += 1
      if (cloudFailCount >= CLOUD_FAIL_LIMIT && plugin) {
        provider = 'plugin'
      }
      if (!plugin) throw err
      return synthByPlugin(text, key)
    })
  }

  if (plugin) return synthByPlugin(text, key)

  const e = new Error(noteError('synth', { message: '没有可用的语音通道' }))
  return Promise.reject(e)
}

function speak(text, opts) {
  const content = String(text || '').trim()
  if (!content) return Promise.resolve()

  const speed = normalizeSpeed(opts && opts.speed)
  const key = keyOf(content, speed)
  const idx = readIndex()
  const rec = idx[key]

  // 1. 本地有文件，直接播；远程地址（插件路径没来得及存本地）也直接播
  if (rec && rec.path) {
    if (rec.path.indexOf('http') === 0) return play(rec.path)
    if (fileExists(rec.path)) {
      return play(rec.path).catch(function () {
        delete idx[key]
        writeIndex(idx)
        return speak(content, opts)
      })
    }
  }

  // 2. 没有就合成
  if (provider === 'none') {
    return Promise.reject(new Error('无可用语音通道'))
  }

  return synth(content, key, speed).then(function (src) {
    if (src === localPathFor(key)) {
      idx[key] = { path: src, at: Date.now() }
      writeIndex(idx)
    }
    return play(src)
  })
}

/** 长文本：按标点切成 <=40 字的小段，串行播放 */
function splitText(text, limit) {
  const max = limit || 40
  const raw = String(text || '').replace(/\s+/g, '')
  if (raw.length <= max) return [raw]

  const out = []
  let buf = ''
  for (let i = 0; i < raw.length; i++) {
    buf += raw[i]
    const isBreak = '。！？；，、'.indexOf(raw[i]) >= 0
    if (buf.length >= max || (isBreak && buf.length >= 12)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

function speakLong(text, opts) {
  const parts = splitText(text)
  let chain = Promise.resolve()
  parts.forEach(function (p) {
    chain = chain.then(function () { return speak(p, opts) })
  })
  return chain
}

function stop() {
  if (audioCtx) {
    try { audioCtx.stop() } catch (e) {}
  }
}

/**
 * 预热：进入阅读页时把整组卡先合成好，翻页不等待。
 * 串行 + 间隔，不并发打云函数。一张卡 6—12 句同时发出去，
 * 很容易撞上云函数并发限制或腾讯云 QPS，反而全失败。
 */
function prefetch(cards, opts) {
  if (provider === 'none' || !cards || !cards.length) return Promise.resolve()

  const speed = normalizeSpeed(opts && opts.speed)
  const todo = []
  cards.forEach(function (c) {
    if (!c || !c.text) return
    const key = keyOf(c.text, speed)
    const idx = readIndex()
    if (idx[key] && fileExists(idx[key].path)) return
    todo.push({ text: c.text, key: key })
  })

  if (!todo.length) return Promise.resolve()

  let chain = Promise.resolve()

  todo.forEach(function (item) {
    chain = chain
      .then(function () {
        return synth(item.text, item.key, speed)
          .then(function (src) {
            if (src !== localPathFor(item.key)) return
            const i2 = readIndex()
            i2[item.key] = { path: src, at: Date.now() }
            writeIndex(i2)
          })
          .catch(function () {
            // 预热失败不影响阅读，用户翻到那张卡时会重试
          })
      })
      .then(function () {
        return new Promise(function (r) { setTimeout(r, 120) })
      })
  })

  return chain
}

/* ---------------- 语速偏好 ----------------
 * 只降不升，不做自动回落。目标用户不会去设置里调回来，
 * 而"慢一点"永远比"听不清"好。复位入口放在首页自检里，只给演示者用。
 */

const SPEED_KEY = 'tts_speed'

function getSpeed() {
  try {
    return normalizeSpeed(wx.getStorageSync(SPEED_KEY))
  } catch (e) {
    return 0
  }
}

function setSpeed(v) {
  const s = normalizeSpeed(v)
  try {
    wx.setStorageSync(SPEED_KEY, s)
  } catch (e) {}
  return s
}

function clearCache() {
  const idx = readIndex()
  Object.keys(idx).forEach(function (k) {
    const p = idx[k].path
    if (p) {
      try { wx.getFileSystemManager().unlinkSync(p) } catch (e) {}
    }
  })
  writeIndex({})
}

/**
 * 播放但最多等 ms 毫秒。开发者工具的音频有时不触发 ended，
 * 自检不能因为这个就一直挂着。
 */
function playWithTimeout(src, ms) {
  return new Promise(function (resolve, reject) {
    let done = false
    const timer = setTimeout(function () {
      if (done) return
      done = true
      resolve('timeout')
    }, ms || 7000)

    play(src)
      .then(function () {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve('ended')
      })
      .catch(function (e) {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(e)
      })
  })
}

/**
 * 语音自检：把「环境 → 合成 → 落盘 → 播放」整条链走一遍，每步都留结果。
 * 真机上不方便看控制台时，用这个弹窗就能定位到哪一环断了。
 */
function diagnose() {
  const steps = []
  const out = {
    provider: provider,
    cloudAvailable: !!wx.cloud,
    cloudReady: false,
    cloudError: '',
    steps: steps,
    ok: false,
    audioBytes: 0,
    played: false
  }

  try {
    const app = getApp()
    if (app && app.globalData) {
      out.cloudReady = !!app.globalData.cloudReady
      out.cloudError = app.globalData.cloudError || ''
    }
  } catch (e) {}

  steps.push({
    name: '运行环境',
    ok: out.cloudAvailable,
    detail: 'provider=' + provider +
      (out.cloudReady ? '，云开发已就绪' : '，云开发未就绪' + (out.cloudError ? '（' + out.cloudError + '）' : ''))
  })

  if (provider === 'none') {
    steps.push({ name: '合成通道', ok: false, detail: '没有可用通道' })
    out.error = '没有可用语音通道'
    return Promise.resolve(out)
  }

  const text = '语音检查正常，可以念给你听'
  const key = 'diag_' + Date.now()

  return synth(text, key, 0)
    .then(function (src) {
      steps.push({ name: '合成', ok: true, detail: 'provider=' + provider })

      // 音色类型直接决定计费口径：精品音色不吃免费资源包
      if (lastMeta && lastMeta.voice) {
        const premium = lastMeta.voiceKind === 'premium' || Number(lastMeta.voice) >= 101000
        steps.push({
          name: '音色',
          ok: !premium,
          detail: lastMeta.voice + (premium
            ? '（精品音色，只能后付费，不吃免费资源包）'
            : '（标准音色，可抵免费资源包）')
        })
      }

      let size = 0
      try {
        const st = wx.getFileSystemManager().statSync(src)
        size = (st && st.size) || 0
      } catch (e) {}

      out.audioBytes = size
      steps.push({
        name: '落盘',
        // 正常一段 8—20 KB，低于 800 B 视为不完整
        ok: size >= 800,
        detail: size
          ? (size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' B，偏小')
          : '文件不存在或取不到大小'
      })

      if (src === localPathFor(key)) {
        const idx = readIndex()
        idx[keyOf(text, 0)] = { path: src, at: Date.now() }
        writeIndex(idx)
      }

      return playWithTimeout(src, 7000)
    })
    .then(function (how) {
      out.played = how === 'ended'
      steps.push({
        name: '播放',
        ok: how === 'ended',
        detail: how === 'ended' ? '正常播完' : '已开始但没等到结束（工具常不模拟扬声器）'
      })
      out.ok = true
      return out
    })
    .catch(function (err) {
      const hint = (lastError && lastError.hint) || ''
      const msg = msgOf(err)
      // 弹窗只放第一句，长解释留给控制台和下面的"怎么办"
      steps.push({ name: '中断', ok: false, detail: msg.split('。')[0] })
      if (hint) {
        steps.push({ name: '怎么办', ok: false, tone: 'note', detail: hint })
      }
      out.error = msg
      out.hint = hint
      return out
    })
}

module.exports = {
  provider: function () { return provider },
  speak: speak,
  speakLong: speakLong,
  splitText: splitText,
  prefetch: prefetch,
  stop: stop,
  clearCache: clearCache,
  getSpeed: getSpeed,
  setSpeed: setSpeed,
  hash: hash,
  diagnose: diagnose,
  lastError: function () { return lastError },
  lastMeta: function () { return lastMeta }
}
