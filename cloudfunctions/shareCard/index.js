const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 卡组分享
 *
 * action = 'create'  入参 { title, cards }        出参 { ok, token }
 * action = 'get'     入参 { token }               出参 { ok, title, cards, count, error? }
 *
 * 设计要点：
 *  - 只传文字，不传音频。接收方打开后由本地 TTS 重新合成。
 *  - 接收方零门槛：读取不校验身份，点开即存。
 *  - 7 天过期，和求助卡 24 小时清理是同一套思路。
 */

const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CARDS = 20

function randomToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz'
  let s = 's_'
  for (let i = 0; i < 10; i++) {
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

function sanitizeCards(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter(function (c) { return c && c.text })
    .slice(0, MAX_CARDS)
    .map(function (c, i) {
      return {
        no: i + 1,
        text: String(c.text).slice(0, 50),
        anchor: String(c.anchor || '').slice(0, 20),
        verb: String(c.verb || '').slice(0, 4)
      }
    })
}

exports.main = async function (event) {
  const action = (event && event.action) || 'create'
  await ensureCollection('sharedCards')

  /* ---------- 发起分享 ---------- */
  if (action === 'create') {
    const cards = sanitizeCards(event.cards)
    if (!cards.length) {
      return { ok: false, error: '这组卡没有可分享的步骤' }
    }

    const token = randomToken()
    const now = Date.now()

    try {
      await db.collection('sharedCards').add({
        data: {
          token: token,
          title: String(event.title || '这张纸').slice(0, 12),
          cards: cards,
          createdAt: now,
          expireAt: now + EXPIRE_MS
        }
      })
      return { ok: true, token: token }
    } catch (err) {
      return { ok: false, error: (err && err.message) || '创建分享失败' }
    }
  }

  /* ---------- 接收方读取 ---------- */
  if (action === 'get') {
    const token = String((event && event.token) || '').trim()
    if (!token) return { ok: false, error: '这个链接不完整' }

    try {
      const found = await db
        .collection('sharedCards')
        .where({ token: token })
        .limit(1)
        .get()

      const rec = found.data && found.data[0]
      if (!rec) return { ok: false, error: '没找到这组卡' }
      if (rec.expireAt && rec.expireAt < Date.now()) {
        return { ok: false, error: '这组卡过时了，让发卡的人重新发一次' }
      }

      const cards = rec.cards || []
      return {
        ok: true,
        title: rec.title || '这张纸',
        count: cards.length,
        cards: cards
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || '读取失败' }
    }
  }

  return { ok: false, error: '未知操作' }
}
