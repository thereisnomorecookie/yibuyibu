const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 受限问答：只回答"这一页纸"上的问题
 *
 * 入参：{ question, cardText, anchor, sourceText, docType, nextText }
 * 出参：{ ok, answer, refused, reason }
 *
 * 设计要点（与《10_受限语音问答策划书》一致）：
 *   1. 入参是文字，不是音频。语音只是前端的一种输入方式，
 *      所以 ASR 挂了、权限被拒，快捷问题照样能走这条链路。
 *   2. 知识边界 = 当前卡 + 这一页原文 + 下一步。
 *      下一步也来自同一页纸，不算越界；不给它，"然后呢"就永远答不了。
 *   3. 拒答话术固定，不让模型自由发挥——固定才能被测试和验收。
 *   4. 不信任模型：返回后还要过一遍二次校验，能拦就拦。
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

exports.main = async function (event) {
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
