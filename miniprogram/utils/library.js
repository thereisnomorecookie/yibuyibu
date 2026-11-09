/**
 * 场景示例库
 *
 * 定位：不是"通用卡库"，是「场景示例 + 拍摄指引」。
 *   解决的是"我该拍哪一页"，不是"我给你现成的卡"。
 *   覆盖各品牌型号的通用卡既不可能也不该做——型号一变就错位，
 *   用户找不到自己那台，反而砸招牌。所以每组只给示例，主按钮永远是「拍我家的」。
 *
 * 边界：清一色实体纸。缴费、政务 App、手机设置类一概不收——
 *   老人要一边看小程序一边操作另一个 App，小程序不能悬浮，切走就断了，
 *   产品在那里没有位置站。
 *
 * 内容为自制虚构文档，不使用真实品牌，规避版权与商誉风险。
 * 约束：每张卡 text <= 50 字符（语音合成硬限），anchor <= 20 字。
 */

const GROUPS = [
  {
    category: '家电说明书',
    items: [
      {
        id: 'lib-washer',
        title: '洗衣机',
        subtitle: '滚筒洗衣机',
        shootHint: '翻到「使用前准备」那一页，把整页都拍进框里，别只拍按键。',
        docType: 'operation',
        isExample: true,
        cards: [
          { no: 1, text: '打开机门，把衣服放进内筒。', anchor: '机门是正面那个圆形的门', verb: '打开' },
          { no: 2, text: '衣服不要超过内筒的三分之二。', anchor: '内筒里有一圈标线', verb: '控制' },
          { no: 3, text: '把机门推回去，听到咔一声就关好了。', anchor: '门把手在门的右边', verb: '推' },
          { no: 4, text: '按下面板右边那个写着启动的方块键。', anchor: '面板右边，蓝色那块', verb: '按' },
          { no: 5, text: '等机器进水，洗干净会响提示音。', anchor: '面板上的数字会往下走', verb: '等' },
          { no: 6, text: '响完别急着开门，等两分钟再开。', anchor: '门上小锁的图标消失才能开', verb: '等' }
        ]
      },
      {
        id: 'lib-cooker',
        title: '电饭煲',
        subtitle: '简易电饭煲',
        shootHint: '拍机身上贴的那张说明贴纸；没有贴纸就翻到「煮饭」那一节。',
        docType: 'operation',
        isExample: true,
        cards: [
          { no: 1, text: '把洗好的米倒进锅里的那个盆。', anchor: '能拿出来的那个内胆', verb: '倒' },
          { no: 2, text: '加水到米上面的刻度线。', anchor: '盆里印着 2 和 4 的刻度', verb: '加' },
          { no: 3, text: '把盆底擦干，再放回锅里转一下。', anchor: '盆底有水会响会坏', verb: '擦' },
          { no: 4, text: '盖上盖子，按下写着煮饭的键。', anchor: '盖子上那个凸起的按钮', verb: '按' },
          { no: 5, text: '看键弹起来就是煮好了，可以吃。', anchor: '灯变黄就是保温', verb: '看' }
        ]
      },
      {
        id: 'lib-microwave',
        title: '微波炉',
        subtitle: '转盘式微波炉',
        shootHint: '拍带按键图的那一页，或者控制面板正对着拍一张。',
        docType: 'operation',
        isExample: true,
        cards: [
          { no: 1, text: '打开炉门，把碗放在中间的玻璃盘上。', anchor: '里面那个圆玻璃盘', verb: '打开' },
          { no: 2, text: '把门推上，听到咔一声才算关好。', anchor: '门左边有几个卡扣', verb: '推' },
          { no: 3, text: '转右边那个旋钮，选到两分钟。', anchor: '面板上最大的圆旋钮', verb: '转' },
          { no: 4, text: '按一下写着启动的键，灯会亮起来。', anchor: '旋钮下面那个方键', verb: '按' },
          { no: 5, text: '等它响三声，过十秒才开门。', anchor: '里面的灯灭了再开', verb: '等' }
        ]
      },
      {
        id: 'lib-ac',
        title: '空调',
        subtitle: '挂机空调遥控器',
        shootHint: '拍遥控器背面那张小卡片；说明书就翻到「制冷」那一页。',
        docType: 'operation',
        isExample: true,
        cards: [
          { no: 1, text: '拿起遥控器，按最上面那个红色键开机。', anchor: '遥控器顶上的红键', verb: '按' },
          { no: 2, text: '按写着模式的键，选到雪花图标。', anchor: '屏幕出现一片雪花', verb: '按' },
          { no: 3, text: '按上下箭头调温度，夏天调到二十六。', anchor: '屏幕中间那个数字', verb: '按' },
          { no: 4, text: '按风速键，选自动那一档。', anchor: '屏幕上的小风扇图标', verb: '按' },
          { no: 5, text: '按睡眠键，睡觉时风会自己变小。', anchor: '最下面一排的月亮图标', verb: '按' }
        ]
      }
    ]
  },
  {
    category: '组装与纸质表单',
    items: [
      {
        id: 'lib-assembly',
        title: '家具组装',
        subtitle: '两层置物架组装单',
        shootHint: '拍第一页的零件清单和步骤图；零件多就分两张，先拍清单再拍步骤。',
        docType: 'operation',
        isExample: true,
        cards: [
          { no: 1, text: '把板子都摊开，照包装上的编号排好。', anchor: '每块板角上贴着数字', verb: '排' },
          { no: 2, text: '先找出最长的那块，它是背板。', anchor: '最长最薄的那块', verb: '找' },
          { no: 3, text: '把螺丝穿过圆孔，用袋里那把小扳手拧。', anchor: '装零件的小塑料袋', verb: '拧' },
          { no: 4, text: '四个角都先拧半紧，不要一次拧死。', anchor: '拧到不晃就行', verb: '拧' },
          { no: 5, text: '立起来看看正不正，再全部拧紧。', anchor: '放在地上看四条腿', verb: '看' },
          { no: 6, text: '最后把塑料盖按进螺丝孔，遮住钉头。', anchor: '袋子里那些小圆盖', verb: '按' }
        ]
      },
      {
        id: 'lib-form',
        title: '建档表',
        subtitle: '就诊人建档表',
        shootHint: '拍空白表格那一页，别拍已经填好的；表头也要拍进去。',
        docType: 'form',
        isExample: true,
        cards: [
          { no: 1, text: '第一格填您的名字，照身份证上写。', anchor: '最上面那一格', verb: '填' },
          { no: 2, text: '第二格选身份证。', anchor: '有照片那张卡', verb: '选' },
          { no: 3, text: '第三格填身份证号码，十八位那串。', anchor: '卡正面最下面一行', verb: '填' },
          { no: 4, text: '第四格选城镇职工，单位给交的那个。', anchor: '六个选项里的第一个', verb: '选' },
          { no: 5, text: '第五格填您的手机号，十一位。', anchor: '常用的那个号码', verb: '填' },
          { no: 6, text: '第六格填家里地址，写到小区就行。', anchor: '不用写到门牌号', verb: '填' },
          { no: 7, text: '最后那个小方框打个勾，再按提交。', anchor: '最下面一行小字旁边', verb: '勾' }
        ]
      }
    ]
  },
  {
    category: '单据报告',
    items: [
      {
        id: 'lib-report',
        title: '血常规',
        subtitle: '血常规检验报告',
        shootHint: '拍整张报告单，上下的医院名和日期都拍进去，别只拍中间几行。',
        docType: 'readonly',
        isExample: true,
        cards: [
          { no: 1, text: '白细胞六点二，正常是三到九点五，这项正常。', anchor: '第一行', verb: '看' },
          { no: 2, text: '血红蛋白一百一十二，要一百一十五以上，这项偏低。', anchor: '第二行', verb: '看' },
          { no: 3, text: '血小板二百一十，在正常范围里，这项没问题。', anchor: '第三行', verb: '看' },
          { no: 4, text: '空腹血糖六点八，上限六点一，这项偏高。', anchor: '第四行', verb: '看' },
          { no: 5, text: '只帮您念数字，怎么办要听医生的。', anchor: '报告单最下面', verb: '记' }
        ]
      }
    ]
  },
  {
    category: '看看我们怎么拦',
    items: [
      {
        id: 'medbox',
        title: '药盒说明',
        subtitle: '会被拦下的那种',
        shootHint: '拍药盒侧面印着用法用量的那一面。这类内容我们只念原文，不拆步骤。',
        docType: 'blocked',
        blockedReason: 'dosage',
        isExample: true,
        readText: '阿莫西林胶囊。口服。成人一次零点五克，两粒，每六到八小时一次，一日不超过四克。青霉素过敏者禁用。',
        cards: []
      }
    ]
  }
]

function groups() {
  return GROUPS.map(function (g) {
    return {
      category: g.category,
      items: g.items.map(function (it) {
        return {
          id: it.id,
          title: it.title,
          subtitle: it.subtitle,
          count: (it.cards || []).length
        }
      })
    }
  })
}

function all() {
  const out = []
  GROUPS.forEach(function (g) {
    g.items.forEach(function (it) { out.push(it) })
  })
  return out
}

function get(id) {
  const found = all().filter(function (it) { return it.id === id })[0]
  return found ? JSON.parse(JSON.stringify(found)) : null
}

/** 「试试看」等处按需取前几组，顺序稳定 */
function pick(n) {
  return all().slice(0, n || 4)
}

module.exports = {
  groups: groups,
  all: all,
  get: get,
  pick: pick,
  BLOCKED_ID: 'medbox'
}
