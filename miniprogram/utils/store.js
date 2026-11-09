/**
 * 本地卡包
 * 全部存本地 storage，断网也能用。
 * 云数据库只用来做"求助传递"，不存卡包主体。
 */

const KEY = 'cards_local'

function readAll() {
  try {
    return wx.getStorageSync(KEY) || []
  } catch (e) {
    return []
  }
}

function writeAll(list) {
  try {
    wx.setStorageSync(KEY, list)
    return true
  } catch (e) {
    return false
  }
}

function genId() {
  return 'c' + Date.now() + Math.floor(Math.random() * 1000)
}

function list() {
  return readAll().sort(function (a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function count() {
  return readAll().length
}

function get(id) {
  const found = readAll().filter(function (c) { return c.id === id })[0]
  return found || null
}

/** 保存一个卡组。传入完整对象，自动补 id 与时间 */
function save(card) {
  const all = readAll()
  const item = Object.assign({}, card)
  item.id = item.id || genId()
  item.createdAt = item.createdAt || Date.now()

  const idx = all.findIndex(function (c) { return c.id === item.id })
  if (idx >= 0) {
    // 合并而不是整体替换：保住 progress 等不在入参里的字段
    all[idx] = Object.assign({}, all[idx], item)
  } else {
    all.unshift(item)
  }
  writeAll(all)
  return item
}

/** 阅读进度：写在卡组对象上，卡组删掉进度自然没了 */
function saveProgress(id, idx) {
  if (!id) return false
  const all = readAll()
  const i = all.findIndex(function (c) { return c.id === id })
  if (i < 0) return false
  all[i].progress = idx
  all[i].progressAt = Date.now()
  return writeAll(all)
}

/** 做完即清零：洗衣机这类任务是可重复的，不留"已完成"状态 */
function clearProgress(id) {
  if (!id) return false
  const all = readAll()
  const i = all.findIndex(function (c) { return c.id === id })
  if (i < 0) return false
  delete all[i].progress
  delete all[i].progressAt
  return writeAll(all)
}

function rename(id, title) {
  const all = readAll()
  const idx = all.findIndex(function (c) { return c.id === id })
  if (idx < 0) return false
  all[idx].title = title
  return writeAll(all)
}

function remove(id) {
  const all = readAll().filter(function (c) { return c.id !== id })
  return writeAll(all)
}

/** 首次进入提示，只播一次 */
function isFirstVisit() {
  try {
    return !wx.getStorageSync('first_visit_done')
  } catch (e) {
    return true
  }
}

function markVisited() {
  try {
    wx.setStorageSync('first_visit_done', 1)
  } catch (e) {}
}

/** 拍照页 → 阅读页的临时传递（避免 URL 传大对象） */
function setCurrent(card) {
  try {
    wx.setStorageSync('current_card', card)
  } catch (e) {}
}

function getCurrent() {
  try {
    return wx.getStorageSync('current_card') || null
  } catch (e) {
    return null
  }
}

module.exports = {
  list: list,
  count: count,
  get: get,
  save: save,
  rename: rename,
  remove: remove,
  genId: genId,
  isFirstVisit: isFirstVisit,
  markVisited: markVisited,
  setCurrent: setCurrent,
  getCurrent: getCurrent,
  saveProgress: saveProgress,
  clearProgress: clearProgress
}
