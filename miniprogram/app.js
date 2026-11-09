const config = require('./config')

App({
  globalData: {
    cloudReady: false,
    cloudError: '',
    // 语音能力探测结果：'plugin' | 'cloud' | 'none'
    ttsProvider: '',
    pendingText: '',
    pendingKey: '',
    // 最近一次识别失败的技术原因，供自检弹窗查看
    lastCaptureError: null
  },

  onLaunch() {
    if (!wx.cloud) {
      this.globalData.cloudError = '当前基础库不支持云开发'
      return
    }
    try {
      // env 统一在 config.js 里配。
      // 留空 = 使用账号下的默认云环境；多环境时填环境 ID。
      wx.cloud.init(
        config.CLOUD_ENV
          ? { env: config.CLOUD_ENV, traceUser: true }
          : { traceUser: true }
      )
      this.globalData.cloudReady = true
    } catch (e) {
      this.globalData.cloudError = (e && e.message) || '云开发初始化失败'
    }
  }
})
