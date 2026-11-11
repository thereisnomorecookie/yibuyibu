const store = require('../../utils/store')
const tts = require('../../utils/tts')
const asr = require('../../utils/asr')
const suggest = require('../../utils/suggest')

const BLOCK_SUB = {
  dosage: '吃药的事，请让医生或药师看一眼',
  money: '涉及钱的事，让孩子陪您弄',
  legal: '这种条款，找个人帮您看看更稳妥'
}

Page({
  data: {
    card: null,
    cur: {},
    idx: 0,
    total: 0,
    isLast: false,
    finished: false,
    saved: false,
    blocked: false,
    blockSub: '吃药的事，请让医生或药师看一眼',
    stairsArr: [],
    fontSize: 52,
    showResume: false,
    // 兜底三问：模型出不了题、断网、还没生成好，都用它顶着。
    // 这三个对任何卡片都成立，不像"是哪个按钮"对"等两分钟"就是废题。
    askItems: [
      { q: '这一步做啥？', a: '' },
      { q: '要注意什么？', a: '' },
      { q: '做对了吗？', a: '' }
    ],
    ask: {
      show: false,
      stage: 'choices',
      voice: false,
      recording: false,
      offline: false,
      question: '',
      answer: ''
    }
  },

  /** 按字数调字号：字多就缩，保证一屏放得下且尽量大 */
  calcFontSize(text) {
    const n = String(text || '').length
    if (n <= 12) return 58
    if (n <= 18) return 52
    if (n <= 26) return 46
    if (n <= 34) return 40
    return 34
  },

  onLoad() {
    const card = store.getCurrent()

    // 语速偏好全局沿用；连点计数按"步"重置
    this.speed = tts.getSpeed()
    this.replayCount = 0

    if (!card) {
      wx.redirectTo({ url: '/pages/home/home' })
      return
    }

    // 拦截态
    if (card.docType === 'blocked') {
      this.setData({
        card: card,
        blocked: true,
        blockSub: BLOCK_SUB[card.blockedReason] || BLOCK_SUB.dosage
      })
      const that = this
      setTimeout(function () {
        tts.speak('这一步不能替您拆，' + that.data.blockSub, { speed: that.speed })
          .catch(function () {})
      }, 350)
      return
    }

    const cards = card.cards || []
    if (!cards.length) {
      wx.redirectTo({ url: '/pages/home/home' })
      return
    }

    const stairsArr = cards.map(function (_, i) { return i })

    // 只有已经存进卡包的卡组才记忆进度；拍照后的首读不记
    const savedRecord = card.id ? store.get(card.id) : null
    this.isSaved = !!savedRecord

    let startIdx = 0
    const prog = (savedRecord && typeof savedRecord.progress === 'number') ? savedRecord.progress : 0
    if (prog > 0 && prog < cards.length) startIdx = prog
    this.needResumeHint = startIdx > 0

    this.setData({
      card: card,
      total: cards.length,
      cur: cards[startIdx],
      idx: startIdx,
      isLast: startIdx === cards.length - 1,
      stairsArr: stairsArr,
      fontSize: this.calcFontSize(cards[startIdx].text)
    })

    // 联想问题：当前卡先生成，下一张顺手排队；生成好了静默替换
    const that = this
    suggest.setListener(function (key, items) {
      that.applySuggested(key, items)
    })
    this.prefetchSuggest(card, startIdx)

    // 预热整组，翻页不等待。按当前语速预热，避免慢速时仍播到正常档的缓存
    tts.prefetch(cards, { speed: this.speed })

    setTimeout(function () {
      that.speakCurrent()
      if (that.needResumeHint) {
        that.setData({ showResume: true })
        setTimeout(function () { that.setData({ showResume: false }) }, 2500)
      }
    }, 350)
  },

  /** 记住读到哪一步。未存入卡包的卡组不记 */
  remember(idx) {
    const card = this.data.card
    if (!this.isSaved || !card || !card.id) return
    store.saveProgress(card.id, idx)
  },

  onHide() {
    tts.stop()
    // 录音中切走：取消这次录音，避免后台一直占着麦克风
    if (this.data.ask.recording) asr.cancel()
  },

  onUnload() {
    tts.stop()
    // 离开页面：清队列与在途，保留缓存，下次打开同组卡还是秒出
    suggest.reset()
    suggest.setListener(null)
  },

  speakCurrent() {
    const cur = this.data.cur
    if (!cur || !cur.text) return
    tts.speak(cur.text, { speed: this.speed }).catch(function () {})
  },

  /**
   * 连点两次「再念一遍」降一档，第 4 次再降一档，到 -1.5 到顶。
   * 不做设置开关：老人不会去设置里找，加了等于没加。
   * 提示语故意用正常速度，让"变慢了"这件事被听见。
   */
  onReplay() {
    tts.stop()
    this.replayCount = (this.replayCount || 0) + 1

    if (this.replayCount === 2 || this.replayCount === 4) {
      const next = this.speed <= -1 ? -1.5 : -1
      if (next !== this.speed) {
        this.speed = tts.setSpeed(next)

        // 先按新语速预热当前这张，减少切档后的等待
        const cur = this.data.cur
        if (cur) tts.prefetch([cur], { speed: this.speed })

        const that = this
        tts.speak('我慢点说', { speed: 0 }).catch(function () {})
        setTimeout(function () { that.speakCurrent() }, 1500)
        return
      }
    }

    this.speakCurrent()
  },

  onNext() {
    const card = this.data.card
    if (!card) return
    const cards = card.cards || []
    const next = this.data.idx + 1

    if (next >= cards.length) {
      tts.stop()
      // 做完即清零：这类任务是可以重复做的
      if (card.id) store.clearProgress(card.id)
      this.replayCount = 0
      this.setData({ finished: true, showResume: false })
      tts.speak('好了，都做完了。要不要存到我的卡里', { speed: this.speed })
        .catch(function () {})
      return
    }

    tts.stop()
    this.remember(next)
    this.replayCount = 0
    this.askPicked = false
    this.setData({
      idx: next,
      cur: cards[next],
      isLast: next === cards.length - 1,
      fontSize: this.calcFontSize(cards[next].text),
      showResume: false
    })
    this.prefetchSuggest(card, next)
    this.speakCurrent()
  },

  onPrev() {
    const cards = (this.data.card && this.data.card.cards) || []
    if (this.data.idx <= 0) return
    const prev = this.data.idx - 1
    tts.stop()
    this.remember(prev)
    this.replayCount = 0
    this.askPicked = false
    this.setData({
      idx: prev,
      cur: cards[prev],
      isLast: prev === cards.length - 1,
      fontSize: this.calcFontSize(cards[prev].text),
      showResume: false
    })
    this.prefetchSuggest(this.data.card, prev)
    this.speakCurrent()
  },

  onTouchStart(e) {
    this.touchStartX = e.touches[0].clientX
  },

  onTouchEnd(e) {
    if (this.touchStartX === undefined) return
    const dx = e.changedTouches[0].clientX - this.touchStartX
    this.touchStartX = undefined
    if (dx < -70) this.onNext()
    else if (dx > 70) this.onPrev()
  },

  onStuck() {
    tts.stop()
    wx.navigateTo({ url: '/pages/help/help?idx=' + this.data.idx })
  },

  /* ---------------- 问一句：只问这一页 ---------------- */

  /** 遮罩上的滑动不要穿透到阅读页，否则会误翻页 */
  noop() {},

  /** 把当前卡和下一张排进联想队列；已缓存则直接跳过 */
  prefetchSuggest(card, idx) {
    const cards = (card && card.cards) || []
    const cur = cards[idx]
    if (!cur) return

    const source = card.readText || card.sourceText || ''

    suggest.ensure({
      cardText: cur.text || '',
      anchor: cur.anchor || '',
      sourceText: source
    })

    const next = cards[idx + 1]
    if (next) {
      suggest.ensure({
        cardText: next.text || '',
        anchor: next.anchor || '',
        sourceText: source
      })
    }
  },

  /** 生成好了：只有当前卡才替换，且用户已经点开某一题就不动 */
  applySuggested(key, items) {
    const card = this.data.card || {}
    const cur = this.data.cur || {}
    const source = card.readText || card.sourceText || ''

    if (key !== suggest.keyOf(cur.text || '', source)) return
    if (this.data.ask.stage !== 'choices') return

    this.setData({ askItems: items })
  },

  /** 断网判断：只用来决定浮层要不要列问题 */
  isOffline() {
    return new Promise(function (resolve) {
      wx.getNetworkType({
        success: function (res) {
          resolve(!!(res && res.networkType === 'none'))
        },
        fail: function () { resolve(false) }
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
          reject(new Error((err && err.errMsg) || '调用失败'))
        }
      })
    })
  },

  async openAsk() {
    tts.stop()
    this.askCache = this.askCache || {}
    this.askPicked = false

    const card = this.data.card || {}
    const cur = this.data.cur || {}

    // 有缓存直接用；没有就拿兜底三问顶着，后台继续生成
    const source = card.readText || card.sourceText || ''
    const cached = suggest.get(suggest.keyOf(cur.text || '', source))

    // 权限被拒就不再显示话筒，只留问题——不弹窗、不报错
    const auth = await asr.checkAuth()
    const offline = await this.isOffline()
    const noNetwork = offline && !cached

    this.setData({
      'ask.show': true,
      'ask.stage': 'choices',
      'ask.voice': auth !== 'denied' && !offline,
      'ask.recording': false,
      'ask.offline': noNetwork,
      'ask.question': '',
      'ask.answer': '',
      askItems: cached || this.data.askItems
    })

    if (!cached && !offline) this.prefetchSuggest(card, this.data.idx)
  },

  closeAsk() {
    if (this.data.ask.recording) asr.cancel()
    tts.stop()
    this.setData({
      'ask.show': false,
      'ask.stage': 'choices',
      'ask.recording': false
    })
  },

  askQuick(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.askItems[idx]
    if (!item) return

    this.askPicked = true

    // 成对生成的问题，答案已经在手里，直接出，不再请求
    if (item.a) {
      this.showAnswer(item.q, item.a)
      return
    }

    this.ask(item.q)
  },

  askAgain() {
    const card = this.data.card || {}
    const cur = this.data.cur || {}
    const source = card.readText || card.sourceText || ''
    // 回到选择态时再读一次缓存：上一轮生成的可能刚回来
    const cached = suggest.get(suggest.keyOf(cur.text || '', source))

    this.setData({
      'ask.stage': 'choices',
      'ask.question': '',
      'ask.answer': '',
      askItems: cached || this.data.askItems
    })
  },

  /** 同一张卡同一问题不重复调模型 */
  ask(question) {
    const q = String(question || '').trim()
    if (!q) return

    const card = this.data.card || {}
    const cur = this.data.cur || {}
    const cards = card.cards || []
    // 卡片 no 从 1 起，所以 cards[no] 正好是下一张
    const nextCard = cards[cur.no || 0]
    const key = (card.id || '') + '|' + (cur.no || 0) + '|' + q

    this.askCache = this.askCache || {}
    if (this.askCache[key]) {
      this.showAnswer(q, this.askCache[key])
      return
    }

    this.setData({ 'ask.stage': 'thinking', 'ask.recording': false, 'ask.question': q })

    const that = this
    this.callFn('askCard', {
      question: q,
      cardText: cur.text || '',
      anchor: cur.anchor || '',
      sourceText: card.readText || card.sourceText || '',
      nextText: nextCard ? nextCard.text : '',
      docType: card.docType || 'operation'
    }).then(function (res) {
      if (!res || !res.ok) {
        throw new Error((res && res.error) || '没想明白')
      }
      that.askCache[key] = res.answer
      that.showAnswer(q, res.answer)
    }).catch(function (err) {
      console.error('[askCard]', err)
      const msg = (err && err.message) || ''
      const said = /没想明白|没听清|网络|调用失败/.test(msg)
        ? msg
        : '我没想明白，先按卡片做'

      that.setData({
        'ask.stage': 'answer',
        'ask.question': q,
        'ask.answer': said
      })
      tts.stop()
      tts.speak(said, { speed: that.speed }).catch(function () {})
    })
  },

  showAnswer(q, answer) {
    this.setData({
      'ask.stage': 'answer',
      'ask.question': q,
      'ask.answer': answer
    })
    tts.stop()
    tts.speak(answer, { speed: this.speed }).catch(function () {})
  },

  /* ---------------- 按住说话 ---------------- */

  onMicStart() {
    if (!this.data.ask.voice) return
    if (this.data.ask.stage !== 'choices') return
    if (this.data.ask.recording) return

    // 只改文案，不切状态：按钮一旦被卸载，touchend 就不会触发，录音停不下来
    asr.start()
    this.setData({ 'ask.recording': true })
  },

  onMicEnd() {
    if (!this.data.ask.recording) return

    // 松手立刻进入"在想…"，不让界面静止——这是 5—9 秒链路里最要紧的一步
    this.setData({ 'ask.recording': false, 'ask.stage': 'thinking' })

    const that = this
    asr.stop().then(function (text) {
      that.ask(text)
    }).catch(function (err) {
      const msg = (err && err.message) || ''

      if (msg === 'cancel') {
        that.setData({ 'ask.stage': 'choices', 'ask.recording': false })
        return
      }

      if (msg === 'too_short') {
        wx.showToast({ title: '没听清，按住多说一会儿', icon: 'none', duration: 2200 })
      } else {
        wx.showToast({ title: msg || '没听清', icon: 'none', duration: 2200 })
        // 录音通道走不通就收起话筒，只留快捷问题，不反复弹错
        if (/录音失败|不支持|授权|权限/.test(msg)) {
          that.setData({ 'ask.voice': false })
        }
      }

      that.setData({ 'ask.stage': 'choices', 'ask.recording': false })
    })
  },

  onMicCancel() {
    if (!this.data.ask.recording) return
    asr.cancel()
    this.setData({ 'ask.stage': 'choices', 'ask.recording': false })
  },

  readOriginal() {
    const card = this.data.card || {}
    const text = card.readText || (card.sourceText || '')
    if (!text) return
    tts.stop()
    tts.speakLong(text, { speed: this.speed }).catch(function () {})
  },

  saveCard() {
    const card = this.data.card
    if (!card) return
    const saved = store.save({
      id: card.id,
      title: card.title,
      docType: card.docType,
      cards: card.cards || [],
      createdAt: card.createdAt || Date.now()
    })
    this.setData({ saved: true })
    tts.stop()
    tts.speak('存好了，下次在首页的我的卡里能找到', { speed: this.speed })
      .catch(function () {})

    const that = this
    setTimeout(function () {
      wx.redirectTo({ url: '/pages/home/home' })
    }, 2600)
    return saved
  },

  goHome() {
    tts.stop()
    wx.redirectTo({ url: '/pages/home/home' })
  }
})
