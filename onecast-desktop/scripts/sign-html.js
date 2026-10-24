#!/usr/bin/env node
/**
 * 对 onecast-desktop/src/onecast.html 进行 ed25519 签名，生成 onecast.html.sig。
 * 用法: node scripts/sign-html.js
 * 私钥按以下顺序查找（均不入库）:
 *   1. 环境变量 ONECAST_SIGN_KEY 指定的路径
 *   2. onecast-desktop/.signkey.pem
 *   3. /workspace/.onecast-sign.key
 *   4. /var/tmp/onecast-sign.key
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'onecast.html');
const SIG = path.join(ROOT, 'src', 'onecast.html.sig');
const KEY_CANDIDATES = [
  process.env.ONECAST_SIGN_KEY,
  path.join(ROOT, '.signkey.pem'),
  '/workspace/.onecast-sign.key',
  '/var/tmp/onecast-sign.key'
].filter(Boolean);
const KEY = KEY_CANDIDATES.find(p => fs.existsSync(p));

if (!KEY) {
  console.error('私钥不存在，已尝试:', KEY_CANDIDATES.join(', '));
  console.error('请先生成密钥对，或通过 ONECAST_SIGN_KEY 指定私钥路径。');
  process.exit(1);
}

const html = fs.readFileSync(HTML);
const privKey = fs.readFileSync(KEY, 'utf8');
const sig = crypto.sign(null, html, { key: privKey, format: 'pem', type: 'pkcs8' });
fs.writeFileSync(SIG, sig.toString('base64') + '\n');
console.log('已签名 ->', path.relative(ROOT, SIG));
console.log('SHA-256:', crypto.createHash('sha256').update(html).digest('hex'));
