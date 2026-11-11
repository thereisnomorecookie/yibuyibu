/**
 * pages/reply 单元测试
 *
 * 运行：cd app/tests && npm test
 * 覆盖率：cd app/tests && npm run test:coverage
 */

const path = require('node:path')
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const {
  loadPage,
  installWx,
  restoreWx,
  replyOk,
  replyFail
} = require('../helpers/miniprogram')

const PAGE_PATH = path.resolve(__dirname, '../../miniprogram/pages/reply/reply.js')

const HELP = {
  _id: 'help_001',
  cardTitle: '电饭煲使用说明',
  stepNo: 3,
  stepTotal: 6,
  stepText: '按下开始键，等灯亮',
  stepAnchor: '第 3 步',
  status: 'waiting',
  createdAt: 1700000000000
}

/** 加载全新页面实例（每个用例互不干扰） */
function freshPage() {
  return loadPage(PAGE_PATH)
}

/** onLoad 内部自己启动 load()，不会返回 Promise，这里等一轮宏任务 */
function flush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0)
  })
}

/**
 * 让页面已加载好求助数据的便捷方法
 * @param {Function} [onCallFunction] 第 2 次及以后的云函数调用如何处理
 */
async function pageWithHelp(onCallFunction) {
  const wxState = installWx({
    onCallFunction: function (options, nth) {
      if (nth === 1) {
        options.success({ result: { ok: true, help: HELP, replies: [] } })
        return
      }
      if (typeof onCallFunction === 'function') onCallFunction(options, nth)
    }
  })
  const page = freshPage()
  page.token = 'tok_abc'
  await page.load()
  return { page: page, wxState: wxState }
}

beforeEach(() => {
  restoreWx()
})

afterEach(() => {
  restoreWx()
})

describe('页面注册与初始状态', () => {
  it('注册了页面并带上预期的初始 data', () => {
    const page = freshPage()
    assert.deepEqual(page.data, {
      loading: true,
      error: '',
      help: null,
      text: '',
      sending: false,
      sent: false
    })
  })

  it('暴露了全部生命周期与交互方法', () => {
    const page = freshPage()
    const methods = [
      'onLoad',
      'callFn',
      'load',
      'onInput',
      'send',
      'again',
      'onShareAppMessage'
    ]
    methods.forEach(function (name) {
      assert.equal(typeof page[name], 'function', name + ' 应为函数')
    })
  })
})

describe('onLoad', () => {
  it('链接里没有 token 时直接提示，不请求云端', async () => {
    const wxState = installWx()
    const page = freshPage()

    await page.onLoad({})

    assert.equal(page.data.loading, false)
    assert.equal(page.data.error, '这个链接不完整')
    assert.equal(wxState.calls.length, 0)
  })

  it('options 为 undefined 时同样按缺少链接处理', async () => {
    const wxState = installWx()
    const page = freshPage()

    await page.onLoad(undefined)

    assert.equal(page.data.error, '这个链接不完整')
    assert.equal(page.data.loading, false)
    assert.equal(wxState.calls.length, 0)
  })

  it('带 token 时缓存 token 并加载求助内容', async () => {
    const wxState = installWx({ onCallFunction: replyOk({ ok: true, help: HELP }) })
    const page = freshPage()

    page.onLoad({ token: 'tok_abc' })
    await flush()

    assert.equal(page.token, 'tok_abc')
    assert.equal(wxState.calls.length, 1)
    assert.equal(wxState.calls[0].name, 'getHelp')
    assert.deepEqual(wxState.calls[0].data, { token: 'tok_abc' })
    assert.equal(page.data.loading, false)
    assert.deepEqual(page.data.help, HELP)
    assert.equal(page.data.error, '')
  })

  it('只有空白的 token 也按原样请求（不做裁剪）', async () => {
    const wxState = installWx({ onCallFunction: replyOk({ ok: true, help: HELP }) })
    const page = freshPage()

    page.onLoad({ token: '   ' })
    await flush()

    assert.equal(page.token, '   ')
    assert.deepEqual(wxState.calls[0].data, { token: '   ' })
  })
})

describe('callFn', () => {
  it('成功时返回 res.result', async () => {
    installWx({ onCallFunction: replyOk({ ok: true, value: 42 }) })
    const page = freshPage()

    const res = await page.callFn('getHelp', { token: 't' })

    assert.deepEqual(res, { ok: true, value: 42 })
  })

  it('成功但没有 result 时返回空对象', async () => {
    installWx({ onCallFunction: (options) => options.success({}) })
    const page = freshPage()

    const res = await page.callFn('getHelp', {})

    assert.deepEqual(res, {})
  })

  it('result 为 null 时也返回空对象', async () => {
    installWx({ onCallFunction: replyOk(null) })
    const page = freshPage()

    const res = await page.callFn('getHelp', {})

    assert.deepEqual(res, {})
  })

  it('fail 时抛出带 errMsg 的错误', async () => {
    installWx({ onCallFunction: replyFail({ errMsg: 'cloud:fail -1' }) })
    const page = freshPage()

    await assert.rejects(page.callFn('getHelp', {}), /cloud:fail -1/)
  })

  it('fail 且没有 errMsg 时使用兜底文案', async () => {
    installWx({ onCallFunction: replyFail(null) })
    const page = freshPage()

    await assert.rejects(page.callFn('getHelp', {}), /调用失败/)
  })
})

describe('load', () => {
  it('服务端返回 ok:false 时展示服务端错误', async () => {
    installWx({ onCallFunction: replyOk({ ok: false, error: '没找到，可能已经过期了' }) })
    const page = freshPage()
    page.token = 'tok_abc'

    await page.load()

    assert.equal(page.data.loading, false)
    assert.equal(page.data.error, '没找到，可能已经过期了')
    assert.equal(page.data.help, null)
  })

  it('服务端返回 ok:false 且无错误文案时使用兜底文案', async () => {
    installWx({ onCallFunction: replyOk({ ok: false }) })
    const page = freshPage()
    page.token = 'tok_abc'

    await page.load()

    assert.equal(page.data.error, '打不开这个求助')
  })

  it('云函数异常时展示异常信息', async () => {
    installWx({ onCallFunction: replyFail({ errMsg: 'cloud:fail timeout' }) })
    const page = freshPage()
    page.token = 'tok_abc'

    await page.load()

    assert.equal(page.data.loading, false)
    assert.equal(page.data.error, 'cloud:fail timeout')
    assert.equal(page.data.help, null)
  })

  it('异常没有 message 时展示网络兜底文案', async () => {
    const page = freshPage()
    page.token = 'tok_abc'
    page.callFn = function () {
      return Promise.reject({})
    }

    await page.load()

    assert.equal(page.data.error, '网络不太好')
  })

  it('请求参数带上当前 token', async () => {
    const wxState = installWx({ onCallFunction: replyOk({ ok: true, help: HELP }) })
    const page = freshPage()
    page.token = 'tok_xyz'

    await page.load()

    assert.equal(wxState.calls[0].name, 'getHelp')
    assert.deepEqual(wxState.calls[0].data, { token: 'tok_xyz' })
  })
})

describe('onInput', () => {
  it('把输入框内容写入 data.text', () => {
    const page = freshPage()

    page.onInput({ detail: { value: '那个圆盖往左拧' } })

    assert.equal(page.data.text, '那个圆盖往左拧')
  })

  it('清空输入时同步为空白字符串', () => {
    const page = freshPage()
    page.data.text = '上一句'

    page.onInput({ detail: { value: '' } })

    assert.equal(page.data.text, '')
  })
})

describe('send', () => {
  it('文本为空时不发送', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = ''

    await page.send()

    assert.equal(wxState.calls.length, 1, '只应有加载求助的那一次调用')
    assert.equal(page.data.sending, false)
    assert.equal(page.data.sent, false)
  })

  it('文本只有空白时不发送', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '   \n\t '

    await page.send()

    assert.equal(wxState.calls.length, 1)
    assert.equal(page.data.sent, false)
  })

  it('正在发送时重复点击不会再次调用', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '往左拧'
    page.data.sending = true

    await page.send()

    assert.equal(wxState.calls.length, 1)
    assert.equal(page.data.sending, true)
  })

  it('发送成功后清空输入并切到成功态', async () => {
    const { page, wxState } = await pageWithHelp(function (options) {
      options.success({ result: { ok: true } })
    })
    page.data.text = '  那个圆盖往左拧  '

    await page.send()

    assert.equal(wxState.calls[1].name, 'replyHelp')
    assert.deepEqual(wxState.calls[1].data, {
      helpId: 'help_001',
      text: '那个圆盖往左拧'
    })
    assert.equal(page.data.sending, false)
    assert.equal(page.data.sent, true)
    assert.equal(page.data.text, '')
    assert.equal(wxState.modals.length, 0)
  })

  it('发送过程中先置 sending 为 true', async () => {
    let sendingWhenCalled = null
    const { page } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      sendingWhenCalled = page.data.sending
      return Promise.resolve({ ok: true })
    }

    await page.send()

    assert.equal(sendingWhenCalled, true)
  })

  it('业务失败时弹窗提示服务端错误并复位 sending', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      return Promise.resolve({ ok: false, error: '说得太长了，短一点' })
    }

    await page.send()

    assert.equal(page.data.sending, false)
    assert.equal(page.data.sent, false)
    assert.equal(wxState.modals.length, 1)
    assert.equal(wxState.modals[0].content, '说得太长了，短一点')
    assert.equal(wxState.modals[0].showCancel, false)
    assert.equal(wxState.modals[0].confirmText, '好')
  })

  it('业务失败且无错误文案时使用默认文案', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      return Promise.resolve({ ok: false })
    }

    await page.send()

    assert.equal(wxState.modals[0].content, '没发出去')
  })

  it('网络失败时弹窗展示 errMsg', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      return Promise.reject(new Error('cloud:fail network'))
    }

    await page.send()

    assert.equal(wxState.modals[0].content, 'cloud:fail network')
    assert.equal(page.data.sending, false)
  })

  it('异常不带 message 时弹窗使用兜底文案', async () => {
    const { page, wxState } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      return Promise.reject({})
    }

    await page.send()

    assert.equal(wxState.modals[0].content, '没发出去，再试一次')
  })

  it('失败后可以再发一次并成功', async () => {
    const { page } = await pageWithHelp()
    page.data.text = '往左拧'
    page.callFn = function () {
      return Promise.reject(new Error('第一次失败'))
    }
    await page.send()
    assert.equal(page.data.sending, false)

    page.callFn = function () {
      return Promise.resolve({ ok: true })
    }
    await page.send()

    assert.equal(page.data.sent, true)
    assert.equal(page.data.text, '')
  })
})

describe('again', () => {
  it('回到可继续补充内容的状态', () => {
    const page = freshPage()
    page.data.sent = true
    page.data.text = '上一句'

    page.again()

    assert.equal(page.data.sent, false)
    assert.equal(page.data.text, '')
  })
})

describe('onShareAppMessage', () => {
  it('返回分享标题与首页路径', () => {
    const page = freshPage()

    const share = page.onShareAppMessage()

    assert.equal(share.title, '我爸妈用它看懂说明书，拍一张纸就能听')
    assert.equal(share.path, '/pages/home/home')
  })
})
