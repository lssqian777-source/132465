# Tpoe 1.0.26 实机测试指令（供本地 AI + MCP 执行）

> 本文件写给本地 AI 助手（带浏览器/桌面控制 MCP）执行。
> 目标：在真实 Windows 电脑上验证 Tpoe 自动发布功能。
> 执行完按文末格式输出报告，发回给开发（我）即可精准修复。

---

## 一、环境准备

1. 确认本机已安装 Chrome 或 Edge（默认路径）。
2. 双击 `Tpoe-1.0.26-portable.exe` 启动软件（如被拦截：右键→属性→解除锁定）。
3. 软件会弹出受控浏览器窗口（顶部有"自动测试软件正在控制 Chrome"提示）。
4. **在该受控浏览器里逐个登录**：抖音、小红书、微博、视频号（扫码登录）。
   登录成功的标志：各平台创作后台可见，刷新后不再跳登录页。
5. 准备 2 张测试图片（jpg/png，放固定路径如 `D:\test-img\1.jpg`、`D:\test-img\2.jpg`）。

---

## 二、主测试流程（驱动 Tpoe 界面）

### 测试 1：小红书（重点）
1. 在 Tpoe 主界面勾选「小红书」。
2. 文案区填：标题 `自动化测试标题`，正文 `这是一条实机测试文案请忽略`，配乐名称留空。
3. 添加 2 张测试图片。
4. 点「生成发布包」→ 点「全部自动填表」。
5. **验证点（切到受控浏览器的小红书标签页）：**
   - [ ] URL 必须是 `creator.xiaohongshu.com/publish/publish?...target=image`（图文上传页）
   - [ ] 页面**没有**弹出 Windows 系统文件选择框（如果弹了=严重bug，截图）
   - [ ] 2 张图片缩略图已出现在上传区
   - [ ] 标题框已填（≤20字），正文框已填
6. 结果弹窗里小红书应显示「已填好」。

### 测试 2：视频号（重点，按用户截图箭头流程）
1. 勾选「微信（视频号）」，同上文案，配乐名称填 `起风了`。
2. 生成发布包 → 全部自动填表。
3. **验证点（切到视频号标签页）：**
   - [ ] 页面先到「图文管理」列表（左侧菜单"图文"高亮）
   - [ ] 自动点了右上角橙色「发表图文」按钮，编辑器打开
   - [ ] 2 张图片已上传（左侧 + 号区显示缩略图）
   - [ ] 「图文标题」已填（≤22字）
   - [ ] 「图文描述」已填
   - [ ] 「音乐」行如果自动选歌失败是可接受的（启发式），记录现象
   - [ ] **不要点「发表」**，核对完关闭即可

### 测试 3：抖音（回归）
1. 勾选「抖音」，配乐名称填 `起风了`，2 张图片。
2. **验证点：**
   - [ ] 切到「发布图文」tab
   - [ ] 图片上传成功、标题正文填好
   - [ ] 配乐自动搜索并选用第一个结果（记录成功/失败）

### 测试 4：微博（回归）
1. 勾选「微博」，2 张图片。
2. **验证点：**
   - [ ] 无系统文件框弹出
   - [ ] 首页正文框已填文字
   - [ ] 图片已上传（缩略图出现）

### 测试 5：Instagram（可选，需科学上网）
- 验证点：instagram.com 首页点左侧「创建」→ 上传 modal 出现 → 图片+文案填好 → 停在 Share 前。

---

## 三、失败时取证（关键！）

任一平台失败，用 MCP 在该平台标签页执行以下 JS（浏览器 evaluate），把输出发回：

```javascript
JSON.stringify({
  url: location.href,
  fileInputs: [...document.querySelectorAll('input[type=file]')].map(i => ({
    accept: i.accept, multiple: i.multiple, visible: i.offsetWidth > 0
  })),
  titleCandidates: [...document.querySelectorAll('input,textarea')].map(i => ({
    tag: i.tagName, placeholder: i.placeholder, maxlength: i.maxLength, ariaLabel: i.getAttribute('aria-label')
  })).filter(i => i.placeholder || i.ariaLabel),
  editableDivs: [...document.querySelectorAll('[contenteditable="true"]')].map(i => ({
    ph: i.getAttribute('data-placeholder') || i.getAttribute('placeholder') || '',
    cls: (i.className||'').slice(0,60)
  })),
  bodyTextSample: (document.body.innerText||'').slice(0, 300)
}, null, 2)
```

同时把 `%APPDATA%\Tpoe\automation-logs\` 里最新截图一并发回。

---

## 四、选择器对照表（当前版本用的，供核对）

| 平台 | 入口 URL | 标题选择器 | 正文选择器 |
|------|----------|-----------|-----------|
| 抖音 | creator.douyin.com/.../content/upload | `input[placeholder*="标题"]` | `div[contenteditable="true"]` |
| 小红书 | ...publish?source=official&from=tab_switch&target=image | `input[placeholder*="标题"]` | `div[contenteditable="true"][data-placeholder*="正文"]` |
| 微博 | weibo.com/ | （无，并入正文） | `div[contenteditable="true"]` |
| 视频号 | channels.weixin.qq.com/platform/post/finderNewLifePostList → 点「发表图文」 | `input[placeholder*="标题"]` / `input[maxlength="22"]` | `textarea[placeholder*="描述"]` |
| INS | instagram.com/ → 点「创建」 | （无） | `div[aria-label*="caption" i]` |

---

## 五、报告格式（执行完输出）

```
【Tpoe 1.0.26 实机测试报告】
小红书：URL正确[Y/N] 图片上传[Y/N] 标题[Y/N] 正文[Y/N] 系统文件框[有/无]
视频号：进入编辑器[Y/N] 图片[Y/N] 标题[Y/N] 描述[Y/N] 音乐[Y/N/未测]
抖音：图片[Y/N] 文案[Y/N] 配乐[Y/N]
微博：图片[Y/N] 文案[Y/N]
INS：[结果/未测]
异常现象：<文字描述>
取证JS输出：<失败平台粘贴>
```
