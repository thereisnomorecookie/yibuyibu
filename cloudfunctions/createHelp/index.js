const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 发起求助
 * 入参：{ cardTitle, stepNo, stepTotal, stepText, stepAnchor }
 * 出参：{ ok, helpId, token }
 *
 * 只存当前这一步，不存整份文档（隐私考虑）。
 */

function randomToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]
  }
  return s
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在会报错，忽略
  }
}

exports.main = async function (event) {
  const stepText = String((event && event.stepText) || '').trim()
  if (!stepText) {
    return { ok: false, error: '缺少步骤内容' }
  }

  await ensureCollection('helps')

  const now = Date.now()
  const token = randomToken()

  try {
    const res = await db.collection('helps').add({
      data: {
        cardTitle: String(event.cardTitle || '这张纸').slice(0, 12),
        stepNo: Number(event.stepNo || 1),
        stepTotal: Number(event.stepTotal || 1),
        stepText: stepText.slice(0, 120),
        stepAnchor: String(event.stepAnchor || '').slice(0, 60),
        token: token,
        status: 'pending',
        createdAt: now,
        expireAt: now + 24 * 60 * 60 * 1000
      }
    })

    return { ok: true, helpId: res._id, token: token }
  } catch (err) {
    return { ok: false, error: (err && err.message) || '创建失败' }
  }
}
