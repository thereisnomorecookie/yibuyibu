const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 受限问答：只回答"这一页纸"上的问题
 *
 * 两种用法，用 action 区分：
 *   问答（默认）：{ question, cardText, anchor, sourceText, docType, nextText }
 *                 → { ok, answer, refused, reason }
 *   出题：{ action:'suggest', cardText, anchor, sourceText }
 *         → { ok, items:[{q,a}], source:'model'|'mixed'|'fallback' }
 *
 * 设计要点（与《10_受限语音问答策划书》《12_动态联想问题策划书》一致）：
 *   1. 入参是文字，不是音频。语音只是前端的一种输入方式，
 *      所以 ASR 挂了、权限被拒，快捷问题照样能走这条链路。
 *   2. 知识边界 = 当前卡 + 这一页原文 + 下一步（下一步只用于被动回答）。
 *   3. 拒答话术固定，不让模型自由发挥——固定才能被测试和验收。
 *   4. 不信任模型：返回后还要过一遍二次校验，能拦就拦。
 *   5. 出题必须与答案成对生成。出题时故意不传 nextText——
 *      传了它就会出"然后呢"，而那是下一张卡的内容。
 *
 * 环境变量：LLM_API_KEY（与 buildCards 共用）
 * 可选：LLM_BASE_URL、LLM_MODEL
 */

const MAX_ANSWER = 30
const MAX_HARD = 40

/** 固定拒答话术：原文里没有 */
const REFUSAL_NO_INFO = '这页没写这个，问问孩子，或者拍下一页'
/** 固定拒答话术：问题与这页无关 */
const REFUSAL_UNRELATED = '这个我说不好，先按卡片上的做'

const RISK_RULES = [
  {
    // 除了"吃几片"，也要拦住"一次吃两片对不对"这种自带剂量的问法
    re: /吃几|服几|喝几|用量|剂量|多少片|多少粒|多少毫升|一天几[次片粒]|[0-9一二三四五六七八九十两半]+\s*[片粒袋支毫克]/,
    reason: 'dosage'
  },
  { re: /转账|汇款|支付密码|验证码|银行卡|转多少/, reason: 'money' },
  { re: /违约|起诉|赔偿|法律责任/, reason: 'legal' }
]

const RISK_ANSWER = {
  dosage: '这事得问医生',
  money: '涉及钱，让孩子陪您弄',
  legal: '这种条款，找个人帮您看看'
}

/** 二次校验拦下来之后，按原因给一句更贴切的话 */
const FALLBACK_BY_REASON = {
  number: '这个数我说不好，问问医生或者孩子',
  money: '涉及钱，让孩子陪您弄',
  toolong: '这页写得太绕，先按卡片做',
  offtopic: REFUSAL_UNRELATED,
  empty: '没听清，再说一次'
}

const SYSTEM_PROMPT = [
  '你是这一页纸的讲解员，不是通用助手。',
  '你只懂手里这一页纸，纸外的事一律不知道。',
  '',
  '【你能用的材料】',
  '只有用户消息里的「原文」和「当前卡」。两者都没有的信息，就是没有。',
  '',
  '【五条规则】',
  'Q1 只用这一页：答案里的每个信息都要能在原文或卡片里找到出处。',
  'Q2 三十字：回答不超过 30 个字，一句话。',
  'Q3 说人话：不用"请""您可""建议""一般来说""通常"。用"您""就""再"。',
  'Q4 指路不代做：说按哪里、看哪里，不要说"我帮您"。',
  'Q5 答不了就说：找不到出处时，只输出这一句，不要改字——',
  REFUSAL_NO_INFO,
  'Q6 问"然后呢"：材料里有【下一步】就照它说；没有就是最后一步，说"这步做完就完了"。',
  '',
  '【不要做的事】',
  '不解释原理，不补充常识，不推荐产品，不猜数字。',
  '哪怕你觉得"一般人都知道"，只要这页没写，就说不知道。',
  '',
  '示例一',
  '原文：按下面板右边那个写着启动的方块键。',
  '当前卡：按下面板右边那个写着启动的方块键。',
  '问题：是哪个按钮？',
  '回答：右边那个蓝色的方块键',
  '',
  '示例二',
  '原文：将衣物放入内筒，注意不要超过内筒的三分之二。',
  '当前卡：衣服不要超过内筒的三分之二。',
  '问题：放多少洗衣液？',
  '回答：' + REFUSAL_NO_INFO,
  '',
  '示例三',
  '原文：按下面板右边那个写着启动的方块键，机器开始进水。',
  '当前卡：按下面板右边那个写着启动的方块键。',
  '问题：这个键是干什么的？',
  '回答：就管开始洗，按一下就行',
  '',
  '示例四',
  '原文：白细胞六点二，正常是三到九点五。',
  '当前卡：白细胞六点二，正常是三到九点五，这项正常。',
  '问题：这个正常吗？',
  '回答：正常，在参考范围里'
].join('\n')

/* ---------------- 出题（动态联想） ---------------- */

const MAX_QUESTION = 12

/**
 * 兜底三问：模型出不了题时用它。
 * 这三个对任何卡片都成立——不像"是哪个按钮"，对"等两分钟"就是废题。
 */
const FALLBACK_QUESTIONS = ['这一步做啥？', '要注意什么？', '做对了吗？']

/**
 * 出题提示词。和答题不一样：这里不给 nextText，
 * 因为一旦给了，模型一定会出"然后呢"——那是下一张卡的内容。
 */
const SUGGEST_PROMPT = [
  '你在替一位看不清说明书的老人想：他看着这一页，可能会问什么。',
  '',
  '【出题规则】',
  '1. 只根据【当前卡】和【原文】出题，不要用纸外的知识。',
  '2. 出 3 道题，每题配一个答案。',
  '3. 问题不超过 12 个字，像老人嘴里说出来的话。',
  '4. 答案不超过 30 个字，口语，一句话。',
  '5. 每道题的答案必须能只从【当前卡】和【原文】里找到，找不到就换一题。',
  '6. 三题不要重复，尽量覆盖：问哪个、问对不对、问要注意什么。',
  '7. 不要出"然后呢""下一步"这类题——那属于下一页，不属于这一页。',
  '',
  '输出纯 JSON，不要解释，不要代码块：',
  '{"items":[{"q":"问题","a":"答案"}]}',
  '',
  '示例一',
  '当前卡：按下面板右边那个写着启动的方块键。',
  '原文：按下面板右边那个写着启动的方块键，机器开始进水。',
  '输出：',
  '{"items":[{"q":"是哪个键？","a":"右边写着启动的方块键"},{"q":"按键在哪儿？","a":"面板右边"},{"q":"按了会怎样？","a":"机器开始进水"}]}',
  '',
  '示例二（原文没写的东西，一个字都不要编）',
  '当前卡：衣服不要超过内筒的三分之二。',
  '原文：将衣物放入内筒，注意衣物总量不得超过内筒容积的三分之二。',
  '输出：',
  '{"items":[{"q":"放多少衣服？","a":"不要超过内筒的三分之二"},{"q":"标线在哪儿？","a":"内筒里有一圈标线"},{"q":"怎么放？","a":"把衣服放进内筒"}]}'
].join('\n')

function httpsPost(urlStr, headers, bodyObj) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr)
    const data = JSON.stringify(bodyObj)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          },
          headers
        )
      },
      function (res) {
        let buf = ''
        res.on('data', function (c) { buf += c })
        res.on('end', function () {
          try {
            resolve(JSON.parse(buf))
          } catch (e) {
            reject(new Error('返回非 JSON: ' + buf.slice(0, 160)))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(10000, function () {
      req.destroy(new Error('模型超时'))
    })
    req.write(data)
    req.end()
  })
}

/** 双字重合度：判断答案是不是跑到了纸外 */
function overlap(answer, source) {
  const a = String(answer || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const s = String(source || '')
  if (a.length < 2) return 1

  let hit = 0
  let total = 0
  for (let i = 0; i < a.length - 1; i++) {
    total += 1
    if (s.indexOf(a.slice(i, i + 2)) >= 0) hit += 1
  }
  return total ? hit / total : 1
}

/**
 * 二次校验：模型说错话的兜底。
 * 能拦的一律换成拒答，不做"截一半继续用"——半句话比不说更误导。
 */
function verify(raw, cardText, sourceText) {
  const a = String(raw || '').replace(/\s+/g, '').trim()

  if (!a) return { ok: false, reason: 'empty' }
  if (a.length > MAX_HARD) return { ok: false, reason: 'toolong' }

  // 钱先判：否则"转账五十元"会先命中下面的数字规则，话术就不贴切了
  if (/转账|汇款|支付密码|验证码|银行卡/.test(a)) {
    return { ok: false, reason: 'money' }
  }
  if (/[0-9一二三四五六七八九十两半]+\s*(元|块钱)/.test(a)) {
    return { ok: false, reason: 'money' }
  }

  // 数字 + 单位：剂量最危险，宁可拦住。
  // 中文数字必须一起拦——"一次吃两片"如果只认阿拉伯数字就会漏过去。
  if (/[0-9一二三四五六七八九十两半]+\s*(mg|毫克|毫升|ml|片|粒|袋|支)/i.test(a)) {
    return { ok: false, reason: 'number' }
  }

  // 模型已经表达了"不知道"，统一成固定话术
  if (/没写|没说|没提|不知道|查不到/.test(a)) {
    return { ok: true, answer: REFUSAL_NO_INFO, refused: true, reason: 'no_info' }
  }

  // 跑题：答案与纸面几乎无重合，判为纸外内容
  if (overlap(a, cardText + sourceText) < 0.25) {
    return { ok: false, reason: 'offtopic' }
  }

  return { ok: true, answer: a.slice(0, MAX_ANSWER), refused: false }
}

/* ---------------- 出题逻辑 ---------------- */

function parseLoose(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {}
  const m = String(raw).match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch (e) {}
  }
  return null
}

/**
 * 逐条校验模型出的题。不合格直接扔，不做修补——
 * 一道题要么能答、要么不该出现在界面上。
 */
function normalizeItems(parsed, cardText, sourceText) {
  const raw = parsed && Array.isArray(parsed.items) ? parsed.items : []
  const out = []
  const seen = {}

  for (let i = 0; i < raw.length; i++) {
    const q = String((raw[i] && raw[i].q) || '').replace(/\s+/g, '').trim()
    const a = String((raw[i] && raw[i].a) || '').replace(/\s+/g, '').trim()

    if (!q || !a) continue
    if (q.length > MAX_QUESTION) continue
    // 越界：问的是下一张卡
    if (/然后|下一步|接下来|之后/.test(q)) continue
    // 出题时超长直接剔除，不截断——半句话比不说更误导
    if (a.length > MAX_ANSWER) continue
    if (seen[q]) continue

    const checked = verify(a, cardText, sourceText)
    // 答案本身是拒答，说明这题出了也答不出来，扔
    if (!checked.ok || checked.refused) continue

    seen[q] = 1
    out.push({ q: q, a: checked.answer })
    if (out.length >= 3) break
  }

  return out
}

/** 固定三问，答案留空：前端点的时候再走正常问答 */
function fallbackItems() {
  return FALLBACK_QUESTIONS.map(function (q) {
    return { q: q, a: '' }
  })
}

/** 模型给的不够 3 条，用固定问题补齐，保证界面上永远有三条 */
function fillItems(items) {
  const out = items.slice(0, 3)
  const used = {}
  out.forEach(function (it) { used[it.q] = 1 })

  for (let i = 0; i < FALLBACK_QUESTIONS.length && out.length < 3; i++) {
    const q = FALLBACK_QUESTIONS[i]
    if (used[q]) continue
    out.push({ q: q, a: '' })
  }
  return out
}

async function suggest(event) {
  const cardText = String((event && event.cardText) || '').trim()
  const anchor = String((event && event.anchor) || '').trim()
  const sourceText = String((event && event.sourceText) || '').trim().slice(0, 2000)

  // 没有卡片内容（拦截态）就没有可问的
  if (!cardText) {
    return { ok: true, items: fallbackItems(), source: 'fallback' }
  }

  const apiKey = process.env.LLM_API_KEY || ''
  if (!apiKey) {
    return { ok: true, items: fallbackItems(), source: 'fallback' }
  }

  const baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'deepseek-chat'

  let content = ''
  try {
    const resp = await httpsPost(
      baseUrl,
      { Authorization: 'Bearer ' + apiKey },
      {
        model: model,
        // 出题需要一点多样性，但不要跑偏
        temperature: 0.3,
        max_tokens: 260,
        messages: [
          { role: 'system', content: SUGGEST_PROMPT },
          {
            role: 'user',
            content:
              '【原文】\n' + (sourceText || '（没有得到原文）') +
              '\n\n【当前卡】\n' + cardText +
              (anchor ? '\n锚点：' + anchor : '') +
              '\n\n按规则出 3 道题，只输出 JSON。'
          }
        ]
      }
    )
    content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content
      : ''
  } catch (err) {
    // 出题失败不是错误，是换兜底
    return { ok: true, items: fallbackItems(), source: 'fallback' }
  }

  const parsed = parseLoose(content)
  const items = normalizeItems(parsed, cardText, sourceText)

  if (!items.length) {
    return { ok: true, items: fallbackItems(), source: 'fallback' }
  }

  return {
    ok: true,
    items: fillItems(items),
    source: items.length >= 3 ? 'model' : 'mixed'
  }
}

exports.main = async function (event) {
  // 出题走单独分支：它没有"问题"，是替用户想问题
  if (event && event.action === 'suggest') {
    return suggest(event)
  }

  const question = String((event && event.question) || '').replace(/\s+/g, '').trim().slice(0, 30)
  const cardText = String((event && event.cardText) || '').trim()
  const anchor = String((event && event.anchor) || '').trim()
  const sourceText = String((event && event.sourceText) || '').trim().slice(0, 2000)
  const nextText = String((event && event.nextText) || '').trim()

  if (!question) {
    return { ok: false, error: '没听清，再说一次', code: 'EMPTY_Q' }
  }

  // 1. 风险前置拦截：不花 token，且比模型更不会漏
  for (let i = 0; i < RISK_RULES.length; i++) {
    if (RISK_RULES[i].re.test(question)) {
      return {
        ok: true,
        answer: RISK_ANSWER[RISK_RULES[i].reason] || REFUSAL_UNRELATED,
        refused: true,
        reason: RISK_RULES[i].reason
      }
    }
  }

  const apiKey = process.env.LLM_API_KEY || ''
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'deepseek-chat'

  if (!apiKey) {
    return { ok: false, error: '云函数未配置 LLM_API_KEY', code: 'NO_KEY' }
  }

  let content = ''
  try {
    const resp = await httpsPost(
      baseUrl,
      { Authorization: 'Bearer ' + apiKey },
      {
        model: model,
        temperature: 0.1,
        max_tokens: 120,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              '【原文】\n' + (sourceText || '（没有得到原文）') +
              '\n\n【当前卡】\n' + (cardText || '（空）') +
              (anchor ? '\n锚点：' + anchor : '') +
              (nextText ? '\n\n【下一步】\n' + nextText : '') +
              '\n\n【问题】\n' + question +
              '\n\n只输出回答本身，不要加"答："之类的字样。'
          }
        ]
      }
    )
    content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content
      : ''
  } catch (err) {
    return {
      ok: false,
      error: '我没想明白，先按卡片做',
      code: 'LLM_FAIL',
      detail: (err && err.message) || ''
    }
  }

  // 2. 二次校验。下一步也属于这一页纸，一并作为出处参与比对
  const checked = verify(content, cardText, sourceText + '\n' + nextText)

  if (!checked.ok) {
    // 拦下来的原因不回给老人，只回一句能听懂的话
    return {
      ok: true,
      answer: FALLBACK_BY_REASON[checked.reason] || REFUSAL_UNRELATED,
      refused: true,
      reason: checked.reason
    }
  }

  return {
    ok: true,
    answer: checked.answer,
    refused: !!checked.refused,
    reason: checked.reason || ''
  }
}
