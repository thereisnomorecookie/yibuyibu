const store = require('../../utils/store')
const tts = require('../../utils/tts')

Page({
  data: {
    state: 'confirm',
    creating: false,
    step: {},
    stepNo: 1,
    stepTotal: 1,
    token: '',
    helpId: '',
    reply: '',
    waitHint: '他看到了就会回你'
  },

  onLoad(options) {
    const card = store.getCurrent()
    if (!card || !card.cards || !card.cards.length) {
      wx.navigateBack()
      return
    }
    const idx = Number((options && options.idx) || 0)
    const step = card.cards[idx] || card.cards[0]
    this.card = card

    this.setData({
      step: step,
      stepNo: idx + 1,
      stepTotal: card.cards.length
    })

    const that = this
    setTimeout(function () {
      tts.speak('要不要让孩子看看这一步').catch(function () {})
    }, 300)
  },

  onUnload() {
    this.stopPoll()
    tts.stop()
  },

  onHide() {
    this.stopPoll()
  },

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

  async confirmYes() {
    if (this.data.creating) return
    if (!getApp().globalData.cloudReady) {
      wx.showModal({
        title: '',
        content: '现在没连上，等一下再试',
        showCancel: false,
        confirmText: '好'
      })
      return
    }

    this.setData({ creating: true })

    try {
      const res = await this.callFn('createHelp', {
        cardTitle: this.card.title,
        stepNo: this.data.stepNo,
        stepTotal: this.data.stepTotal,
        stepText: this.data.step.text,
        stepAnchor: this.data.step.anchor
      })

      if (!res.ok) throw new Error(res.error || '没准备好')

      this.setData({
        creating: false,
        state: 'ready',
        token: res.token,
        helpId: res.helpId
      })
      tts.speak('点下面这个，发给孩子').catch(function () {})
    } catch (err) {
      this.setData({ creating: false })
      wx.showModal({
        title: '',
        content: (err && err.message) || '没准备好，等一下再试',
        showCancel: false,
        confirmText: '好'
      })
    }
  },

  confirmNo() {
    tts.stop()
    wx.navigateBack()
  },

  startWaiting() {
    this.setData({ state: 'waiting', waitHint: '他看到了就会回你' })
    tts.stop()
    tts.speak('已经发出去了，等一下').catch(function () {})
    this.startPoll()
  },

  onShareAppMessage() {
    const token = this.data.token || ''
    return {
      title: '我卡在第 ' + this.data.stepNo + ' 步，帮我看一眼',
      path: '/pages/reply/reply?token=' + token
    }
  },

  startPoll() {
    this.stopPoll()
    const that = this
    let times = 0

    this.pollTimer = setInterval(function () {
      times++
      if (times > 20) {
        that.stopPoll()
        that.setData({ waitHint: '他可能没看到，你先试试，回头他回你了再看' })
        return
      }
      if (!that.data.token) return

      that.callFn('getHelp', { token: that.data.token }).then(function (res) {
        if (res && res.ok && res.replies && res.replies.length) {
          const last = res.replies[res.replies.length - 1]
          that.stopPoll()
          that.setData({ state: 'replied', reply: last.text || '' })
          tts.stop()
          tts.speak(last.text || '').catch(function () {})
        }
      }).catch(function () {})
    }, 3000)
  },

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  },

  back() {
    this.stopPoll()
    tts.stop()
    wx.navigateBack()
  }
})
