const store = require('../../utils/store')
const tts = require('../../utils/tts')

const STAGES = {
  uploading: { idx: 1, title: '正在看这张纸…', voice: '正在看这张纸，等一下' },
  recognizing: { idx: 2, title: '正在认字…', voice: '快好了' },
  building: { idx: 3, title: '正在拆成几步…', voice: '马上就好' }
}

/**
 * 把技术错误翻成老人能看懂的一句话。
 * 原始错误已经在 console 里完整打印，屏幕上不必出现 openapi / quota / errCode。
 */
function friendlyOf(err) {
  const raw = (err && err.message) || ''

  if (/quota/i.test(raw)) return '这边还没准备好，先用「试试看」看看效果'
  if (/读到 0 个字|0 个文本块/.test(raw)) return '这张纸没看清，靠近一点、找个亮点的地方再拍'
  if (/timeout|超时|ETIMEDOUT/i.test(raw)) return '网络有点慢，等一下再试一次'
  if (/fileID|图片地址/i.test(raw)) return '照片没传上去，看看网络再试'
  if (/OCR|openapi|errCode|SDK|module|Cannot find/i.test(raw)) return '这边出了点问题，先用「试试看」'
  return raw || '换个地方再拍一张试试'
}

Page({
  data: {
    stage: 'idle',
    stageIdx: 0,
    processTitle: '',
    processSub: '',
    processNote: '',
    failTitle: '这张纸没看清',
    failHint: '能靠近一点，或者换个亮一点的地方再拍吗',
    stairs: [1, 2, 3, 4, 5, 6]
  },

  onLoad(options) {
    const mode = options && options.mode
    if (mode === 'album') {
      const that = this
      setTimeout(function () { that.chooseAlbum() }, 300)
    }
  },

  onUnload() {
    tts.stop()
    if (this.guardTimer) clearTimeout(this.guardTimer)
  },

  takePhoto() {
    const that = this
    const ctx = wx.createCameraContext()
    ctx.takePhoto({
      quality: 'high',
      success: function (res) {
        that.handleImage(res.tempImagePath)
      },
      fail: function () {
        that.showFail('相机没打开', '点下面「从相册选」也可以，或者去手机设置里给个相机权限')
      }
    })
  },

  chooseAlbum() {
    const that = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: function (res) {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) that.handleImage(f.tempFilePath)
      },
      fail: function () {}
    })
  },

  onCamError() {
    this.showFail('相机没打开', '点下面「从相册选」试试')
  },

  retry() {
    tts.stop()
    this.setData({ stage: 'idle', stageIdx: 0, processTitle: '' })
  },

  async handleImage(filePath) {
    const app = getApp()

    if (!app.globalData.cloudReady) {
      this.showFail('这边还没连上', '先用样例看看效果，等会再试一次')
      return
    }

    this.setStage('uploading')

    // 总超时保护：25 秒仍无结果则提示失败，避免界面长时间无响应
    const that = this
    if (this.guardTimer) clearTimeout(this.guardTimer)
    this.guardTimer = setTimeout(function () {
      if (that.data.stage === 'busy') {
        that.showFail('这张纸有点难', '换一张试试，或者先用样例看看')
      }
    }, 25000)

    try {
      const compressed = await this.compress(filePath)
      const fileID = await this.upload(compressed)

      this.setStage('recognizing')
      const ocr = await this.callFn('ocrCard', { fileID: fileID })
      if (!ocr.ok || !ocr.text) {
        const e = new Error(ocr.errMsg || '没认出字')
        e.step = 'ocr'
        e.code = ocr.errCode
        e.via = ocr.via
        throw e
      }

      // 把"认了多少"摆到屏幕上。这不是加载动画，是 AI 的判断结果
      this.setData({
        stage: 'busy',
        stageIdx: 3,
        processTitle: '认出 ' + (ocr.blocks || 0) + ' 行字',
        processSub: '正在拆成几步…',
        processNote: ''
      })

      const built = await this.callFn('buildCards', { text: ocr.text })
      if (!built.ok) {
        throw new Error(built.errMsg || '没拆出步骤')
      }

      if (this.guardTimer) clearTimeout(this.guardTimer)

      // 自检报告留证：答辩时在首页长按标题可查看。
      // 只在真拆出步骤时记录；拦截与兜底没有"通过率"可言，记了反而误导。
      app.globalData.lastBuildChecks = built.checks
        ? Object.assign({ title: built.title || '这张纸', at: Date.now() }, built.checks)
        : null

      // 让结果在屏幕上停一下：拆成几步、几步拿不准，说清楚再走
      this.showResult(built)
      await this.wait(1300)

      this.goReader({
        id: store.genId(),
        title: built.title || '这张纸',
        docType: built.docType || 'operation',
        blockedReason: built.blockedReason || null,
        cards: built.cards || [],
        sourceText: ocr.text,
        createdAt: Date.now()
      })
    } catch (err) {
      if (this.guardTimer) clearTimeout(this.guardTimer)
      // 界面只说人话，具体原因留给首页自检弹窗查看
      app.globalData.lastCaptureError = {
        step: (err && err.step) || 'unknown',
        code: (err && err.code) || '',
        via: (err && err.via) || '',
        msg: (err && err.message) || '',
        at: Date.now()
      }
      this.showFail('这张纸没看清', friendlyOf(err))
    }
  },

  /**
   * 压缩到微信 OCR 支持的尺寸。
   * 硬限制：体积 < 2MB，长边 < 4096px。手机原图常见 4—8MB，
   * 只给 quality 不限制宽度的话，压完照样超，OCR 端看到的就是"认不出字"。
   */
  compress(src) {
    function compressOnce(input, quality, cb) {
      wx.compressImage({
        src: input,
        quality: quality,
        compressedWidth: 1600,
        success: function (r) { cb(r.tempFilePath) },
        fail: function () { cb(input) }
      })
    }

    function sizeOf(p, cb) {
      wx.getFileSystemManager().getFileInfo({
        filePath: p,
        success: function (r) { cb(r.size || 0) },
        fail: function () { cb(0) }
      })
    }

    const LIMIT = 1.8 * 1024 * 1024

    return new Promise(function (resolve) {
      compressOnce(src, 80, function (first) {
        sizeOf(first, function (size) {
          if (!size || size <= LIMIT) return resolve(first)
          // 还超标就再压一档；仍超标就退回上一版，交给云函数兜底
          compressOnce(first, 50, function (second) {
            sizeOf(second, function (s2) {
              if (s2 && s2 > 2 * 1024 * 1024) {
                return resolve(second)
              }
              resolve(second || first)
            })
          })
        })
      })
    })
  },

  upload(filePath) {
    return new Promise(function (resolve, reject) {
      const ext = (filePath.match(/\.\w+$/) || ['.jpg'])[0]
      wx.cloud.uploadFile({
        cloudPath: 'ocr/' + Date.now() + ext,
        filePath: filePath,
        success: function (r) {
          if (r.fileID) resolve(r.fileID)
          else reject(new Error('图片没传上去'))
        },
        fail: function () { reject(new Error('图片没传上去，看看网络')) }
      })
    })
  },

  callFn(name, data) {
    return new Promise(function (resolve, reject) {
      wx.cloud.callFunction({
        name: name,
        data: data,
        success: function (res) { resolve(res.result || {}) },
        fail: function (err) {
          reject(new Error((err && err.errMsg) || '云函数调用失败'))
        }
      })
    })
  },

  setStage(key) {
    const cfg = STAGES[key]
    if (!cfg) return
    this.setData({ stage: 'busy', stageIdx: cfg.idx, processTitle: cfg.title })
    tts.speak(cfg.voice).catch(function () {})
  },

  /**
   * 把 AI 的判断结果摆出来，而不是"正在处理…"。
   * 这是让 AI 可见的核心：认了多少行、拆成几步、几步拿不准，全是真实数字。
   */
  showResult(built) {
    const cards = built.cards || []
    const ck = built.checks || {}

    if (built.docType === 'blocked') {
      this.setData({
        stage: 'busy',
        stageIdx: 6,
        processTitle: '这页我不拆',
        processSub: '',
        processNote: '涉及用药、钱或者条款，得让医生或孩子看'
      })
      return
    }

    const total = cards.length || ck.total || 0
    const warned = ck.warned || 0
    const fixed = ck.fixed || 0

    let note = '都挺有把握'
    if (warned > 0) note = '其中 ' + warned + ' 步我拿不准，您慢点看'
    else if (fixed > 0) note = fixed + ' 步我顺手改成了人话'

    this.setData({
      stage: 'busy',
      stageIdx: 6,
      processTitle: '拆成 ' + total + ' 步',
      processSub: built.title || '',
      processNote: note
    })
  },

  wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms || 0)
    })
  },

  showFail(title, hint) {
    this.setData({
      stage: 'fail',
      failTitle: title || '这张纸没看清',
      failHint: hint || '换个地方再拍一张试试'
    })
  },

  goReader(card) {
    store.setCurrent(card)
    wx.redirectTo({ url: '/pages/reader/reader' })
  },

  /**
   * 「试试看」不再单选某一组，改为进示例库。
   * 两处各自维护一份样卡列表迟早会不一致（旧列表里还有已砍掉的手机操作类场景），
   * 统一到 library 一个数据源。用 navigateTo 让"拍我家的"能返回本页。
   */
  pickSample() {
    tts.stop()
    wx.navigateTo({ url: '/pages/library/library?from=capture' })
  }
})
