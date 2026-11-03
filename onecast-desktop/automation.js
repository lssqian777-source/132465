/**
 * Tpoe (万相位面) 自动发布引擎（实验性）
 *
 * 原理：用 playwright-core 驱动本机已安装的 Chrome / Edge，在一个独立的浏览器
 * 配置文件（%APPDATA%/Tpoe/browser-profile）里打开各平台创作中心，复用你
 * 在该配置文件中的登录态。
 *
 * 重要说明：
 * - 不读取、不复制你日常浏览器的 Cookie 和密码，登录需要在该工作台里单独完成一次。
 * - 默认只「自动填表」（上传素材 + 填标题正文），最后一步由你人工点击发布。
 * - 填完的标签页会保持打开，你可以直接在那个窗口里核对并点发布。
 * - 平台页面随时可能改版，本引擎按文本/结构做启发式匹配；每填一项都会回读校验，
 *   没填进去会如实返回，失败时保留截图在 %APPDATA%/Tpoe/automation-logs/。
 */
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 各平台适配信息（启发式，不依赖固定元素 id） */
const ADAPTERS = {
  douyin: {
    name: '抖音',
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    host: 'douyin.com',
    imageTab: ['发布图文', '图文'],
    videoTab: ['发布视频', '视频'],
    titleSelectors: ['input[placeholder*="标题"]', 'input[placeholder*="作品"]'],
    bodySelectors: ['div[contenteditable="true"]', 'textarea[placeholder*="简介"]'],
    submit: ['发布', '立即发布'],
    note: '图文最多 35 张；封面在发布页单独设置'
  },
  xiaohongshu: {
    name: '小红书',
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    host: 'xiaohongshu.com',
    imageTab: ['上传图文', '图文'],
    videoTab: ['上传视频', '视频'],
    titleSelectors: ['input[placeholder*="标题"]', 'div[contenteditable="true"][data-placeholder*="标题"]'],
    bodySelectors: ['div[contenteditable="true"][data-placeholder*="正文"]', 'div[contenteditable="true"]'],
    submit: ['发布', '发布笔记'],
    note: '标题上限 20 字；正文里的话题用 #话题# 形式'
  },
  bilibili: {
    name: 'B 站',
    url: 'https://member.bilibili.com/platform/upload/article/video',
    host: 'bilibili.com',
    imageTab: ['图文', '专栏'],
    videoTab: ['视频', '投稿'],
    titleSelectors: ['input[placeholder*="标题"]', 'input[class*="title"]'],
    bodySelectors: ['div[contenteditable="true"]', 'textarea'],
    submit: ['发布', '发送'],
    note: '视频投稿走这个页；图文动态走 t.bilibili.com（反爬严格），建议只用来传视频'
  },
  weibo: {
    name: '微博',
    url: 'https://weibo.com/compose',
    host: 'weibo.com',
    imageTab: [],
    videoTab: [],
    titleSelectors: [],
    bodySelectors: ['div[contenteditable="true"]', 'textarea'],
    submit: ['发送', '发布'],
    note: '正文 140 字；图片最多 9 张'
  },
  x: {
    name: 'X',
    url: 'https://x.com/compose/post',
    host: 'x.com',
    imageTab: [],
    videoTab: [],
    titleSelectors: [],
    bodySelectors: ['div[contenteditable="true"]', 'textarea'],
    submit: ['Post', '发布'],
    note: '280 字符；图片最多 4 张'
  },
  instagram: {
    name: 'Instagram',
    url: 'https://www.instagram.com/',
    host: 'instagram.com',
    manual: true,
    imageTab: [],
    videoTab: [],
    titleSelectors: [],
    bodySelectors: [],
    submit: ['Share', '分享'],
    note: '网页版发文不稳定，请手动发布'
  },
  wechat: {
    name: '微信（视频号/贴图）',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    host: 'weixin.qq.com',
    imageTab: ['图文', '图片'],
    videoTab: ['视频'],
    titleSelectors: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'],
    bodySelectors: ['div[contenteditable="true"]', 'textarea[placeholder*="描述"]', 'textarea'],
    submit: ['发表', '发布', '创建'],
    note: '视频号助手网页版可发图文/视频；朋友圈无网页接口，贴图请手动'
  }
};

/** AI 评分适配器：用网页版聊天（免费，不调 API） */
const AI_MARK_A = '<<<SCORE_START>>>';
const AI_MARK_B = '<<<SCORE_END>>>';

const AI_ADAPTERS = {
  doubao: {
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
    host: 'doubao.com',
    // 输入框：contenteditable 或 textarea
    inputSelectors: ['div[contenteditable="true"]', 'textarea'],
    // 发送按钮：按文本或 aria-label 找
    sendLabels: ['发送', 'Send', '发送消息'],
    // 回复：豆包一条消息是一个 [class*="inner-item"]，最后一条是 AI 回复
    replyEval: () => {
      const items = document.querySelectorAll('[class*="inner-item"]');
      if (items.length) {
        const t = (items[items.length - 1].innerText || '').trim();
        if (t) return t;
      }
      const rows = document.querySelectorAll('.scroller_content .list_items > .v_list_row, .message-list-zLoNs1 .v_list_row');
      for (let i = rows.length - 1; i >= 0; i--) {
        const t = (rows[i].innerText || '').trim();
        if (t.length > 10) return t;
      }
      return '';
    }
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    host: 'deepseek.com',
    inputSelectors: ['textarea', 'div[contenteditable="true"]'],
    sendLabels: ['发送', 'Send', '发送消息'],
    replyEval: () => {
      // DeepSeek 消息流
      const all = document.querySelectorAll('[class*="message"], [class*="chat"], [class*="response"]');
      let last = '';
      for (const el of all) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt && txt.length > 5 && txt.length < 4000) last = txt;
      }
      return last;
    }
  }
};

/** 查找本机 Chrome / Edge 可执行文件
 * @param {'auto'|'chrome'|'edge'} [preference='auto'] 用户偏好的浏览器
 */
function findBrowser(preference) {
  if (process.env.ONECAST_BROWSER) {
    try {
      if (fs.existsSync(process.env.ONECAST_BROWSER)) return process.env.ONECAST_BROWSER;
    } catch (e) { /* fall through */ }
  }
  if (process.platform !== 'win32') return null;
  const chromePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const edgePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const order = preference === 'chrome' ? [chromePaths, edgePaths]
              : preference === 'edge'   ? [edgePaths, chromePaths]
              : /* auto */                [chromePaths, edgePaths];
  for (const group of order) {
    for (const p of group) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch (e) { /* keep probing */ }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 依次尝试多个选择器，返回第一个可见且面积最大的元素（跨 iframe） */
async function findField(page, selectors) {
  for (const sel of (selectors || [])) {
    for (const frame of page.frames()) {
      let els = [];
      try {
        els = await frame.$$(sel);
      } catch (e) {
        continue;
      }
      let best = null;
      let bestArea = 0;
      for (const el of els) {
        const info = await el.evaluate(e => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return {
            w: r.width,
            h: r.height,
            vis: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0
          };
        }).catch(() => null);
        if (!info || !info.vis || info.w < 20 || info.h < 10) continue;
        const area = info.w * info.h;
        if (area > bestArea) {
          best = el;
          bestArea = area;
        }
      }
      if (best) return best;
    }
  }
  return null;
}

/** 点击文本按钮（跨 iframe），用于切「发布图文 / 发布视频」等页签 */
async function clickByText(page, texts) {
  for (const frame of page.frames()) {
    for (const t of texts) {
      try {
        const loc = frame.locator(`text=${t}`).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          return true;
        }
      } catch (e) {
        /* try next */
      }
    }
  }
  return false;
}

/** 选择文件输入框：按 accept 猜测是图片还是视频，避免塞错 input */
async function pickFileInput(page, kind) {
  for (const frame of page.frames()) {
    let handles = [];
    try {
      handles = await frame.$$('input[type=file]');
    } catch (e) {
      continue;
    }
    let best = null;
    let bestScore = -99;
    for (const h of handles) {
      const meta = await h.evaluate(e => ({
        accept: (e.accept || '').toLowerCase(),
        multiple: !!e.multiple
      })).catch(() => ({ accept: '', multiple: false }));
      let score = 0;
      if (kind === 'image') {
        if (meta.accept.includes('image')) score += 5;
        if (!meta.accept || meta.accept.includes('*')) score += 2;
        if (meta.accept.includes('video') && !meta.accept.includes('image')) score -= 4;
      } else {
        if (meta.accept.includes('video')) score += 5;
        if (!meta.accept || meta.accept.includes('*')) score += 2;
        if (meta.accept.includes('image') && !meta.accept.includes('video')) score -= 4;
      }
      if (meta.multiple) score += 1;
      if (score > bestScore) {
        best = h;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0) return best;
  }
  return null;
}

/** 写入文本：input/textarea 走原生 setter（兼容 React 受控组件），其余走键盘输入 */
async function writeField(page, el, text) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const tag = await el.evaluate(e => e.tagName).catch(() => '');
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const ok = await el.evaluate((e, t) => {
      e.focus();
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(e, t);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return e.value === t;
    }, text).catch(() => false);
    if (ok) return true;
  }
  // contenteditable / 兜底：聚焦后全选，再用键盘输入替换，触发平台自己的 input 事件
  await el.evaluate(e => {
    e.focus();
    if (e.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(e);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } else if (typeof e.select === 'function') {
      e.select();
    }
  }).catch(() => {});
  await page.keyboard.insertText(text);
  return true;
}

/** 从抓到的整段文本里取出 AI 标记之间的内容 */
function extractMarked(text) {
  if (!text) return '';
  const a = text.indexOf(AI_MARK_A);
  const b = text.lastIndexOf(AI_MARK_B);
  if (a >= 0 && b > a) return text.slice(a + AI_MARK_A.length, b).trim();
  return '';
}

/**
 * 上传图片到 AI 输入框。
 * 优先找 <input type=file accept=image> 用 setInputFiles；
 * 没有就用 DataTransfer 模拟拖放（豆包网页版只支持拖放）。
 * @param {object} page
 * @param {string[]} dataUrls  base64 data URL 列表
 */
async function uploadImages(page, dataUrls) {
  if (!dataUrls || !dataUrls.length) return false;

  // 方式 1：找 accept 含 image 的 file input
  let fileInput = null;
  for (const frame of page.frames()) {
    try {
      const inputs = await frame.$$('input[type="file"]');
      for (const inp of inputs) {
        const accept = await inp.getAttribute('accept').catch(() => '');
        if (accept && /image/i.test(accept)) { fileInput = inp; break; }
      }
      if (fileInput) break;
    } catch (e) { /* try next frame */ }
  }
  if (!fileInput) {
    for (const frame of page.frames()) {
      try {
        const inp = await frame.$('input[type="file"]');
        if (inp) { fileInput = inp; break; }
      } catch (e) { /* try next frame */ }
    }
  }

  if (fileInput) {
    // setInputFiles 只能吃本地路径，把 data URL 写成临时文件
    const paths = dataUrls.map((u, i) => {
      const m = u.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!m) return null;
      const ext = (m[1] === 'jpeg') ? 'jpg' : (m[1] === 'svg+xml' ? 'svg' : m[1]);
      const p = path.join(os.tmpdir(), `tpoe-ai-${Date.now()}-${i}.${ext}`);
      fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
      return p;
    }).filter(Boolean);
    if (paths.length) {
      try {
        await fileInput.setInputFiles(paths);
        paths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        return true;
      } catch (e) {
        paths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        /* fallthrough to drag-drop */
      }
    }
  }

  // 方式 2：模拟拖放（豆包）——在页面里把 data URL 转成 File 后 dispatch drop
  try {
    await page.evaluate(async (urls) => {
      const el = document.querySelector('div[contenteditable="true"], textarea');
      if (!el) throw new Error('no editor element');
      const files = [];
      for (const url of urls) {
        const res = await fetch(url);
        const blob = await res.blob();
        const mime = blob.type || 'image/png';
        const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
        files.push(new File([blob], `tpoe-img-${files.length}.${ext}`, { type: mime }));
      }
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, dataUrls);
    return true;
  } catch (e) {
    return false;
  }
}

const norm = s => String(s == null ? '' : s).replace(/\s+/g, '');

/** 回读校验：确认文字真的写进了页面 */
async function verifyField(el, text) {
  const got = norm(await el.evaluate(e => (
    ('value' in e && e.value != null) ? e.value : (e.innerText || e.textContent || '')
  )).catch(() => ''));
  const want = norm(text);
  if (!got || !want) return false;
  const head = want.slice(0, Math.min(12, want.length));
  return got.includes(head) || head.includes(got.slice(0, 8));
}

/** 统计页面里的缩略图数量，用来确认素材真的上传了 */
async function countThumbs(page) {
  let n = 0;
  for (const frame of page.frames()) {
    try {
      n += await frame.evaluate(() =>
        document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').length);
    } catch (e) { /* ignore */ }
  }
  return n;
}

async function waitUntil(fn, timeout = 15000, step = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch (e) { /* keep waiting */ }
    await sleep(step);
  }
  return false;
}

class AutoRunner {
  constructor(userDataDir) {
    this.profileDir = path.join(userDataDir, 'browser-profile');
    this.logDir = path.join(userDataDir, 'automation-logs');
    this.context = null;
    this.currentExe = null;
    this.pages = new Map();
    this.busy = false;
    this.cancelled = false;
  }

  /**
   * @param {'auto'|'chrome'|'edge'} [browserPref='auto']
   */
  async ensureContext(browserPref) {
    const want = findBrowser(browserPref);
    if (!want) throw new Error('未找到本机 Chrome 或 Edge，请先安装其中一个浏览器');
    // 偏好变了 → 关掉旧 context 重建（换浏览器）
    if (this.context && this.currentExe && this.currentExe !== want) {
      try { await this.context.close(); } catch (e) { /* already gone */ }
      this.context = null;
      this.pages.clear();
    }
    if (this.context) return this.context;
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.currentExe = want;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: want,
      headless: false,
      viewport: null,
      locale: 'zh-CN',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled']
    });
    this.context.on('close', () => {
      this.context = null;
      this.pages.clear();
    });
    return this.context;
  }

  async close() {
    const ctx = this.context;
    this.context = null;
    this.pages.clear();
    if (ctx) {
      try { await ctx.close(); } catch (e) { /* already gone */ }
    }
  }

  /** 打开工作台让用户登录（只打开首页，不做任何操作） */
  async openWorkbench(browserPref) {
    const ctx = await this.ensureContext(browserPref);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://creator.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return '工作台已打开：请在这里分别登录要自动化的平台，登录态会长期保留';
  }

  async shot(page, tag) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const f = path.join(this.logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.png`);
      await page.screenshot({ path: f, fullPage: false });
      return f;
    } catch (e) {
      return '';
    }
  }

  /** 每个平台复用一个标签页：填完不关闭，方便你直接核对并点发布 */
  async getPage(pid, adapter, browserPref) {
    const ctx = await this.ensureContext(browserPref);
    let page = this.pages.get(pid);
    if (page && !page.isClosed()) return page;
    page = await ctx.newPage();
    this.pages.set(pid, page);
    page.on('close', () => this.pages.delete(pid));
    if (adapter && adapter.host) {
      try { await page.goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { /* handled by caller */ }
    }
    return page;
  }

  /** 通用填表：切页签 → 上传素材 → 填标题/正文 → （可选）点发布，逐项回读校验 */
  async fillOne(page, adapter, job) {
    const files = (job.files || []).filter(f => f && fs.existsSync(f.path)).map(f => f.path);
    const imagesOnly = files.length > 0 && files.every(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
    const fields = { title: false, body: false, images: 0 };

    // 1. 先切到正确的发布类型（图文 / 视频）
    const tabs = imagesOnly ? (adapter.imageTab || []) : (adapter.videoTab || []);
    if (tabs.length && await clickByText(page, tabs)) await sleep(1500);

    // 2. 上传素材：塞给正确的 file input（不要盲取第一个）
    if (files.length) {
      let input = await pickFileInput(page, imagesOnly ? 'image' : 'video');
      if (!input) {
        await sleep(1500);
        input = await pickFileInput(page, imagesOnly ? 'image' : 'video');
      }
      if (input) {
        const before = await countThumbs(page);
        try {
          await input.setInputFiles(files.slice(0, 18), { timeout: 20000 });
          await waitUntil(async () => (await countThumbs(page)) > before, 20000);
          fields.images = Math.min(files.length, 18);
        } catch (e) {
          /* 上传失败保持 0，后续如实报告 */
        }
      }
    }

    // 3. 等编辑区渲染出来（很多平台上传完素材才显示标题/正文）
    await waitUntil(async () =>
      (await findField(page, adapter.titleSelectors)) || (await findField(page, adapter.bodySelectors)), 15000);

    const content = job.content || {};
    const title = (content.title || '').trim();
    const body = (content.body || '').trim();
    const tagList = (content.tags || '').split(/[,，\s#]+/).filter(Boolean);
    const tags = tagList.map(t => '#' + t).join(' ');
    const bodyText = [body, tags].filter(Boolean).join('\n');

    // 4. 标题
    const titleEl = (adapter.titleSelectors || []).length
      ? await findField(page, adapter.titleSelectors)
      : null;
    if (titleEl && title) {
      await writeField(page, titleEl, title.slice(0, 80));
      fields.title = await verifyField(titleEl, title.slice(0, 80));
    }

    // 5. 正文：没有独立标题框的平台（微博 / X）把标题并进正文
    const finalBody = titleEl ? bodyText : [title, bodyText].filter(Boolean).join('\n');
    const bodyEl = await findField(page, adapter.bodySelectors);
    if (bodyEl && finalBody) {
      await writeField(page, bodyEl, finalBody);
      fields.body = await verifyField(bodyEl, finalBody);
    }

    await sleep(500);
    return fields;
  }

  async runOne(pid, job, opts, emit) {
    const adapter = ADAPTERS[pid];
    if (!adapter) {
      return { pid, ok: false, stage: 'skip', message: '该平台暂不支持自动发布，请用半自动模式' };
    }
    if (adapter.manual) {
      return { pid, ok: false, stage: 'skip', message: `${adapter.name}：${adapter.note || '没有可用的网页发布入口'}，请用半自动模式` };
    }

    let page = null;
    try {
      page = await this.getPage(pid, adapter, opts.browser);
      page.setDefaultTimeout(20000);
      emit({ pid, stage: 'open', message: `打开${adapter.name}创作中心` });
      await page.goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: 35000 });

      // 登录态检测：被带到登录页说明该工作台还没登录过这个平台
      const url = page.url();
      if (/login|passport|signin|accounts\./i.test(url)) {
        const shot = await this.shot(page, pid + '-need-login');
        await page.bringToFront().catch(() => {});
        return { pid, ok: false, stage: 'login', shot,
          message: `需要先在自动发布工作台登录${adapter.name}（窗口已打开，登录后重新点发布即可）` };
      }

      await sleep(1200);
      emit({ pid, stage: 'upload', message: '上传素材并填写文案' });
      const r = await this.fillOne(page, adapter, job);

      // 6. 仅当用户显式开启「自动提交」才点发布
      let submitted = false;
      if (opts.submit) {
        for (const label of (adapter.submit || [])) {
          const btn = page.locator(`button:has-text("${label}"), [role="button"]:has-text("${label}")`).last();
          if (await btn.count()) {
            await btn.click({ timeout: 5000 }).catch(() => {});
            submitted = true;
            break;
          }
        }
        await sleep(1500);
      }

      // 7. 把窗口切到前台，让你能直接看到填好的内容
      await page.bringToFront().catch(() => {});

      const parts = [];
      if (job.content && job.content.title) parts.push('标题' + (r.title ? '✓' : '✗'));
      if (job.content && (job.content.body || job.content.tags)) parts.push('正文' + (r.body ? '✓' : '✗'));
      if (r.images) parts.push(`素材${r.images}张`);
      const needTitle = !!(job.content && job.content.title);
      const needBody = !!(job.content && (job.content.body || job.content.tags));
      const needMedia = !!(job.files && job.files.length);
      const complete = (!needTitle || r.title) && (!needBody || r.body) && (!needMedia || r.images > 0);

      const shot = await this.shot(page, pid + (submitted ? '-submitted' : '-filled'));
      if (submitted) {
        return { pid, ok: true, stage: 'submitted', fields: r, shot, uploaded: r.images,
          message: `已填写并提交（${parts.join(' ')}），请到平台后台核对是否真的发出` };
      }
      if (!complete) {
        return { pid, ok: false, stage: 'partial', fields: r, shot, uploaded: r.images,
          message: `部分内容没填进去（${parts.join(' ')}），窗口已保留，请在里面手动补全` };
      }
      return { pid, ok: true, stage: 'filled', fields: r, shot, uploaded: r.images,
        message: `已填好（${parts.join(' ')}），窗口保持打开，核对后点发布即可` };
    } catch (e) {
      const shot = page ? await this.shot(page, pid + '-error') : '';
      return { pid, ok: false, stage: 'error', shot,
        message: '自动化出错：' + (e.message || e).slice(0, 120) };
    }
    // 注意：不关闭 page，填好的内容留在窗口里给你确认
  }

  async run(jobs, opts, emit) {
    emit = emit || (() => {});
    opts = opts || {};
    if (this.busy) return [{ pid: '', ok: false, stage: 'busy', message: '已有自动发布任务在运行' }];
    this.busy = true;
    this.cancelled = false;
    const results = [];
    try {
      for (const job of jobs) {
        if (this.cancelled) break;
        emit({ pid: job.pid, stage: 'start', message: '排队中' });
        const r = await this.runOne(job.pid, job, opts, emit);
        results.push(r);
        emit(Object.assign({ type: 'result' }, r));
      }
    } finally {
      this.busy = false;
    }
    return results;
  }

  /**
   * AI 内容评分：打开豆包/DeepSeek 网页版，粘贴 prompt，抓取 AI 回复
   * @param {string} provider 'doubao' | 'deepseek'
   * @param {string} prompt  拼好的评分 prompt
   * @param {string[]} [imageDataUrls] 要上传的素材图片（base64 data URL）
   * @param {string} [browserPref]
   * @param {Function} [emit]  进度回调
   */
  async scoreContent(provider, prompt, imageDataUrls, browserPref, emit) {
    emit = emit || (() => {});
    imageDataUrls = imageDataUrls || [];
    const adapter = AI_ADAPTERS[provider];
    if (!adapter) return { ok: false, error: '不支持的 AI：' + provider };

    let page = null;
    try {
      emit({ stage: 'open', message: `打开${adapter.name}` });
      // 每个 AI 用单独的标签页（key = ai:doubao），复用登录态
      page = this.pages.get('ai:' + provider);
      if (page && page.isClosed && page.isClosed()) page = null;
      const ctx = await this.ensureContext(browserPref);
      if (!page) {
        page = await ctx.newPage();
        this.pages.set('ai:' + provider, page);
        page.on('close', () => this.pages.delete('ai:' + provider));
      }
      await page.goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await sleep(1500);

      // 登录态检测（DeepSeek 跳转的是 /sign_in，不是 /signin）
      const url = page.url();
      if (/login|passport|sign[_-]?in|sign[_-]?up|accounts\./i.test(url)) {
        await page.bringToFront().catch(() => {});
        return { ok: false, stage: 'login',
          message: `需要先在自动发布工作台登录${adapter.name}（窗口已打开，登录后重新评分即可）` };
      }

      emit({ stage: 'input', message: '写入评分内容' });
      // 要求 AI 把结果包在标记里，方便精确截取（页面上的推荐问题/广告不会被混进来）
      const fullPrompt = prompt + `\n\n【输出格式要求】请把你要输出的全部内容放在 ${AI_MARK_A} 与 ${AI_MARK_B} 两行之间，两个标记各自单独占一行；标记之外不要写任何文字。`;
      // 等输入框出现（注意：waitUntil 只返回布尔值，元素要单独接住）
      let input = null;
      await waitUntil(async () => {
        for (const sel of adapter.inputSelectors) {
          for (const frame of page.frames()) {
            try {
              const els = await frame.$$(sel);
              for (const el of els) {
                const info = await el.evaluate(e => {
                  const r = e.getBoundingClientRect();
                  const cs = getComputedStyle(e);
                  return { vis: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0, w: r.width, h: r.height };
                }).catch(() => null);
                if (info && info.vis && info.w > 50 && info.h > 20) {
                  input = el;
                  return true;
                }
              }
            } catch (e) { /* try next */ }
          }
        }
        return false;
      }, 15000);
      if (!input) return { ok: false, stage: 'error', message: '找不到输入框，页面可能改版了' };

      // 有素材图片 → 先上传图片（AI 能实际看到画面再评分）
      if (imageDataUrls.length) {
        emit({ stage: 'upload', message: `上传素材图片（${imageDataUrls.length} 张）…` });
        const uploaded = await uploadImages(page, imageDataUrls);
        if (!uploaded) {
          // 上传失败不阻断，退化为纯文字评分
          emit({ stage: 'upload', message: '图片上传失败，改用纯文字评分' });
        } else {
          await sleep(1500); // 等缩略图渲染
        }
      }

      await writeField(page, input, fullPrompt);
      await sleep(600);

      emit({ stage: 'send', message: '发送给 AI' });
      // 点发送按钮：先尝试按文本，再尝试 aria-label，最后按回车
      let sent = await clickByText(page, adapter.sendLabels);
      if (!sent) {
        // 尝试找带发送 aria-label 的按钮
        for (const frame of page.frames()) {
          try {
            const btn = await frame.$('button[aria-label*="发送"], button[aria-label*="Send"], [role="button"][aria-label*="发送"]');
            if (btn) { await btn.click(); sent = true; break; }
          } catch (e) { /* try next frame */ }
        }
      }
      if (!sent) {
        // 兜底：在输入框里按 Ctrl+Enter 或 Enter
        await input.focus().catch(() => {});
        await page.keyboard.press('Enter');
        sent = true;
      }

      emit({ stage: 'wait', message: '等待 AI 回复…' });
      // 等待回复完成：每隔 1.5s 抓取最后一条回复，连续 3 次长度不变认为完成
      let lastText = '';
      let stable = 0;
      let captcha = false;
      const deadline = Date.now() + 120000;
      await sleep(3000); // 先等 AI 开始输出
      while (Date.now() < deadline) {
        await sleep(1500);
        const cur = await page.evaluate(adapter.replyEval).catch(() => '');
        // 未登录时可能弹人机验证（选图/拖动），提前告知用户
        if (!lastText) {
          captcha = await page.evaluate(() => {
            const t = document.body ? document.body.innerText.slice(0, 2000) : '';
            return /拖动到下方|请选择所有符合|人机验证|完成验证|安全验证/i.test(t);
          }).catch(() => false);
          if (captcha) break;
        }
        if (cur && cur.length > lastText.length) {
          lastText = cur;
          stable = 0;
          emit({ stage: 'wait', message: 'AI 正在回复…（' + cur.length + ' 字）' });
        } else if (cur && cur === lastText) {
          stable++;
          if (stable >= 3) break; // 连续 3 次不变 → 完成
        }
      }

      if (captcha) {
        await page.bringToFront().catch(() => {});
        return { ok: false, stage: 'captcha',
          message: `${adapter.name} 弹出人机验证，请在打开的窗口里手动完成验证，然后重新点「开始评分」` };
      }
      if (!lastText) return { ok: false, stage: 'error', message: '没有收到 AI 回复' };

      // 优先取标记之间的内容；AI 没按要求输出时退回整段（去掉页面上的推广/推荐问题尾巴）
      const marked = extractMarked(lastText);
      const text = (marked || lastText).trim();

      await page.bringToFront().catch(() => {});
      return { ok: true, stage: 'done', text,
        message: `${adapter.name} 评分完成（${text.length} 字）` };
    } catch (e) {
      const shot = page ? await this.shot(page, 'ai-' + provider + '-error') : '';
      return { ok: false, stage: 'error', shot, message: 'AI 评分出错：' + (e.message || e).slice(0, 120) };
    }
    // 不关闭 page，保留登录态
  }
}

module.exports = { AutoRunner, ADAPTERS, AI_ADAPTERS, findBrowser };
