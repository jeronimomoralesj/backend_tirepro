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
  const gradient = ACCENT_GRADIENTS[accent];
  const fallback = ACCENT_FALLBACK[accent];
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>TirePro</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.text};-webkit-font-smoothing:antialiased;">
${opts.preheader ? `<div style="display:none;font-size:1px;color:#f5f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px -12px rgba(10,24,58,0.18);">

      <!-- LOGO HEADER -->
      <tr><td style="padding:24px 32px 20px;background:#ffffff;border-bottom:1px solid ${BRAND.hairline};">
        <a href="${SITE_URL}" style="text-decoration:none;display:inline-block;">
          <img src="${LOGO_URL}" alt="TirePro" height="28" style="display:block;height:28px;width:auto;border:0;outline:none;" />
        </a>
      </td></tr>

      <!-- HERO BAND -->
      <tr><td style="padding:36px 32px;background:${fallback};background-image:${gradient};color:#ffffff;">
        ${opts.eyebrow ? `<p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.85);">${escapeHtml(opts.eyebrow)}</p>` : ''}
        <h1 style="margin:0;font-size:24px;font-weight:900;line-height:1.2;color:#ffffff;">${escapeHtml(opts.title)}</h1>
        ${opts.subtitle ? `<p style="margin:10px 0 0;font-size:14px;line-height:1.55;color:rgba(255,255,255,0.92);">${escapeHtml(opts.subtitle)}</p>` : ''}
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:32px;background:#ffffff;color:${BRAND.text};font-size:14px;line-height:1.6;">
        ${opts.body}
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="padding:24px 32px;background:${BRAND.navy};color:rgba(255,255,255,0.72);font-size:12px;line-height:1.55;text-align:center;">
        <p style="margin:0 0 6px;font-weight:800;color:#ffffff;letter-spacing:1px;">TirePro</p>
        <p style="margin:0 0 8px;">La plataforma de llantas para Colombia</p>
        <p style="margin:0 0 12px;">
          <a href="${SITE_URL}" style="color:rgba(255,255,255,0.85);text-decoration:none;font-weight:700;">tirepro.com.co</a>
          <span style="opacity:0.4;margin:0 6px;">·</span>
          <a href="mailto:info@tirepro.com.co" style="color:rgba(255,255,255,0.85);text-decoration:none;">info@tirepro.com.co</a>
        </p>
        <p style="margin:0;font-size:10px;color:rgba(255,255,255,0.4);">Bogotá, Colombia</p>
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
    ? `<img src="${escapeAttr(opts.imageUrl)}" alt="" width="64" height="64" style="display:block;width:64px;height:64px;border-radius:10px;background:#F0F7FF;object-fit:contain;border:1px solid ${BRAND.hairline};" />`
    : `<div style="width:64px;height:64px;border-radius:10px;background:#F0F7FF;border:1px solid ${BRAND.hairline};"></div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background:#FAFBFC;border:1px solid ${BRAND.hairline};border-radius:12px;">
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
