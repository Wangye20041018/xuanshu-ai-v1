/**
 * 玄枢AI — 常识规则库 (250+ 条)
 * 
 * 覆盖: WPS/微信/浏览器/Windows系统/动画设置/会员弹窗/常见应用
 * 
 * 每条规则: { id, domain, trigger, action, fallback?, description }
 */

export interface KnowledgeRule {
  id: string
  domain: string
  trigger: string[]    // 触发关键词
  action: string       // 建议操作
  fallback?: string    // 回退操作
  description: string
  priority: number     // 1-10, 10最高
}

export const RULES: KnowledgeRule[] = [
  // ==================== WPS Office ====================
  { id: 'wps-1', domain: 'wps', trigger: ['会员','开通','vip','付费'], action: '点击"暂不"或"×"关闭弹窗', fallback: '按Esc键', description: 'WPS会员弹窗处理', priority: 8 },
  { id: 'wps-2', domain: 'wps', trigger: ['新建','文档','doc'], action: '点击"新建"→选择"空白文档"', description: '新建WPS文档', priority: 6 },
  { id: 'wps-3', domain: 'wps', trigger: ['新建','演示','PPT','幻灯片'], action: '点击"新建"→选择"新建演示"', description: '新建PPT演示', priority: 6 },
  { id: 'wps-4', domain: 'wps', trigger: ['新建','表格','excel','xls'], action: '点击"新建"→选择"新建表格"', description: '新建WPS表格', priority: 6 },
  { id: 'wps-5', domain: 'wps', trigger: ['保存','ctrl+s'], action: '点击左上角"保存"按钮或Ctrl+S', description: '保存文档', priority: 5 },
  { id: 'wps-6', domain: 'wps', trigger: ['另存为','导出','pdf'], action: '点击"文件"→"另存为"→选择格式', description: '导出为PDF', priority: 5 },
  { id: 'wps-7', domain: 'wps', trigger: ['字体','字号','文字'], action: '在"开始"选项卡选择字体和字号', description: '设置文字格式', priority: 4 },
  { id: 'wps-8', domain: 'wps', trigger: ['动画','飞入','淡入','强调'], action: '选中对象→点击"动画"选项卡→选择动画效果', fallback: '点击"动画窗格"添加效果', description: '添加PPT动画', priority: 7 },
  { id: 'wps-9', domain: 'wps', trigger: ['切换','翻页'], action: '点击"切换"选项卡→选择切换效果', description: '设置页面切换效果', priority: 5 },
  { id: 'wps-10', domain: 'wps', trigger: ['插入','图片','形状','图表','表格'], action: '点击"插入"选项卡→选择要插入的内容', description: '插入元素', priority: 5 },
  { id: 'wps-11', domain: 'wps', trigger: ['新建','幻灯片','空白页'], action: '点击"开始"→"新建幻灯片"或Ctrl+M', description: '新建空白幻灯片', priority: 5 },
  { id: 'wps-12', domain: 'wps', trigger: ['模板','主题','设计'], action: '点击"设计"选项卡→选择主题模板', fallback: '使用默认主题', description: '应用设计模板', priority: 4 },
  { id: 'wps-13', domain: 'wps', trigger: ['页眉','页脚','页码'], action: '点击"插入"→"页眉和页脚"', description: '添加页眉页脚', priority: 4 },
  { id: 'wps-14', domain: 'wps', trigger: ['撤销','撤回'], action: 'Ctrl+Z 撤销上一步', description: '撤销操作', priority: 3 },
  { id: 'wps-15', domain: 'wps', trigger: ['批注','评论'], action: '选中内容→点击"审阅"→"新建批注"', description: '添加批注', priority: 3 },
  { id: 'wps-16', domain: 'wps', trigger: ['查找','搜索','替换'], action: 'Ctrl+F 打开查找面板', description: '查找替换', priority: 3 },
  { id: 'wps-17', domain: 'wps', trigger: ['打印'], action: 'Ctrl+P 打开打印设置', description: '打印文档', priority: 3 },
  { id: 'wps-18', domain: 'wps', trigger: ['关闭','退出'], action: '点击右上角×或Alt+F4', fallback: '先保存再关闭', description: '关闭WPS', priority: 4 },
  { id: 'wps-19', domain: 'wps', trigger: ['公式','数学','符号'], action: '点击"插入"→"公式"→选择公式模板', description: '插入数学公式', priority: 5 },
  { id: 'wps-20', domain: 'wps', trigger: ['图表','柱状图','折线图','饼图'], action: '点击"插入"→"图表"→选择图表类型', description: '插入数据图表', priority: 5 },
  { id: 'wps-21', domain: 'wps', trigger: ['文本框'], action: '点击"插入"→"文本框"→在画布上拖动', description: '插入文本框', priority: 4 },
  { id: 'wps-22', domain: 'wps', trigger: ['艺术字'], action: '点击"插入"→"艺术字"→选择样式', description: '插入艺术字', priority: 4 },
  { id: 'wps-23', domain: 'wps', trigger: ['页边距','纸张','布局'], action: '点击"页面布局"→"页边距"或"纸张大小"', description: '调整页面布局', priority: 4 },
  { id: 'wps-24', domain: 'wps', trigger: ['分栏','多栏'], action: '点击"页面布局"→"分栏"→选择栏数', description: '设置分栏排版', priority: 4 },
  { id: 'wps-25', domain: 'wps', trigger: ['水印'], action: '点击"插入"→"水印"→选择样式', description: '添加水印', priority: 3 },
  { id: 'wps-26', domain: 'wps', trigger: ['目录','自动目录'], action: '点击"引用"→"目录"→选择自动目录样式', description: '插入自动目录', priority: 5 },
  { id: 'wps-27', domain: 'wps', trigger: ['脚注','尾注'], action: '点击"引用"→"插入脚注"或"插入尾注"', description: '添加脚注尾注', priority: 3 },
  { id: 'wps-28', domain: 'wps', trigger: ['合并','邮件合并'], action: '点击"引用"→"邮件合并"→按向导操作', description: '邮件合并', priority: 4 },
  { id: 'wps-29', domain: 'wps', trigger: ['加密','密码','保护'], action: '点击"文件"→"文档加密"→设置密码', description: '文档加密保护', priority: 5 },
  { id: 'wps-30', domain: 'wps', trigger: ['拼写','语法','检查'], action: 'F7 或点击"审阅"→"拼写检查"', description: '拼写语法检查', priority: 3 },
  { id: 'wps-31', domain: 'wps', trigger: ['字数','统计'], action: '点击"审阅"→"字数统计"', description: '查看字数统计', priority: 2 },
  { id: 'wps-32', domain: 'wps', trigger: ['修订','更改','痕迹'], action: '点击"审阅"→"修订"开启记录修改', description: '开启修订模式', priority: 4 },
  { id: 'wps-33', domain: 'wps', trigger: ['超链接','链接'], action: '选中文字→右键→"超链接"或Ctrl+K', description: '添加超链接', priority: 3 },
  { id: 'wps-34', domain: 'wps', trigger: ['表格','合并单元格','拆分'], action: '选中表格→"表格工具"→"合并"或"拆分"', description: '合并拆分表格单元格', priority: 4 },
  { id: 'wps-35', domain: 'wps', trigger: ['排序','筛选'], action: '选中数据→"数据"→"排序"或"筛选"', description: '数据排序筛选', priority: 4 },
  { id: 'wps-36', domain: 'wps', trigger: ['数据透视表'], action: '选中数据→"数据"→"数据透视表"→选择区域', description: '创建数据透视表', priority: 5 },
  { id: 'wps-37', domain: 'wps', trigger: ['条件格式'], action: '选中数据→"开始"→"条件格式"→选择规则', description: '设置条件格式', priority: 4 },
  { id: 'wps-38', domain: 'wps', trigger: ['冻结','冻结窗格'], action: '点击"视图"→"冻结窗格"→选择冻结方式', description: '冻结表格行/列', priority: 4 },
  { id: 'wps-39', domain: 'wps', trigger: ['幻灯片母版','母版'], action: '点击"视图"→"幻灯片母版"进行全局编辑', description: '编辑幻灯片母版', priority: 4 },
  { id: 'wps-40', domain: 'wps', trigger: ['排练计时'], action: '点击"幻灯片放映"→"排练计时"', description: '排练演示计时', priority: 3 },
  { id: 'wps-41', domain: 'wps', trigger: ['演讲者备注','备注'], action: '在幻灯片底部备注区域点击输入', description: '添加演讲者备注', priority: 3 },
  { id: 'wps-42', domain: 'wps', trigger: ['导出','图片','png','jpg'], action: '右键幻灯片→"另存为图片"或文件→导出→选择图片格式', description: '将幻灯片导出为图片', priority: 4 },
  { id: 'wps-43', domain: 'wps', trigger: ['合并文档','对比'], action: '点击"审阅"→"比较"→选择要合并的文档', description: '合并或比较文档', priority: 4 },
  { id: 'wps-44', domain: 'wps', trigger: ['宏','vba'], action: '点击"开发工具"→"宏"→选择或录制', description: '录制或运行宏', priority: 3 },
  { id: 'wps-45', domain: 'wps', trigger: ['恢复','未保存'], action: '点击"文件"→"备份管理"→查看历史版本', description: '恢复未保存的文档', priority: 5 },
  
  // ==================== 微信 (WeChat) ====================
  { id: 'wx-1', domain: 'wechat', trigger: ['微信','wechat'], action: '双击桌面微信图标或从任务栏打开', description: '打开微信', priority: 7 },
  { id: 'wx-2', domain: 'wechat', trigger: ['发送','消息','文件','图片'], action: '在输入框Ctrl+V粘贴后按Ctrl+Enter发送', description: '发送消息或文件', priority: 7 },
  { id: 'wx-3', domain: 'wechat', trigger: ['搜索','查找'], action: 'Ctrl+F打开搜索框', description: '搜索联系人/聊天记录', priority: 5 },
  { id: 'wx-4', domain: 'wechat', trigger: ['联系人','好友'], action: 'Ctrl+F输入名称→点击搜索结果', description: '查找联系人', priority: 6 },
  { id: 'wx-5', domain: 'wechat', trigger: ['文件传输助手','自己'], action: 'Ctrl+F搜索"文件传输助手"→点击', description: '找到文件传输助手', priority: 6 },
  { id: 'wx-6', domain: 'wechat', trigger: ['截图','截屏'], action: 'Alt+A 唤出微信截图', description: '微信截图', priority: 4 },
  { id: 'wx-7', domain: 'wechat', trigger: ['表情','emoji'], action: '点击输入框表情图标选择', description: '发送表情', priority: 3 },
  { id: 'wx-8', domain: 'wechat', trigger: ['语音','视频','通话'], action: '点击聊天窗口右上角电话/视频图标', description: '发起语音视频通话', priority: 4 },
  { id: 'wx-9', domain: 'wechat', trigger: ['发文件','传文件','发送文档'], action: '点击"发送文件"按钮→选择文件→点击发送', fallback: '拖动文件到聊天窗口', description: '发送文件到微信', priority: 7 },
  { id: 'wx-10', domain: 'wechat', trigger: ['收藏'], action: '右键消息→"收藏"', description: '收藏消息', priority: 3 },
  { id: 'wx-11', domain: 'wechat', trigger: ['朋友圈'], action: '点击左侧"朋友圈"图标', description: '打开朋友圈', priority: 4 },
  { id: 'wx-12', domain: 'wechat', trigger: ['小程序'], action: '点击底部"发现"→"小程序"', description: '打开小程序', priority: 3 },
  { id: 'wx-13', domain: 'wechat', trigger: ['视频号'], action: '点击底部"发现"→"视频号"', description: '打开视频号', priority: 3 },
  { id: 'wx-14', domain: 'wechat', trigger: ['看一看'], action: '点击底部"发现"→"看一看"', description: '打开看一看', priority: 3 },
  { id: 'wx-15', domain: 'wechat', trigger: ['扫一扫'], action: '点击底部"发现"→"扫一扫"', description: '打开扫一扫', priority: 3 },
  { id: 'wx-16', domain: 'wechat', trigger: ['摇一摇'], action: '点击底部"发现"→"摇一摇"', description: '打开摇一摇', priority: 2 },
  { id: 'wx-17', domain: 'wechat', trigger: ['附近的人'], action: '点击底部"发现"→"附近"', description: '查看附近的人', priority: 2 },
  { id: 'wx-18', domain: 'wechat', trigger: ['红包','发红包'], action: '点击聊天输入框旁"+"→"红包"→设置金额→发送', description: '发送微信红包', priority: 5 },
  { id: 'wx-19', domain: 'wechat', trigger: ['转账'], action: '点击聊天输入框旁"+"→"转账"→输入金额', description: '微信转账', priority: 5 },
  { id: 'wx-20', domain: 'wechat', trigger: ['群聊','建群','创建群'], action: '点击"+"→"发起群聊"→选择联系人', description: '创建群聊', priority: 4 },
  { id: 'wx-21', domain: 'wechat', trigger: ['@所有人','@all'], action: '在输入框输入@后选择"所有人"', description: '@所有人', priority: 3 },
  { id: 'wx-22', domain: 'wechat', trigger: ['引用','回复'], action: '右键消息→"引用"→输入回复内容', description: '引用回复消息', priority: 3 },
  { id: 'wx-23', domain: 'wechat', trigger: ['多选','转发'], action: '右键消息→"多选"→勾选多条→点击转发图标', description: '多选转发消息', priority: 3 },
  { id: 'wx-24', domain: 'wechat', trigger: ['清空','删除聊天'], action: '右键会话→"清空聊天记录"或"删除会话"', description: '清空或删除聊天', priority: 3 },
  { id: 'wx-25', domain: 'wechat', trigger: ['置顶'], action: '右键会话→"置顶"', description: '置顶聊天', priority: 2 },
  { id: 'wx-26', domain: 'wechat', trigger: ['免打扰','静音'], action: '右键会话→"消息免打扰"', description: '设置消息免打扰', priority: 2 },
  { id: 'wx-27', domain: 'wechat', trigger: ['支付','钱包'], action: '点击底部"我"→"支付"或"服务"', description: '打开微信支付', priority: 4 },
  { id: 'wx-28', domain: 'wechat', trigger: ['我的','个人','设置'], action: '点击底部"我"→"设置"', description: '进入个人设置', priority: 4 },
  { id: 'wx-29', domain: 'wechat', trigger: ['换行'], action: 'Shift+Enter 换行，Enter发送', description: '微信内换行输入', priority: 2 },
  
  // ==================== 浏览器 (Chrome/Edge) ====================
  { id: 'browser-1', domain: 'browser', trigger: ['打开','浏览器','chrome','edge'], action: '双击桌面浏览器图标或从任务栏打开', description: '打开浏览器', priority: 7 },
  { id: 'browser-2', domain: 'browser', trigger: ['网址','url','地址'], action: 'Ctrl+L 聚焦地址栏→输入网址→Enter', description: '输入网址', priority: 7 },
  { id: 'browser-3', domain: 'browser', trigger: ['搜索','百度','谷歌','搜索'], action: 'Ctrl+L或点击地址栏→输入关键词→Enter', description: '搜索引擎搜索', priority: 6 },
  { id: 'browser-4', domain: 'browser', trigger: ['下载','保存文件'], action: '点击下载链接→等待弹出保存对话框→选择位置→确定', fallback: '右键→"另存为"', description: '下载文件', priority: 7 },
  { id: 'browser-5', domain: 'browser', trigger: ['新标签','新建标签页'], action: 'Ctrl+T 新建标签页', description: '新建标签页', priority: 4 },
  { id: 'browser-6', domain: 'browser', trigger: ['关闭标签','关掉'], action: 'Ctrl+W 关闭当前标签', description: '关闭标签页', priority: 4 },
  { id: 'browser-7', domain: 'browser', trigger: ['前进','后退','返回'], action: 'Alt+← 后退, Alt+→ 前进', description: '页面导航', priority: 3 },
  { id: 'browser-8', domain: 'browser', trigger: ['刷新','重新加载'], action: 'F5 或 Ctrl+R 刷新页面', description: '刷新页面', priority: 3 },
  { id: 'browser-9', domain: 'browser', trigger: ['书签','收藏'], action: 'Ctrl+D 添加书签', description: '收藏网页', priority: 3 },
  { id: 'browser-10', domain: 'browser', trigger: ['历史记录','历史'], action: 'Ctrl+H 打开历史记录', description: '查看浏览历史', priority: 3 },
  { id: 'browser-11', domain: 'browser', trigger: ['打印','打印页面'], action: 'Ctrl+P 打印当前页', description: '打印网页', priority: 3 },
  { id: 'browser-12', domain: 'browser', trigger: ['全屏'], action: 'F11 切换全屏', description: '全屏浏览', priority: 2 },
  { id: 'browser-13', domain: 'browser', trigger: ['开发者','f12'], action: 'F12 打开开发者工具', description: '开发者工具', priority: 2 },
  { id: 'browser-14', domain: 'browser', trigger: ['无痕','隐私'], action: 'Ctrl+Shift+N 打开无痕窗口', description: '无痕模式', priority: 2 },
  { id: 'browser-15', domain: 'browser', trigger: ['放大','缩小','缩放'], action: 'Ctrl++放大 Ctrl+-缩小 Ctrl+0重置', description: '页面缩放', priority: 3 },
  { id: 'browser-16', domain: 'browser', trigger: ['查找','页面查找'], action: 'Ctrl+F 打开页面查找栏', description: '在当前页查找文字', priority: 3 },
  { id: 'browser-17', domain: 'browser', trigger: ['下载','下载内容','下载管理'], action: 'Ctrl+J 打开下载管理页面', description: '查看下载内容', priority: 3 },
  { id: 'browser-18', domain: 'browser', trigger: ['扩展','插件','拓展'], action: '点击右上角拼图图标管理扩展', description: '管理浏览器扩展', priority: 2 },
  { id: 'browser-19', domain: 'browser', trigger: ['清除','缓存','历史记录清除'], action: 'Ctrl+Shift+Del 打开清除浏览数据', description: '清除浏览数据', priority: 3 },
  { id: 'browser-20', domain: 'browser', trigger: ['截图','网页截图'], action: 'F12→Ctrl+Shift+P→输入"screenshot"', fallback: '使用扩展或系统截图', description: '浏览器截图', priority: 3 },
  { id: 'browser-21', domain: 'browser', trigger: ['静音','标签静音'], action: '右键标签→"静音标签"', description: '静音浏览器标签', priority: 2 },
  { id: 'browser-22', domain: 'browser', trigger: ['翻译','翻译页面'], action: '右键→"翻译成中文"或点击地址栏翻译图标', description: '翻译网页', priority: 3 },
  { id: 'browser-23', domain: 'browser', trigger: ['恢复标签','恢复关闭'], action: 'Ctrl+Shift+T 恢复上次关闭的标签', description: '恢复关闭的标签页', priority: 3 },
  { id: 'browser-24', domain: 'browser', trigger: ['定位','地址栏'], action: 'Ctrl+L 或 F6 或 Alt+D 聚焦地址栏', description: '快速定位到地址栏', priority: 4 },
  
  // ==================== Windows 系统操作 ====================
  { id: 'sys-1', domain: 'system', trigger: ['桌面','返回桌面'], action: 'Win+D 显示桌面', description: '显示桌面', priority: 6 },
  { id: 'sys-2', domain: 'system', trigger: ['任务管理器'], action: 'Ctrl+Shift+Esc 打开任务管理器', description: '打开任务管理器', priority: 5 },
  { id: 'sys-3', domain: 'system', trigger: ['运行','cmd','命令'], action: 'Win+R 打开运行→输入命令', description: '打开运行对话框', priority: 5 },
  { id: 'sys-4', domain: 'system', trigger: ['文件','资源管理器','我的电脑'], action: 'Win+E 打开文件资源管理器', description: '打开文件资源管理器', priority: 6 },
  { id: 'sys-5', domain: 'system', trigger: ['设置','配置'], action: 'Win+I 打开设置', description: '打开系统设置', priority: 5 },
  { id: 'sys-6', domain: 'system', trigger: ['搜索','查找文件'], action: 'Win+S 或 Win+Q 打开搜索', description: 'Windows搜索', priority: 4 },
  { id: 'sys-7', domain: 'system', trigger: ['截图','截屏','snipping'], action: 'Win+Shift+S 打开截图工具', fallback: 'PrtScn键', description: '系统截图', priority: 4 },
  { id: 'sys-8', domain: 'system', trigger: ['锁定','锁屏'], action: 'Win+L 锁定电脑', description: '锁定电脑', priority: 3 },
  { id: 'sys-9', domain: 'system', trigger: ['关机','关电脑'], action: 'Win+X→U→U 关机', description: '关机', priority: 5 },
  { id: 'sys-10', domain: 'system', trigger: ['重启'], action: 'Win+X→U→R 重启', description: '重启电脑', priority: 5 },
  { id: 'sys-11', domain: 'system', trigger: ['睡眠','休眠'], action: 'Win+X→U→S 睡眠', description: '进入睡眠', priority: 3 },
  { id: 'sys-12', domain: 'system', trigger: ['任务栏'], action: '鼠标移到屏幕底部', description: '操作任务栏', priority: 4 },
  { id: 'sys-13', domain: 'system', trigger: ['开始菜单','开始'], action: 'Win 键打开开始菜单', description: '打开开始菜单', priority: 4 },
  { id: 'sys-14', domain: 'system', trigger: ['最小化'], action: '点击窗口右上角"—"按钮或Win+↓', description: '最小化窗口', priority: 3 },
  { id: 'sys-15', domain: 'system', trigger: ['最大化','全屏'], action: '点击窗口右上角"□"按钮或Win+↑', description: '最大化窗口', priority: 3 },
  { id: 'sys-16', domain: 'system', trigger: ['切换窗口','alt+tab'], action: 'Alt+Tab 切换窗口', description: '切换窗口', priority: 4 },
  { id: 'sys-17', domain: 'system', trigger: ['虚拟桌面','新建桌面'], action: 'Win+Ctrl+D 新建虚拟桌面', fallback: 'Win+Tab→新建桌面', description: '创建虚拟桌面', priority: 3 },
  { id: 'sys-18', domain: 'system', trigger: ['控制面板'], action: 'Win+R→输入"control"→Enter', description: '打开控制面板', priority: 3 },
  { id: 'sys-19', domain: 'system', trigger: ['卸载','删除程序'], action: 'Win+I→应用→已安装的应用', fallback: '控制面板→卸载程序', description: '卸载软件', priority: 4 },
  { id: 'sys-20', domain: 'system', trigger: ['网络','wifi','连接'], action: '点击右下角网络图标→选择网络→连接', description: '连接WiFi', priority: 4 },
  { id: 'sys-21', domain: 'system', trigger: ['蓝牙'], action: 'Win+I→蓝牙和其他设备→开启蓝牙', description: '打开蓝牙设置', priority: 3 },
  { id: 'sys-22', domain: 'system', trigger: ['投影','投屏','第二屏幕'], action: 'Win+P 选择投影方式', description: '投影/扩展屏幕', priority: 3 },
  { id: 'sys-23', domain: 'system', trigger: ['剪贴板','粘贴历史'], action: 'Win+V 查看剪贴板历史', description: '剪贴板历史', priority: 3 },
  { id: 'sys-24', domain: 'system', trigger: ['屏幕键盘','触摸键盘'], action: '右键任务栏→"显示触摸键盘按钮"', description: '打开屏幕键盘', priority: 2 },
  { id: 'sys-25', domain: 'system', trigger: ['放大镜','放大器'], action: 'Win++ 打开放大镜', description: '打开放大镜', priority: 2 },
  { id: 'sys-26', domain: 'system', trigger: ['讲述人','语音'], action: 'Win+Ctrl+Enter 打开讲述人', description: '打开讲述人', priority: 2 },
  { id: 'sys-27', domain: 'system', trigger: ['日期','时间','日历'], action: '点击右下角时间日期区域', description: '查看日期时间', priority: 2 },
  { id: 'sys-28', domain: 'system', trigger: ['音量','声音','静音'], action: '点击右下角扬声器图标调节', description: '调节音量', priority: 3 },
  { id: 'sys-29', domain: 'system', trigger: ['通知','操作中心'], action: 'Win+A 打开操作中心', description: '查看通知', priority: 3 },
  { id: 'sys-30', domain: 'system', trigger: ['计算器'], action: 'Win+R→输入"calc"→Enter', description: '打开计算器', priority: 3 },
  { id: 'sys-31', domain: 'system', trigger: ['记事本','notepad'], action: 'Win+R→输入"notepad"→Enter', description: '打开记事本', priority: 3 },
  { id: 'sys-32', domain: 'system', trigger: ['画图','mspaint'], action: 'Win+R→输入"mspaint"→Enter', description: '打开画图', priority: 3 },
  { id: 'sys-33', domain: 'system', trigger: ['命令提示符','cmd','终端'], action: 'Win+R→输入"cmd"→Enter', description: '打开命令提示符', priority: 4 },
  { id: 'sys-34', domain: 'system', trigger: ['powershell'], action: '右键开始→"Windows PowerShell"', description: '打开PowerShell', priority: 3 },
  { id: 'sys-35', domain: 'system', trigger: ['设备管理器'], action: 'Win+R→输入"devmgmt.msc"→Enter', description: '打开设备管理器', priority: 3 },
  { id: 'sys-36', domain: 'system', trigger: ['磁盘管理'], action: 'Win+R→输入"diskmgmt.msc"→Enter', description: '打开磁盘管理', priority: 3 },
  { id: 'sys-37', domain: 'system', trigger: ['服务','services'], action: 'Win+R→输入"services.msc"→Enter', description: '打开服务管理', priority: 3 },
  { id: 'sys-38', domain: 'system', trigger: ['组策略','gpedit'], action: 'Win+R→输入"gpedit.msc"→Enter', description: '打开本地组策略编辑器', priority: 2 },
  { id: 'sys-39', domain: 'system', trigger: ['注册表','regedit'], action: 'Win+R→输入"regedit"→Enter', description: '打开注册表编辑器', priority: 2 },
  { id: 'sys-40', domain: 'system', trigger: ['系统信息','msinfo'], action: 'Win+R→输入"msinfo32"→Enter', description: '查看系统信息', priority: 2 },
  { id: 'sys-41', domain: 'system', trigger: ['任务计划','计划任务'], action: 'Win+R→输入"taskschd.msc"→Enter', description: '打开任务计划程序', priority: 2 },
  { id: 'sys-42', domain: 'system', trigger: ['截图工具'], action: 'Win+Shift+S 或搜索"截图工具"', description: '打开截图工具', priority: 3 },
  { id: 'sys-43', domain: 'system', trigger: ['录音机','录音'], action: '搜索"录音机"或Win+R→"soundrecorder"', description: '打开录音机', priority: 2 },
  { id: 'sys-44', domain: 'system', trigger: ['步骤记录器'], action: 'Win+R→输入"psr"→Enter', description: '打开步骤记录器', priority: 2 },
  { id: 'sys-45', domain: 'system', trigger: ['远程桌面','mstsc'], action: 'Win+R→输入"mstsc"→Enter', description: '打开远程桌面连接', priority: 3 },
  { id: 'sys-46', domain: 'system', trigger: ['hosts','host文件'], action: '以管理员身份打开记事本→文件→打开→C:\Windows\System32\drivers\etc\hosts', description: '编辑hosts文件', priority: 3 },
  { id: 'sys-47', domain: 'system', trigger: ['环境变量','path'], action: 'Win+I→系统→关于→高级系统设置→环境变量', description: '编辑系统环境变量', priority: 4 },
  
  // ==================== 动画设置 ====================
  { id: 'anim-1', domain: 'animation', trigger: ['飞入','fly in'], action: '选中对象→动画→选择"飞入"效果→设置持续0.5-1秒', description: '添加飞入动画', priority: 7 },
  { id: 'anim-2', domain: 'animation', trigger: ['淡入','fade in'], action: '选中对象→动画→选择"淡入"效果', description: '添加淡入动画', priority: 6 },
  { id: 'anim-3', domain: 'animation', trigger: ['强调','放大','缩小'], action: '选中对象→动画→"强调"分类下选择效果', description: '添加强调动画', priority: 5 },
  { id: 'anim-4', domain: 'animation', trigger: ['擦除','擦出'], action: '选中对象→动画→选择"擦除"效果', description: '添加擦除动画', priority: 5 },
  { id: 'anim-5', domain: 'animation', trigger: ['路径','自定义路径'], action: '选中对象→动画→"动作路径"→"自定义路径"', description: '添加路径动画', priority: 4 },
  { id: 'anim-6', domain: 'animation', trigger: ['计时','时长','速度'], action: '在动画窗格中双击动画→设置"计时"参数', description: '调整动画速度', priority: 4 },
  { id: 'anim-7', domain: 'animation', trigger: ['顺序','排序'], action: '打开"动画窗格"→拖动调整顺序', description: '调整动画顺序', priority: 4 },
  { id: 'anim-8', domain: 'animation', trigger: ['触发','点击触发'], action: '选中动画→"触发"→"单击开始时"', description: '设置点击触发', priority: 4 },
  { id: 'anim-9', domain: 'animation', trigger: ['退出动画','消失'], action: '选中对象→添加动画→"退出"分类', description: '添加退出动画', priority: 4 },
  { id: 'anim-10', domain: 'animation', trigger: ['组合动画','多重'], action: '逐个添加多个动画到同一对象→调整顺序', description: '组合多个动画', priority: 3 },
  { id: 'anim-11', domain: 'animation', trigger: ['弹跳','bounce'], action: '选中对象→动画→"弹跳"效果', description: '添加弹跳动画', priority: 3 },
  { id: 'anim-12', domain: 'animation', trigger: ['旋转','spin'], action: '选中对象→动画→"旋转"效果', description: '添加旋转动画', priority: 3 },
  { id: 'anim-13', domain: 'animation', trigger: ['缩放','zoom'], action: '选中对象→动画→"缩放"效果', description: '添加缩放动画', priority: 3 },
  { id: 'anim-14', domain: 'animation', trigger: ['闪烁'], action: '选中对象→动画→"闪烁"效果', description: '添加闪烁动画', priority: 2 },
  { id: 'anim-15', domain: 'animation', trigger: ['波浪'], action: '选中对象→动画→"波浪"效果', description: '添加波浪动画', priority: 2 },
  { id: 'anim-16', domain: 'animation', trigger: ['与上一动画同时'], action: '选中动画→计时→开始→"与上一动画同时"', description: '设置动画同时播放', priority: 4 },
  { id: 'anim-17', domain: 'animation', trigger: ['上一动画之后'], action: '选中动画→计时→开始→"上一动画之后"', description: '设置动画依次播放', priority: 4 },
  { id: 'anim-18', domain: 'animation', trigger: ['动画复制','动画刷'], action: '选中带动画的对象→点击"动画刷"→点击目标对象', description: '使用动画刷复制动画', priority: 4 },
  { id: 'anim-19', domain: 'animation', trigger: ['延迟'], action: '在动画窗格中设置"延迟"时间（秒）', description: '设置动画延迟', priority: 3 },
  { id: 'anim-20', domain: 'animation', trigger: ['重复','循环'], action: '动画计时→重复→选择次数或"直到幻灯片末尾"', description: '设置动画重复', priority: 3 },
  
  // ==================== 会员/付费弹窗处理 ====================
  { id: 'pay-1', domain: 'payment', trigger: ['会员','开通','vip','svip'], action: '寻找"暂不"、"关闭"、"×"按钮点击', fallback: '按Esc键→继续免费使用', description: 'WPS会员弹窗', priority: 9 },
  { id: 'pay-2', domain: 'payment', trigger: ['试用到','体验','试用'], action: '优先点击"继续试用"或"稍后"', fallback: '关闭弹窗,使用基础功能替代', description: '试用弹窗处理', priority: 8 },
  { id: 'pay-3', domain: 'payment', trigger: ['广告','推广','广告弹窗'], action: '点击"×"或"跳过"关闭广告', fallback: '延迟5秒→广告自动关闭', description: '关闭广告弹窗', priority: 7 },
  { id: 'pay-4', domain: 'payment', trigger: ['升级','付费','购买'], action: '点击"暂不升级"或"稍后提醒"', fallback: '即使关闭,告知用户有免费替代', description: '升级提示弹窗', priority: 8 },
  { id: 'pay-5', domain: 'payment', trigger: ['限免','限时','优惠'], action: '关闭弹窗,不影响正常使用', description: '限时优惠弹窗', priority: 6 },
  { id: 'pay-6', domain: 'payment', trigger: ['续费','到期'], action: '关闭弹窗→继续使用当前版本', description: '续费提醒弹窗', priority: 6 },
  { id: 'pay-7', domain: 'payment', trigger: ['注册','登录','账号'], action: '如果不需要注册就关闭,需要则用默认信息', description: '注册登录弹窗', priority: 6 },
  { id: 'pay-8', domain: 'payment', trigger: ['权限','授权','允许'], action: '点击"允许"或"是"继续操作', description: '权限请求弹窗', priority: 5 },
  { id: 'pay-9', domain: 'payment', trigger: ['错误','失败','出错'], action: '点击"重试"或"确定"后重新操作', description: '错误提示弹窗', priority: 6 },
  { id: 'pay-10', domain: 'payment', trigger: ['更新','升级版本','新版本'], action: '点击"稍后提醒"或"忽略此版本"', fallback: '关闭弹窗即可', description: '软件更新提示', priority: 5 },
  { id: 'pay-11', domain: 'payment', trigger: ['推荐','猜你喜欢','为你推荐'], action: '点击×关闭推荐弹窗', description: '关闭推荐弹窗', priority: 4 },
  { id: 'pay-12', domain: 'payment', trigger: ['评分','评价','反馈'], action: '点击"以后再说"或直接关闭', description: '评分反馈弹窗', priority: 4 },
  { id: 'pay-13', domain: 'payment', trigger: ['问卷','调查'], action: '点击×关闭问卷弹窗', description: '关闭问卷调查', priority: 3 },
  { id: 'pay-14', domain: 'payment', trigger: ['安全警告','安全提示'], action: '确认来源安全→点击"确定"或"运行"', description: '安全警告弹窗', priority: 6 },
  { id: 'pay-15', domain: 'payment', trigger: ['防火墙','网络访问'], action: '点击"允许访问"', description: '防火墙提示弹窗', priority: 5 },
  
  // ==================== VSCode ====================
  { id: 'vscode-1', domain: 'vscode', trigger: ['vscode','vs code','编辑器'], action: '搜索"Visual Studio Code"或从开始菜单打开', description: '打开VSCode', priority: 6 },
  { id: 'vscode-2', domain: 'vscode', trigger: ['打开文件','打开文件夹'], action: 'Ctrl+O 打开文件 / Ctrl+K Ctrl+O 打开文件夹', description: '在VSCode中打开文件', priority: 5 },
  { id: 'vscode-3', domain: 'vscode', trigger: ['搜索文件','快速打开'], action: 'Ctrl+P 输入文件名快速打开', description: '快速打开文件', priority: 5 },
  { id: 'vscode-4', domain: 'vscode', trigger: ['命令面板','命令'], action: 'F1 或 Ctrl+Shift+P 打开命令面板', description: '打开命令面板', priority: 5 },
  { id: 'vscode-5', domain: 'vscode', trigger: ['终端','terminal'], action: 'Ctrl+` 打开集成终端', description: '打开VSCode终端', priority: 4 },
  { id: 'vscode-6', domain: 'vscode', trigger: ['侧边栏','资源管理器'], action: 'Ctrl+B 切换侧边栏', description: '显示/隐藏侧边栏', priority: 3 },
  { id: 'vscode-7', domain: 'vscode', trigger: ['搜索','全局搜索'], action: 'Ctrl+Shift+F 全局搜索', description: '全局搜索', priority: 4 },
  { id: 'vscode-8', domain: 'vscode', trigger: ['替换','全局替换'], action: 'Ctrl+Shift+H 全局搜索替换', description: '全局替换', priority: 3 },
  { id: 'vscode-9', domain: 'vscode', trigger: ['git','提交','推送'], action: '点击左侧源代码管理图标→输入提交信息→Ctrl+Enter提交', description: 'Git操作', priority: 5 },
  { id: 'vscode-10', domain: 'vscode', trigger: ['断点','调试','debug'], action: 'F5 开始调试 / F9 设置断点', description: '调试代码', priority: 5 },
  { id: 'vscode-11', domain: 'vscode', trigger: ['扩展','插件','拓展'], action: 'Ctrl+Shift+X 打开扩展面板', description: '管理扩展', priority: 4 },
  { id: 'vscode-12', domain: 'vscode', trigger: ['设置','配置'], action: 'Ctrl+, 打开设置', description: '打开VSCode设置', priority: 4 },
  { id: 'vscode-13', domain: 'vscode', trigger: ['函数','定义','跳转'], action: 'F12 跳转到定义 / Alt+F12 预览定义', description: '跳转到函数定义', priority: 4 },
  { id: 'vscode-14', domain: 'vscode', trigger: ['重命名','重构'], action: 'F2 重命名符号', description: '重命名变量/函数', priority: 4 },
  { id: 'vscode-15', domain: 'vscode', trigger: ['注释','取消注释'], action: 'Ctrl+/ 单行注释 / Shift+Alt+A 块注释', description: '添加/取消注释', priority: 3 },
  { id: 'vscode-16', domain: 'vscode', trigger: ['格式化','美化'], action: 'Shift+Alt+F 格式化文档', description: '格式化代码', priority: 3 },
  { id: 'vscode-17', domain: 'vscode', trigger: ['多光标','多处编辑'], action: 'Alt+Click 添加光标 / Ctrl+Alt+↑/↓ 上下添加', description: '多光标编辑', priority: 3 },
  { id: 'vscode-18', domain: 'vscode', trigger: ['折叠','展开'], action: 'Ctrl+Shift+[ 折叠 / Ctrl+Shift+] 展开', description: '折叠展开代码块', priority: 2 },
  { id: 'vscode-19', domain: 'vscode', trigger: ['分割','分屏'], action: 'Ctrl+\ 分割编辑器 / Ctrl+1/2/3 切换', description: '分屏编辑', priority: 3 },
  { id: 'vscode-20', domain: 'vscode', trigger: ['关闭编辑器'], action: 'Ctrl+W 关闭当前编辑器标签', description: '关闭编辑器', priority: 3 },
  
  // ==================== QQ ====================
  { id: 'qq-1', domain: 'qq', trigger: ['qq','qq聊天'], action: '双击桌面QQ图标或从任务栏打开', description: '打开QQ', priority: 6 },
  { id: 'qq-2', domain: 'qq', trigger: ['发送','消息'], action: '在输入框输入后Ctrl+Enter发送', description: '发送QQ消息', priority: 6 },
  { id: 'qq-3', domain: 'qq', trigger: ['截图'], action: 'Ctrl+Alt+A 打开QQ截图', description: 'QQ截图', priority: 4 },
  { id: 'qq-4', domain: 'qq', trigger: ['文件','发送文件'], action: '点击"发送文件"图标→选择文件→发送', fallback: '拖动文件到聊天窗口', description: 'QQ发送文件', priority: 5 },
  { id: 'qq-5', domain: 'qq', trigger: ['语音','视频','通话'], action: '点击聊天窗口上方电话/摄像头图标', description: '发起QQ语音视频通话', priority: 4 },
  { id: 'qq-6', domain: 'qq', trigger: ['远程','远程协助','远程桌面'], action: '点击聊天窗口"+"→"远程协助"', description: 'QQ远程协助', priority: 4 },
  { id: 'qq-7', domain: 'qq', trigger: ['空间','qzone'], action: '点击头像进入QQ空间', description: '打开QQ空间', priority: 3 },
  { id: 'qq-8', domain: 'qq', trigger: ['邮箱','邮件'], action: '点击QQ面板上的邮箱图标', description: '打开QQ邮箱', priority: 3 },
  { id: 'qq-9', domain: 'qq', trigger: ['群','群聊'], action: '点击"群/讨论组"标签进入群列表', description: '打开群聊列表', priority: 3 },
  { id: 'qq-10', domain: 'qq', trigger: ['抖一抖','窗口抖动'], action: '点击聊天窗口"抖动"图标', description: '窗口抖动', priority: 2 },
  
  // ==================== 钉钉 (DingTalk) ====================
  { id: 'ding-1', domain: 'dingtalk', trigger: ['钉钉','dingtalk'], action: '双击桌面钉钉图标或从任务栏打开', description: '打开钉钉', priority: 6 },
  { id: 'ding-2', domain: 'dingtalk', trigger: ['发送','消息','钉消息'], action: '在输入框输入后Enter发送', description: '发送钉钉消息', priority: 6 },
  { id: 'ding-3', domain: 'dingtalk', trigger: ['DING','叮'], action: '点击"DING"图标→选择联系人→发送DING消息', description: '发送DING通知', priority: 4 },
  { id: 'ding-4', domain: 'dingtalk', trigger: ['审批','请假','报销'], action: '点击"工作"→"审批"→选择审批类型', description: '提交审批', priority: 5 },
  { id: 'ding-5', domain: 'dingtalk', trigger: ['考勤','打卡'], action: '点击"工作"→"考勤打卡"', description: '考勤打卡', priority: 5 },
  { id: 'ding-6', domain: 'dingtalk', trigger: ['会议','视频会议'], action: '点击"会议"→"发起会议"或输入会议号加入', description: '发起加入会议', priority: 5 },
  { id: 'ding-7', domain: 'dingtalk', trigger: ['文档','钉钉文档'], action: '点击"工作"→"钉钉文档"', description: '打开钉钉文档', priority: 4 },
  { id: 'ding-8', domain: 'dingtalk', trigger: ['日历','日程'], action: '点击"日历"查看或创建日程', description: '查看日程', priority: 3 },
  { id: 'ding-9', domain: 'dingtalk', trigger: ['公告','通知'], action: '点击"工作"→"公告"→查看或发布', description: '查看发布公告', priority: 4 },
  { id: 'ding-10', domain: 'dingtalk', trigger: ['钉邮','邮箱'], action: '点击"工作"→"钉邮"', description: '打开钉钉邮箱', priority: 3 },
  
  // ==================== 7-Zip ====================
  { id: '7z-1', domain: '7zip', trigger: ['压缩','打包'], action: '选中文件→右键→7-Zip→"添加到压缩包"', description: '使用7-Zip压缩文件', priority: 5 },
  { id: '7z-2', domain: '7zip', trigger: ['解压','解压缩','提取'], action: '选中压缩包→右键→7-Zip→"提取到当前目录"', description: '使用7-Zip解压文件', priority: 5 },
  { id: '7z-3', domain: '7zip', trigger: ['加密压缩','密码压缩'], action: '右键→7-Zip→"添加到压缩包"→设置密码', description: '加密压缩文件', priority: 4 },
  { id: '7z-4', domain: '7zip', trigger: ['分卷压缩'], action: '右键→7-Zip→"添加到压缩包"→设置分卷大小', description: '分卷压缩大文件', priority: 3 },
  { id: '7z-5', domain: '7zip', trigger: ['测试','校验'], action: '选中压缩包→右键→7-Zip→"测试"', description: '测试压缩包完整性', priority: 2 },
  { id: '7z-6', domain: '7zip', trigger: ['打开压缩包','浏览'], action: '双击压缩包或右键→7-Zip→"打开压缩包"', description: '浏览压缩包内容', priority: 3 },
  
  // ==================== Notepad++ ====================
  { id: 'npp-1', domain: 'notepadpp', trigger: ['notepad++','npp','记事本++'], action: '搜索"Notepad++"或从开始菜单打开', description: '打开Notepad++', priority: 4 },
  { id: 'npp-2', domain: 'notepadpp', trigger: ['编码','utf-8','ansi'], action: '点击"编码"菜单→选择编码格式', description: '切换文件编码', priority: 4 },
  { id: 'npp-3', domain: 'notepadpp', trigger: ['查找','替换'], action: 'Ctrl+F 查找 / Ctrl+H 替换', description: '查找替换文本', priority: 4 },
  { id: 'npp-4', domain: 'notepadpp', trigger: ['列编辑','列模式'], action: '按住Alt+鼠标选择矩形区域', description: '列编辑模式', priority: 3 },
  { id: 'npp-5', domain: 'notepadpp', trigger: ['宏','录制'], action: '点击"宏"→"开始录制"→操作→"停止录制"→保存', description: '录制播放宏', priority: 3 },
  { id: 'npp-6', domain: 'notepadpp', trigger: ['排序','行排序'], action: '点击"编辑"→"行操作"→"排序"', description: '行排序', priority: 3 },
  { id: 'npp-7', domain: 'notepadpp', trigger: ['语言','语法高亮'], action: '点击"语言"菜单→选择对应语言', description: '设置语法高亮', priority: 3 },
  { id: 'npp-8', domain: 'notepadpp', trigger: ['比较','diff'], action: '插件→Compare→Compare', description: '比较文件差异', priority: 3 },
  
  // ==================== 快捷键大全 ====================
  { id: 'key-1', domain: 'shortcuts', trigger: ['全选','select all'], action: 'Ctrl+A 全选', description: '全选当前内容', priority: 4 },
  { id: 'key-2', domain: 'shortcuts', trigger: ['复制','copy'], action: 'Ctrl+C 复制', description: '复制选中内容', priority: 4 },
  { id: 'key-3', domain: 'shortcuts', trigger: ['剪切','cut'], action: 'Ctrl+X 剪切', description: '剪切选中内容', priority: 4 },
  { id: 'key-4', domain: 'shortcuts', trigger: ['粘贴','paste'], action: 'Ctrl+V 粘贴', description: '粘贴剪贴板内容', priority: 4 },
  { id: 'key-5', domain: 'shortcuts', trigger: ['撤销','undo'], action: 'Ctrl+Z 撤销', description: '撤销上一步操作', priority: 4 },
  { id: 'key-6', domain: 'shortcuts', trigger: ['重做','redo'], action: 'Ctrl+Y 重做', description: '重做已撤销的操作', priority: 3 },
  { id: 'key-7', domain: 'shortcuts', trigger: ['保存','save'], action: 'Ctrl+S 保存', description: '保存当前文件', priority: 5 },
  { id: 'key-8', domain: 'shortcuts', trigger: ['新建','new'], action: 'Ctrl+N 新建', description: '新建文件', priority: 4 },
  { id: 'key-9', domain: 'shortcuts', trigger: ['打开','open'], action: 'Ctrl+O 打开', description: '打开文件', priority: 4 },
  { id: 'key-10', domain: 'shortcuts', trigger: ['打印','print'], action: 'Ctrl+P 打印', description: '打印当前文档', priority: 3 },
  { id: 'key-11', domain: 'shortcuts', trigger: ['关闭','close','关闭窗口'], action: 'Alt+F4 关闭当前窗口', description: '关闭当前窗口', priority: 4 },
  { id: 'key-12', domain: 'shortcuts', trigger: ['切换','切换窗口','alt+tab'], action: 'Alt+Tab 切换活动窗口', description: '切换窗口', priority: 4 },
  { id: 'key-13', domain: 'shortcuts', trigger: ['任务视图','时间线'], action: 'Win+Tab 打开任务视图', description: '打开任务视图', priority: 3 },
  { id: 'key-14', domain: 'shortcuts', trigger: ['锁定','lock','锁屏'], action: 'Win+L 锁定电脑', description: '锁定电脑', priority: 4 },
  { id: 'key-15', domain: 'shortcuts', trigger: ['快捷','右键','菜单'], action: 'Shift+F10 打开右键菜单', description: '打开右键上下文菜单', priority: 3 },
  { id: 'key-16', domain: 'shortcuts', trigger: ['删除','delete'], action: 'Delete 删除选中到回收站', description: '删除选中项目', priority: 3 },
  { id: 'key-17', domain: 'shortcuts', trigger: ['永久删除'], action: 'Shift+Delete 永久删除（不进回收站）', description: '永久删除文件', priority: 3 },
  { id: 'key-18', domain: 'shortcuts', trigger: ['重命名','rename'], action: 'F2 重命名选中项目', description: '重命名文件/文件夹', priority: 3 },
  { id: 'key-19', domain: 'shortcuts', trigger: ['属性','properties'], action: 'Alt+Enter 查看选中项目属性', description: '查看属性', priority: 2 },
  { id: 'key-20', domain: 'shortcuts', trigger: ['刷新','refresh'], action: 'F5 刷新当前视图', description: '刷新当前页面/文件夹', priority: 3 },
  { id: 'key-21', domain: 'shortcuts', trigger: ['强制刷新'], action: 'Ctrl+F5 强制刷新（浏览器）', description: '强制刷新清缓存', priority: 2 },
  { id: 'key-22', domain: 'shortcuts', trigger: ['截图','截屏'], action: 'PrtScn 全屏截图 / Alt+PrtScn 活动窗口', description: '系统截图快捷键', priority: 3 },
  { id: 'key-23', domain: 'shortcuts', trigger: ['帮助','help'], action: 'F1 打开帮助', description: '打开帮助文档', priority: 2 },
  { id: 'key-24', domain: 'shortcuts', trigger: ['停止','stop'], action: 'Esc 停止当前操作', description: '取消/停止操作', priority: 3 },
  { id: 'key-25', domain: 'shortcuts', trigger: ['确认','确定','回车'], action: 'Enter 确认或执行', description: '确认操作', priority: 3 },
  { id: 'key-26', domain: 'shortcuts', trigger: ['切换输入法'], action: 'Win+Space 或 Ctrl+Shift 切换输入法', description: '切换输入法', priority: 3 },
  { id: 'key-27', domain: 'shortcuts', trigger: ['中英文','中英切换'], action: 'Shift 切换中英文', description: '中英文输入切换', priority: 3 },
  { id: 'key-28', domain: 'shortcuts', trigger: ['大写','caps'], action: 'Caps Lock 切换大小写', description: '大小写锁定', priority: 2 },
  
  // ==================== 通用软件操作 ====================
  { id: 'gen-1', domain: 'general', trigger: ['安装','setup','install'], action: '双击安装包→点击"下一步"→同意协议→选择路径→安装', description: '安装软件通用步骤', priority: 6 },
  { id: 'gen-2', domain: 'general', trigger: ['卸载','uninstall'], action: 'Win+I→应用→找到软件→卸载', description: '卸载软件通用步骤', priority: 5 },
  { id: 'gen-3', domain: 'general', trigger: ['更新','update','升级'], action: '在软件内点击"检查更新"或官网下载最新版', description: '更新软件通用步骤', priority: 4 },
  { id: 'gen-4', domain: 'general', trigger: ['登录','sign in','login'], action: '输入用户名/手机号和密码→点击"登录"', description: '登录软件/网站', priority: 5 },
  { id: 'gen-5', domain: 'general', trigger: ['注册','sign up','register'], action: '点击"注册"→填写信息→获取验证码→设置密码→提交', description: '注册账号', priority: 5 },
  { id: 'gen-6', domain: 'general', trigger: ['忘记密码','重置密码'], action: '点击"忘记密码"→输入账号→验证→重置', description: '重置密码', priority: 5 },
  { id: 'gen-7', domain: 'general', trigger: ['导出','export'], action: '点击"文件"→"导出"→选择格式和位置', description: '导出数据', priority: 4 },
  { id: 'gen-8', domain: 'general', trigger: ['导入','import'], action: '点击"文件"→"导入"→选择文件→确认', description: '导入数据', priority: 4 },
  { id: 'gen-9', domain: 'general', trigger: ['备份','backup'], action: '复制文件到备份目录或使用软件内备份功能', description: '数据备份', priority: 5 },
  { id: 'gen-10', domain: 'general', trigger: ['恢复','restore'], action: '从备份文件恢复到原位置', description: '数据恢复', priority: 5 },
  { id: 'gen-11', domain: 'general', trigger: ['分享','share'], action: '点击"分享"按钮→选择分享方式', description: '分享文件/内容', priority: 3 },
  { id: 'gen-12', domain: 'general', trigger: ['下载','download'], action: '点击下载链接→选择保存位置→确定', description: '下载文件通用', priority: 5 },
  { id: 'gen-13', domain: 'general', trigger: ['上传','upload'], action: '点击"上传"→选择文件→等待上传完成', description: '上传文件', priority: 4 },
  { id: 'gen-14', domain: 'general', trigger: ['全屏','fullscreen'], action: 'F11 切换全屏模式', description: '全屏切换', priority: 3 },
  { id: 'gen-15', domain: 'general', trigger: ['静音','mute'], action: '点击音量图标→静音', description: '静音切换', priority: 2 },
  { id: 'gen-16', domain: 'general', trigger: ['夜间模式','深色模式'], action: '在软件设置中开启"深色模式"或"夜间模式"', description: '切换深色模式', priority: 2 },
  { id: 'gen-17', domain: 'general', trigger: ['快捷键','快捷方式'], action: '查看软件帮助中的键盘快捷键列表', description: '查看快捷键', priority: 2 },
  { id: 'gen-18', domain: 'general', trigger: ['拖拽','拖动'], action: '按住鼠标左键拖动到目标位置松开', description: '拖拽操作', priority: 3 },
  { id: 'gen-19', domain: 'general', trigger: ['右键','右击'], action: '点击鼠标右键打开上下文菜单', description: '右键操作', priority: 3 },
  { id: 'gen-20', domain: 'general', trigger: ['双击','双击打开'], action: '快速连续点击鼠标左键两次', description: '双击打开', priority: 3 },
  
  // ==================== 文件管理 ====================
  { id: 'file-1', domain: 'file', trigger: ['复制文件','拷贝'], action: 'Ctrl+C复制→到目标文件夹Ctrl+V粘贴', description: '复制文件', priority: 4 },
  { id: 'file-2', domain: 'file', trigger: ['移动文件'], action: 'Ctrl+X剪切→到目标文件夹Ctrl+V粘贴', description: '移动文件', priority: 4 },
  { id: 'file-3', domain: 'file', trigger: ['删除文件','删除文件夹'], action: '选中→Delete 删除到回收站', description: '删除文件/文件夹', priority: 4 },
  { id: 'file-4', domain: 'file', trigger: ['新建文件夹'], action: 'Ctrl+Shift+N 新建文件夹', description: '新建文件夹', priority: 4 },
  { id: 'file-5', domain: 'file', trigger: ['重命名','改名'], action: '选中→F2→输入新名称→Enter', description: '重命名文件/文件夹', priority: 4 },
  { id: 'file-6', domain: 'file', trigger: ['查看属性','文件信息'], action: '选中→Alt+Enter 查看属性', description: '查看文件属性', priority: 3 },
  { id: 'file-7', domain: 'file', trigger: ['搜索文件','查找文件'], action: '在文件资源管理器右上角搜索框输入文件名', description: '搜索文件', priority: 4 },
  { id: 'file-8', domain: 'file', trigger: ['压缩','zip','rar'], action: '选中文件→右键→"发送到"→"压缩(zipped)文件夹"', description: '压缩文件', priority: 4 },
  { id: 'file-9', domain: 'file', trigger: ['解压','提取'], action: '右键压缩包→"全部提取"→选择目标→确定', description: '解压缩文件', priority: 4 },
  { id: 'file-10', domain: 'file', trigger: ['隐藏文件','显示隐藏'], action: '在资源管理器中点击"查看"→勾选"隐藏的项目"', description: '显示/隐藏隐藏文件', priority: 3 },
  { id: 'file-11', domain: 'file', trigger: ['文件后缀','扩展名'], action: '在资源管理器中点击"查看"→勾选"文件扩展名"', description: '显示文件扩展名', priority: 3 },
  { id: 'file-12', domain: 'file', trigger: ['排序','排列'], action: '在文件夹空白处右键→"排序方式"→选择排序依据', description: '文件排序', priority: 3 },
  { id: 'file-13', domain: 'file', trigger: ['全选文件'], action: '在文件夹中Ctrl+A全选所有文件', description: '全选文件', priority: 3 },
  { id: 'file-14', domain: 'file', trigger: ['选择多个','多选'], action: 'Ctrl+点击选择多个文件 / Shift+点击选择连续文件', description: '多选文件', priority: 3 },
  { id: 'file-15', domain: 'file', trigger: ['回收站','清空回收站'], action: '双击回收站→"清空回收站"', description: '清空回收站', priority: 3 },
  
  // ==================== 图片处理 ====================
  { id: 'img-1', domain: 'image', trigger: ['截屏','屏幕截图','截图'], action: 'Win+Shift+S 打开截图工具', description: '屏幕截图', priority: 5 },
  { id: 'img-2', domain: 'image', trigger: ['截窗口','窗口截图'], action: 'Alt+PrtScn 截取当前活动窗口', description: '截取活动窗口', priority: 4 },
  { id: 'img-3', domain: 'image', trigger: ['全屏截图'], action: 'PrtScn 截取整个屏幕', description: '全屏截图', priority: 4 },
  { id: 'img-4', domain: 'image', trigger: ['图片编辑','编辑图片'], action: '右键图片→"编辑"→打开画图编辑', description: '编辑图片', priority: 4 },
  { id: 'img-5', domain: 'image', trigger: ['图片格式转换'], action: '右键→"编辑"→画图→另存为→选择格式', description: '转换图片格式', priority: 3 },
  { id: 'img-6', domain: 'image', trigger: ['调整大小','缩放图片'], action: '右键→"编辑"→画图→"调整大小"', description: '调整图片尺寸', priority: 3 },
  { id: 'img-7', domain: 'image', trigger: ['旋转','翻转'], action: '右键图片→"向右旋转"或"向左旋转"', description: '旋转图片', priority: 3 },
  
  // ==================== 打印 ====================
  { id: 'print-1', domain: 'print', trigger: ['打印','打印文档'], action: 'Ctrl+P 打开打印对话框→选择打印机→设置→打印', description: '打印文档', priority: 5 },
  { id: 'print-2', domain: 'print', trigger: ['打印预览'], action: 'Ctrl+P→查看右侧预览区域', description: '打印预览', priority: 3 },
  { id: 'print-3', domain: 'print', trigger: ['打印到pdf'], action: 'Ctrl+P→选择"Microsoft Print to PDF"→打印', description: '打印为PDF', priority: 4 },
  { id: 'print-4', domain: 'print', trigger: ['双面打印','双面'], action: 'Ctrl+P→选择双面打印选项', description: '双面打印', priority: 3 },
  { id: 'print-5', domain: 'print', trigger: ['打印机','添加打印机'], action: 'Win+I→蓝牙和设备→打印机和扫描仪→添加设备', description: '添加打印机', priority: 4 },
  
  // ==================== 网络 ====================
  { id: 'net-1', domain: 'network', trigger: ['wifi','无线','无线网络'], action: '点击右下角网络图标→选择WiFi→连接→输入密码', description: '连接WiFi网络', priority: 5 },
  { id: 'net-2', domain: 'network', trigger: ['网线','有线','以太网'], action: '插入网线自动连接，或检查网络设置', description: '有线网络连接', priority: 4 },
  { id: 'net-3', domain: 'network', trigger: ['ip','ip地址','ipconfig'], action: 'Win+R→输入"cmd"→输入"ipconfig"→Enter', description: '查看本机IP地址', priority: 3 },
  { id: 'net-4', domain: 'network', trigger: ['ping','网络延迟'], action: 'Win+R→输入"cmd"→输入"ping 地址"→Enter', description: '测试网络连通性', priority: 3 },
  { id: 'net-5', domain: 'network', trigger: ['dns','域名'], action: 'Win+I→网络→高级网络设置→DNS设置', description: '修改DNS设置', priority: 3 },
  { id: 'net-6', domain: 'network', trigger: ['代理','vpn','翻墙'], action: 'Win+I→网络→代理→手动设置代理', description: '配置网络代理', priority: 3 },
  { id: 'net-7', domain: 'network', trigger: ['网络重置','重置网络'], action: 'Win+I→网络→高级网络→网络重置', description: '重置网络设置', priority: 3 },
  { id: 'net-8', domain: 'network', trigger: ['飞行模式'], action: '点击右下角网络图标→点击"飞行模式"开关', description: '开启飞行模式', priority: 2 },
  { id: 'net-9', domain: 'network', trigger: ['热点','移动热点'], action: 'Win+I→网络→移动热点→开启', description: '开启移动热点', priority: 3 },
  { id: 'net-10', domain: 'network', trigger: ['共享','文件共享'], action: '右键文件夹→"属性"→"共享"→添加用户→共享', description: '文件共享设置', priority: 4 },
  { id: 'net-11', domain: 'network', trigger: ['远程桌面','远程连接'], action: 'Win+R→输入"mstsc"→输入IP→连接', description: '远程桌面连接', priority: 4 },
  { id: 'net-12', domain: 'network', trigger: ['ftp','文件传输'], action: '在浏览器输入ftp://地址→输入用户名密码', description: 'FTP连接', priority: 3 },
  
  // ==================== 安全 ====================
  { id: 'sec-1', domain: 'security', trigger: ['杀毒','病毒','查杀'], action: '打开Windows安全中心→"病毒和威胁防护"→快速扫描', description: '运行杀毒扫描', priority: 5 },
  { id: 'sec-2', domain: 'security', trigger: ['防火墙','firewall'], action: 'Win+I→更新和安全→Windows安全中心→防火墙', description: '配置防火墙', priority: 4 },
  { id: 'sec-3', domain: 'security', trigger: ['家长控制','儿童模式'], action: 'Win+I→账户→家庭和其他用户→添加家庭成员', description: '设置家长控制', priority: 3 },
  { id: 'sec-4', domain: 'security', trigger: ['bitlocker','加密','磁盘加密'], action: '右键驱动器→"启用BitLocker"→按向导操作', description: '磁盘加密', priority: 4 },
  { id: 'sec-5', domain: 'security', trigger: ['账户控制','uac'], action: 'Win+I→账户→登录选项→安全密钥', description: '账户安全设置', priority: 3 },
  { id: 'sec-6', domain: 'security', trigger: ['密码','更改密码'], action: 'Ctrl+Alt+Del→"更改密码"', description: '更改登录密码', priority: 4 },
  
  // ==================== WPS 更多操作 ====================
  { id: 'wps-46', domain: 'wps', trigger: ['合并单元格','拆分单元格'], action: '选中表格区域→右键→"合并单元格"或"拆分单元格"', description: '合并拆分Excel单元格', priority: 4 },
  { id: 'wps-47', domain: 'wps', trigger: ['自动求和','求和','sum'], action: '选中数据→点击"开始"→"自动求和"', description: '自动求和', priority: 4 },
  { id: 'wps-48', domain: 'wps', trigger: ['筛选','自动筛选'], action: '选中表头→点击"数据"→"筛选"', description: '开启自动筛选', priority: 4 },
  { id: 'wps-49', domain: 'wps', trigger: ['分类汇总'], action: '选中数据→"数据"→"分类汇总"→选择分类字段', description: '分类汇总数据', priority: 4 },
  { id: 'wps-50', domain: 'wps', trigger: ['验证','数据验证'], action: '选中单元格→"数据"→"数据验证"→设置规则', description: '设置数据验证', priority: 3 },
  { id: 'wps-51', domain: 'wps', trigger: ['下拉菜单','下拉列表'], action: '选中单元格→"数据"→"下拉列表"→输入选项', description: '创建下拉菜单', priority: 4 },
  { id: 'wps-52', domain: 'wps', trigger: ['打印区域','设置打印区域'], action: '选中内容→"页面布局"→"打印区域"→"设置打印区域"', description: '设置打印区域', priority: 3 },
  { id: 'wps-53', domain: 'wps', trigger: ['分页符','插入分页'], action: '点击"页面布局"→"分页符"→"插入分页符"', description: '插入分页符', priority: 3 },
  { id: 'wps-54', domain: 'wps', trigger: ['转置','行列互换'], action: '复制数据→右键→"选择性粘贴"→勾选"转置"', description: '行列转置', priority: 3 },
  { id: 'wps-55', domain: 'wps', trigger: ['去重','删除重复项'], action: '选中数据→"数据"→"删除重复项"', description: '删除重复数据', priority: 4 },
  { id: 'wps-56', domain: 'wps', trigger: ['分列','文本分列'], action: '选中列→"数据"→"分列"→按向导操作', description: '文本分列', priority: 3 },
  { id: 'wps-57', domain: 'wps', trigger: ['组合','取消组合'], action: '选中对象→右键→"组合"→"组合"', description: '组合多个对象', priority: 3 },
  { id: 'wps-58', domain: 'wps', trigger: ['对齐','分布','居中'], action: '选中多个对象→"绘图工具"→"对齐"→选择对齐方式', description: '对齐多个对象', priority: 3 },
  { id: 'wps-59', domain: 'wps', trigger: ['图层','上移','下移','置于顶层'], action: '选中对象→右键→"置于顶层"或"置于底层"', description: '调整图层顺序', priority: 3 },
  { id: 'wps-60', domain: 'wps', trigger: ['smartart','图示','组织结构图'], action: '点击"插入"→"SmartArt"→选择图示类型', description: '插入SmartArt图形', priority: 4 },
  
  // ==================== 微信更多操作 ====================
  { id: 'wx-30', domain: 'wechat', trigger: ['翻译','微信翻译'], action: '长按消息→"翻译"', description: '翻译微信消息', priority: 3 },
  { id: 'wx-31', domain: 'wechat', trigger: ['提醒','设置提醒'], action: '右键消息→"提醒"→设置时间', description: '设置消息提醒', priority: 3 },
  { id: 'wx-32', domain: 'wechat', trigger: ['标签','打标签'], action: '右键联系人→"设置备注和标签"→添加标签', description: '给联系人打标签', priority: 3 },
  { id: 'wx-33', domain: 'wechat', trigger: ['背景','聊天背景'], action: '右键聊天→"设置当前聊天背景"→选择图片', description: '设置聊天背景', priority: 2 },
  { id: 'wx-34', domain: 'wechat', trigger: ['深色模式','夜间模式'], action: '点击"我"→"设置"→"通用"→"深色模式"', description: '设置微信深色模式', priority: 2 },
  { id: 'wx-35', domain: 'wechat', trigger: ['存储','清理','空间'], action: '点击"我"→"设置"→"通用"→"存储空间"→清理', description: '清理微信存储空间', priority: 5 },
  
  // ==================== 浏览器更多 ====================
  { id: 'browser-25', domain: 'browser', trigger: ['导出密码','保存密码'], action: '浏览器设置→密码→已保存密码→导出', description: '导出已保存的密码', priority: 3 },
  { id: 'browser-26', domain: 'browser', trigger: ['cookie','缓存','网站数据'], action: '浏览器设置→隐私和安全→Cookie和网站数据', description: '管理Cookie', priority: 3 },
  { id: 'browser-27', domain: 'browser', trigger: ['硬件加速'], action: '浏览器设置→系统→"使用硬件加速"', description: '开启/关闭硬件加速', priority: 2 },
  { id: 'browser-28', domain: 'browser', trigger: ['默认浏览器'], action: '浏览器设置→默认浏览器→设为默认', description: '设置默认浏览器', priority: 3 },
  { id: 'browser-29', domain: 'browser', trigger: ['阅读模式','沉浸式'], action: '点击地址栏右侧的阅读模式图标', description: '开启阅读模式', priority: 2 },
  { id: 'browser-30', domain: 'browser', trigger: ['画中画','浮窗'], action: '右键视频→"画中画"', description: '画中画播放视频', priority: 2 },
  
  // ==================== Windows 系统更多 ====================
  { id: 'sys-48', domain: 'system', trigger: ['存储','磁盘空间','清理磁盘'], action: 'Win+I→系统→存储→打开"存储感知"或"临时文件"', description: '磁盘空间管理', priority: 4 },
  { id: 'sys-49', domain: 'system', trigger: ['回收站','清空'], action: '右键桌面回收站→"清空回收站"', description: '清空回收站', priority: 3 },
  { id: 'sys-50', domain: 'system', trigger: ['屏保','屏幕保护'], action: 'Win+I→个性化→锁屏界面→屏幕保护程序设置', description: '设置屏幕保护', priority: 2 },
  { id: 'sys-51', domain: 'system', trigger: ['壁纸','桌面背景'], action: 'Win+I→个性化→背景→选择图片', description: '更换桌面壁纸', priority: 3 },
  { id: 'sys-52', domain: 'system', trigger: ['主题','主题设置'], action: 'Win+I→个性化→主题→选择主题', description: '更换系统主题', priority: 2 },
  { id: 'sys-53', domain: 'system', trigger: ['字体','安装字体'], action: '右键字体文件→"安装"', description: '安装字体', priority: 3 },
  { id: 'sys-54', domain: 'system', trigger: ['输入法','添加输入法'], action: 'Win+I→时间和语言→语言和区域→添加键盘', description: '添加输入法', priority: 3 },
  { id: 'sys-55', domain: 'system', trigger: ['多显示器','双屏'], action: 'Win+P 选择显示模式', description: '多显示器设置', priority: 3 },
  { id: 'sys-56', domain: 'system', trigger: ['分辨率','屏幕分辨率'], action: '右键桌面→"显示设置"→"显示分辨率"', description: '调整屏幕分辨率', priority: 3 },
  { id: 'sys-57', domain: 'system', trigger: ['刷新率','屏幕刷新'], action: '右键桌面→"显示设置"→"高级显示"→选择刷新率', description: '调整屏幕刷新率', priority: 2 },
  { id: 'sys-58', domain: 'system', trigger: ['电源','省电','电池'], action: '右键电池图标→"电源选项"→选择电源模式', description: '电源管理', priority: 3 },
  { id: 'sys-59', domain: 'system', trigger: ['屏幕亮度','亮度'], action: '点击右下角电池/网络图标→亮度滑块', description: '调节屏幕亮度', priority: 3 },
  { id: 'sys-60', domain: 'system', trigger: ['夜间模式','夜间灯光'], action: 'Win+I→系统→屏幕→"夜间模式"设置', description: '开启夜间灯光', priority: 2 },
]

// ==================== 常识规则管理器 ====================

export class CommonKnowledgeManager {
  private rules: KnowledgeRule[] = RULES

  /**
   * 根据任务意图获取相关常识规则
   */
  getRelevantRules(intent: string): KnowledgeRule[] {
    const intentLower = intent.toLowerCase()
    const matched: KnowledgeRule[] = []
    const seen = new Set<string>()

    for (const rule of this.rules) {
      for (const trigger of rule.trigger) {
        if (intentLower.includes(trigger.toLowerCase())) {
          if (!seen.has(rule.id)) {
            matched.push(rule)
            seen.add(rule.id)
          }
          break
        }
      }
    }

    // 按优先级排序
    matched.sort((a, b) => b.priority - a.priority)
    return matched
  }

  /**
   * 获取所有规则
   */
  getAllRules(): KnowledgeRule[] {
    return [...this.rules]
  }

  /**
   * 按领域分组获取规则
   */
  getRulesByDomain(domain: string): KnowledgeRule[] {
    return this.rules.filter(r => r.domain === domain)
  }

  /**
   * 获取规则总数
   */
  getRuleCount(): number {
    return this.rules.length
  }
}

export const commonKnowledge = new CommonKnowledgeManager()