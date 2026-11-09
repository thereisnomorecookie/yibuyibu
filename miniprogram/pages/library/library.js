const library = require('../../utils/library')
const store = require('../../utils/store')
const tts = require('../../utils/tts')

Page({
  data: {
    groups: [],
    sheet: { show: false, id: '', title: '', hint: '', count: 0 }
  },

  onLoad(options) {
    // 从拍照页进来时，"拍我家的"应该是返回，而不是再开一个拍照页
    this.from = (options && options.from) || ''

    const groups = library.groups()
    this.setData({ groups: groups })
  },

  onHide() {
    tts.stop()
  },

  onUnload() {
    tts.stop()
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id
    const item = library.get(id)
    if (!item) return

    tts.stop()
    this.setData({
      sheet: {
        show: true,
        id: id,
        title: item.title,
        hint: item.shootHint || '把整页都拍进框里，别只拍一个角。',
        count: (item.cards || []).length
      }
    })
  },

  closeSheet() {
    this.setData({ 'sheet.show': false })
  },

  goCapture() {
    tts.stop()
    this.setData({ 'sheet.show': false })

    if (this.from === 'capture') {
      wx.navigateBack({
        fail: function () {
          wx.redirectTo({ url: '/pages/capture/capture?mode=camera' })
        }
      })
      return
    }
    wx.redirectTo({ url: '/pages/capture/capture?mode=camera' })
  },

  /**
   * 看示例：直接进阅读页，reader 一行不改。
   * 标题带上「（示例）」，存进卡包后也能和自拍卡区分开。
   */
  viewExample() {
    const item = library.get(this.data.sheet.id)
    if (!item) return

    tts.stop()
    this.setData({ 'sheet.show': false })

    store.setCurrent({
      id: store.genId(),
      title: item.title + '（示例）',
      docType: item.docType,
      blockedReason: item.blockedReason || null,
      cards: item.cards || [],
      readText: item.readText || '',
      isSample: true,
      isExample: true,
      createdAt: Date.now()
    })
    wx.navigateTo({ url: '/pages/reader/reader' })
  }
})
