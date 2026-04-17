#!/usr/bin/env node
/* eslint-disable */
/**
 * Email connectivity & send test. Reads the same env vars the app uses.
 *
 *   node scripts/test-email.js                       # verify only
 *   node scripts/test-email.js --send you@domain.tld # actually send
 *
 * Env:
 *   EMAIL_USER      — SMTP auth user (full address)
 *   EMAIL_PASSWORD  — SMTP password (for Google Workspace: App Password,
 *                     not the regular login password)
 *   EMAIL_FROM      — optional display/envelope from (default = EMAIL_USER)
 *   EMAIL_HOST      — optional SMTP host. If unset, uses Gmail service.
 *   EMAIL_PORT      — optional SMTP port (default 465 when EMAIL_HOST set)
 *   EMAIL_SECURE    — optional "true"/"false" (default true)
 */

const fs = require('fs');
const path = require('path');

// Best-effort .env loader — we don't want to depend on dotenv being installed.
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch {}

const nodemailer = require('nodemailer');

const user = (process.env.EMAIL_USER || '').trim();
const pass = process.env.EMAIL_PASSWORD || '';
const from = (process.env.EMAIL_FROM || user).trim();
const host = (process.env.EMAIL_HOST || '').trim();
const port = Number(process.env.EMAIL_PORT ?? 465);
const secure = (process.env.EMAIL_SECURE ?? 'true').toLowerCase() !== 'false';

if (!user || !pass) {
  console.error('✗ EMAIL_USER or EMAIL_PASSWORD not set');
  process.exit(1);
}

const transportOpts = host
  ? { host, port, secure, auth: { user, pass } }
  : { service: 'gmail', auth: { user, pass } };

console.log('→ SMTP target:   ', host ? `${host}:${port} (secure=${secure})` : 'gmail (smtp.gmail.com:465)');
console.log('→ Auth user:     ', user);
console.log('→ From address:  ', from);
console.log('→ Password shape:', `${pass.length} chars, has-space=${/\s/.test(pass)}`);
console.log();

const transporter = nodemailer.createTransport(transportOpts);

(async () => {
  try {
    await transporter.verify();
    console.log('✓ SMTP verify: OK — credentials accepted, ready to send');
  } catch (err) {
    console.error('✗ SMTP verify FAILED');
    console.error('  message: ', err && err.message);
    console.error('  code:    ', err && err.code);
    console.error('  response:', err && err.response);
    console.error('  command: ', err && err.command);
    if (err && err.response && /application-specific password|535|BadCredentials/i.test(err.response)) {
      console.error('\n  → Looks like Google rejected the password.');
      console.error('  → For Google Workspace you must use an App Password,');
      console.error('    NOT the regular account password. Enable 2FA first at');
      console.error('    https://myaccount.google.com/security, then generate one');
      console.error('    at https://myaccount.google.com/apppasswords');
    }
    process.exit(2);
  }

  const sendToArg = process.argv.indexOf('--send');
  if (sendToArg < 0) {
    console.log('\nPass --send <address> to actually send a test email.');
    return;
  }
  const to = process.argv[sendToArg + 1];
  if (!to) {
    console.error('--send requires an email address');
    process.exit(1);
  }

  try {
    const info = await transporter.sendMail({
      from: `"TirePro Support" <${from}>`,
      to,
      subject: `TirePro email test — ${new Date().toISOString()}`,
      text: `If you are reading this, SMTP auth and delivery are working.\nUser: ${user}\nHost: ${host || 'gmail'}`,
      html: `<p>If you are reading this, SMTP auth and delivery are working.</p>
             <ul><li>User: <code>${user}</code></li><li>Host: <code>${host || 'gmail'}</code></li></ul>`,
    });
    console.log(`✓ Sent to ${to}. messageId=${info.messageId}`);
    if (info.accepted && info.accepted.length) console.log('  accepted:', info.accepted);
    if (info.rejected && info.rejected.length) console.log('  rejected:', info.rejected);
  } catch (err) {
    console.error('✗ sendMail FAILED');
    console.error('  message: ', err && err.message);
    console.error('  code:    ', err && err.code);
    console.error('  response:', err && err.response);
    process.exit(3);
  }
})();
