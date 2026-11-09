const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 文档 → 步骤卡
 * 入参：{ text }
 * 出参：{ ok, docType, title, cards[], blockedReason, checks }
 *
 * 三层处理：
 *   1. 风险关键词前置拦截（不消耗模型 token，先于模型执行）
 *   2. 大模型按六条规则重构（输出质量取决于提示词约束）
 *   3. 解析、字段校验与规则自检兜底
 *
 * 第三层是 P1-2 补的工程兜底：模型不一定守规矩，所以不信任单次输出。
 *   R4 截断、R2 拆分、R1 补语气词 —— 确定性可修，直接改；
 *   R3 相对位置、修不了的 R1 —— 只标记 warn，不擅自改写。
 * 自检结果随返回值带出去，供答辩现场展示，但不向老人端暴露任何"可能不准"。
 */

const MAX_CARDS = 12
const MAX_TEXT = 50
const MAX_ANCHOR = 20

/** 自检：warn 占比超过这个值，整组不再声称"可执行" */
const WARN_DOWNGRADE_RATE = 0.3

/** R1 动词首字表。祈使句以这些字开头即视为合规 */
const VERB_HEADS =
  '打开关按点把拿放插拔拧推拉选填等看擦倒加盖勾扫举转连设装拆取挂贴翻对抬搬洗晾切煮盛端试查读写签交进出上下停启保确输检准递换扯敲拍摸找念听记问说走站坐立蹲伸收塞倒灌冲浸泡抖甩叠抽挤掰顶扶握踩不'

/**
 * 拆分后右段常以副词开头（"再全部拧紧"→"全部拧紧"），
 * 这些词不是动作，确定性剥掉就能让动词露出来，属于可修项。
 */
const LEAD_FILLERS = [
  '最后', '全部', '然后', '接着', '同时', '并且',
  '再', '先', '也', '还', '就', '请', '您', '都'
]

/** R3 相对位置词。这些词在老人眼里没有可操作的落点 */
const REL_POS_RE = /左上|右上|左下|右下|最左|最右|第[一二三四五六七八九十]个|左边第|右边第/

/** R2 明确连接词：出现即视为两个动作，必须拆 */
const STRONG_CONNECTORS = ['并且', '然后', '同时', '接着']

const RISK_RULES = [
  { re: /用法用量|剂\s*量|口服|每[日天次][^。！？\n]{0,10}[片粒袋支毫升]|\d+(\.\d+)?\s*(mg|毫克|毫升)/i, reason: 'dosage' },
  { re: /转账|汇款|支付密码|短信验证码|银行卡号|信用卡/, reason: 'money' },
  { re: /违约|诉讼|法律责任|赔偿金/, reason: 'legal' }
]

const SYSTEM_PROMPT = [
  '你是一个为视力与阅读能力较弱的老年用户改写说明文档的助手。',
  '你的任务不是总结，而是把一页纸重写成"可以照着做"的动作序列。',
  '',
  '六条硬规则，任何一条违反都算失败：',
  'R1 动作化：每张卡必须是祈使句，以动词开头。删除所有原理介绍、参数说明、广告语。',
  'R2 单动作：一张卡只能有一个动作。出现"并且""然后""同时"必须拆成两张卡。',
  'R3 外形锚点：禁止使用"左上角""左下""第三个""第二个"等相对位置词。',
  '   必须改写为看得见的外形特征：颜色、形状、上面的字、材质、图标。',
  'R4 五十字：每张卡的 text 不超过 50 个字符，目标 15—25 字。anchor 不超过 20 字。',
  'R5 不增不减：绝对不能添加原文没有的操作步骤。信息不足以判断时，',
  '   输出一张提示卡要求用户重拍，不要猜测。',
  'R6 风险闸门：若原文含药品剂量、用药频次、金额、转账、法律后果、违约责任，',
  '   立即停止拆解，把 docType 设为 blocked。',
  '',
  '先分诊，再拆解：',
  '- operation：连续操作类（家电、设备、流程），拆成步骤卡',
  '- form：表单类，一个输入项一张卡，说明这一格填什么',
  '- readonly：数值/条款/报告类，只逐条朗读原文，不做判断',
  '- blocked：命中 R6',
  '',
  '输出必须是纯 JSON，不要任何解释文字、不要 markdown 代码块。',
  '',
  '示例输入：',
  '2. 本机采用模糊逻辑控制技术，可根据衣物重量与材质自动匹配洗涤参数。',
  '3. 将衣物放入内筒，注意衣物总量不得超过内筒容积的三分之二。',
  '4. 关闭机门后，按下控制面板右侧标有"启动/暂停"的方形按键，机器开始进水。',
  '',
  '示例输出：',
  '{"docType":"operation","title":"洗衣机","cards":[',
  '{"no":1,"text":"打开机门，把衣服放进内筒。","anchor":"机门是正面那个圆形的门","verb":"打开"},',
  '{"no":2,"text":"衣服不要超过内筒的三分之二。","anchor":"内筒里有一圈标线","verb":"控制"},',
  '{"no":3,"text":"把机门推回去，听到咔一声就关好了。","anchor":"门把手在门的右边","verb":"推"},',
  '{"no":4,"text":"按下面板右边那个写着启动的方块键。","anchor":"面板右边，蓝色那块","verb":"按"}',
  '],"blockedReason":null}'
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
    req.setTimeout(12000, function () {
      req.destroy(new Error('模型超时'))
    })
    req.write(data)
    req.end()
  })
}

/** 超长按标点截断，不硬切 */
function clamp(str, max) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const idx = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('，'),
    cut.lastIndexOf('；'), cut.lastIndexOf('、')
  )
  return idx > max * 0.5 ? cut.slice(0, idx + 1) : cut
}

/* ---------------- 规则自检（R1—R4） ---------------- */

function startsWithVerb(text) {
  const first = String(text || '').charAt(0)
  return first ? VERB_HEADS.indexOf(first) >= 0 : false
}

/** 剥掉开头的副词，让动词露出来；剥完太短就放弃，避免剥成残句 */
function stripLead(text) {
  let t = String(text || '')
  let changed = false

  for (let guard = 0; guard < 3; guard++) {
    let hit = ''
    for (let i = 0; i < LEAD_FILLERS.length; i++) {
      if (t.indexOf(LEAD_FILLERS[i]) === 0) {
        hit = LEAD_FILLERS[i]
        break
      }
    }
    if (!hit) break
    if (t.length - hit.length < 2) break
    t = t.slice(hit.length).replace(/^[，,、：:\s]+/, '')
    changed = true
  }

  return { text: t, changed: changed }
}

/** 找第一个可靠的切分点。切不动就返回空，宁可不拆也不拆出碎片 */
function findSplit(text) {
  const t = String(text || '')

  for (let i = 0; i < STRONG_CONNECTORS.length; i++) {
    const c = STRONG_CONNECTORS[i]
    const at = t.indexOf(c)
    if (at < 0) continue
    const left = t.slice(0, at).replace(/[，,、；;：:\s]+$/, '').trim()
    const right = t.slice(at + c.length).replace(/^[，,、；;：:\s]+/, '').trim()
    // 两侧都要能独立成句，否则拆出来是残句。
    // 左段 4 字即放行："打开机门"本身就是完整动作，不必凑到 5 字。
    if (left.length < 4 || right.length < 5) continue
    return { left: left, right: right }
  }

  // "再"单独出现太常见（"等两分钟再开"），只在有逗号分隔时才当连接词
  const m = t.match(/[，,]\s*再\s*/)
  if (m && m.index > 0) {
    const at = m.index
    const left = t.slice(0, at).replace(/[，,、；;：:\s]+$/, '').trim()
    const right = t.slice(at + m[0].length).replace(/^[，,、；;：:\s]+/, '').trim()
    if (left.length >= 5 && right.length >= 5) {
      return { left: left, right: right }
    }
  }

  return null
}

/** 递归拆分，直到没有可靠切分点 */
function splitByConnector(text) {
  const seg = findSplit(text)
  if (!seg) return [String(text || '').trim()]
  const head = /[。！？；]$/.test(seg.left) ? seg.left : seg.left + '。'
  return [head].concat(splitByConnector(seg.right))
}

/**
 * 逐张过规则。互斥口径：warned > fixed > passed，
 * 三者相加等于 total，方便答辩时说"5 步通过、1 步修复、0 步待复核"。
 */
function checkCards(rawCards, docType) {
  // R2 拆分与 R3 外形锚点：操作类和表单类都要守
  const needCheck = docType === 'operation' || docType === 'form'
  // R1 祈使句只对操作类要求。表单的"第一格填姓名"是纸面印好的格子序号，
  // 强求动词开头反而降低可读性，还会把好卡误判成待复核。
  const checkVerb = docType === 'operation'
  const checks = {
    total: 0,
    passed: 0,
    fixed: 0,
    warned: 0,
    split: 0,
    truncated: 0,
    downgraded: false,
    issues: []
  }
  const out = []

  rawCards.forEach(function (c) {
    const segments = needCheck ? splitByConnector(c.text) : [c.text]
    if (segments.length > 1) checks.split += segments.length - 1

    segments.forEach(function (seg) {
      let text = String(seg || '').replace(/\s+/g, ' ').trim()
      if (!text) return

      let fixed = false
      let warned = false

      // R4 五十字：TTS 硬限，任何类型都要守
      if (text.length > MAX_TEXT) {
        text = clamp(text, MAX_TEXT)
        fixed = true
        checks.truncated += 1
      }

      // R1 祈使句：先确定性修复，修不了才标 warn
      if (checkVerb && !startsWithVerb(text)) {
        const lead = stripLead(text)
        if (lead.changed && startsWithVerb(lead.text)) {
          text = lead.text
          fixed = true
        } else if (/不要|别|注意|记得|务必|小心/.test(text) && text.length <= MAX_TEXT - 3) {
          text = '注意，' + text
          fixed = true
        } else {
          warned = true
          if (checks.issues.length < 6) checks.issues.push({ rule: 'R1', text: text.slice(0, 20) })
        }
      }

      // R3 外形锚点：改成什么取决于实物，不能瞎改，只能标记
      if (needCheck && REL_POS_RE.test(text)) {
        warned = true
        if (checks.issues.length < 6) checks.issues.push({ rule: 'R3', text: text.slice(0, 20) })
      }

      checks.total += 1
      if (warned) checks.warned += 1
      else if (fixed) checks.fixed += 1
      else checks.passed += 1

      out.push({
        no: out.length + 1,
        text: text,
        anchor: clamp(c.anchor, MAX_ANCHOR),
        verb: String(c.verb || '').slice(0, 4)
      })
    })
  })

  // 大面积不合格时不再声称可执行，降为只读材料。
  // 老人端不显示任何提示——少给，但不给错。
  // 至少 3 张才判：1—2 张的短文档，一张卡出问题就会 50% 以上，降级过于激进。
  if (
    needCheck &&
    checks.total >= 3 &&
    checks.warned / checks.total > WARN_DOWNGRADE_RATE
  ) {
    checks.downgraded = true
  }

  return { cards: out, checks: checks }
}

function parseLoose(raw) {
  if (!raw) return null
  try { return JSON.parse(raw) } catch (e) {}
  const m = String(raw).match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch (e) {}
  }
  return null
}

function normalize(parsed) {
  const allowed = ['operation', 'form', 'readonly', 'blocked']
  let docType = parsed && parsed.docType
  if (allowed.indexOf(docType) < 0) docType = 'operation'

  let cards = (parsed && Array.isArray(parsed.cards)) ? parsed.cards : []
  cards = cards
    .filter(function (c) { return c && c.text })
    .slice(0, MAX_CARDS)
    .map(function (c) {
      return {
        text: String(c.text || ''),
        anchor: String(c.anchor || ''),
        verb: String(c.verb || '')
      }
    })

  const checked = checkCards(cards, docType)

  // 降级只改语义：不再声称"可以照着做"，卡片与朗读体验不变，
  // 因为老人端不该出现任何"这组可能不准"的提示。
  const finalType = checked.checks.downgraded ? 'readonly' : docType

  let title = clamp((parsed && parsed.title) || '', 6)
  if (!title) title = '这张纸'

  return {
    docType: finalType,
    title: title,
    cards: checked.cards,
    blockedReason: (parsed && parsed.blockedReason) || null,
    checks: checked.checks
  }
}

function fallbackCard(msg) {
  return {
    docType: 'readonly',
    title: '再看一眼',
    cards: [{ no: 1, text: msg || '这页字太多，能靠近一点再拍吗', anchor: '', verb: '拍' }],
    blockedReason: null,
    checks: null
  }
}

exports.main = async function (event) {
  const text = String((event && event.text) || '').trim()

  if (!text) {
    return Object.assign({ ok: false }, fallbackCard('这张纸没看清，再拍一张试试'))
  }

  // 1. 风险前置拦截：不花 token，且比模型更不会漏
  for (let i = 0; i < RISK_RULES.length; i++) {
    if (RISK_RULES[i].re.test(text)) {
      return {
        ok: true,
        docType: 'blocked',
        title: '这张纸',
        cards: [],
        blockedReason: RISK_RULES[i].reason,
        checks: null
      }
    }
  }

  // 2. 调模型
  const apiKey = process.env.LLM_API_KEY || ''
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'deepseek-chat'

  if (!apiKey) {
    return Object.assign(
      { ok: false, errMsg: '云函数未配置 LLM_API_KEY' },
      fallbackCard('识别服务暂时不可用，先用样例看看')
    )
  }

  let content = ''
  try {
    const resp = await httpsPost(
      baseUrl,
      { Authorization: 'Bearer ' + apiKey },
      {
        model: model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              '以下是文档 OCR 文本，请按规则输出 JSON：\n---\n' +
              text.slice(0, 3000) +
              '\n---\n\n输出格式：\n' +
              '{"docType":"operation|form|readonly|blocked","title":"不超过6个字的文档名",' +
              '"cards":[{"no":1,"text":"...","anchor":"...","verb":"打开"}],"blockedReason":null}'
          }
        ]
      }
    )
    content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content
      : ''
  } catch (err) {
    return Object.assign(
      { ok: false, errMsg: (err && err.message) || '模型调用失败' },
      fallbackCard('这边出了点问题，再试一次')
    )
  }

  // 3. 解析兜底
  const parsed = parseLoose(content)
  if (!parsed) {
    return Object.assign({ ok: false, errMsg: '模型返回无法解析' }, fallbackCard())
  }

  const result = normalize(parsed)

  if (result.docType !== 'blocked' && !result.cards.length) {
    return Object.assign({ ok: false, errMsg: '没有拆出步骤' }, fallbackCard())
  }

  return Object.assign({ ok: true }, result)
}
