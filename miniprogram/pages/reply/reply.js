Page({
  data: {
    loading: true,
    error: '',
    help: null,
    text: '',
    sending: false,
    sent: false
  },

  onLoad(options) {
    const token = (options && options.token) || ''
    if (!token) {
      this.setData({ loading: false, error: '这个链接不完整' })
      return
    }
    this.token = token
    this.load()
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

  async load() {
    try {
      const res = await this.callFn('getHelp', { token: this.token })
      if (!res.ok) {
        this.setData({ loading: false, error: res.error || '打不开这个求助' })
        return
      }
      this.setData({ loading: false, help: res.help })
    } catch (err) {
      this.setData({
        loading: false,
        error: (err && err.message) || '网络不太好'
      })
    }
  },

  onInput(e) {
    this.setData({ text: e.detail.value })
  },

  async send() {
    const text = String(this.data.text || '').trim()
    if (!text || this.data.sending) return

    this.setData({ sending: true })

    try {
      const res = await this.callFn('replyHelp', {
        helpId: this.data.help._id,
        text: text
      })
      if (!res.ok) throw new Error(res.error || '没发出去')
      this.setData({ sending: false, sent: true, text: '' })
    } catch (err) {
      this.setData({ sending: false })
      wx.showModal({
        title: '',
        content: (err && err.message) || '没发出去，再试一次',
        showCancel: false,
        confirmText: '好'
      })
    }
  },

  again() {
    this.setData({ sent: false, text: '' })
  },

  onShareAppMessage() {
    return {
      title: '我爸妈用它看懂说明书，拍一张纸就能听',
      path: '/pages/home/home'
    }
  }
})
