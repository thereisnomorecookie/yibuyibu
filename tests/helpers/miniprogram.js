/**
 * 小程序页面测试基座
 *
 * 小程序页面文件在加载时会直接调用全局 Page({...})，并依赖全局 wx，
 * 因此这里负责：捕获 Page 的配置对象、构造可调用的页面实例、注入 wx 模拟。
 */

/**
 * 加载页面文件并返回一个"页面实例"
 * @param {string} pagePath 页面 js 的绝对路径
 */
function loadPage(pagePath) {
  const resolved = require.resolve(pagePath)
  let captured = null

  const previousPage = global.Page
  global.Page = function (options) {
    captured = options
  }

  try {
    delete require.cache[resolved]
    require(resolved)
  } finally {
    if (previousPage === undefined) {
      delete global.Page
    } else {
      global.Page = previousPage
    }
  }

  if (!captured) {
    throw new Error('页面没有调用 Page()：' + pagePath)
  }

  return createInstance(captured)
}

/**
 * 用 Page 配置对象造实例：方法挂在原型上，data 深拷贝，并注入 setData
 */
function createInstance(options) {
  const instance = Object.create(options)
  instance.data = JSON.parse(JSON.stringify(options.data || {}))
  instance.setDataCalls = []
  instance.setData = function (patch) {
    instance.setDataCalls.push(patch)
    Object.keys(patch || {}).forEach(function (key) {
      instance.data[key] = patch[key]
    })
  }
  return instance
}

/**
 * 安装全局 wx 模拟
 * @param {object} handlers
 * @param {Function} [handlers.onCallFunction] 收到 wx.cloud.callFunction 时回调 (options, nth)
 * @param {Function} [handlers.onShowModal] 收到 wx.showModal 时回调 (options)
 */
function installWx(handlers) {
  const conf = handlers || {}
  const calls = []
  const modals = []

  global.wx = {
    cloud: {
      callFunction: function (options) {
        calls.push({ name: options.name, data: options.data })
        if (typeof conf.onCallFunction === 'function') {
          conf.onCallFunction(options, calls.length)
        }
      }
    },
    showModal: function (options) {
      modals.push(options)
      if (typeof conf.onShowModal === 'function') {
        conf.onShowModal(options)
      }
    }
  }

  return { calls: calls, modals: modals }
}

function restoreWx() {
  delete global.wx
}

/** 云函数成功返回（带 result） */
function replyOk(result) {
  return function (options) {
    options.success({ result: result })
  }
}

/** 云函数调用失败（fail 回调） */
function replyFail(err) {
  return function (options) {
    options.fail(err)
  }
}

module.exports = {
  loadPage: loadPage,
  installWx: installWx,
  restoreWx: restoreWx,
  replyOk: replyOk,
  replyFail: replyFail
}
