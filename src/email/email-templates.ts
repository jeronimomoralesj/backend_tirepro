// =============================================================================
// EMAIL TEMPLATE SYSTEM
// =============================================================================
// Single source of truth for transactional email chrome. Every email — from
// verification to order updates — flows through `wrapEmail()` so they share
// the same header, hero, footer, and visual language. Helpers below let
// callers compose typed body sections (CTA, product cards, key-value
// summaries, callout boxes) without dropping into raw HTML.
//
// Constraints email clients impose:
//   - No flexbox / grid (Outlook). Layout is table-based.
//   - All styles inline (Gmail strips <style> blocks in the iframe).
//   - Web-safe fonts only ("system-ui" + Helvetica fallback).
//   - Background images are unreliable; use solid colors and gradients.
//   - Max width 600px (industry standard for mobile + desktop balance).
// =============================================================================

const BRAND = {
  navy:    '#0A183A',
  blue:    '#1E76B6',
  sky:     '#F0F7FF',
  ink:     '#0A183A',
  text:    '#1F2937',
  muted:   '#6B7280',
  hairline:'#E5E7EB',
} as const;

// Canonical TirePro logo. Hosted on the production marketplace host so
// emails archived for months don't break — moving the asset means
// updating it here, nowhere else.
const LOGO_URL = 'https://www.tirepro.com.co/logo_full.png';
const SITE_URL = 'https://www.tirepro.com.co';

export type Accent = 'brand' | 'success' | 'warning' | 'danger';

const ACCENT_GRADIENTS: Record<Accent, string> = {
  brand:   'linear-gradient(135deg, #0A183A 0%, #1E76B6 100%)',
  success: 'linear-gradient(135deg, #15803D 0%, #22C55E 100%)',
  warning: 'linear-gradient(135deg, #B45309 0%, #F59E0B 100%)',
  danger:  'linear-gradient(135deg, #991B1B 0%, #EF4444 100%)',
};

const ACCENT_FALLBACK: Record<Accent, string> = {
  brand:   '#1E76B6',
  success: '#22C55E',
  warning: '#F59E0B',
  danger:  '#EF4444',
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SHELL
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailShellOptions {
  /** Hidden preheader text — shows in the inbox preview line. */
  preheader?: string;
  /** Hero accent (controls the band color). Default 'brand'. */
  accent?: Accent;
  /** Hero headline (shown in white on the accent band). */
  title: string;
  /** Optional eyebrow line above the title (uppercase, tracked). */
  eyebrow?: string;
  /** Optional subtitle below the title. */
  subtitle?: string;
  /** Free-form body HTML — composed via the helpers below. */
  body: string;
}

export function wrapEmail(opts: EmailShellOptions): string {
  const accent = opts.accent ?? 'brand';
  const accentColor = ACCENT_FALLBACK[accent];
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>TirePro</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.text};-webkit-font-smoothing:antialiased;">
${opts.preheader ? `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
  <tr><td align="center" style="padding:24px 12px;background:#ffffff;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;">

      <!-- LOGO HEADER -->
      <tr><td style="padding:8px 32px 24px;background:#ffffff;">
        <a href="${SITE_URL}" style="text-decoration:none;display:inline-block;">
          <img src="${LOGO_URL}" alt="TirePro" height="28" style="display:block;height:28px;width:auto;border:0;outline:none;" />
        </a>
      </td></tr>

      <!-- HERO — kept minimal: a thin colored accent line + typography
           on a fully white background. Replaces the old gradient band
           per "all-white background on every email" — accent stays
           only as a 3px top line and as the eyebrow text color so the
           email type (success / warning / danger) is still legible. -->
      <tr><td style="padding:0 32px;background:#ffffff;">
        <div style="height:3px;width:48px;background:${accentColor};margin-bottom:18px;"></div>
        ${opts.eyebrow ? `<p style="margin:0 0 10px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${accentColor};">${escapeHtml(opts.eyebrow)}</p>` : ''}
        <h1 style="margin:0;font-size:26px;font-weight:900;line-height:1.2;color:${BRAND.navy};">${escapeHtml(opts.title)}</h1>
        ${opts.subtitle ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:${BRAND.muted};">${escapeHtml(opts.subtitle)}</p>` : ''}
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:28px 32px 32px;background:#ffffff;color:${BRAND.text};font-size:14px;line-height:1.6;">
        ${opts.body}
      </td></tr>

      <!-- FOOTER — also white now. Hairline divider keeps it visually
           separated from the body without introducing a dark band. -->
      <tr><td style="padding:24px 32px;background:#ffffff;color:${BRAND.muted};font-size:12px;line-height:1.55;text-align:center;border-top:1px solid ${BRAND.hairline};">
        <p style="margin:0 0 6px;font-weight:800;color:${BRAND.navy};letter-spacing:1px;">TirePro</p>
        <p style="margin:0 0 8px;color:${BRAND.muted};">La plataforma de llantas para Colombia</p>
        <p style="margin:0 0 12px;">
          <a href="${SITE_URL}" style="color:${BRAND.blue};text-decoration:none;font-weight:700;">tirepro.com.co</a>
          <span style="color:${BRAND.hairline};margin:0 6px;">·</span>
          <a href="mailto:info@tirepro.com.co" style="color:${BRAND.blue};text-decoration:none;">info@tirepro.com.co</a>
        </p>
        <p style="margin:0;font-size:10px;color:${BRAND.muted};">Bogotá, Colombia</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BODY HELPERS — compose with these inside the `body` slot.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hero CTA — full-width on mobile, fixed-width on desktop. The bulletproof
 * pattern uses a table + VML fallback for Outlook so the rounded corners
 * survive everywhere.
 */
export function emailButton(label: string, href: string, opts: { color?: 'brand' | 'success' | 'danger'; size?: 'lg' | 'md' } = {}): string {
  const color = opts.color ?? 'brand';
  const bg = color === 'success' ? '#16A34A' : color === 'danger' ? '#DC2626' : BRAND.blue;
  const padding = opts.size === 'lg' ? '16px 32px' : '14px 28px';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto;"><tr><td align="center" style="border-radius:10px;background:${bg};">
    <a href="${escapeAttr(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:${padding};font-size:14px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:10px;background:${bg};letter-spacing:0.2px;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

/**
 * Plain paragraph with sensible defaults. Use for the "Hola, …" body copy.
 */
export function emailText(html: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:${BRAND.text};">${html}</p>`;
}

export function emailLead(html: string): string {
  return `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${BRAND.text};">${html}</p>`;
}

/**
 * Tinted callout box for warnings, expirations, cancellation reasons, etc.
 */
export function emailCallout(opts: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; body: string }): string {
  const tone = opts.tone ?? 'info';
  const palette = {
    info:    { bg: '#EFF6FF', border: '#1E76B6', text: '#0A183A' },
    success: { bg: '#F0FDF4', border: '#16A34A', text: '#14532D' },
    warning: { bg: '#FFFBEB', border: '#F59E0B', text: '#7C2D12' },
    danger:  { bg: '#FEF2F2', border: '#EF4444', text: '#7F1D1D' },
  }[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
    <tr><td style="padding:14px 16px;background:${palette.bg};border-left:4px solid ${palette.border};border-radius:8px;color:${palette.text};font-size:13px;line-height:1.55;">
      ${opts.title ? `<p style="margin:0 0 4px;font-weight:800;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;">${escapeHtml(opts.title)}</p>` : ''}
      <div>${opts.body}</div>
    </td></tr></table>`;
}

/**
 * Key-value list rendered as two-column rows. Use for order summary,
 * verification expirations, etc.
 */
export function emailKvList(rows: Array<{ label: string; value: string; bold?: boolean }>): string {
  const trs = rows.map((r) => `<tr>
    <td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">${escapeHtml(r.label)}</td>
    <td align="right" style="padding:6px 0;font-size:13px;font-weight:${r.bold ? '800' : '700'};color:${r.bold ? BRAND.navy : BRAND.text};">${r.value}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${trs}</table>`;
}

/**
 * Payment breakdown — Subtotal / IVA (19%) / Total pagado. Mirrors
 * the Resumen block on the cart and order tracking page so the
 * email receipt matches what the buyer's card statement will show
 * (gross, with IVA). Pass the per-order net subtotal (totalCop in
 * the schema); IVA is computed on the fly. The "Total pagado" row
 * is visually emphasised with a top border to read like a receipt.
 */
export function emailPaymentBreakdown(subtotalCop: number, ivaRate = 0.19): string {
  const iva = Math.round(subtotalCop * ivaRate);
  const total = subtotalCop + iva;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background:#ffffff;border:1px solid ${BRAND.hairline};border-radius:12px;">
    <tr><td style="padding:14px 16px 6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:${BRAND.blue};">Resumen de pago</td></tr>
    <tr>
      <td style="padding:0 16px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:4px 0;font-size:13px;color:${BRAND.muted};">Subtotal</td>
            <td align="right" style="padding:4px 0;font-size:13px;font-weight:700;color:${BRAND.text};">${fmtCOP(subtotalCop)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;font-size:13px;color:${BRAND.muted};">IVA (19%)</td>
            <td align="right" style="padding:4px 0;font-size:13px;font-weight:700;color:${BRAND.text};">${fmtCOP(iva)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0 12px;font-size:14px;font-weight:800;color:${BRAND.navy};border-top:1px dashed ${BRAND.hairline};">Total pagado</td>
            <td align="right" style="padding:8px 0 12px;font-size:14px;font-weight:900;color:${BRAND.navy};border-top:1px dashed ${BRAND.hairline};">${fmtCOP(total)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

/**
 * Product card — used in order/cancellation/status emails. Renders the
 * cover image, marca/modelo headline, dimension, qty, and total.
 */
export function emailProductCard(opts: {
  imageUrl?: string | null;
  marca: string;
  modelo: string;
  dimension: string;
  quantity?: number;
  totalLabel?: string;
  totalValue?: string;
}): string {
  const img = opts.imageUrl
    ? `<img src="${escapeAttr(opts.imageUrl)}" alt="" width="64" height="64" style="display:block;width:64px;height:64px;border-radius:10px;background:#ffffff;object-fit:contain;border:1px solid ${BRAND.hairline};" />`
    : `<div style="width:64px;height:64px;border-radius:10px;background:#ffffff;border:1px solid ${BRAND.hairline};"></div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background:#ffffff;border:1px solid ${BRAND.hairline};border-radius:12px;">
    <tr>
      <td width="80" style="padding:14px 0 14px 14px;vertical-align:middle;">${img}</td>
      <td style="padding:14px;vertical-align:middle;">
        <p style="margin:0;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:${BRAND.blue};">${escapeHtml(opts.marca)}</p>
        <p style="margin:2px 0 0;font-size:15px;font-weight:800;color:${BRAND.navy};line-height:1.3;">${escapeHtml(opts.modelo)}</p>
        <p style="margin:4px 0 0;font-size:12px;color:${BRAND.muted};">${escapeHtml(opts.dimension)}${opts.quantity ? ` · ${opts.quantity} unid.` : ''}</p>
      </td>
      ${opts.totalValue ? `<td align="right" style="padding:14px;vertical-align:middle;">
        ${opts.totalLabel ? `<p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:${BRAND.muted};">${escapeHtml(opts.totalLabel)}</p>` : ''}
        <p style="margin:2px 0 0;font-size:15px;font-weight:900;color:${BRAND.navy};">${escapeHtml(opts.totalValue)}</p>
      </td>` : ''}
    </tr>
  </table>`;
}

/**
 * Subtle divider — section break inside the body.
 */
export function emailDivider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td style="border-top:1px solid ${BRAND.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/**
 * "Sectional" eyebrow — label above a grouping (Producto, Cliente, etc.).
 */
export function emailLabel(text: string): string {
  return `<p style="margin:0 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.4px;color:${BRAND.muted};">${escapeHtml(text)}</p>`;
}

/**
 * Tiny copy-the-link block under buttons — accessibility + mail-client
 * fallback when the button doesn't render or click-through is blocked.
 */
export function emailFallbackLink(href: string, prefix = 'O copia este enlace:'): string {
  return `<p style="margin:18px 0 0;font-size:11px;color:${BRAND.muted};text-align:center;line-height:1.5;">${escapeHtml(prefix)}<br/><a href="${escapeAttr(href)}" style="color:${BRAND.blue};word-break:break-all;text-decoration:underline;">${escapeHtml(href)}</a></p>`;
}

/**
 * Currency formatter — every email shows COP, all without decimals.
 */
export function fmtCOP(n: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// ESCAPING — keep injected user data from breaking the HTML.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DATA-VISUALIZATION HELPERS — email-safe charts using HTML tables + inline CSS
// ─────────────────────────────────────────────────────────────────────────────

export function emailDataTable(opts: {
  title?: string;
  columns: string[];
  rows: string[][];
  highlightCol?: number;
}): string {
  const header = opts.columns
    .map(
      (c) =>
        `<th style="padding:8px 10px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.8px;color:${BRAND.muted};background:#F9FAFB;border-bottom:2px solid ${BRAND.hairline};text-align:left;">${escapeHtml(c)}</th>`,
    )
    .join('');
  const body = opts.rows
    .map(
      (row, ri) =>
        `<tr>${row
          .map(
            (cell, ci) =>
              `<td style="padding:7px 10px;font-size:13px;color:${ci === opts.highlightCol ? BRAND.navy : BRAND.text};font-weight:${ci === opts.highlightCol ? '700' : '400'};border-bottom:1px solid ${BRAND.hairline};${ri % 2 === 1 ? 'background:#FAFBFC;' : ''}">${escapeHtml(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `${opts.title ? `<p style="margin:0 0 8px;font-size:13px;font-weight:800;color:${BRAND.navy};">${escapeHtml(opts.title)}</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.hairline};">
      <tr>${header}</tr>${body}
    </table>`;
}

export function emailBarChart(opts: {
  title?: string;
  unit?: string;
  data: { label: string; value: number; color?: string }[];
}): string {
  const maxVal = Math.max(...opts.data.map((d) => d.value), 1);
  const palette = ['#1E76B6', '#0A183A', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#8b5cf6', '#14b8a6'];
  const bars = opts.data
    .map(
      (d, i) => {
        const pct = Math.round((d.value / maxVal) * 100);
        const color = d.color || palette[i % palette.length];
        return `<tr>
          <td style="padding:4px 0;font-size:12px;color:${BRAND.text};width:30%;white-space:nowrap;">${escapeHtml(d.label)}</td>
          <td style="padding:4px 8px;width:55%;">
            <div style="background:#F3F4F6;border-radius:4px;height:18px;width:100%;">
              <div style="background:${color};border-radius:4px;height:18px;width:${pct}%;min-width:${pct > 0 ? '4px' : '0'};"></div>
            </div>
          </td>
          <td style="padding:4px 0;font-size:12px;font-weight:700;color:${BRAND.navy};text-align:right;white-space:nowrap;">${d.value}${opts.unit ? ' ' + escapeHtml(opts.unit) : ''}</td>
        </tr>`;
      },
    )
    .join('');
  return `${opts.title ? `<p style="margin:0 0 8px;font-size:13px;font-weight:800;color:${BRAND.navy};">${escapeHtml(opts.title)}</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${bars}</table>`;
}

export function emailPieList(opts: {
  title?: string;
  data: { label: string; value: number; color?: string }[];
}): string {
  const total = opts.data.reduce((s, d) => s + d.value, 0) || 1;
  const palette = ['#1E76B6', '#0A183A', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#8b5cf6', '#14b8a6'];
  const rows = opts.data
    .map(
      (d, i) => {
        const pct = Math.round((d.value / total) * 100);
        const color = d.color || palette[i % palette.length];
        return `<tr>
          <td style="padding:5px 0;width:16px;"><div style="width:12px;height:12px;border-radius:3px;background:${color};"></div></td>
          <td style="padding:5px 8px;font-size:13px;color:${BRAND.text};">${escapeHtml(d.label)}</td>
          <td style="padding:5px 0;font-size:13px;font-weight:700;color:${BRAND.navy};text-align:right;">${d.value}</td>
          <td style="padding:5px 0 5px 6px;font-size:12px;color:${BRAND.muted};text-align:right;width:40px;">${pct}%</td>
        </tr>`;
      },
    )
    .join('');
  return `${opts.title ? `<p style="margin:0 0 8px;font-size:13px;font-weight:800;color:${BRAND.navy};">${escapeHtml(opts.title)}</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${rows}</table>`;
}

export function emailGauge(opts: {
  label: string;
  value: number;
  max?: number;
  unit?: string;
}): string {
  const max = opts.max ?? 100;
  const pct = Math.max(0, Math.min(100, Math.round((opts.value / max) * 100)));
  const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
    <tr>
      <td style="padding:0 12px 0 0;">
        <div style="width:56px;height:56px;border-radius:50%;border:5px solid #F3F4F6;position:relative;text-align:center;line-height:46px;">
          <div style="position:absolute;top:0;left:0;width:56px;height:56px;border-radius:50%;border:5px solid ${color};border-color:${color} ${pct >= 75 ? color : '#F3F4F6'} ${pct >= 50 ? color : '#F3F4F6'} ${pct >= 25 ? color : '#F3F4F6'};"></div>
          <span style="font-size:16px;font-weight:800;color:${BRAND.navy};position:relative;">${pct}%</span>
        </div>
      </td>
      <td style="padding:0;">
        <p style="margin:0;font-size:13px;font-weight:700;color:${BRAND.navy};">${escapeHtml(opts.label)}</p>
        ${opts.unit ? `<p style="margin:2px 0 0;font-size:11px;color:${BRAND.muted};">${escapeHtml(opts.unit)}</p>` : ''}
      </td>
    </tr></table>`;
}

export function emailMetricRow(metrics: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' }[]): string {
  const toneColors = { good: '#10b981', warn: '#f59e0b', bad: '#ef4444', neutral: BRAND.navy };
  const cols = metrics
    .map(
      (m) => {
        const color = m.tone ? toneColors[m.tone] : BRAND.navy;
        return `<td style="padding:12px;text-align:center;background:#FAFBFC;border-radius:8px;">
          <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND.muted};">${escapeHtml(m.label)}</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:800;color:${color};">${escapeHtml(m.value)}</p>
        </td>`;
      },
    )
    .join(`<td style="width:8px;"></td>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr>${cols}</tr></table>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/"/g, '&quot;');
}
