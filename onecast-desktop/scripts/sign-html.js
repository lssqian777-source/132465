#!/usr/bin/env node
/**
 * 对 onecast-desktop/src/onecast.html 进行 ed25519 签名，生成 onecast.html.sig。
 * 用法: node scripts/sign-html.js
 * 私钥位置: /workspace/.onecast-sign.key  (不入库)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'onecast.html');
const SIG = path.join(ROOT, 'src', 'onecast.html.sig');
const KEY = process.env.ONECAST_SIGN_KEY || '/workspace/.onecast-sign.key';

if (!fs.existsSync(KEY)) {
  console.error('私钥不存在:', KEY);
  console.error('请先生成密钥对，或通过 ONECAST_SIGN_KEY 指定私钥路径。');
  process.exit(1);
}

const html = fs.readFileSync(HTML);
const privKey = fs.readFileSync(KEY, 'utf8');
const sig = crypto.sign(null, html, { key: privKey, format: 'pem', type: 'pkcs8' });
fs.writeFileSync(SIG, sig.toString('base64') + '\n');
console.log('已签名 ->', path.relative(ROOT, SIG));
console.log('SHA-256:', crypto.createHash('sha256').update(html).digest('hex'));
