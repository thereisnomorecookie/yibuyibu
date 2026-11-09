const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 语音转文字（一句话识别）
 * 入参：{ audio, format }
 *   audio  — 录音文件的 base64（前端读本地文件得到，不经云存储）
 *   format — mp3 / wav / m4a / aac，默认 mp3
 * 出参：{ ok, text, requestId } 或 { ok:false, error, code, hint }
 *
 * 为什么走腾讯云而不是 WechatSI：
 *   WechatSI 是插件，未认证小程序加不了，这条路已实测走不通。
 *   一句话识别可以在云函数里调，60 秒内、≤3MB、base64 直传，
 *   不需要云存储，也就没有临时文件清理问题。
 *
 * 环境变量：
 *   ASR_SECRET_ID / ASR_SECRET_KEY
 *   未配置时自动复用 TTS_SECRET_ID / TTS_SECRET_KEY（同一对密钥，不同产品）
 *
 * 注意：语音识别与语音合成是两个独立产品，控制台里的资源包不通用。
 */

const SECRET_ID = process.env.ASR_SECRET_ID || process.env.TTS_SECRET_ID || ''
const SECRET_KEY = process.env.ASR_SECRET_KEY || process.env.TTS_SECRET_KEY || ''

const MAX_BYTES = 3 * 1024 * 1024
const ALLOWED_FORMATS = ['mp3', 'wav', 'm4a', 'aac', 'amr', 'pcm', 'ogg-opus', 'speex', 'silk']

let client = null
let sdkError = ''

try {
  const AsrClient = require('tencentcloud-sdk-nodejs-asr').asr.v20190614.Client

  if (SECRET_ID && SECRET_KEY) {
    client = new AsrClient({
      credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
      region: '',
      profile: {
        httpProfile: { endpoint: 'asr.tencentcloudapi.com', reqTimeout: 10 }
      }
    })
  } else {
    sdkError = '未配置 ASR_SECRET_ID / ASR_SECRET_KEY'
  }
} catch (e) {
  sdkError = 'SDK 加载失败: ' + ((e && e.message) || '')
}

/** 把腾讯云错误码翻成能指导动作的一句话 */
function explain(code, msg) {
  const c = String(code || '')
  const m = String(msg || '')

  if (/UserNotRegistered|ServiceNotOpened/i.test(c) || /not registered|未开通/.test(m)) {
    return '语音识别服务还没开通，去控制台开通'
  }
  if (/ServiceIsolate|Arrears|NoBanlance/i.test(c)) return '语音识别服务被停用或欠费'
  if (/NotEnoughFreeQuota/i.test(c)) return '语音识别免费额度已用完'
  if (/ResourcePackExhausted|PkgExhausted/i.test(c)) return '语音识别资源包已用完'
  if (/AuthFailure|SignatureFailure|SecretIdNotFound/i.test(c)) return '密钥不对或已失效（AuthFailure）'
  if (/RequestLimitExceeded|LimitExceeded/i.test(c)) return '调用太频繁，等一下再试'
  if (/InvalidParameter.*VoiceFormat|VoiceFormat/i.test(c)) return '录音格式不支持（' + m + '）'
  if (/InvalidParameter/i.test(c)) return '参数不合法（' + m + '）'
  if (/FailedOperation/i.test(c)) return '识别服务出错了（' + m + '）'

  return (c ? c + '：' : '') + (m || '识别失败')
}

function hintOf(code) {
  const c = String(code || '')
  if (/UserNotRegistered|ServiceNotOpened/i.test(c)) {
    return '去「语音识别」控制台（console.cloud.tencent.com/asr，不是语音合成）→ 先开通服务 → 领取免费额度'
  }
  if (/NotEnoughFreeQuota|ResourcePackExhausted|PkgExhausted/i.test(c)) {
    return '语音识别按月赠送免费额度，用完后按量计费；也可在控制台购买资源包'
  }
  if (/AuthFailure|SignatureFailure|SecretIdNotFound/i.test(c)) {
    return '检查 ASR_SECRET_ID / ASR_SECRET_KEY，或确认复用的 TTS 那对密钥仍然有效'
  }
  return ''
}

exports.main = async function (event) {
  const audio = String((event && event.audio) || '')
  const format = String((event && event.format) || 'mp3').toLowerCase()

  if (!audio) {
    return { ok: false, error: '没有收到录音', code: 'EMPTY_AUDIO' }
  }

  if (ALLOWED_FORMATS.indexOf(format) < 0) {
    return { ok: false, error: '录音格式不支持：' + format, code: 'BAD_FORMAT' }
  }

  // base64 解码后约 3/4，据此估算真实字节数，避免把超限音频发出去
  const bytes = Math.round(audio.length * 0.75)
  if (bytes > MAX_BYTES) {
    return { ok: false, error: '这段录音太长了', code: 'TOO_LONG' }
  }

  if (!client) {
    return { ok: false, error: sdkError || 'ASR 未初始化', code: 'NO_CLIENT' }
  }

  try {
    const res = await client.SentenceRecognition({
      EngSerViceType: '16k_zh',
      SourceType: 1,
      VoiceFormat: format,
      Data: audio,
      DataLen: bytes,
      ProjectId: 0
    })

    const text = String((res && res.Result) || '').replace(/\s+/g, '').trim()

    if (!text) {
      return { ok: false, error: '没听清', code: 'EMPTY_RESULT' }
    }

    // 识别结果也要限长：问一句话不该有 50 个字
    return {
      ok: true,
      text: text.slice(0, 50),
      chars: text.length,
      requestId: (res && res.RequestId) || ''
    }
  } catch (err) {
    const code = (err && (err.code || err.Code)) || ''
    const msg = (err && (err.message || '')) || ''
    return {
      ok: false,
      error: explain(code, msg),
      hint: hintOf(code),
      code: code || 'UNKNOWN',
      requestId: (err && err.requestId) || ''
    }
  }
}
