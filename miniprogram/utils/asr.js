/**
 * 录音与语音识别
 *
 * 只做两件事：录音、把录音转成文字。
 * 转出来的文字交给 askCard —— 语音只是「问一句」的一种输入方式，
 * 不是它的前提。所以这个模块挂了，快捷问题照样能用。
 *
 * 为什么不用 WechatSI：它是插件，未认证小程序加不了，已实测。
 * 改走云函数 asr（腾讯云一句话识别），录音 base64 直传，不经云存储。
 */

const MIN_MS = 1000
const MAX_MS = 8000

let recorder = null
let pending = null
let startedAt = 0
let lastStop = null
let lastError = null
let notified = false

function msgOf(err) {
  if (!err) return '未知错误'
  const s = err.errMsg || err.msg || err.message || String(err)
  return String(s).split('\n')[0].trim()
}

function noteError(stage, err) {
  const msg = msgOf(err)
  lastError = { stage: stage, msg: msg, at: Date.now() }

  if (!notified) {
    notified = true
    try {
      wx.showToast({ title: '没听清，用上面的问题也行', icon: 'none', duration: 2200 })
    } catch (e) {}
  }
  return msg
}

/** 把录音文件转成文字 */
function recognize(filePath) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud) {
      return reject(new Error('没有云开发环境'))
    }

    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (r) {
        const b64 = r && r.data
        if (!b64) return reject(new Error('录音是空的'))

        wx.cloud.callFunction({
          name: 'asr',
          data: { audio: b64, format: 'mp3' },
          success: function (res) {
            const out = (res && res.result) || {}
            if (out.ok && out.text) return resolve(out.text)

            const e = new Error(out.error || '没听清')
            e.code = out.code || ''
            e.hint = out.hint || ''
            lastError = e
            reject(e)
          },
          fail: function (err) {
            const e = new Error(noteError('asr/invoke', err))
            reject(e)
          }
        })
      },
      fail: function () {
        reject(new Error('录音读不出来'))
      }
    })
  })
}

function handleStop(path) {
  if (!path) return Promise.reject(new Error('录音是空的'))
  const dur = Date.now() - startedAt
  if (dur < MIN_MS) return Promise.reject(new Error('too_short'))
  return recognize(path)
}

/** 只创建一次，回调也只注册一次 */
function ensure() {
  if (recorder) return recorder

  recorder = wx.getRecorderManager()

  recorder.onStop(function (res) {
    const p = pending
    pending = null
    const path = res && res.tempFilePath

    // 用户还按着、但到了 8 秒上限：先存着，等他松手再取
    if (!p) {
      lastStop = { path: path, at: Date.now() }
      return
    }

    handleStop(path).then(p.resolve).catch(p.reject)
  })

  recorder.onError(function (err) {
    const p = pending
    pending = null
    noteError('record', err)
    if (p) p.reject(new Error('录音失败'))
  })

  return recorder
}

function checkAuth() {
  return new Promise(function (resolve) {
    wx.getSetting({
      success: function (res) {
        const v = res && res.authSetting && res.authSetting['scope.record']
        if (v === true) resolve('granted')
        else if (v === false) resolve('denied')
        else resolve('unknown')
      },
      fail: function () {
        resolve('unknown')
      }
    })
  })
}

function openSetting() {
  wx.openSetting({})
}

function start() {
  const r = ensure()
  lastStop = null
  lastError = null
  startedAt = Date.now()

  r.start({
    duration: MAX_MS,
    sampleRate: 16000,
    numberOfChannels: 1,
    encodeBitRate: 48000,
    format: 'mp3'
  })
}

/** 松手：返回识别出的文字 */
function stop() {
  return new Promise(function (resolve, reject) {
    // 已经因 8 秒上限自动停过，直接用暂存的结果
    if (lastStop) {
      const path = lastStop.path
      lastStop = null
      return handleStop(path).then(resolve).catch(reject)
    }

    pending = { resolve: resolve, reject: reject }

    try {
      ensure().stop()
    } catch (e) {
      pending = null
      reject(new Error('录音没开始'))
    }
  })
}

/** 手指滑走等情况下取消，不识别 */
function cancel() {
  const p = pending
  pending = null
  lastStop = null
  if (p) p.reject(new Error('cancel'))

  try {
    ensure().stop()
  } catch (e) {}
}

module.exports = {
  start: start,
  stop: stop,
  cancel: cancel,
  checkAuth: checkAuth,
  openSetting: openSetting,
  minMs: MIN_MS,
  maxMs: MAX_MS,
  lastError: function () { return lastError }
}
