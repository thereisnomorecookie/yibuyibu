const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 子女端读取求助
 * 入参：{ token }
 * 出参：{ ok, help, replies[] }
 */

exports.main = async function (event) {
  const token = String((event && event.token) || '').trim()
  if (!token) return { ok: false, error: '缺少口令' }

  try {
    const found = await db
      .collection('helps')
      .where({ token: token })
      .limit(1)
      .get()

    const help = found.data && found.data[0]
    if (!help) return { ok: false, error: '没找到，可能已经过期了' }
    if (help.expireAt && help.expireAt < Date.now()) {
      return { ok: false, error: '这个已经过期了，让孩子再发一次' }
    }

    let replies = []
    try {
      const r = await db
        .collection('replies')
        .where({ helpId: help._id })
        .orderBy('createdAt', 'asc')
        .limit(20)
        .get()
      replies = r.data || []
    } catch (e) {
      replies = []
    }

    return {
      ok: true,
      help: {
        _id: help._id,
        cardTitle: help.cardTitle,
        stepNo: help.stepNo,
        stepTotal: help.stepTotal,
        stepText: help.stepText,
        stepAnchor: help.stepAnchor,
        status: help.status,
        createdAt: help.createdAt
      },
      replies: replies
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || '读取失败' }
  }
}
