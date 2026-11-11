/**
 * Unit tests for miniprogram/pages/reply/reply.js
 *
 * reply.js is a WeChat mini program page definition: it registers a config
 * object via the global `Page()` and relies on `wx` for cloud calls / modals.
 * The harness below captures that config and builds a fresh page instance per
 * test, with a `setData` implementation that merges into `this.data` exactly
 * like the runtime does.
 */

const path = require('path')

const PAGE_PATH = path.resolve(__dirname, '../miniprogram/pages/reply/reply.js')

/**
 * Build a `wx` mock whose `cloud.callFunction` replays a pre-seeded queue of
 * responses: `{ result }` resolves, `{ errMsg }` rejects.
 */
function createWxMock() {
  const state = { queue: [] }

  const wx = {
    cloud: {
      callFunction: jest.fn(function (options) {
        const next = state.queue.shift()
        if (!next) {
          throw new Error('unexpected callFunction: no seeded response')
        }
        if (Object.prototype.hasOwnProperty.call(next, 'errMsg')) {
          options.fail({ errMsg: next.errMsg })
        } else {
          options.success({ result: next.result })
        }
      })
    },
    showModal: jest.fn()
  }

  return { wx, state }
}

/** Ask the next `wx.cloud.callFunction` call to success with `result`. */
function seedSuccess(result) {
  global.__wxState.queue.push({ result })
}

/** Ask the next `wx.cloud.callFunction` call to fail with `errMsg`. */
function seedFailure(errMsg) {
  global.__wxState.queue.push({ errMsg })
}

/** Load reply.js fresh and return an isolated page instance. */
function createPage() {
  let captured = null
  global.Page = jest.fn(function (config) {
    captured = config
  })

  jest.resetModules()
  require(PAGE_PATH)

  expect(captured).toBeTruthy()

  const page = Object.assign({}, captured)
  // Deep clone so tests never mutate the module's shared default data.
  page.data = JSON.parse(JSON.stringify(captured.data))
  page.setData = jest.fn(function (patch) {
    Object.assign(this.data, patch)
  })

  // `this.callFn` is looked up on the instance, so spying is straightforward.
  // The untouched implementation stays available for the callFn suite.
  page.__realCallFn = captured.callFn
  page.callFn = jest.fn()

  return page
}

const HELP = {
  _id: 'help-1',
  cardTitle: '电饭煲说明书',
  stepNo: 3,
  stepTotal: 8,
  stepText: '按住盖子上的圆钮，往左拧',
  stepAnchor: '图二 · 第三步',
  status: 'pending',
  createdAt: 1700000000000
}

let page

beforeEach(() => {
  const { wx, state } = createWxMock()
  global.wx = wx
  global.__wxState = state
  page = createPage()
})

afterEach(() => {
  delete global.Page
  delete global.wx
  delete global.__wxState
})

describe('page registration', () => {
  test('registers exactly one page config with the expected initial state', () => {
    expect(global.Page).toHaveBeenCalledTimes(1)
    expect(page.data).toEqual({
      loading: true,
      error: '',
      help: null,
      text: '',
      sending: false,
      sent: false
    })
  })

  test('exposes all handlers used by reply.wxml', () => {
    expect(typeof page.onLoad).toBe('function')
    expect(typeof page.onInput).toBe('function')
    expect(typeof page.send).toBe('function')
    expect(typeof page.again).toBe('function')
    expect(typeof page.onShareAppMessage).toBe('function')
    expect(typeof page.callFn).toBe('function')
    expect(typeof page.load).toBe('function')
  })
})

describe('callFn', () => {
  // Re-bind the real implementation for these tests.
  beforeEach(() => {
    page.callFn = page.__realCallFn
  })

  test('forwards name and data to wx.cloud.callFunction', async () => {
    seedSuccess({ ok: true })

    await page.callFn('getHelp', { token: 'abc' })

    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'getHelp',
        data: { token: 'abc' }
      })
    )
  })

  test('resolves with res.result on success', async () => {
    seedSuccess({ ok: true, help: HELP })

    await expect(page.callFn('getHelp', { token: 'abc' })).resolves.toEqual({
      ok: true,
      help: HELP
    })
  })

  test('resolves with an empty object when result is undefined', async () => {
    seedSuccess(undefined)

    await expect(page.callFn('probe', {})).resolves.toEqual({})
  })

  test('resolves with an empty object when result is null', async () => {
    seedSuccess(null)

    await expect(page.callFn('probe', {})).resolves.toEqual({})
  })

  test('resolves with an empty object when result is a falsy primitive', async () => {
    seedSuccess(0)
    await expect(page.callFn('probe', {})).resolves.toEqual({})

    seedSuccess('')
    await expect(page.callFn('probe', {})).resolves.toEqual({})
  })

  test('rejects with an Error carrying errMsg when the call fails', async () => {
    seedFailure('cloud.callFunction:fail time out')

    await expect(page.callFn('getHelp', {})).rejects.toThrow('cloud.callFunction:fail time out')
  })

  test('rejects with the fallback message when errMsg is missing', async () => {
    seedFailure(undefined)

    await expect(page.callFn('getHelp', {})).rejects.toThrow('调用失败')
  })
})

describe('callFn with a malformed failure payload', () => {
  test('rejects with 调用失败 when fail receives nothing', async () => {
    wx.cloud.callFunction = jest.fn(function (options) {
      options.fail()
    })

    await expect(page.__realCallFn.call(page, 'getHelp', {})).rejects.toThrow('调用失败')
  })

  test('rejects with 调用失败 when fail receives null', async () => {
    wx.cloud.callFunction = jest.fn(function (options) {
      options.fail(null)
    })

    await expect(page.__realCallFn.call(page, 'getHelp', {})).rejects.toThrow('调用失败')
  })
})

describe('onLoad', () => {
  test('shows an error and skips loading when options is missing', () => {
    page.load = jest.fn()

    page.onLoad()

    expect(page.data.loading).toBe(false)
    expect(page.data.error).toBe('这个链接不完整')
    expect(page.load).not.toHaveBeenCalled()
    expect(page.token).toBeUndefined()
  })

  test('shows an error when options is null', () => {
    page.load = jest.fn()

    page.onLoad(null)

    expect(page.data.error).toBe('这个链接不完整')
    expect(page.load).not.toHaveBeenCalled()
  })

  test('shows an error when token is an empty string', () => {
    page.load = jest.fn()

    page.onLoad({ token: '' })

    expect(page.data.error).toBe('这个链接不完整')
    expect(page.data.loading).toBe(false)
    expect(page.load).not.toHaveBeenCalled()
  })

  test('shows an error when token is absent from options', () => {
    page.load = jest.fn()

    page.onLoad({ scene: 'x' })

    expect(page.data.error).toBe('这个链接不完整')
    expect(page.load).not.toHaveBeenCalled()
  })

  test('stores the token and starts loading when token is present', () => {
    page.load = jest.fn()
    seedSuccess({ ok: true, help: HELP })

    page.onLoad({ token: 'tok-123' })

    expect(page.token).toBe('tok-123')
    expect(page.data.error).toBe('')
    expect(page.load).toHaveBeenCalledTimes(1)
  })

  test('keeps the token verbatim (no trimming) and still loads', () => {
    page.load = jest.fn()

    page.onLoad({ token: '  tok  ' })

    expect(page.token).toBe('  tok  ')
    expect(page.load).toHaveBeenCalledTimes(1)
  })

  test('works end-to-end with a successful getHelp response', async () => {
    page.callFn = page.__realCallFn
    seedSuccess({ ok: true, help: HELP })

    page.onLoad({ token: 'tok-123' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(page.data.loading).toBe(false)
    expect(page.data.error).toBe('')
    expect(page.data.help).toEqual(HELP)
  })
})

describe('load', () => {
  test('calls getHelp with the stored token', async () => {
    page.token = 'tok-123'
    page.callFn.mockResolvedValue({ ok: true, help: HELP })

    await page.load()

    expect(page.callFn).toHaveBeenCalledWith('getHelp', { token: 'tok-123' })
  })

  test('stores the help payload and clears the loading flag on success', async () => {
    page.token = 'tok-123'
    page.callFn.mockResolvedValue({ ok: true, help: HELP })

    await page.load()

    expect(page.data).toEqual({
      loading: false,
      error: '',
      help: HELP,
      text: '',
      sending: false,
      sent: false
    })
  })

  test('accepts a help payload without stepAnchor', async () => {
    const minimal = { _id: 'help-2', stepNo: 1, stepTotal: 2, stepText: '先打开盖子' }
    page.token = 'tok'
    page.callFn.mockResolvedValue({ ok: true, help: minimal })

    await page.load()

    expect(page.data.help).toEqual(minimal)
    expect(page.data.help.stepAnchor).toBeUndefined()
    expect(page.data.loading).toBe(false)
  })

  test('keeps a null help payload without crashing', async () => {
    page.token = 'tok'
    page.callFn.mockResolvedValue({ ok: true, help: null })

    await page.load()

    expect(page.data.help).toBeNull()
    expect(page.data.loading).toBe(false)
  })

  test('uses the server error message when ok is false', async () => {
    page.token = 'tok'
    page.callFn.mockResolvedValue({ ok: false, error: '这个已经过期了，让孩子再发一次' })

    await page.load()

    expect(page.data.loading).toBe(false)
    expect(page.data.error).toBe('这个已经过期了，让孩子再发一次')
    expect(page.data.help).toBeNull()
  })

  test('falls back to 打不开这个求助 when ok is false without an error message', async () => {
    page.token = 'tok'
    page.callFn.mockResolvedValue({ ok: false })

    await page.load()

    expect(page.data.error).toBe('打不开这个求助')
  })

  test('falls back to 打不开这个求助 when the response is empty', async () => {
    page.token = 'tok'
    page.callFn.mockResolvedValue({})

    await page.load()

    expect(page.data.error).toBe('打不开这个求助')
    expect(page.data.loading).toBe(false)
  })

  test('uses the rejection message on network failure', async () => {
    page.token = 'tok'
    page.callFn.mockRejectedValue(new Error('cloud.callFunction:fail'))

    await page.load()

    expect(page.data.loading).toBe(false)
    expect(page.data.error).toBe('cloud.callFunction:fail')
  })

  test('falls back to 网络不太好 when the rejection carries no message', async () => {
    page.token = 'tok'
    page.callFn.mockRejectedValue({})

    await page.load()

    expect(page.data.error).toBe('网络不太好')
    expect(page.data.loading).toBe(false)
  })

  test('falls back to 网络不太好 when the rejection is null', async () => {
    page.token = 'tok'
    page.callFn.mockRejectedValue(null)

    await page.load()

    expect(page.data.error).toBe('网络不太好')
  })

  test('never throws to the caller', async () => {
    page.token = 'tok'
    page.callFn.mockRejectedValue(new Error('boom'))

    await expect(page.load()).resolves.toBeUndefined()
  })
})

describe('onInput', () => {
  test('mirrors the textarea value into data.text', () => {
    page.onInput({ detail: { value: '那个圆盖往左拧' } })

    expect(page.data.text).toBe('那个圆盖往左拧')
    expect(page.setData).toHaveBeenCalledWith({ text: '那个圆盖往左拧' })
  })

  test('clears data.text when the textarea is emptied', () => {
    page.data.text = '旧内容'

    page.onInput({ detail: { value: '' } })

    expect(page.data.text).toBe('')
  })

  test('handles an undefined value without throwing', () => {
    page.onInput({ detail: { value: undefined } })

    expect(page.data.text).toBeUndefined()
  })
})

describe('send', () => {
  test('does nothing when text is empty', async () => {
    page.data.help = HELP
    page.data.text = ''

    await page.send()

    expect(page.callFn).not.toHaveBeenCalled()
    expect(page.data.sending).toBe(false)
    expect(wx.showModal).not.toHaveBeenCalled()
  })

  test('does nothing when text is only whitespace', async () => {
    page.data.help = HELP
    page.data.text = '   \n\t '

    await page.send()

    expect(page.callFn).not.toHaveBeenCalled()
    expect(page.data.sending).toBe(false)
  })

  test('does nothing when text is a falsy non-string', async () => {
    page.data.help = HELP
    page.data.text = 0

    await page.send()

    expect(page.callFn).not.toHaveBeenCalled()
  })

  test('ignores a second tap while a send is in flight', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.data.sending = true

    await page.send()

    expect(page.callFn).not.toHaveBeenCalled()
  })

  test('sends the trimmed text with the help id', async () => {
    page.data.help = HELP
    page.data.text = '  那个圆盖往左拧  '
    page.callFn.mockResolvedValue({ ok: true })

    await page.send()

    expect(page.callFn).toHaveBeenCalledWith('replyHelp', {
      helpId: 'help-1',
      text: '那个圆盖往左拧'
    })
  })

  test('marks the message as sent and clears the input on success', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockResolvedValue({ ok: true })

    await page.send()

    expect(page.data).toMatchObject({
      sending: false,
      sent: true,
      text: ''
    })
    expect(wx.showModal).not.toHaveBeenCalled()
  })

  test('exposes the in-flight sending flag while waiting for the cloud', async () => {
    let resolveCall
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve
        })
    )

    const pending = page.send()
    expect(page.data.sending).toBe(true)

    resolveCall({ ok: true })
    await pending

    expect(page.data.sending).toBe(false)
    expect(page.data.sent).toBe(true)
  })

  test('forwards a 200-character message unchanged (upper bound)', async () => {
    const text = '字'.repeat(200)
    page.data.help = HELP
    page.data.text = text
    page.callFn.mockResolvedValue({ ok: true })

    await page.send()

    expect(page.callFn).toHaveBeenCalledWith('replyHelp', {
      helpId: 'help-1',
      text: text
    })
    expect(page.data.sent).toBe(true)
  })

  test('shows the server error and keeps the input when ok is false', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockResolvedValue({ ok: false, error: '说得太长了，短一点' })

    await page.send()

    expect(page.data.sending).toBe(false)
    expect(page.data.sent).toBe(false)
    expect(page.data.text).toBe('往左拧')
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(wx.showModal.mock.calls[0][0]).toMatchObject({
      title: '',
      content: '说得太长了，短一点',
      showCancel: false,
      confirmText: '好'
    })
  })

  test('falls back to 没发出去 when ok is false without an error message', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockResolvedValue({ ok: false })

    await page.send()

    expect(wx.showModal.mock.calls[0][0].content).toBe('没发出去')
    expect(page.data.sending).toBe(false)
    expect(page.data.sent).toBe(false)
  })

  test('uses the rejection message in the modal on network failure', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockRejectedValue(new Error('cloud.callFunction:fail network'))

    await page.send()

    expect(wx.showModal.mock.calls[0][0].content).toBe('cloud.callFunction:fail network')
    expect(page.data.sending).toBe(false)
    expect(page.data.sent).toBe(false)
    expect(page.data.text).toBe('往左拧')
  })

  test('falls back to 没发出去，再试一次 when the rejection has no message', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockRejectedValue({})

    await page.send()

    expect(wx.showModal.mock.calls[0][0].content).toBe('没发出去，再试一次')
    expect(page.data.sending).toBe(false)
  })

  test('recovers gracefully when help is still null (stale tap before load)', async () => {
    page.data.help = null
    page.data.text = '往左拧'

    await expect(page.send()).resolves.toBeUndefined()

    expect(page.data.sending).toBe(false)
    expect(page.data.sent).toBe(false)
    expect(page.data.text).toBe('往左拧')
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(typeof wx.showModal.mock.calls[0][0].content).toBe('string')
    expect(wx.showModal.mock.calls[0][0].content.length).toBeGreaterThan(0)
  })

  test('never throws to the caller', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockRejectedValue(new Error('boom'))

    await expect(page.send()).resolves.toBeUndefined()
  })

  test('allows resending the same message after a failure', async () => {
    page.data.help = HELP
    page.data.text = '往左拧'
    page.callFn.mockResolvedValueOnce({ ok: false, error: '没发出去' })
    await page.send()

    page.callFn.mockResolvedValueOnce({ ok: true })
    await page.send()

    expect(page.callFn).toHaveBeenCalledTimes(2)
    expect(page.data.sent).toBe(true)
    expect(page.data.text).toBe('')
  })
})

describe('again', () => {
  test('resets the sent flag and the input so another note can be written', () => {
    page.data.sent = true
    page.data.text = '往左拧'
    page.data.help = HELP

    page.again()

    expect(page.data.sent).toBe(false)
    expect(page.data.text).toBe('')
    expect(page.data.help).toEqual(HELP)
    expect(page.setData).toHaveBeenCalledWith({ sent: false, text: '' })
  })

  test('is idempotent when nothing was sent', () => {
    page.again()
    page.again()

    expect(page.data.sent).toBe(false)
    expect(page.data.text).toBe('')
  })
})

describe('onShareAppMessage', () => {
  test('shares the home page with the fixed invitation copy', () => {
    const share = page.onShareAppMessage()

    expect(share).toEqual({
      title: '我爸妈用它看懂说明书，拍一张纸就能听',
      path: '/pages/home/home'
    })
  })

  test('does not read page state or touch wx', () => {
    page.data.sent = true
    page.onShareAppMessage()

    expect(wx.showModal).not.toHaveBeenCalled()
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
  })
})
