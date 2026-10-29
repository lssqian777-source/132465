/**
 * OneCast 自动发布引擎（实验性）
 *
 * 原理：用 playwright-core 驱动本机已安装的 Chrome / Edge，在一个独立的浏览器
 * 配置文件（%APPDATA%/OneCast/browser-profile）里打开各平台创作中心，复用你
 * 在该配置文件中的登录态。
 *
 * 重要说明：
 * - 不读取、不复制你日常浏览器的 Cookie 和密码，登录需要在该工作台里单独完成一次。
 * - 默认只「自动填表」（上传素材 + 填标题正文），最后一步由你人工点击发布。
 *   只有显式开启 submit 才会尝试点击发布按钮。
 * - 平台页面随时可能改版，本引擎按文本/结构做启发式匹配，失败时会保留截图与日志，
 *   存放在 %APPDATA%/OneCast/automation-logs/ 便于排查。
 */
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

/** 各平台适配信息（启发式，不依赖固定元素 id） */
const ADAPTERS = {
  douyin: {
    name: '抖音',
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    prepare: ['发布图文', '图文'],
    submit: ['发布', '立即发布'],
    titleInput: 'input[placeholder*="标题"], input[placeholder*="填写"]',
    note: '图文最多 35 张；封面在发布页单独设置'
  },
  xiaohongshu: {
    name: '小红书',
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    prepare: ['上传图文', '图文'],
    submit: ['发布', '发布笔记'],
    titleInput: 'input[placeholder*="标题"]',
    note: '标题上限 20 字；正文里的话题用 #话题# 形式'
  },
  bilibili: {
    name: 'B 站',
    url: 'https://t.bilibili.com/publish',
    prepare: [],
    submit: ['发布', '发送'],
    titleInput: null,
    note: '图文走「动态」，视频走投稿页；动态正文上限较低'
  },
  weibo: {
    name: '微博',
    url: 'https://weibo.com/compose',
    prepare: [],
    submit: ['发送', '发布'],
    titleInput: null,
    note: '正文 140 字；图片最多 9 张'
  },
  x: {
    name: 'X',
    url: 'https://x.com/compose/post',
    prepare: [],
    submit: ['Post', '发布'],
    titleInput: null,
    note: '280 字符；图片最多 4 张'
  },
  instagram: {
    name: 'Instagram',
    url: 'https://www.instagram.com/',
    prepare: [],
    submit: ['Share', '分享'],
    titleInput: null,
    note: '网页版发布能力有限，建议手动'
  },
  wechat: {
    name: '微信（视频号/贴图）',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    prepare: [],
    submit: [],
    titleInput: null,
    note: '视频号/朋友圈没有可用的网页发布接口，只能手动'
  }
};

/** 查找本机 Chrome / Edge 可执行文件 */
function findBrowser() {
  if (process.platform !== 'win32') return null;
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of roots) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      /* keep probing */
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class AutoRunner {
  constructor(userDataDir) {
    this.profileDir = path.join(userDataDir, 'browser-profile');
    this.logDir = path.join(userDataDir, 'automation-logs');
    this.context = null;
    this.busy = false;
    this.cancelled = false;
  }

  async ensureContext() {
    if (this.context) return this.context;
    fs.mkdirSync(this.profileDir, { recursive: true });
    const exe = findBrowser();
    if (!exe) throw new Error('未找到本机 Chrome 或 Edge，请先安装其中一个浏览器');
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: exe,
      headless: false,
      viewport: null,
      locale: 'zh-CN',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled']
    });
    this.context.on('close', () => { this.context = null; });
    return this.context;
  }

  async close() {
    const ctx = this.context;
    this.context = null;
    if (ctx) {
      try { await ctx.close(); } catch (e) { /* already gone */ }
    }
  }

  /** 打开工作台让用户登录（只打开首页，不做任何操作） */
  async openWorkbench() {
    const ctx = await this.ensureContext();
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

  /** 通用填表：上传素材 → 填标题/正文 → （可选）点发布 */
  async fillOne(page, adapter, job, opts) {
    const files = (job.files || []).filter(f => f && fs.existsSync(f.path)).map(f => f.path);
    let uploaded = 0;

    // 1. 素材上传：直接给 input[type=file] 塞文件，避免依赖按钮位置
    if (files.length) {
      let input = page.locator('input[type=file]').first();
      if (await input.count() === 0) {
        // 某些平台要先进「上传/图文」页签才会出现 file input
        for (const t of (adapter.prepare || [])) {
          const btn = page.locator(`text=${t}`).first();
          if (await btn.count()) { await btn.click({ timeout: 3000 }).catch(() => {}); await sleep(1200); break; }
        }
        input = page.locator('input[type=file]').first();
      }
      if (await input.count() > 0) {
        try {
          await input.setInputFiles(files.slice(0, 18), { timeout: 15000 });
          uploaded = Math.min(files.length, 18);
          // 等缩略图生成 / 上传完成（经验值，超时也不阻塞后续填字）
          await sleep(Math.min(4000 + uploaded * 900, 12000));
        } catch (e) {
          /* 上传失败会在下面的截图里体现 */
        }
      }
    }

    // 2. 文本填写：标题（若有独立标题框）→ 正文
    const content = job.content || {};
    const title = (content.title || '').trim();
    const body = (content.body || '').trim();
    const tags = (content.tags || '').trim();

    if (title) {
      const titleSel = adapter.titleInput || 'input[placeholder*="标题"]';
      const t = page.locator(titleSel).first();
      if (await t.count()) {
        await t.click({ timeout: 3000 }).catch(() => {});
        await t.fill('').catch(() => {});
        await page.keyboard.insertText(title.slice(0, 80));
      }
    }
    if (body || tags) {
      const text = [body, tags ? tags.split(/[,，\s]+/).filter(Boolean).map(t => t.startsWith('#') ? t : '#' + t).join(' ') : '']
        .filter(Boolean).join('\n');
      // 选可见且面积最大的可写区作为正文，避免误填到隐藏的小编辑框
      const hasBody = await page.evaluate(() => {
        const vis = [...document.querySelectorAll('[contenteditable="true"], textarea')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 30 && r.height > 20;
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          })[0];
        if (!vis) return false;
        vis.focus();
        return true;
      });
      if (hasBody) await page.keyboard.insertText(text);
    }

    await sleep(600);

    // 3. 仅当用户显式开启「自动提交」才点发布
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

    return { uploaded, submitted };
  }

  async runOne(pid, job, opts, emit) {
    const adapter = ADAPTERS[pid];
    if (!adapter) {
      return { pid, ok: false, stage: 'skip', message: '该平台暂不支持自动发布，请用半自动模式' };
    }
    if (pid === 'wechat') {
      return { pid, ok: false, stage: 'skip', message: '微信视频号/贴图没有网页发布入口，请用半自动模式' };
    }

    let page = null;
    try {
      const ctx = await this.ensureContext();
      page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      emit({ pid, stage: 'open', message: `打开${adapter.name}创作中心` });
      await page.goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: 35000 });

      // 登录态检测：被带到登录页说明该工作台还没登录过这个平台
      const url = page.url();
      if (/login|passport|signin|accounts\./i.test(url)) {
        const shot = await this.shot(page, pid + '-need-login');
        await page.bringToFront().catch(() => {});
        return { pid, ok: false, stage: 'login',
          message: `需要先在自动发布工作台登录${adapter.name}（窗口已打开，登录后重新点发布即可）`, shot };
      }

      await sleep(1200);
      emit({ pid, stage: 'upload', message: '上传素材并填写文案' });
      const r = await this.fillOne(page, adapter, job, opts);

      const shot = await this.shot(page, pid + (opts.submit ? '-submitted' : '-filled'));
      if (opts.submit && !r.submitted) {
        await page.bringToFront().catch(() => {});
        return { pid, ok: true, stage: 'filled', uploaded: r.uploaded,
          message: '已填好，但没找到发布按钮：请手动确认后发布', shot };
      }
      return {
        pid, ok: true, stage: opts.submit ? 'submitted' : 'filled',
        uploaded: r.uploaded,
        message: opts.submit
          ? `已填好并提交（上传 ${r.uploaded} 个素材），请在平台内确认结果`
          : `已填好（上传 ${r.uploaded} 个素材），请在平台内检查并点击发布`,
        shot
      };
    } catch (e) {
      const shot = page ? await this.shot(page, pid + '-error') : '';
      return { pid, ok: false, stage: 'error', message: '自动化出错：' + (e.message || e).slice(0, 120), shot };
    } finally {
      if (page) await page.close().catch(() => {});
    }
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
}

module.exports = { AutoRunner, ADAPTERS, findBrowser };
