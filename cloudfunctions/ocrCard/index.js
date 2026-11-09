const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 通用印刷体识别 + 文本重排
 * 入参：{ fileID }
 * 出参：{ ok, text, blocks, via, tried[], errCode?, errMsg? }
 *
 * 坐标重排：微信 OCR 返回带坐标的文本块数组，顺序不可直接拼接，
 *   需按 top 分行（容差 12px），行内按 left 排序。
 *
 * 图片限制：格式 jpg/png、体积 < 2MB、长边 < 4096px。
 *   超限不返回明确的"图片过大"错误，只表现为识别不到文字。
 *   因此客户端先压缩，本函数内再做一层兜底。
 *
 * 双通道：微信云调用按"服务市场"计费，额度用尽返回
 *   `openapi.ocr.printedText:fail not enough market quota`，
 *   属于账号配额问题而非代码问题。故提供两条通道：
 *     ① 微信云调用（免密钥，走服务市场配额）
 *     ② 腾讯云 OCR（使用自有 SecretId，每月含免费额度）
 *   ①失败自动切②，两条均不可用时才返回错误，并附带两边原因。
 */

let ocrClient = null
let ocrClientError = ''

try {
  const OcrClient = require('tencentcloud-sdk-nodejs-ocr').ocr.v20181119.Client
  // 复用 TTS 那套密钥，少配一组；要分开计费就配 OCR_SECRET_ID / KEY
  const secretId = process.env.OCR_SECRET_ID || process.env.TTS_SECRET_ID || ''
  const secretKey = process.env.OCR_SECRET_KEY || process.env.TTS_SECRET_KEY || ''

  if (secretId && secretKey) {
    ocrClient = new OcrClient({
      credential: { secretId: secretId, secretKey: secretKey },
      region: 'ap-guangzhou',
      profile: {
        httpProfile: { endpoint: 'ocr.tencentcloudapi.com', reqTimeout: 15 }
      }
    })
  } else {
    ocrClientError = '未配置 OCR_SECRET_ID / OCR_SECRET_KEY（也没找到 TTS_SECRET_ID / KEY）'
  }
} catch (e) {
  ocrClientError = 'OCR SDK 加载失败：' + ((e && e.message) || '')
}

function reflow(items) {
  if (!items || !items.length) return ''

  const list = items
    .filter(function (it) { return it && it.text })
    .map(function (it) {
      const pos = it.pos || {}
      return {
        text: String(it.text).trim(),
        left: Number(pos.left || 0),
        top: Number(pos.top || 0)
      }
    })
    .filter(function (it) { return it.text })

  list.sort(function (a, b) {
    if (Math.abs(a.top - b.top) > 12) return a.top - b.top
    return a.left - b.left
  })

  const lines = []
  let curTop = null
  let curLine = []

  list.forEach(function (it) {
    if (curTop === null || Math.abs(it.top - curTop) > 12) {
      if (curLine.length) lines.push(curLine)
      curLine = [it]
      curTop = it.top
    } else {
      curLine.push(it)
    }
  })
  if (curLine.length) lines.push(curLine)

  return lines
    .map(function (line) {
      line.sort(function (a, b) { return a.left - b.left })
      return line.map(function (x) { return x.text }).join(' ')
    })
    .join('\n')
}

function rawOf(err) {
  if (!err) return ''
  // 只取第一行：模块缺失时会附带整段 require stack，需截断后再返回
  const s = String(err.errMsg || err.errmsg || err.message || '')
  const first = s.split('\n')[0].trim()
  return first.length > 140 ? first.slice(0, 140) + '…' : first
}

function codeOf(err) {
  if (!err) return ''
  const c = err.errCode !== undefined ? err.errCode
    : (err.errcode !== undefined ? err.errcode : err.code)
  return c === undefined || c === null ? '' : String(c)
}

function isQuotaError(err) {
  const s = rawOf(err).toLowerCase()
  return s.indexOf('quota') >= 0 || s.indexOf('not enough') >= 0
}

function describe(err) {
  const msg = rawOf(err)
  const code = codeOf(err)
  const base = msg || '识别失败'

  if (isQuotaError(err)) {
    return '微信 OCR 服务市场额度不足（' + base + '）'
  }
  if (/unauthor|scope|permission|48001/i.test(msg)) {
    return '微信 OCR 没有接口权限（' + base + '）'
  }
  return code ? ('OCR ' + code + '：' + base) : base
}

function callWechat(imgUrl) {
  return cloud.openapi.ocr.printedText({ type: 'photo', imgUrl: imgUrl })
}

function normalizeWechat(res) {
  const code = res && (res.errCode !== undefined ? res.errCode : res.errcode)
  if (code !== undefined && code !== 0 && String(code) !== '0') {
    const e = new Error(res.errMsg || res.errmsg || '接口报错')
    e.errCode = code
    throw e
  }
  const items = (res && res.items) || []
  return items.map(function (it) {
    const pos = it.pos || {}
    return { text: it.text, pos: { left: pos.left, top: pos.top } }
  })
}

async function byWechat(fileID) {
  try {
    return normalizeWechat(await callWechat(fileID))
  } catch (e) {
    // 直传云文件 ID 不行就退一步用临时链接
    const temp = await cloud.getTempFileURL({ fileList: [fileID] })
    const first = temp.fileList && temp.fileList[0]
    if (!first || !first.tempFileURL) throw e
    return normalizeWechat(await callWechat(first.tempFileURL))
  }
}

async function byTencent(fileID) {
  if (!ocrClient) throw new Error(ocrClientError || '腾讯云 OCR 未配置')

  const dl = await cloud.downloadFile({ fileID: fileID })
  const base64 = dl.fileContent.toString('base64')

  const res = await ocrClient.GeneralBasicOCR({ ImageBase64: base64 })
  const dets = res.TextDetections || []

  return dets.map(function (d) {
    const p = d.ItemPolygon || (d.Polygon && d.Polygon[0]) || {}
    return {
      text: d.DetectedText,
      pos: { left: p.X || 0, top: p.Y || 0 }
    }
  })
}

function resultFrom(items, via, tried) {
  const text = reflow(items)
  if (!text) return null
  return {
    ok: true,
    text: text,
    blocks: items.length,
    via: via,
    tried: tried
  }
}

exports.main = async function (event) {
  const fileID = event && event.fileID
  if (!fileID) {
    return { ok: false, errMsg: '缺少 fileID，前端没把图片传上来' }
  }

  const tried = []
  let wechatErr = null
  let tencentErr = null
  let wechatZero = false
  let tencentZero = false

  // 1. 先试微信云调用：额度内最快，也不占自己的密钥额度
  try {
    const items = await byWechat(fileID)
    const hit = resultFrom(items, 'wechat', ['wechat'])
    if (hit) return hit
    wechatZero = true
    tried.push('wechat:0')
  } catch (e) {
    wechatErr = e
    tried.push('wechat:err')
  }

  // 2. 微信不通（额度/权限/0 字）再试腾讯云
  try {
    const items = await byTencent(fileID)
    const hit = resultFrom(items, 'tencent', tried.concat('tencent'))
    if (hit) return hit
    tencentZero = true
    tried.push('tencent:0')
  } catch (e) {
    tencentErr = e
    tried.push('tencent:err')
  }

  // 3. 两条都不通，把原因摊开说，别只说"识别失败"
  const reasons = []

  if (wechatErr) reasons.push('微信：' + describe(wechatErr))
  else if (wechatZero) reasons.push('微信：能调通但读到 0 个字')

  if (tencentErr) reasons.push('腾讯云：' + (rawOf(tencentErr) || '未配置'))
  else if (tencentZero) reasons.push('腾讯云：能调通但读到 0 个字')

  if (!reasons.length) {
    reasons.push('可能太糊、太暗或者没对着纸')
  } else if (wechatZero && tencentZero) {
    reasons.push('建议：换光线好一点的地方，把整页纸放进框里再拍')
  }

  return {
    ok: false,
    errMsg: reasons.join('；'),
    errCode: codeOf(wechatErr) || undefined,
    tried: tried
  }
}
