/**
 * 样卡视图（兼容层）
 *
 * 数据已统一到 utils/library.js，这里只保留旧接口，
 * 避免仍引用 sample 的页面突然失效。
 * 新代码请直接用 library。
 */

const library = require('./library')

function list() {
  return library.pick(4).map(function (it) {
    return {
      id: it.id,
      title: it.title,
      subtitle: it.subtitle,
      docType: it.docType,
      count: (it.cards || []).length
    }
  })
}

function get(id) {
  return library.get(id)
}

module.exports = {
  list: list,
  get: get,
  BLOCKED_ID: library.BLOCKED_ID
}
