const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 子女回复
 * 入参：{ helpId, text }
 * 出参：{ ok }
 *
 * v1 仅支持文字回复，客户端取回后用语音合成朗读；
 * 真人语音便条列为后续版本。
 */

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (e) {}
}

exports.main = async function (event) {
  const helpId = String((event && event.helpId) || '').trim()
  const text = String((event && event.text) || '').trim()

  if (!helpId || !text) return { ok: false, error: '缺少内容' }
  if (text.length > 200) return { ok: false, error: '说得太长了，短一点' }

  await ensureCollection('replies')

  try {
    await db.collection('replies').add({
      data: {
        helpId: helpId,
        type: 'text',
        text: text,
        createdAt: Date.now()
      }
    })

    try {
      await db.collection('helps').doc(helpId).update({
        data: { status: 'replied' }
      })
    } catch (e) {}

    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err && err.message) || '发送失败' }
  }
}
