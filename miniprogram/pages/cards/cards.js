const store = require('../../utils/store')
const tts = require('../../utils/tts')

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

Page({
  data: {
    list: [],
    empty: true,
    shareSheet: { show: false, title: '', count: 0, token: '' }
  },

  onShow() {
    this.refresh()
  },

  onHide() {
    tts.stop()
  },

  onUnload() {
    tts.stop()
  },

  refresh() {
    const raw = store.list()
    const list = raw.map(function (c) {
      const total = (c.cards || []).length
      const prog = typeof c.progress === 'number' ? c.progress : 0
      const date = fmtDate(c.createdAt)

      let subText = '共 ' + total + ' 步 · ' + date
      if (prog > 0 && prog < total) {
        subText = '做到第 ' + (prog + 1) + ' 步 / 共 ' + total + ' 步 · ' + date
      }

      return {
        id: c.id,
        title: c.title || '这张纸',
        count: total,
        subText: subText
      }
    })
    this.setData({ list: list, empty: list.length === 0 })
  },

  openCard(e) {
    const id = e.currentTarget.dataset.id
    const card = store.get(id)
    if (!card) return
    tts.stop()
    store.setCurrent(card)
    wx.navigateTo({ url: '/pages/reader/reader' })
  },

  /* ---------------- 长按菜单 ---------------- */

  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    const card = store.get(id)
    if (!card) return

    // 拦截态没有可分享的步骤，菜单里就不放这一项
    const canShare = card.docType !== 'blocked' && (card.cards || []).length > 0
    const items = canShare ? ['改名字', '分享给微信', '删掉'] : ['改名字', '删掉']
    const that = this

    wx.showActionSheet({
      itemList: items,
      success: function (res) {
        const label = items[res.tapIndex]
        if (label === '改名字') that.rename(id)
        else if (label === '分享给微信') that.share(id)
        else that.remove(id)
      },
      fail: function () {}
    })
  },

  /* ---------------- 分享 ---------------- */

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

  async share(id) {
    const card = store.get(id)
    if (!card) return

    if (!getApp().globalData.cloudReady) {
      wx.showModal({
        title: '',
        content: '现在没连上，等一下再分享',
        showCancel: false,
        confirmText: '好'
      })
      return
    }

    wx.showLoading({ title: '正在准备…', mask: true })

    try {
      const res = await this.callFn('shareCard', {
        action: 'create',
        title: card.title || '这张纸',
        cards: card.cards || []
      })
      wx.hideLoading()

      if (!res.ok || !res.token) {
        throw new Error(res.error || '没准备好')
      }

      this.setData({
        shareSheet: {
          show: true,
          title: card.title || '这张纸',
          count: (card.cards || []).length,
          token: res.token
        }
      })
    } catch (err) {
      wx.hideLoading()
      wx.showModal({
        title: '',
        content: (err && err.message) || '没准备好，等一下再试',
        showCancel: false,
        confirmText: '好'
      })
    }
  },

  closeShare() {
    this.setData({ shareSheet: { show: false, title: '', count: 0, token: '' } })
  },

  onShareAppMessage() {
    const s = this.data.shareSheet || {}
    if (s.show && s.token) {
      const that = this
      setTimeout(function () { that.closeShare() }, 600)
      return {
        title: s.title + ' · ' + s.count + ' 步语音卡，点开就能听',
        path: '/pages/home/home?shared=' + s.token
      }
    }
    return {
      title: '一步一步 · 拍一张纸，念给你听',
      path: '/pages/home/home'
    }
  },

  /* ---------------- 改名 / 删除 ---------------- */

  rename(id) {
    const card = store.get(id)
    if (!card) return
    const that = this
    wx.showModal({
      title: '给它起个名字',
      editable: true,
      placeholderText: '比如：洗衣机',
      content: card.title || '',
      success: function (res) {
        if (!res.confirm) return
        const name = String(res.content || '').trim().slice(0, 8)
        if (!name) return
        store.rename(id, name)
        that.refresh()
      }
    })
  },

  remove(id) {
    const that = this
    wx.showModal({
      title: '',
      content: '这张卡删了就没了，确定吗',
      confirmText: '删掉',
      cancelText: '留着',
      success: function (res) {
        if (!res.confirm) return
        store.remove(id)
        that.refresh()
      }
    })
  },

  goHome() {
    wx.redirectTo({ url: '/pages/home/home' })
  },

  goLibrary() {
    tts.stop()
    wx.navigateTo({ url: '/pages/library/library' })
  }
})
