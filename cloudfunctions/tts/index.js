const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 文字转语音（云函数版）
 * 入参：{ text, speed }
 * 出参：{ ok, audio, bytes, voice, voiceKind, speed, requestId }  audio 为 base64 mp3
 *
 * speed 可选：-2 ~ 2，0 为正常，负数更慢。
 *   前端只用 0 / -1 / -1.5 三档，但这里按区间接住，避免非法值把合成打挂。
 *   不给 speed 时退回环境变量 TTS_SPEED，保持旧调用方式兼容。
 *
 * 返回 base64 而非云存储链接：省去上传、临时链接过期与 downloadFile 域名校验；
 *   单句 15—40 字，音频 10—20KB，base64 后仍在 callFunction 返回限制内。
 *
 * 需要在云函数环境变量里配置：
 *   TTS_SECRET_ID / TTS_SECRET_KEY   （腾讯云访问密钥）
 * 可选：
 *   TTS_VOICE_TYPE  默认 1001（标准音色·智瑜，情感女声）
 *   TTS_SPEED       默认 0（-2 慢 ~ 6 快；朗读场景可设 -1，约 0.8 倍速）
 *   TTS_VOLUME      默认 5（0 正常，10 最大）
 *
 * 音色默认取 1001 的原因：精品音色号段从 101000 起（101001 为精品·智瑜），
 *   按腾讯云计费规则，免费资源包优先抵扣标准音色，精品音色仅支持后付费。
 *   使用 101001 时即便账号已领取免费包，也会返回
 *   UnsupportedOperation.PkgExhausted（资源包余量已用尽）。
 *   标准音色 1001 与 101001 同场景，朗读说明书足够，且可抵扣免费额度。
 *
 * 错误码透传：不同错误对应完全不同的处理方式，
 *   因此统一返回腾讯云原始 code，并翻译为可执行的说明。
 */

let client = null
let sdkError = ''

const SECRET_ID = process.env.TTS_SECRET_ID || ''
const SECRET_KEY = process.env.TTS_SECRET_KEY || ''
const VOICE = Number(process.env.TTS_VOICE_TYPE || 1001)
const SPEED = Number(process.env.TTS_SPEED || 0)
const VOLUME = Number(process.env.TTS_VOLUME || 5)

/** 精品音色号段从 101000 起，计费和资源包规则与标准音色不同 */
function voiceKind(v) {
  return v >= 101000 ? 'premium' : 'standard'
}

/** 语速按请求传，非法值退回默认；腾讯云只接受 -2 ~ 2 */
function pickSpeed(v) {
  if (v === undefined || v === null || v === '') return SPEED
  const n = Number(v)
  if (!isFinite(n)) return SPEED
  return Math.min(2, Math.max(-2, n))
}

try {
  const TtsClient = require('tencentcloud-sdk-nodejs-tts').tts.v20190823.Client

  if (SECRET_ID && SECRET_KEY) {
    client = new TtsClient({
      credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
      region: '',
      profile: {
        httpProfile: { endpoint: 'tts.tencentcloudapi.com', reqTimeout: 12 }
      }
    })
  } else {
    sdkError = '未配置 TTS_SECRET_ID / TTS_SECRET_KEY'
  }
} catch (e) {
  sdkError = 'SDK 加载失败: ' + ((e && e.message) || '')
}

/** 把腾讯云的错误码翻成能指导动作的一句话 */
function explain(code, msg) {
  const c = String(code || '')
  const m = String(msg || '')

  // 配额类错误优先匹配：配置正确但无输出，多为此类原因
  if (/PkgExhausted/i.test(c) || /PkgExhausted|resource pack allowance/i.test(m)) {
    return '语音合成资源包余量已用尽（PkgExhausted）。注意语音识别和语音合成是两个独立产品，识别控制台里的包不能用于合成'
  }
  if (/NoFreeAccount/i.test(c) || /免费资源包已用尽/i.test(m)) {
    return '免费资源包已用尽，需在语音合成控制台领取或购买资源包'
  }
  if (/QuotaRunOut/i.test(c) || /额度用尽/.test(m)) {
    return '语音合成额度已用尽，充值后重试'
  }

  if (/InArrears|AccountArrears|NoBanlance/i.test(c)) return '账号欠费或余额不足'
  if (/NotExist|ServerNotOpen/i.test(c)) return '语音合成服务还没开通，去控制台开通'
  if (/AuthFailure|AuthorizationFailed/i.test(c)) return '密钥不对或已失效（AuthFailure）'
  if (/AuthorizationExpired/i.test(c)) return '密钥授权已过期，重新生成一对'
  if (/VoiceType/i.test(c) || /VoiceType/.test(m)) return '音色号不支持，检查 TTS_VOICE_TYPE'
  if (/AccessLimit|ResourceReachedLimit|LimitExceeded/i.test(c)) return '调用太频繁或超出用量上限'
  if (/ForbiddenUse|Freeze|StopUsing/i.test(c)) return '这个账号被限制使用语音合成'
  if (/InvalidParameter/i.test(c)) return '参数不合法（' + m + '）'

  return (c ? c + '：' : '') + (m || '合成失败')
}

/** 配额类错误额外给一条可执行的建议 */
function hintOf(code) {
  const c = String(code || '')
  if (/PkgExhausted|NoFreeAccount|QuotaRunOut/i.test(c)) {
    return '去「语音合成」控制台（console.cloud.tencent.com/tts，不是语音识别）→ 资源包管理 → 先开通服务，再免费领取「基础音色资源包」：800 万字符、3 个月、一账号一次'
  }
  if (/VoiceType/i.test(c)) {
    return '标准音色用 1001—1018 号段，精品音色用 101000 以上号段'
  }
  return ''
}

exports.main = async function (event) {
  const text = String((event && event.text) || '').trim()
  const speed = pickSpeed(event && event.speed)

  if (!text) {
    return { ok: false, error: '空文本' }
  }
  if (text.length > 60) {
    return { ok: false, error: '文本过长，前端应先切分' }
  }
  if (!client) {
    return { ok: false, error: sdkError || 'TTS 未初始化', code: 'NO_CLIENT' }
  }

  try {
    const res = await client.TextToVoice({
      Text: text,
      SessionId: 's' + Date.now() + Math.floor(Math.random() * 1000),
      VoiceType: VOICE,
      Codec: 'mp3',
      SampleRate: 16000,
      Speed: speed,
      Volume: VOLUME,
      ProjectId: 0,
      ModelType: 1,
      PrimaryLanguage: 1
    })

    if (!res || !res.Audio) {
      return { ok: false, error: '合成无音频返回', code: 'EMPTY_AUDIO' }
    }

    return {
      ok: true,
      audio: res.Audio,
      mime: 'audio/mpeg',
      // 实际音频字节数，base64 解码后约 3/4；前端据此判断是否异常小
      bytes: Math.round(res.Audio.length * 0.75),
      voice: VOICE,
      voiceKind: voiceKind(VOICE),
      speed: speed,
      chars: text.length,
      requestId: res.RequestId || ''
    }
  } catch (err) {
    const code = (err && (err.code || err.Code)) || ''
    const msg = (err && (err.message || err.message)) || ''
    return {
      ok: false,
      error: explain(code, msg),
      hint: hintOf(code),
      code: code || 'UNKNOWN',
      voice: VOICE,
      voiceKind: voiceKind(VOICE),
      speed: speed,
      requestId: (err && err.requestId) || ''
    }
  }
}
