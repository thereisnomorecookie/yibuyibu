const store = require('../../utils/store')
const tts = require('../../utils/tts')

Page({
  data: {
    count: 0,
    ttsHint: '看不清的东西，别硬猜，找人问',
    receiving: false,
    receiveError: '',
    receive: null
  },

  onLoad(options) {
    const shared = options && options.shared
    if (shared) this.loadShared(shared)
  },

  onShow() {
    this.setData({ count: store.count() })
  },

  onReady() {
    // 收到卡组时不播引导语，避免两句话打架
    if (this.data.receiving || this.data.receive || this.data.receiveError) return

    // 首次进入自动播报一次引导，之后不再打扰
    if (!store.isFirstVisit()) return
    store.markVisited()
    const that = this
    setTimeout(function () {
      tts.speak('点中间的大按钮，拍一张纸，帮你看看').catch(function () {
        that.setData({ ttsHint: '这台手机暂时不能朗读，看大字就行' })
      })
    }, 800)
  },

  onHide() {
    tts.stop()
  },

  onUnload() {
    tts.stop()
  },

  /* ---------------- 收到别人分享的卡组 ---------------- */

  callFn(name, data) {
    return new Promise(function (resolve, reject) {
      wx.cloud.callFunction({
        name: name,
        data: data,
        success: function (res) { resolve(res.result || {}) },
        fail: function (err) {
          reject(new Error((err && err.errMsg) || '调用失败'))
        }
      })
    })
  },

  async loadShared(token) {
    this.setData({ receiving: true, receiveError: '' })

    try {
      const res = await this.callFn('shareCard', { action: 'get', token: token })
      if (!res.ok) {
        this.setData({ receiving: false, receiveError: res.error || '打不开这组卡' })
        return
      }
      this.setData({
        receiving: false,
        receive: {
          title: res.title,
          count: res.count,
          cards: res.cards || []
        }
      })
      tts.speak('给你发来一组卡，' + res.title + '，存起来吗').catch(function () {})
    } catch (err) {
      this.setData({
        receiving: false,
        receiveError: (err && err.message) || '网络不太好'
      })
    }
  },

  saveReceived() {
    const r = this.data.receive
    if (!r) return

    store.save({
      id: store.genId(),
      title: r.title,
      docType: 'operation',
      cards: r.cards,
      createdAt: Date.now()
    })

    tts.stop()
    tts.speak('存好了').catch(function () {})
    this.setData({ receive: null })
    wx.redirectTo({ url: '/pages/cards/cards' })
  },

  dismissReceive() {
    tts.stop()
    this.setData({ receive: null, receiveError: '', receiving: false })
    // 用 reLaunch 清掉 shared 参数，回到干净的首页
    wx.reLaunch({ url: '/pages/home/home' })
  },

  /* ---------------- 常规入口 ---------------- */

  goCapture() {
    tts.stop()
    wx.navigateTo({ url: '/pages/capture/capture?mode=camera' })
  },

  chooseAlbum() {
    tts.stop()
    wx.navigateTo({ url: '/pages/capture/capture?mode=album' })
  },

  goCards() {
    tts.stop()
    wx.navigateTo({ url: '/pages/cards/cards' })
  },

  /**
   * 能力清单：说清 AI 在哪几处工作，也说清它不做什么。
   * 给评委和家属看的一道小门，老人的主路径不经过这里。
   */
  showAbilities() {
    tts.stop()
    wx.showModal({
      title: '它会这五件事',
      content: [
        '1. 看纸：拍一张，整页认成字',
        '2. 拆步：一段话拆成一屏一句',
        '3. 朗读：念给您听，能再念、能慢一点',
        '4. 答疑：只答这一页，答不了直说',
        '5. 叫人：卡住了，帮您叫孩子',
        '',
        '它不会聊天，也不懂纸外的事。'
      ].join('\n'),
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /**
   * 长按标题：语音自检。
   * 真机上没有控制台，这个入口能把「环境 / 合成 / 落盘 / 播放」四步结果直接摆出来。
   * 正式演示前可以删掉，或留着当兜底。
   */
  onLongPressHead() {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    wx.showLoading({ title: '检查语音…', mask: true })

    tts.diagnose().then(function (info) {
      wx.hideLoading()
      const lines = info.steps.map(function (s) {
        const mark = s.tone === 'note' ? '· ' : (s.ok ? '✓ ' : '✗ ')
        return mark + s.name + '：' + s.detail
      })

      // 最近一次识别失败的技术原因不在界面上显示，只在这里给出
      try {
        const cap = getApp().globalData.lastCaptureError
        if (cap) {
          lines.push('')
          lines.push('最近一次识别失败：' + cap.step +
            (cap.code ? '／' + cap.code : '') +
            (cap.via ? '／' + cap.via : ''))
          lines.push('· ' + String(cap.msg || '').split('\n')[0].slice(0, 60))
        }
      } catch (e) {}

      // 最近一次卡片自检：答辩时"怎么保证按规则输出"的现场证据
      try {
        const ck = getApp().globalData.lastBuildChecks
        if (ck) {
          const fixedBits = []
          if (ck.split) fixedBits.push('拆分 ' + ck.split)
          if (ck.truncated) fixedBits.push('截断 ' + ck.truncated)

          lines.push('')
          lines.push('最近一次拆卡：' + ck.title + ' · 共 ' + ck.total + ' 步')
          lines.push('✓ 一次通过 ' + ck.passed + ' 步')
          lines.push('· 自动修复 ' + ck.fixed + ' 步' +
            (fixedBits.length ? '（' + fixedBits.join('，') + '）' : ''))
          lines.push('· 待复核 ' + ck.warned + ' 步' + (ck.downgraded ? '，已降为只读' : ''))
        }
      } catch (e) {}

      // 语速只降不升，这里放唯一出口：只给演示者和验收用
      const speed = tts.getSpeed()
      const speedText = speed === 0 ? '正常' : (speed <= -1.5 ? '最慢' : '慢一档')
      lines.push('')
      lines.push('朗读语速：' + speedText +
        (speed === 0 ? '' : '（点下方可复位）'))

      wx.showModal({
        title: info.ok ? '语音正常' : '语音有问题',
        content: lines.join('\n'),
        showCancel: speed !== 0,
        cancelText: '复位语速',
        confirmText: '知道了',
        success: function (res) {
          if (!res.cancel) return
          tts.setSpeed(0)
          wx.showToast({ title: '语速已恢复正常', icon: 'none', duration: 2000 })
        }
      })
    }).catch(function (err) {
      wx.hideLoading()
      wx.showModal({
        title: '自检没跑完',
        content: (err && (err.message || err.errMsg)) || '未知错误',
        showCancel: false
      })
    })
  }
})
