import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleService } from '../vehicles/vehicle.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CatalogService } from '../catalog/catalog.service';
import { S3Service } from './s3.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import {
  EjeType,
  TireAlertLevel,
  TireEventType,
  VidaValue,
  MotivoFinVida,
  InspeccionSource,
  Prisma,
} from '@prisma/client';
import * as XLSX from 'xlsx';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

const C = {
  KM_POR_MES:                  6_000,
  MS_POR_DIA:                  86_400_000,
  PREMIUM_TIRE_EXPECTED_KM:    120_000,  // legacy — bulk upload now uses catalog or 80k fallback
  STANDARD_TIRE_EXPECTED_KM:   80_000,  // updated default when catalog has no data
  SIGNIFICANT_WEAR_MM:         10,
  RECENT_REGISTRATION_DAYS:    30,
  DEFAULT_PROFUNDIDAD_INICIAL: 22,
  REENCAUCHE_COST:             650_000,
  FALLBACK_TIRE_PRICE:         1_900_000,
  PREMIUM_TIRE_THRESHOLD:      2_100_000,
  LIMITE_LEGAL_MM:             2,
  PRESSURE_UNDER_WARN_PSI:     10,
  PRESSURE_UNDER_CRIT_PSI:     20,
  PRESSURE_HEALTH_PENALTY_PER_5PSI: 4,
  PRESSURE_MAX_HEALTH_PENALTY: 20,

  // ── Expert thresholds (from tire engineering knowledge) ──────────────────
  OPTIMAL_RETIREMENT_MM:       3,     // Best point for retreadable casing preservation
  ALIGNMENT_WARN_MM:           1.5,   // Unilateral shoulder delta → alignment needed
  ALIGNMENT_SEVERE_MM:         3.0,   // Severe alignment issue
  DUAL_HARMONY_MAX_DELTA_MM:   3.0,   // Max depth diff between dual/twin tires
  ROTATION_INTERVAL_KM:        10_000, // Recommend rotation every 10K km
  REGRABADO_MIN_MM:            3.0,   // Min depth for regrooving eligibility
  REGRABADO_MAX_MM:            4.5,   // Max depth for regrooving (above this, not needed yet)
} as const;

// Valid axle positions per tire design type — for application match validation
const VALID_DESIGN_AXLE: Record<string, EjeType[]> = {
  direccional:    [EjeType.direccion],
  traccion:       [EjeType.traccion],
  toda_posicion:  [EjeType.direccion, EjeType.traccion, EjeType.libre, EjeType.remolque],
  mixto:          [EjeType.direccion, EjeType.traccion, EjeType.libre],
  regional:       [EjeType.traccion, EjeType.libre, EjeType.remolque],
};

const VIDA_SEQUENCE: VidaValue[] = [
  VidaValue.nueva,
  VidaValue.reencauche1,
  VidaValue.reencauche2,
  VidaValue.reencauche3,
  VidaValue.fin,
];

const VALID_VIDA_SET = new Set<string>(VIDA_SEQUENCE);

// =============================================================================
// Fuzzy-matching helpers for bulk upload brand / design / dimension correction
// =============================================================================

/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[] = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    let prev = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val  = Math.min(dp[j] + 1, prev + 1, dp[j - 1] + cost);
      dp[j - 1] = prev;
      prev       = val;
    }
    dp[lb] = prev;
  }
  return dp[lb];
}

/**
 * Collapse a name to its alphanumeric core so punctuation / separator
 * variants compare equal. "HDR2 SA", "HDR2+SA", "HDR2-SA", "hdr2sa"
 * all normalize to "hdr2sa".
 */
function normalizeMatchKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Multiset character-overlap ratio: |intersection| / max(|a|, |b|).
 * Used to distinguish typos (high overlap) from coincidentally
 * similar-length names (low overlap). "contiennetal" vs "continental"
 * shares 11/12 chars ≈ 0.92; "retectire" vs "nexentire" shares 6/9 ≈ 0.67.
 */
function charOverlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const count = (s: string) => {
    const m: Record<string, number> = {};
    for (const ch of s) m[ch] = (m[ch] ?? 0) + 1;
    return m;
  };
  const ca = count(a), cb = count(b);
  let inter = 0;
  for (const k in ca) if (cb[k]) inter += Math.min(ca[k], cb[k]);
  return inter / Math.max(a.length, b.length);
}

/**
 * Find the best match from a list of known values. Returns the match if
 * the edit distance is within the tolerance threshold, otherwise null.
 *
 * Matching tiers (first hit wins):
 *  1. Case-insensitive exact match
 *  2. Normalized-key exact match (ignores spaces / +, -, /, etc.)
 *  3. Levenshtein on normalized keys, with layered guards:
 *       - first character must match (brand typos almost never flip the
 *         leading letter; this alone kills most false positives)
 *       - length delta ≤ 2
 *       - absolute distance ≤ 2 (distance = 3 allowed only when the
 *         multiset char-overlap is ≥ 0.85, covering 3-letter shuffles
 *         like "Contiennetal" → "Continental" without catching
 *         "retectire" → "nexentire")
 */
function fuzzyMatch(input: string, known: string[]): string | null {
  if (!input) return null;
  const lo = input.toLowerCase();

  // 1. Case-insensitive exact match (fast path)
  const exact = known.find(k => k.toLowerCase() === lo);
  if (exact) return exact;

  // 2. Punctuation-insensitive match — handles "HDR2 SA" ↔ "HDR2+SA"
  const normInput = normalizeMatchKey(input);
  if (!normInput) return null;
  const punctMatch = known.find(k => normalizeMatchKey(k) === normInput);
  if (punctMatch) return punctMatch;

  // 3. Levenshtein on normalized keys — only for strings long enough to
  // have real typos. Short product codes like "HDR2" vs "HDR3" or
  // "KMAX" vs "KMAXD" are distinct SKUs, not typos, so we skip fuzzy
  // matching when the normalized input is ≤ 5 chars.
  if (normInput.length <= 5) return null;

  let bestMatch: string | null = null;
  let bestDist  = Infinity;

  for (const candidate of known) {
    const normCand = normalizeMatchKey(candidate);
    if (!normCand || normCand.length <= 5) continue;
    if (normCand[0] !== normInput[0]) continue;
    if (Math.abs(normCand.length - normInput.length) > 2) continue;

    const dist = levenshtein(normInput, normCand);
    if (dist > 3) continue;

    if (dist <= 2) {
      if (charOverlapRatio(normInput, normCand) < 0.6) continue;
    } else {
      // dist === 3: only accept when multisets are nearly identical
      // ("Contiennetal" → "Continental" yes, "retectire" → "nexentire" no).
      if (charOverlapRatio(normInput, normCand) < 0.85) continue;
    }

    if (dist < bestDist) {
      bestDist  = dist;
      bestMatch = candidate;
    }
  }
  return bestMatch;
}

/**
 * Normalize a tire dimension string to a canonical format.
 * Handles common variations users type:
 *   "12r22.5"   → "12 R 22.5"
 *   "12R22.5"   → "12 R 22.5"
 *   "12 r 22.5" → "12 R 22.5"
 *   "295/80r22.5" → "295/80 R 22.5"
 *   "295/80R22.5" → "295/80 R 22.5"
 *   "11 R 22.5"   → "11 R 22.5" (unchanged)
 *   "385/65r22.5" → "385/65 R 22.5"
 */
function normalizeDimension(raw: string): string {
  if (!raw) return raw;
  let d = raw.trim();
  // Collapse multiple spaces
  d = d.replace(/\s+/g, ' ');
  // Main pattern: capture {prefix}R{rimSize} with optional spaces around R
  // prefix can be like "12", "295/80", "11.00", etc.
  d = d.replace(
    /^([\d./]+)\s*[rR]\s*([\d.]+)$/,
    (_, prefix, rim) => `${prefix} R ${rim}`,
  );
  return d;
}

/**
 * Match a user-provided dimension against known catalog dimensions.
 * Tiers: format-normalized exact → punctuation-insensitive exact →
 * Levenshtein fuzzy on normalized forms.
 */
function matchDimension(input: string, known: string[]): string | null {
  if (!input) return null;
  const normInput = normalizeDimension(input).toLowerCase();

  // 1. Format-normalized exact match
  for (const k of known) {
    if (normalizeDimension(k).toLowerCase() === normInput) return k;
  }

  // 2. Punctuation-insensitive match — catches "295/80R22.5" ↔ "295 80 R 22 5"
  const keyInput = normalizeMatchKey(input);
  if (keyInput) {
    for (const k of known) {
      if (normalizeMatchKey(k) === keyInput) return k;
    }
  }

  // 3. Fuzzy on format-normalized forms
  const normKnown = known.map(k => normalizeDimension(k).toLowerCase());
  const maxDist = 2;
  let bestMatch: string | null = null;
  let bestDist  = Infinity;
  for (let i = 0; i < normKnown.length; i++) {
    if (Math.abs(normKnown[i].length - normInput.length) > maxDist) continue;
    const dist = levenshtein(normInput, normKnown[i]);
    if (dist < bestDist && dist <= maxDist) {
      bestDist  = dist;
      bestMatch = known[i];
    }
  }
  return bestMatch;
}

// =============================================================================
// Public-facing DTO / interface types
// =============================================================================

export interface EditTireDto {
  marca?: string;
  diseno?: string;
  dimension?: string;
  eje?: EjeType;
  posicion?: number;
  profundidadInicial?: number;
  vehicleId?: string | null;
  kilometrosRecorridos?: number;
  companyId?: string;
  inspectionEdit?: {
    fecha: string;
    profundidadInt: number;
    profundidadCen: number;
    profundidadExt: number;
  };
  costoEdit?: {
    fecha: string;
    newValor: number;
  };
}

export interface TireAnalysis {
  id: string;
  posicion: number;
  profundidadActual: number | null;
  alertLevel: TireAlertLevel;
  healthScore: number;
  recomendaciones: string[];
  cpkTrend: number | null;
  projectedDateEOL: Date | null;
  desechos: unknown;
}

export interface InspectionRow {
  fecha: string;
  profundidadInt: number;
  profundidadCen: number;
  profundidadExt: number;
  diasEnUso: number;
  mesesEnUso: number;
  kilometrosRecorridos: number;
  kmActualVehiculo: number;
  cpk: number;
  cpkProyectado: number;
  cpt: number;
  cptProyectado: number;
  imageUrl?: string;
  kmEfectivos?: number;
  kmProyectado?: number;
}

interface CpkMetrics {
  cpk: number;
  cpt: number;
  cpkProyectado: number;
  cptProyectado: number;
  projectedKm: number;
  projectedMonths: number;
}

// =============================================================================
// Pure utility functions  (unchanged from original except where noted)
// =============================================================================

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

function safeFloat(v: unknown, fallback = 0): number {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? fallback : n;
}

function safeInt(v: unknown, fallback = 0): number {
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

function parseCurrency(value: string): number {
  if (!value) return 0;
  const n = parseFloat(value.replace(/[$,\s]/g, '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a date string from Excel. Handles:
 *  - DD/MM/YYYY (Colombian format): "30/01/2026"
 *  - MM/DD/YYYY: "01/30/2026"
 *  - YYYY-MM-DD (ISO): "2026-01-30"
 *  - DD-MM-YYYY: "30-01-2026"
 *  - Excel serial numbers: 45322 (days since 1899-12-30)
 *  - Any string Date() can parse directly
 */
function parseExcelDate(raw: string): Date | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();

  // Excel serial number (e.g., 45322)
  if (/^\d{4,5}$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 30000 && serial < 60000) {
      // Excel epoch: 1899-12-30
      const d = new Date(1899, 11, 30);
      d.setDate(d.getDate() + serial);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (isoMatch) {
    const d = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY (detect: if first part > 12, it must be day)
  const slashMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    const a = +slashMatch[1], b = +slashMatch[2], y = +slashMatch[3];
    // If first number > 12 → definitely DD/MM/YYYY
    // If second number > 12 → definitely MM/DD/YYYY
    // If both ≤ 12 → assume DD/MM/YYYY (Colombian convention)
    let day: number, month: number;
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { day = b; month = a; }
    else { day = a; month = b; } // default: DD/MM/YYYY
    const d = new Date(y, month - 1, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback: let JS try
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function generateTireId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11).toUpperCase()}`;
}

function needsIdGeneration(id: string): boolean {
  if (!id?.trim()) return true;
  const bad = ['no aplica', 'no visible', 'no space', 'nospace'];
  return bad.some(p => normalize(id).includes(p));
}

function normalizeTipoVHC(t: string): string {
  if (!t) return '';
  const n = normalize(t);
  if (n === 'trailer')  return 'trailer 3 ejes';
  if (n === 'cabezote') return 'cabezote 2 ejes';
  return t.trim().toLowerCase();
}

function normalizeEje(raw: string): EjeType {
  const n = normalize(raw);
  if (n.includes('direcc'))  return EjeType.direccion;
  if (n.includes('tracc'))   return EjeType.traccion;
  if (n.includes('remolq'))  return EjeType.remolque;
  if (n.includes('repuest')) return EjeType.repuesto;
  return EjeType.libre;
}

function calcMinDepth(i: number, c: number, e: number): number {
  return Math.min(i, c, e);
}

/**
 * Estimate how many km the tire accumulated since its last inspection
 * when the user didn't provide a reliable odometer delta. Uses wear
 * (mm worn) and calendar time (days elapsed) — averages both estimates
 * when available so outliers in either signal get dampened.
 *
 * Returns 0 when neither signal is strong enough.
 */
function estimateKmDelta(params: {
  mmWorn: number;
  daysElapsed: number;
  usableDepth: number;
  expectedLifetimeKm: number;
  // Optional crowd-derived wear rate (mm per 1000 km) — when present it's
  // the most accurate source; otherwise we extrapolate from the tire's
  // expected lifetime vs its usable depth.
  catalogWearMmPer1000Km?: number | null;
  // Optional per-day km for this vehicle derived from its own history.
  // Falls back to a conservative fleet average when absent.
  vehicleKmPerDay?: number | null;
}): number {
  const { mmWorn, daysElapsed, usableDepth, expectedLifetimeKm, catalogWearMmPer1000Km, vehicleKmPerDay } = params;

  let wearEst = 0;
  if (mmWorn > 0) {
    if (catalogWearMmPer1000Km && catalogWearMmPer1000Km > 0) {
      wearEst = (mmWorn / catalogWearMmPer1000Km) * 1000;
    } else if (expectedLifetimeKm > 0 && usableDepth > 0) {
      wearEst = (expectedLifetimeKm / usableDepth) * mmWorn;
    }
  }

  let daysEst = 0;
  if (daysElapsed > 0) {
    const kmPerDay = vehicleKmPerDay && vehicleKmPerDay > 0
      ? vehicleKmPerDay
      : C.KM_POR_MES / 30; // conservative fallback
    daysEst = daysElapsed * kmPerDay;
  }

  if (wearEst > 0 && daysEst > 0) return Math.round((wearEst + daysEst) / 2);
  if (wearEst > 0) return Math.round(wearEst);
  if (daysEst > 0) return Math.round(daysEst);
  return 0;
}

function toDateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function isVidaValue(s: string | null | undefined): s is VidaValue {
  return !!s && VALID_VIDA_SET.has(s);
}

function calcCpkMetrics(
  totalCost: number,
  km: number,
  meses: number,
  profundidadInicial: number,
  minDepth: number,
  expectedLifetimeKm: number = 80_000,
): CpkMetrics {
  const usableDepth = profundidadInicial - C.LIMITE_LEGAL_MM;
  const mmWorn      = profundidadInicial - minDepth;
  const mmLeft      = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  let   projectedKm = 0;

  if (usableDepth > 0) {
    if (km > 0) {
      // Wear-rate estimate: extrapolate from actual km/mm observed
      const wearEstimate = mmWorn > 0
        ? km + (km / mmWorn) * mmLeft
        : 0;

      // Fallback estimate: use catalog/estimated lifecycle proportionally
      const fallbackEstimate = km + (mmLeft / usableDepth) * expectedLifetimeKm;

      if (mmWorn <= 0) {
        // No wear yet — pure fallback
        projectedKm = fallbackEstimate;
      } else {
        // Blend: confidence in wear data grows with mm worn (0→1 over usableDepth)
        const wearConfidence = Math.min(mmWorn / usableDepth, 1);
        projectedKm = wearEstimate * wearConfidence + fallbackEstimate * (1 - wearConfidence);
      }
    } else {
      // No km data at all — project from catalog/estimated lifecycle
      projectedKm = expectedLifetimeKm;
    }
  }

  // CPK: prefer actual km, but only when we have a meaningful amount.
  // Very small km values (just-mounted tires with 100-500 km driven)
  // produce nonsense CPKs like $1.9M / 209 = $9k per km. Below 5k km a
  // tire hasn't run long enough for cost/km to be meaningful — fall back
  // to the projected lifecycle instead.
  const MIN_MEANINGFUL_KM = 5_000;
  let cpk: number;
  if (km >= MIN_MEANINGFUL_KM) {
    cpk = totalCost / km;
  } else if (projectedKm > 0 && totalCost > 0) {
    cpk = totalCost / projectedKm;
  } else {
    cpk = 0;
  }

  const cpt = meses > 0 ? totalCost / meses : 0;

  const projectedMonths = projectedKm / C.KM_POR_MES;
  const cpkProyectado   = projectedKm     > 0 ? totalCost / projectedKm     : 0;
  const cptProyectado   = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm, projectedMonths };
}

function resolveVidaStartDate(
  eventos: { fecha: Date | string; notas?: string | null }[],
  vida: VidaValue,
  installationDate: Date,
): Date {
  const evt = [...eventos]
    .filter(e => e.notas === vida)
    .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
    .at(0);
  return evt ? new Date(evt.fecha) : installationDate;
}

function costsForVida(
  costos: { valor: number; fecha: Date | string }[],
  vidaStartDate: Date,
): { valor: number; fecha: Date | string }[] {
  return costos.filter(c => new Date(c.fecha) >= vidaStartDate);
}

function resolveVidaCostAndKm(params: {
  costos:               { valor: number; fecha: Date | string }[];
  inspecciones:         { fecha: Date | string; kilometrosEstimados?: number | null }[];
  eventos:              { fecha: Date | string; notas?: string | null }[];
  vidaActual:           VidaValue;
  currentKm:            number;
  installationDate:     Date;
  creationKm?:          number; // tire.kilometrosRecorridos at creation (0 for new)
}): { costForVida: number; kmForVida: number } {
  const { costos, inspecciones, eventos, vidaActual, currentKm, installationDate, creationKm } = params;

  const vidaStart = resolveVidaStartDate(eventos, vidaActual, installationDate);

  const vidaCostos = costsForVida(costos, vidaStart);
  let costForVida: number;

  if (vidaCostos.length > 0) {
    costForVida = vidaCostos.reduce((s, c) => s + c.valor, 0);
  } else {
    const sorted = [...costos].sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );
    costForVida = sorted.at(0)?.valor ?? 0;
  }

  // Find km at the moment the current vida started:
  // 1. Look for the last inspection BEFORE vida start → that's the odometer baseline
  // 2. If vida is 'nueva' and no prior inspections → use creationKm (usually 0)
  // 3. Fallback to 0
  const allSorted = [...inspecciones].sort(
    (a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime(),
  );
  const lastInspBeforeVida = [...allSorted]
    .reverse()
    .find(i => new Date(i.fecha) < vidaStart);

  let kmAtVidaStart: number;
  if (lastInspBeforeVida?.kilometrosEstimados != null) {
    // There was an inspection before this vida started — use its km as baseline
    kmAtVidaStart = lastInspBeforeVida.kilometrosEstimados;
  } else if (vidaActual === VidaValue.nueva) {
    // New tire — vida started at creation, baseline is creation km (typically 0)
    kmAtVidaStart = creationKm ?? 0;
  } else {
    // Reencauche with no prior inspections — use 0 as safe fallback
    kmAtVidaStart = 0;
  }

  const kmForVida = Math.max(currentKm - kmAtVidaStart, 0);

  return { costForVida, kmForVida };
}

function calcHealthScore(params: {
  profundidadInicial: number;
  pInt: number;
  pCen: number;
  pExt: number;
  cpkTrend?: number | null;
  presionPsi?: number | null;
  presionRecomendadaPsi?: number | null;
  pesoCarga?: number | null;
  cargaMaxLlanta?: number | null;
}) {
  const {
    profundidadInicial,
    pInt,
    pCen,
    pExt,
    cpkTrend,
    presionPsi,
    presionRecomendadaPsi,
    pesoCarga,
    cargaMaxLlanta,
  } = params;

  // 1. DEPTH SCORE
  const minDepth  = Math.min(pInt, pCen, pExt);
  const usable    = Math.max(profundidadInicial - C.LIMITE_LEGAL_MM, 1);
  const remaining = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  const depthScore = Math.min((remaining / usable) * 100, 100);

  // 2. IRREGULARITY SCORE
  const maxDelta = Math.max(
    Math.abs(pInt - pCen),
    Math.abs(pCen - pExt),
    Math.abs(pInt - pExt),
  );
  const irregularityScore = Math.max(100 - maxDelta * 18, 0);

  // 3. TREND SCORE (optional)
  let trendScore: number | null = null;
  if (cpkTrend != null) {
    trendScore = Math.min(Math.max(60 - cpkTrend * 120, 0), 100);
  }

  // 4. PRESSURE SCORE (optional)
  let pressureScore: number | null = null;
  if (presionPsi != null && presionRecomendadaPsi != null) {
    const diff = presionPsi - presionRecomendadaPsi;
    pressureScore = Math.abs(diff) <= 3 ? 100 : Math.max(100 - Math.abs(diff) * 6, 0);
  }

  // 5. STRESS SCORE (optional)
  let stressScore: number | null = null;
  if (
    presionPsi != null &&
    presionRecomendadaPsi != null &&
    pesoCarga != null &&
    cargaMaxLlanta != null
  ) {
    const stress = (pesoCarga / cargaMaxLlanta) * (presionRecomendadaPsi / presionPsi);
    stressScore = stress <= 1 ? 100 : Math.max(100 - (stress - 1) * 120, 0);
  }

  // 6. WEIGHTED COMPOSITE (dynamic weights — absent signals are redistributed)
  const components = [
    { value: depthScore,       weight: 0.50 },
    { value: irregularityScore, weight: 0.20 },
    { value: trendScore,       weight: 0.15 },
    { value: pressureScore,    weight: 0.10 },
    { value: stressScore,      weight: 0.05 },
  ];

  const active       = components.filter(c => c.value != null);
  const totalWeight  = active.reduce((s, c) => s + c.weight, 0);
  const normalised   = active.reduce((s, c) => s + c.value! * (c.weight / totalWeight), 0);
  const confidenceScore = Math.round((active.length / components.length) * 100);

  return {
    healthScore: Math.round(normalised),
    confidenceScore,
    breakdown: { depthScore, irregularityScore, trendScore, pressureScore, stressScore },
  };
}

function calcCpkTrend(cpkValues: number[]): number | null {
  if (cpkValues.length < 2) return null;
  const n     = cpkValues.length;
  const xs    = cpkValues.map((_, i) => i);
  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = cpkValues.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * cpkValues[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function deriveAlertLevel(healthScore: number, minDepth: number): TireAlertLevel {
  if (minDepth <= C.LIMITE_LEGAL_MM) return TireAlertLevel.critical;
  if (healthScore < 25)              return TireAlertLevel.critical;
  if (healthScore < 50)              return TireAlertLevel.warning;
  if (healthScore < 70)              return TireAlertLevel.watch;
  return TireAlertLevel.ok;
}

function resolvePresionRecomendada(vehicle: any, posicion: number): number | null {
  if (!vehicle?.presionesRecomendadas) return null;
  const configs = Array.isArray(vehicle.presionesRecomendadas)
    ? vehicle.presionesRecomendadas as { posicion: number; presionRecomendadaPsi: number }[]
    : [];
  return configs.find(c => c.posicion === posicion)?.presionRecomendadaPsi ?? null;
}

function buildVidaSnapshotPayload(params: {
  tire:         any;
  vida:         VidaValue;
  vidaInsps:    any[];
  vidaCostos:   any[];
  fechaInicio:  Date;
  fechaFin:     Date;
  bandaNombre?: string;
  bandaMarca?:  string;
  proveedor?:   string;
  motivoFin?:   MotivoFinVida;
  notasRetiro?: string;
  desechoData?: {
    causales:             string;
    milimetrosDesechados: number;
    imageUrls?:           string[];
  };
}) {
  const {
    tire, vida, vidaInsps, vidaCostos,
    fechaInicio, fechaFin,
    bandaNombre, bandaMarca, proveedor,
    motivoFin, notasRetiro, desechoData,
  } = params;

  const firstInsp = vidaInsps.at(0);
  const lastInsp  = vidaInsps.at(-1);

  const diasTotales  = Math.max(
    Math.floor((fechaFin.getTime() - fechaInicio.getTime()) / C.MS_POR_DIA), 0,
  );
  const mesesTotales = diasTotales / 30;
  const kmTotales    = lastInsp?.kmEfectivos ?? lastInsp?.kilometrosEstimados ?? 0;

  const profundidadInicial = firstInsp
    ? (firstInsp.profundidadInt + firstInsp.profundidadCen + firstInsp.profundidadExt) / 3
    : tire.profundidadInicial;

  const profIntFinal = lastInsp?.profundidadInt ?? null;
  const profCenFinal = lastInsp?.profundidadCen ?? null;
  const profExtFinal = lastInsp?.profundidadExt ?? null;
  const profundidadFinal = lastInsp
    ? (lastInsp.profundidadInt + lastInsp.profundidadCen + lastInsp.profundidadExt) / 3
    : 0;

  const mmDesgastados = Math.max(profundidadInicial - profundidadFinal, 0);

  const desgasteIrregular = lastInsp
    ? Math.max(
        Math.abs(lastInsp.profundidadInt - lastInsp.profundidadCen),
        Math.abs(lastInsp.profundidadCen - lastInsp.profundidadExt),
        Math.abs(lastInsp.profundidadInt - lastInsp.profundidadExt),
      ) > 3
    : false;

  const costoTotal   = vidaCostos.reduce((s: number, c: any) => s + c.valor, 0);
  const costoInicial = vidaCostos.at(0)?.valor ?? 0;

  const cpkData = vidaInsps.filter((i: any) => (i.cpk ?? 0) > 0).map((i: any) => i.cpk as number);
  const cpkAvg  = cpkData.length ? cpkData.reduce((a: number, b: number) => a + b, 0) / cpkData.length : null;
  const cpkMin  = cpkData.length ? Math.min(...cpkData) : null;
  const cpkMax  = cpkData.length ? Math.max(...cpkData) : null;

  const presionData = vidaInsps.filter((i: any) => i.presionPsi != null).map((i: any) => i.presionPsi as number);
  const presionAvg  = presionData.length ? presionData.reduce((a: number, b: number) => a + b, 0) / presionData.length : null;
  const presionMin  = presionData.length ? Math.min(...presionData) : null;
  const presionMax  = presionData.length ? Math.max(...presionData) : null;

  // Dinero perdido = tread value that went to the trash.
  //   = mm_remaining × (costo_vida / profundidad_inicial_vida)
  //
  // "costo_vida" is the purchase price for a new tire or the retread price
  // for a reencauche vida. "profundidad_inicial_vida" is the usable tread
  // at the start of this vida (first inspection, else the tire baseline).
  let desechoRemanente: number | null = null;
  const desechoMilimetros = desechoData?.milimetrosDesechados ?? null;
  if (desechoMilimetros != null && desechoMilimetros > 0 && costoInicial > 0 && profundidadInicial > 0) {
    desechoRemanente = parseFloat(((costoInicial / profundidadInicial) * desechoMilimetros).toFixed(2));
  }

  return {
    vida,
    marca:     tire.marca,
    diseno:    bandaNombre ?? tire.diseno,
    dimension: tire.dimension,
    eje:       tire.eje,
    posicion:  tire.posicion ?? null,
    bandaNombre:  bandaNombre  ?? null,
    bandaMarca:   bandaMarca   ?? null,
    proveedor:    proveedor    ?? null,
    costoInicial,
    costoTotal,
    fechaInicio,
    fechaFin,
    diasTotales,
    mesesTotales,
    profundidadInicial,
    profundidadFinal,
    mmDesgastados,
    mmDesgastadosPorMes:    mesesTotales > 0 ? mmDesgastados / mesesTotales : null,
    mmDesgastadosPor1000km: kmTotales    > 0 ? (mmDesgastados / kmTotales) * 1000 : null,
    profundidadIntFinal: profIntFinal,
    profundidadCenFinal: profCenFinal,
    profundidadExtFinal: profExtFinal,
    desgasteIrregular,
    kmTotales,
    kmProyectadoFinal: lastInsp?.kmProyectado ?? null,
    cpkFinal:           lastInsp?.cpk           ?? null,
    cptFinal:           lastInsp?.cpt           ?? null,
    cpkProyectadoFinal: lastInsp?.cpkProyectado ?? null,
    cptProyectadoFinal: lastInsp?.cptProyectado ?? null,
    cpkMin,
    cpkMax,
    cpkAvg,
    presionAvgPsi:          presionAvg,
    presionMinPsi:          presionMin,
    presionMaxPsi:          presionMax,
    inspeccionesConPresion: presionData.length,
    healthScoreAtEnd:  tire.healthScore ?? null,
    alertLevelAtEnd:   tire.alertLevel  ?? null,
    totalInspecciones: vidaInsps.length,
    firstInspeccionId: firstInsp?.id ?? null,
    lastInspeccionId:  lastInsp?.id  ?? null,
    motivoFin:    motivoFin   ?? null,
    notasRetiro:  notasRetiro ?? null,
    desechoCausales:   desechoData?.causales          ?? null,
    desechoMilimetros,
    desechoRemanente,
    desechoImageUrls:  desechoData?.imageUrls          ?? [],
    dataSource: 'live',
  };
}

// =============================================================================
// Excel header maps  (unchanged)
// =============================================================================

const HEADER_MAP_A: Record<string, string> = {
  'llanta':               'llanta',
  'numero de llanta':     'llanta',
  'id':                   'llanta',
  'placa vehiculo':       'placa_vehiculo',
  'placa':                'placa_vehiculo',
  'marca':                'marca',
  'diseno':               'diseno_original',
  'diseño':               'diseno_original',
  'dimension':            'dimension',
  'dimensión':            'dimension',
  'eje':                  'eje',
  'posicion':             'posicion',
  'vida':                 'vida',
  'kilometros llanta':    'kilometros_llanta',
  'kilometraje vehiculo': 'kilometros_vehiculo',
  'profundidad int':      'profundidad_int',
  'profundidad cen':      'profundidad_cen',
  'profundidad ext':      'profundidad_ext',
  'profundidad inicial':  'profundidad_inicial',
  'costo':                'costo',
  'cost':                 'costo',
  'precio':               'costo',
  'costo furgon':         'costo',
  'fecha instalacion':    'fecha_instalacion',
  'fecha montaje':        'fecha_instalacion',
  'fecha de montaje':     'fecha_instalacion',
  'fecha inspeccion':     'fecha_inspeccion',
  'fecha ult ins':        'fecha_inspeccion',
  'fecha ult. ins':       'fecha_inspeccion',
  'fecha ultima inspeccion': 'fecha_inspeccion',
  'imageurl':             'imageurl',
  'tipovhc':              'tipovhc',
  'tipo de vehiculo':     'tipovhc',
  'tipo vhc':             'tipovhc',
  'presion psi':          'presion_psi',
  'presión psi':          'presion_psi',
  'presion':              'presion_psi',
};

const HEADER_MAP_B: Record<string, string> = {
  'tipo de equipo':      'tipovhc',
  'placa':               'placa_vehiculo',
  'km actual':           'kilometros_vehiculo',
  'pos':                 'posicion',
  'posicion':            'posicion',
  '# numero de llanta':  'llanta',
  'numero de llanta':    'llanta',
  'diseño':              'diseno_original',
  'diseno':              'diseno_original',
  'marca':               'marca',
  'marca band':          'marca_banda',
  'banda':               'banda_name',
  'dimensión':           'dimension',
  'dimension':           'dimension',
  'prf int':             'profundidad_int',
  'pro cent':            'profundidad_cen',
  'pro ext':             'profundidad_ext',
  'profundidad inicial': 'profundidad_inicial',
  'tipo llanta':         'tipollanta',
  'tipo de llanta':      'tipollanta',
  'eje':                 'tipollanta',
  'vida':                'vida_override',
  'fecha ult ins':       'fecha_inspeccion',
  'fecha ult. ins':      'fecha_inspeccion',
  'fecha ultima inspeccion': 'fecha_inspeccion',
  'presion psi':         'presion_psi',
  'presión psi':         'presion_psi',
  'novedad':             'novedad',
  'serie':               'serie',
};

function isFormatB(rows: Record<string, string>[]): boolean {
  if (!rows.length) return false;
  return Object.keys(rows[0]).some(k =>
    k.toLowerCase().includes('numero de llanta') ||
    k.toLowerCase().includes('tipo de equipo'),
  );
}

function getCell(
  row: Record<string, string>,
  field: string,
  headerMap: Record<string, string>,
): string {
  const key = Object.keys(row).find(k => {
    const mapped = headerMap[normalize(k)];
    return mapped === field || normalize(k) === field;
  });
  return key ? String(row[key] ?? '') : '';
}

// =============================================================================
// TireService
// =============================================================================

@Injectable()
export class TireService {
  private readonly logger = new Logger(TireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleService: VehicleService,
    private readonly notificationsService: NotificationsService,
    private readonly catalogService: CatalogService,
    private readonly s3: S3Service,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  private tireKey(companyId: string)  { return `tires:${companyId}`; }
  private vehicleKey(vehicleId: string) { return `tires:vehicle:${vehicleId}`; }
  private benchmarkKey(marca: string, diseno: string, dimension: string) {
    return `benchmark:${marca}:${diseno}:${dimension}`;
  }

  private static readonly TTL_COMPANY   = 60 * 60 * 1000;
  private static readonly TTL_VEHICLE   = 10 * 60 * 1000;
  private static readonly TTL_BENCHMARK = 24 * 60 * 60 * 1000;

  private async invalidateCompanyCache(companyId: string | null | undefined) {
    if (!companyId) return; // orphan tires aren't in any company cache
    // Wipe the 3 main caches for this company: the full /tires payload, the
    // slim projection, and every cursor page. We can't easily enumerate all
    // :pg:<cursor>:<limit> keys from Nest's cache-manager API, so when Redis
    // is the store we fall back to a SCAN-based delete; otherwise the page
    // entries simply age out at their 10-min TTL.
    const base = this.tireKey(companyId);
    await Promise.all([this.cache.del(base), this.cache.del(`${base}:slim`)]);

    const redis = (this.cache as any)?.store?.client;
    if (redis?.scanStream) {
      // cache-manager-ioredis-yet exposes the underlying ioredis client here
      const pattern = `${base}:pg:*`;
      await new Promise<void>((resolve) => {
        const stream = redis.scanStream({ match: pattern, count: 200 });
        stream.on('data', (keys: string[]) => {
          if (keys.length) redis.unlink(...keys).catch(() => {});
        });
        stream.on('end',   () => resolve());
        stream.on('error', () => resolve());
      });
    }
  }

  private async invalidateVehicleCache(vehicleId: string) {
    await this.cache.del(this.vehicleKey(vehicleId));
  }

  private resolveCurrentVida(eventos: any[]): VidaValue {
    const vidaEvts = eventos
      .filter(e => isVidaValue(e.notas))
      .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
    const last = vidaEvts.at(-1);
    return isVidaValue(last?.notas) ? (last!.notas as VidaValue) : VidaValue.nueva;
  }

  private resolveVidaStartDate(eventos: any[], vida: VidaValue, fallback: Date): Date {
    return resolveVidaStartDate(eventos, vida, fallback);
  }

  private async fetchFallbackPrice(marca: string, diseno: string, dimension: string): Promise<number> {
    const cacheKey = this.benchmarkKey(marca, diseno, dimension);
    const cached   = await this.cache.get<number>(cacheKey);
    if (cached != null) return cached;

    try {
      const benchmark = await this.prisma.tireBenchmark.findUnique({
        where:  { marca_diseno_dimension: { marca, diseno, dimension } },
        select: { precioPromedio: true },
      });
      const price = benchmark?.precioPromedio ?? C.FALLBACK_TIRE_PRICE;
      await this.cache.set(cacheKey, price, TireService.TTL_BENCHMARK);
      return price;
    } catch (_) {
      await this.cache.set(cacheKey, C.FALLBACK_TIRE_PRICE, TireService.TTL_BENCHMARK);
      return C.FALLBACK_TIRE_PRICE;
    }
  }

  private async sumCostoById(tireId: string): Promise<number> {
    const result = await this.prisma.tireCosto.aggregate({
      where: { tireId },
      _sum:  { valor: true },
    });
    return result._sum.valor ?? 0;
  }

  // ===========================================================================
  // VEHICLE TIRE HISTORY — lifecycle hooks
  //
  // openHistoryEntry:  called when a tire is mounted on a (vehicle, position)
  // closeOpenHistory:  called when a tire leaves that (vehicle, position)
  //
  // The writes are deliberately best-effort: we swallow errors so a DB
  // hiccup on the history row never breaks the user-facing tire mutation.
  // The backfill script (scripts/backfill-vehicle-tire-history.sql) keeps
  // the log consistent with the current tire state even if a single hook
  // fails silently.
  // ===========================================================================

  private async openHistoryEntry(
    tireId: string,
    vehicleId: string,
    position: number,
  ): Promise<void> {
    try {
      const tire = await this.prisma.tire.findUnique({
        where:  { id: tireId },
        select: {
          companyId: true,
          marca: true,
          diseno: true,
          dimension: true,
          vidaActual: true,
          profundidadInicial: true,
        },
      });
      if (!tire) return;
      if (!tire.marca || !tire.diseno || !tire.dimension) return;

      // Close any stale open entries for this tire first — defensive against
      // a missing prior hook.
      await this.prisma.vehicleTireHistory.updateMany({
        where: { tireId, fechaDesmonte: null },
        data:  { fechaDesmonte: new Date(), motivoDesmonte: 'reasignacion' },
      });

      await this.prisma.vehicleTireHistory.create({
        data: {
          vehicleId,
          companyId:     tire.companyId,
          position,
          tireId,
          marca:         tire.marca,
          diseno:        tire.diseno,
          dimension:     tire.dimension,
          vidaAlMontaje: tire.vidaActual ?? VidaValue.nueva,
          profundidadInicial: tire.profundidadInicial ?? null,
          fechaMontaje:  new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(`openHistoryEntry failed for tire ${tireId}: ${(err as Error).message}`);
    }
  }

  /**
   * Close every open history entry for this tire. Writes the final snapshot
   * (km, CPK, minimum tread depth) so aggregation queries can compute
   * per-position / per-SKU performance without re-reading inspections.
   *
   * @param motivo  one of 'rotacion' | 'reencauche' | 'fin' | 'desvinculado'
   *                | 'vehiculo_archivado' | 'reasignacion'
   */
  private async closeOpenHistory(
    tireId: string,
    motivo: string,
  ): Promise<void> {
    try {
      const tire = await this.prisma.tire.findUnique({
        where:  { id: tireId },
        select: {
          kilometrosRecorridos: true,
          currentCpk: true,
          lifetimeCpk: true,
          currentProfundidad: true,
          inspecciones: {
            orderBy: { fecha: 'desc' },
            take: 1,
            select: {
              profundidadInt: true,
              profundidadCen: true,
              profundidadExt: true,
              cpk: true,
              cpkProyectado: true,
            },
          },
        },
      });
      if (!tire) return;

      // Best CPK signal: lifetime > current > last inspection's cpk/proy.
      const lastInsp = tire.inspecciones[0];
      const cpkFinal =
        (tire.lifetimeCpk && tire.lifetimeCpk > 0) ? tire.lifetimeCpk :
        (tire.currentCpk  && tire.currentCpk  > 0) ? tire.currentCpk  :
        lastInsp?.cpkProyectado && lastInsp.cpkProyectado > 0 ? lastInsp.cpkProyectado :
        lastInsp?.cpk && lastInsp.cpk > 0 ? lastInsp.cpk : null;

      // Min depth at desmonte: prefer last inspection's 3-point reading,
      // fall back to the tire-level cached currentProfundidad.
      let minDepth: number | null = null;
      if (lastInsp) {
        const mins = [lastInsp.profundidadInt, lastInsp.profundidadCen, lastInsp.profundidadExt]
          .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
        if (mins.length) minDepth = Math.min(...mins);
      }
      if (minDepth === null && typeof tire.currentProfundidad === 'number') {
        minDepth = tire.currentProfundidad;
      }

      await this.prisma.vehicleTireHistory.updateMany({
        where: { tireId, fechaDesmonte: null },
        data: {
          fechaDesmonte:         new Date(),
          motivoDesmonte:        motivo,
          kmRecorridosAlDesmonte: tire.kilometrosRecorridos ?? null,
          cpkFinal,
          profundidadFinalMin:   minDepth,
        },
      });
    } catch (err) {
      this.logger.warn(`closeOpenHistory failed for tire ${tireId}: ${(err as Error).message}`);
    }
  }

  // ===========================================================================
  // CREATE SINGLE TIRE  (unchanged — correct as-is)
  // ===========================================================================

  async createTire(dto: CreateTireDto) {
    const {
      placa, marca, diseno, profundidadInicial, dimension, eje,
      costo, inspecciones, primeraVida, kilometrosRecorridos, eventos,
      companyId, vehicleId, posicion, desechos, fechaInstalacion,
    } = dto;

    const [company, vehicle] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      vehicleId
        ? this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    if (!company)              throw new BadRequestException('Invalid companyId');
    if (vehicleId && !vehicle) throw new BadRequestException('Invalid vehicleId');

    if (placa?.trim()) {
      const normalizedPlaca = placa.trim().toLowerCase();
      const existing = await this.prisma.tire.findFirst({
        where: { placa: normalizedPlaca, companyId },
        include: {
          vehicle:      { select: { placa: true, tipovhc: true } },
          inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
        },
      });

      if (existing) {
        return {
          duplicate: true,
          existingTire: {
            id:             existing.id,
            placa:          existing.placa,
            marca:          existing.marca,
            diseno:         existing.diseno,
            dimension:      existing.dimension,
            eje:            existing.eje,
            posicion:       existing.posicion,
            vehicle:        existing.vehicle
              ? { placa: existing.vehicle.placa, tipovhc: existing.vehicle.tipovhc }
              : null,
            suggestedPlaca: normalizedPlaca + '*',
          },
        };
      }
    }

    const finalPlaca  = placa?.trim() ? placa.trim().toLowerCase() : generateTireId().toLowerCase();
    const instalacion = fechaInstalacion ? new Date(fechaInstalacion) : new Date();

    // Determine initial vida: prefer explicit dto.vidaActual, then fall back to eventos
    const incomingVidaEvt = Array.isArray(eventos)
      ? [...eventos]
          .filter(e => isVidaValue(e.notas))
          .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
          .at(0)
      : null;
    const initialVida: VidaValue = dto.vidaActual
      ? (dto.vidaActual as VidaValue)
      : isVidaValue(incomingVidaEvt?.notas)
        ? (incomingVidaEvt!.notas as VidaValue)
        : VidaValue.nueva;

    const newTire = await this.prisma.tire.create({
      data: {
        placa:                finalPlaca,
        marca:                marca.toLowerCase(),
        diseno:               (diseno ?? '').toLowerCase(),
        profundidadInicial:   profundidadInicial ?? C.DEFAULT_PROFUNDIDAD_INICIAL,
        dimension:            (dimension ?? '').toLowerCase(),
        eje:                  (eje as EjeType) ?? EjeType.libre,
        posicion:             posicion ?? 0,
        kilometrosRecorridos: kilometrosRecorridos ?? 0,
        companyId,
        vehicleId:            vehicleId ?? null,
        fechaInstalacion:     instalacion,
        diasAcumulados:       0,
        alertLevel:           TireAlertLevel.ok,
        vidaActual:           initialVida,
        totalVidas:           0,
        primeraVida:          toJson(Array.isArray(primeraVida) ? primeraVida : []),
        desechos:             desechos ?? null,
      },
    });

    await Promise.all([
      Array.isArray(inspecciones) && inspecciones.length
        ? this.prisma.inspeccion.createMany({
            data: inspecciones.map((insp: InspectionRow) => ({
              tireId:              newTire.id,
              fecha:               new Date(insp.fecha),
              profundidadInt:      insp.profundidadInt,
              profundidadCen:      insp.profundidadCen,
              profundidadExt:      insp.profundidadExt,
              cpk:                 insp.cpk             ?? null,
              cpkProyectado:       insp.cpkProyectado   ?? null,
              cpt:                 insp.cpt             ?? null,
              cptProyectado:       insp.cptProyectado   ?? null,
              diasEnUso:           insp.diasEnUso        ?? null,
              mesesEnUso:          insp.mesesEnUso       ?? null,
              kilometrosEstimados: insp.kilometrosRecorridos ?? null,
              kmActualVehiculo:    insp.kmActualVehiculo ?? null,
              kmEfectivos:         insp.kmEfectivos      ?? null,
              kmProyectado:        insp.kmProyectado     ?? null,
              imageUrl:            insp.imageUrl         ?? null,
              vidaAlMomento:       initialVida,
              source:              InspeccionSource.manual,
            })),
          })
        : Promise.resolve(),

      Array.isArray(eventos) && eventos.length
        ? this.prisma.tireEvento.createMany({
            data: eventos.map((e: any) => ({
              tireId:   newTire.id,
              tipo:     (e.tipo as TireEventType) ?? TireEventType.montaje,
              fecha:    new Date(e.fecha),
              notas:    e.notas ?? null,
              metadata: e.metadata ? toJson(e.metadata) : Prisma.JsonNull,
            })),
          })
        : Promise.resolve(),

      Array.isArray(costo) && costo.length
        ? this.prisma.tireCosto.createMany({
            data: costo.map((c: any) => ({
              tireId:   newTire.id,
              valor:    c.valor,
              fecha:    new Date(c.fecha),
              concepto: c.concepto ?? 'compra_nueva',
            })),
          })
        : Promise.resolve(),
    ]);

    // Create initial TireVidaSnapshot so the vida is tracked from day one
    const costoInicial = Array.isArray(costo) && costo.length > 0
      ? costo.reduce((s: number, c: any) => s + (c.valor ?? 0), 0)
      : 0;

    await this.prisma.tireVidaSnapshot.create({
      data: {
        tireId:             newTire.id,
        companyId,
        vida:               initialVida,
        marca:              newTire.marca,
        diseno:             newTire.diseno,
        dimension:          newTire.dimension,
        eje:                newTire.eje as EjeType,
        posicion:           newTire.posicion,
        costoInicial,
        costoTotal:         costoInicial,
        fechaInicio:        instalacion,
        fechaFin:           instalacion,  // will be updated when vida transitions
        diasTotales:        0,
        mesesTotales:       0,
        profundidadInicial: newTire.profundidadInicial,
        profundidadFinal:   newTire.profundidadInicial,
        mmDesgastados:      0,
        kmTotales:          kilometrosRecorridos ?? 0,
        totalInspecciones:  Array.isArray(inspecciones) ? inspecciones.length : 0,
        dataSource:         'live',
      },
    });

    await this.invalidateCompanyCache(companyId);
    if (vehicleId) await this.invalidateVehicleCache(vehicleId);

    // Fire-and-forget: enrich catalog with crowdsource data from this tire
    this.catalogService
      .enrichFromTireData(marca, dimension ?? '', diseno ?? '')
      .catch((err) => this.logger.warn(`Crowdsource enrich failed: ${err.message}`));

    return this.refreshTireAnalyticsCache(newTire.id);
  }

  // ===========================================================================
  // BULK UPLOAD  — fixed + optimised
  //
  // Key changes:
  //  • In-memory vehicleMap: eliminates duplicate DB vehicle lookups for the
  //    same placa across rows (very common for multi-axle fleets).
  //  • In-memory priceCache: eliminates repeated fetchFallbackPrice DB hits for
  //    the same marca/diseno/dimension combination.
  //  • refreshTireAnalyticsCache runs concurrently (Promise.allSettled) after
  //    all rows are processed — not serially per tire.
  //  • Vehicle + company cache invalidations also run concurrently at the end.
  //  • resolveVidaCostAndKm now reuses the already-fetched full tire record
  //    instead of re-querying.
  // ===========================================================================

  async bulkUploadTires(
    file: { buffer: Buffer },
    companyId: string,
    opts: { userId?: string; fileName?: string; recordSnapshot?: boolean } = {},
  ) {
    const wb    = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
      raw: false, defval: '',
    });

    const fmtB      = isFormatB(rows);
    const headerMap = fmtB ? HEADER_MAP_B : HEADER_MAP_A;
    const get       = (row: Record<string, string>, f: string) => getCell(row, f, headerMap);

    this.logger.log(`Bulk upload: Format ${fmtB ? 'B' : 'A'}, ${rows.length} rows`);

    const processedIds    = new Set<string>();
    const errors:   string[] = [];
    const warnings: string[] = [];
    const tireIdsToRefresh   = new Set<string>();

    // ─────────────────────────────────────────────────────────────────────────
    // PERF: in-memory caches for the duration of this upload
    // Eliminates repeated DB hits for vehicles and benchmark prices that
    // repeat across rows (extremely common for fleet uploads).
    // ─────────────────────────────────────────────────────────────────────────
    const vehicleMap  = new Map<string, any>();   // placa → vehicle record
    const priceCache  = new Map<string, number>(); // marca:diseno:dimension → price
    const skuCache    = new Map<string, any>();    // marca:dimension → catalog SKU (or null)

    /** Look up the catalog SKU for a marca + dimension. Returns null if not found. */
    const resolveSku = async (marca: string, dimension: string): Promise<any> => {
      const key = `${marca.toLowerCase()}:${dimension.toLowerCase()}`;
      if (skuCache.has(key)) return skuCache.get(key);
      try {
        const sku = await this.catalogService.findBestMatch(marca, dimension);
        skuCache.set(key, sku ?? null);
        return sku ?? null;
      } catch {
        skuCache.set(key, null);
        return null;
      }
    };

    const resolvePrice = async (marca: string, diseno: string, dimension: string): Promise<number> => {
      const key = `${marca}:${diseno}:${dimension}`;
      if (priceCache.has(key)) return priceCache.get(key)!;
      const price = await this.fetchFallbackPrice(marca, diseno, dimension);
      priceCache.set(key, price);
      return price;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // CATALOG-AWARE FUZZY MATCHING
    // Pre-load all known brands, designs, and dimensions from the catalog so
    // that typos like "continenal" → "Continental" or "12r22.5" → "12 R 22.5"
    // are automatically corrected during upload.
    // ─────────────────────────────────────────────────────────────────────────
    let catalogBrands:     string[] = [];
    let catalogModels:     string[] = [];
    let catalogDimensions: string[] = [];
    try {
      const [brandsRes, modelsRes, dimsRes] = await Promise.all([
        this.prisma.tireMasterCatalog.findMany({
          select: { marca: true }, distinct: ['marca'],
        }),
        this.prisma.tireMasterCatalog.findMany({
          select: { modelo: true }, distinct: ['modelo'],
        }),
        this.prisma.tireMasterCatalog.findMany({
          select: { dimension: true }, distinct: ['dimension'],
        }),
      ]);
      catalogBrands     = brandsRes.map(b => b.marca);
      catalogModels     = modelsRes.map(m => m.modelo);
      catalogDimensions = dimsRes.map(d => d.dimension);
      this.logger.log(`Bulk upload: catalog loaded — ${catalogBrands.length} brands, ${catalogModels.length} models, ${catalogDimensions.length} dimensions`);
    } catch (e) {
      this.logger.warn('Bulk upload: could not load catalog for fuzzy matching — proceeding without');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRE-SORT: when the same tire appears multiple times (multiple inspections),
    // ensure the row with DEEPER tread comes first (= older/initial inspection)
    // and the row with SHALLOWER tread comes second (= newer inspection with wear).
    // This prevents the duplicate-detection logic from mistakenly treating a
    // worn tire as a "replacement" (depths suddenly deeper).
    // ─────────────────────────────────────────────────────────────────────────
    const getLlantaKey = (row: Record<string, string>) => {
      const id = getCell(row, 'llanta', headerMap)?.trim().toLowerCase();
      if (id && !needsIdGeneration(id)) return id;
      // Fallback: vehicle placa + position
      const placa = getCell(row, 'placa_vehiculo', headerMap)?.trim().toLowerCase();
      const pos   = getCell(row, 'posicion', headerMap)?.trim();
      return placa && pos ? `${placa}:${pos}` : '';
    };
    const getMinDepth = (row: Record<string, string>) => {
      const int = safeFloat(getCell(row, 'profundidad_int', headerMap));
      const cen = safeFloat(getCell(row, 'profundidad_cen', headerMap));
      const ext = safeFloat(getCell(row, 'profundidad_ext', headerMap));
      return calcMinDepth(int, cen, ext);
    };

    // Stable sort: group by tire key, deeper rows first within each group
    const indexedRows = rows.map((row, idx) => ({ row, idx, key: getLlantaKey(row), minD: getMinDepth(row) }));
    indexedRows.sort((a, b) => {
      if (a.key && b.key && a.key === b.key) {
        // Same tire: deeper (more mm) first, shallower (less mm) second
        return b.minD - a.minD;
      }
      // Preserve original order for different tires
      return a.idx - b.idx;
    });

    let lastTipoVHC = '';
    let lastPlaca   = '';

    for (let i = 0; i < indexedRows.length; i++) {
      const row    = indexedRows[i].row;
      const rowNum = indexedRows[i].idx + 2; // original Excel row number

      try {
        if (fmtB) {
          const tv = get(row, 'tipovhc')?.trim();
          const pl = get(row, 'placa_vehiculo')?.trim();
          if (tv) lastTipoVHC = tv;
          if (pl) lastPlaca   = pl;
        }

        const rawId     = get(row, 'llanta')?.trim();
        const tirePlaca = needsIdGeneration(rawId)
          ? generateTireId().toLowerCase()
          : rawId.toLowerCase();

        if (processedIds.has(tirePlaca)) {
          const hasVehicleCtx = !!(fmtB
            ? get(row, 'placa_vehiculo')?.trim() || lastPlaca
            : get(row, 'placa_vehiculo')?.trim());
          if (!hasVehicleCtx) {
            errors.push(`Row ${rowNum}: Duplicate tire ID "${tirePlaca}" with no vehicle context. Skipped.`);
            continue;
          }
        }
        processedIds.add(tirePlaca);

        const marcaRaw  = get(row, 'marca').trim();
        let marca       = marcaRaw.charAt(0).toUpperCase() + marcaRaw.slice(1).toLowerCase();
        let diseno      = get(row, 'diseno_original').toLowerCase();
        let dimension   = get(row, 'dimension').toLowerCase();

        // ── Catalog fuzzy matching (brand / design / dimension) ─────────────
        // Correct typos and normalize formats against known catalog values.
        if (catalogBrands.length > 0) {
          const matchedBrand = fuzzyMatch(marca, catalogBrands);
          if (matchedBrand && matchedBrand.toLowerCase() !== marca.toLowerCase()) {
            warnings.push(`Row ${rowNum}: marca "${marca}" → "${matchedBrand}" (catálogo)`);
            marca = matchedBrand;
          }
        }
        if (catalogModels.length > 0 && diseno) {
          const matchedModel = fuzzyMatch(diseno, catalogModels);
          if (matchedModel && matchedModel.toLowerCase() !== diseno.toLowerCase()) {
            warnings.push(`Row ${rowNum}: diseño "${diseno}" → "${matchedModel}" (catálogo)`);
            diseno = matchedModel.toLowerCase();
          }
        }

        // ── Banda → marca inference for rows with empty brand ───────────────
        // If the upload didn't give us a brand but we do know the design,
        // look it up in the master catalog (or the closest fuzzy match) and
        // borrow whatever marca ships with that modelo. Otherwise the tire
        // ends up in a "N/A" bucket on every per-marca view.
        if (!marca && diseno) {
          try {
            let sku = await this.prisma.tireMasterCatalog.findFirst({
              where:   { modelo: { equals: diseno, mode: 'insensitive' } },
              orderBy: { precioCop: { sort: 'desc', nulls: 'last' } },
              select:  { marca: true, modelo: true },
            });
            if (!sku && catalogModels.length > 0) {
              // No exact modelo — try the closest catalog entry via fuzzy
              const fuzzyModel = fuzzyMatch(diseno, catalogModels);
              if (fuzzyModel) {
                sku = await this.prisma.tireMasterCatalog.findFirst({
                  where:   { modelo: { equals: fuzzyModel, mode: 'insensitive' } },
                  orderBy: { precioCop: { sort: 'desc', nulls: 'last' } },
                  select:  { marca: true, modelo: true },
                });
              }
            }
            if (sku?.marca) {
              marca = sku.marca.charAt(0).toUpperCase() + sku.marca.slice(1).toLowerCase();
              warnings.push(`Row ${rowNum}: marca vacía → "${marca}" (inferida del diseño "${sku.modelo}")`);
            }
          } catch (err) {
            this.logger.warn(`Row ${rowNum}: banda→marca lookup failed: ${(err as Error).message}`);
          }
        }
        if (catalogDimensions.length > 0 && dimension) {
          const matchedDim = matchDimension(dimension, catalogDimensions);
          if (matchedDim) {
            if (matchedDim.toLowerCase() !== dimension) {
              warnings.push(`Row ${rowNum}: dimensión "${dimension}" → "${matchedDim}" (catálogo)`);
            }
            dimension = matchedDim.toLowerCase();
          } else {
            // No catalog match — still normalize the format
            dimension = normalizeDimension(dimension).toLowerCase();
          }
        } else {
          // No catalog loaded — still normalize the dimension format
          dimension = normalizeDimension(dimension).toLowerCase();
        }

        const posicion  = safeInt(get(row, 'posicion'), 0);
        const eje       = normalizeEje(fmtB ? get(row, 'tipollanta') : get(row, 'eje'));

        let tipovhc = fmtB
          ? (get(row, 'tipovhc')?.trim() || lastTipoVHC)
          : get(row, 'tipovhc')?.trim();
        tipovhc = normalizeTipoVHC(tipovhc);

        const profInt  = safeFloat(get(row, 'profundidad_int'));
        const profCen  = safeFloat(get(row, 'profundidad_cen'));
        const profExt  = safeFloat(get(row, 'profundidad_ext'));
        const hasInsp  = profInt > 0 || profCen > 0 || profExt > 0;
        const minDepth = hasInsp ? calcMinDepth(profInt, profCen, profExt) : 0;

        const presionRaw = safeFloat(get(row, 'presion_psi'), 0);
        const presionPsi = presionRaw > 0 ? presionRaw : null;

        // ── Catalog SKU lookup (for profundidadInicial + km estimation) ──────
        const sku = await resolveSku(marca, dimension);
        const catalogRtd = sku?.rtdMm ?? null;        // initial depth from catalog
        const catalogKm  = sku?.kmEstimadosReales ?? null; // expected lifetime from catalog

        let profundidadInicial = safeFloat(get(row, 'profundidad_inicial'));
        if (profundidadInicial <= 0) {
          const maxObs = Math.max(profInt, profCen, profExt);
          if (catalogRtd && catalogRtd > 0) {
            // Use catalog initial depth, but never less than observed + 1
            profundidadInicial = maxObs > 0
              ? Math.max(catalogRtd, maxObs + 1)
              : catalogRtd;
          } else if (maxObs > 0) {
            // No catalog — use observed depth + 1mm (tire can't be shallower than what we measured)
            profundidadInicial = maxObs + 1;
          } else {
            // No measurements at all — fallback to 22mm
            profundidadInicial = C.DEFAULT_PROFUNDIDAD_INICIAL;
          }
          warnings.push(`Row ${rowNum}: profundidadInicial inferred as ${profundidadInicial}mm${catalogRtd ? ' (catálogo)' : ''}`);
        } else if (hasInsp) {
          // Even when provided, ensure it's not less than observed depths
          const maxObs = Math.max(profInt, profCen, profExt);
          if (profundidadInicial < maxObs) {
            profundidadInicial = maxObs + 1;
            warnings.push(`Row ${rowNum}: profundidadInicial adjusted to ${profundidadInicial}mm (was less than measured depth)`);
          }
        }

        let vidaValor       = '';
        let needsReencauche = false;
        let bandaName       = '';

        if (fmtB) {
          const marcaBanda = normalize(get(row, 'marca_banda'));
          bandaName        = get(row, 'banda_name').toLowerCase();
          needsReencauche  = marcaBanda.includes('reencauche') || marcaBanda.includes('rencauche');

          // Format B: check if there's a "Vida" column override, else default 'nueva'
          const vidaOverride = normalize(get(row, 'vida_override'));
          if (vidaOverride === 'original' || vidaOverride === 'nueva' || !vidaOverride) {
            vidaValor = 'nueva';
          } else if (vidaOverride.includes('reencauche') || vidaOverride.includes('rencauche')) {
            vidaValor = 'reencauche1';
            needsReencauche = true;
          } else if (isVidaValue(vidaOverride)) {
            vidaValor = vidaOverride;
          } else {
            vidaValor = 'nueva';
          }

          // Fuzzy-match banda name against catalog models
          if (bandaName && catalogModels.length > 0) {
            const matchedBanda = fuzzyMatch(bandaName, catalogModels);
            if (matchedBanda && matchedBanda.toLowerCase() !== bandaName) {
              warnings.push(`Row ${rowNum}: banda "${bandaName}" → "${matchedBanda}" (catálogo)`);
              bandaName = matchedBanda.toLowerCase();
            }
          }
        } else {
          vidaValor = get(row, 'vida').trim().toLowerCase();
          if (vidaValor === 'rencauche' || vidaValor === 'reencauche') vidaValor = 'reencauche1';
        }

        const placaVehiculo = (fmtB
          ? (get(row, 'placa_vehiculo')?.trim() || lastPlaca)
          : get(row, 'placa_vehiculo')?.trim()
        )?.toLowerCase();

        const kmVehiculo = safeFloat(get(row, 'kilometros_vehiculo'));

        // ── Vehicle resolution (in-memory cache) ─────────────────────────────
        // BUG-FIX / PERF: vehicleMap prevents repeated DB hits when multiple
        // rows in the same upload belong to the same vehicle (very common).
        let vehicle: any = null;
        if (placaVehiculo) {
          if (vehicleMap.has(placaVehiculo)) {
            vehicle = vehicleMap.get(placaVehiculo);
          } else {
            vehicle = await this.prisma.vehicle.findFirst({ where: { placa: placaVehiculo } });
            if (!vehicle) {
              vehicle = await this.vehicleService.createVehicle({
                placa: placaVehiculo, kilometrajeActual: kmVehiculo,
                carga: '', pesoCarga: 0, tipovhc, companyId, cliente: '',
              });
            }
            vehicleMap.set(placaVehiculo, vehicle);
          }

          // Update odometer only when the new reading is higher
          if (vehicle && kmVehiculo > (vehicle.kilometrajeActual || 0)) {
            await this.vehicleService.updateKilometraje(vehicle.id, kmVehiculo);
            vehicle = { ...vehicle, kilometrajeActual: kmVehiculo };
            vehicleMap.set(placaVehiculo, vehicle); // keep cache current
          }

          if (vehicle && tipovhc && !vehicle.tipovhc) {
            await this.prisma.vehicle.update({ where: { id: vehicle.id }, data: { tipovhc } });
            vehicle = { ...vehicle, tipovhc };
            vehicleMap.set(placaVehiculo, vehicle);
          }
        }

        // ── Cost resolution (in-memory price cache) ───────────────────────────
        const costoRaw = get(row, 'costo');
        let costoCell  = parseCurrency(costoRaw);
        if (costoCell <= 0) {
          costoCell = await resolvePrice(marca, diseno, dimension);
          warnings.push(`Row ${rowNum}: Cost fallback used — $${costoCell}`);
        }

        // ── Date & KM resolution ─────────────────────────────────────────────
        // Priority for fechaInspeccion: Excel "Fecha Ult Ins" > now
        // Priority for fechaInstalacion: Excel > estimate from km > estimate from wear > now
        const now = new Date();

        const rawFechaInstalacion = get(row, 'fecha_instalacion')?.trim();
        const rawFechaInsp        = get(row, 'fecha_inspeccion')?.trim();

        // fechaInspeccion: always prefer the explicit column
        const fechaInspeccion: Date = rawFechaInsp
          ? (parseExcelDate(rawFechaInsp) ?? now)
          : now;

        const kmLlantaExcel = safeFloat(get(row, 'kilometros_llanta'));
        const usableDepth   = profundidadInicial - C.LIMITE_LEGAL_MM;
        const mmWorn        = hasInsp ? (profundidadInicial - minDepth) : 0;

        // KM resolution (done before date so we can use km to estimate fechaInstalacion)
        // Use catalog expected km if available, otherwise 80k default
        const FALLBACK_EXPECTED_KM = 80_000;
        const expectedLifetimeKm = catalogKm ?? FALLBACK_EXPECTED_KM;

        let kmEstimados: number;

        if (kmLlantaExcel > 0) {
          kmEstimados = kmLlantaExcel;
        } else if (hasInsp && mmWorn > 0 && usableDepth > 0) {
          kmEstimados = Math.round((expectedLifetimeKm / usableDepth) * mmWorn);
          warnings.push(`Row ${rowNum}: KM estimated from wear — ${kmEstimados} km${catalogKm ? ' (catálogo)' : ''}`);
        } else {
          kmEstimados = 0; // will be re-estimated below after date resolution
        }

        // fechaInstalacion: estimate if not provided
        let fechaInstalacion: Date;
        if (rawFechaInstalacion) {
          fechaInstalacion = parseExcelDate(rawFechaInstalacion) ?? now;
        } else {
          // Estimate how long ago the tire was mounted:
          // 1. From km: divide by avg monthly km to get months back
          // 2. From wear: mm worn ÷ avg wear rate gives months
          // 3. Fallback: 1 month before inspection date for new tires
          let estimatedMonthsBack = 0;

          if (kmEstimados > 0) {
            estimatedMonthsBack = kmEstimados / C.KM_POR_MES;
          } else if (hasInsp && mmWorn > 0) {
            // Typical wear: ~1mm per 5000km → ~0.83mm/month at 6000km/month
            const mmPerMonth = C.KM_POR_MES / 5000;
            estimatedMonthsBack = mmWorn / mmPerMonth;
          } else {
            // Brand new tire with no data — assume installed 1 month ago
            estimatedMonthsBack = 1;
          }

          // Cap at 5 years back (60 months) as a sanity check
          estimatedMonthsBack = Math.min(estimatedMonthsBack, 60);
          const msBack = Math.round(estimatedMonthsBack * 30 * C.MS_POR_DIA);
          fechaInstalacion = new Date(fechaInspeccion.getTime() - msBack);
          warnings.push(
            `Row ${rowNum}: fechaInstalacion estimated as ${fechaInstalacion.toISOString().slice(0, 10)} ` +
            `(~${Math.round(estimatedMonthsBack)} months before inspection)`,
          );
        }

        // Ensure fechaInstalacion is not after fechaInspeccion
        if (fechaInstalacion.getTime() > fechaInspeccion.getTime()) {
          fechaInstalacion = new Date(fechaInspeccion.getTime() - C.MS_POR_DIA);
        }

        const diasEnUso = Math.max(
          Math.floor(
            (fechaInspeccion.getTime() - fechaInstalacion.getTime()) / C.MS_POR_DIA,
          ),
          1,
        );
        const mesesEnUso = diasEnUso / 30;

        // Re-estimate KM from time if it was 0 and we now have a real date span
        if (kmEstimados <= 0 && mesesEnUso > 0.5) {
          kmEstimados = Math.round(mesesEnUso * C.KM_POR_MES);
          warnings.push(`Row ${rowNum}: KM estimated from time — ${kmEstimados} km`);
        }

        const presionRecomendada = vehicle
          ? resolvePresionRecomendada(vehicle, posicion)
          : null;
        const presionDelta = (presionPsi != null && presionRecomendada != null)
          ? presionPsi - presionRecomendada
          : null;

        const vidaAlMomento: VidaValue = isVidaValue(vidaValor)
          ? (vidaValor as VidaValue)
          : VidaValue.nueva;

        // ── Explicit replacement signal from "Novedad" column ────────────────
        // If the user writes "cambio", "cambiada", "reemplazo", etc. in the
        // novedad column, treat this row as an explicit tire replacement:
        // dispose the old tire at that position and create a new one, even
        // if depths happen to match the previous inspection.
        const novedadRaw = normalize(get(row, 'novedad') || '');
        const forceReplacement =
          novedadRaw.includes('cambio') ||
          novedadRaw.includes('cambiada') ||
          novedadRaw.includes('reemplaz') ||
          novedadRaw.includes('nueva llanta') ||
          novedadRaw === 'cambiar';

        // ── Existing tire lookup ──────────────────────────────────────────────
        // CRITICAL: must be scoped to companyId, otherwise a tire ID like "1157"
        // in another company would be mistakenly found and updated, leaking data
        // and preventing the target company from getting its own tire.
        let existing: any = null;
        if (!needsIdGeneration(rawId)) {
          existing = await this.prisma.tire.findFirst({
            where: { placa: tirePlaca, companyId },
          });
        }
        if (!existing && vehicle && posicion > 0) {
          existing = await this.prisma.tire.findFirst({
            where: { vehicleId: vehicle.id, posicion, companyId },
          });
        }

        // ── Cross-vehicle ID collision guard ─────────────────────────────────
        // Real-world fleet spreadsheets occasionally reuse a tire ID across
        // two different physical tires on different vehicles (same sticker
        // number, lazy data entry). When we find an existing tire whose
        // current mount is a DIFFERENT vehicle than this row targets, we
        // must not merge — otherwise the "deeper depths → replace" detection
        // below wrongly disposes the original tire. Treat it as a new tire
        // with a suffixed placa instead.
        if (
          existing &&
          vehicle &&
          existing.vehicleId &&
          existing.vehicleId !== vehicle.id
        ) {
          warnings.push(
            `Row ${rowNum}: ID "${tirePlaca}" ya está montada en otro vehículo ` +
            `(${existing.placa} → vehicleId ${existing.vehicleId}); creando nueva llanta con sufijo "*".`,
          );
          existing = null;
          // finalTirePlaca suffix logic downstream will add the * when it
          // detects the remaining placa collision.
        }

        // ── Branch A: existing tire — smart duplicate detection ─────────────
        let existingFull: any = null;
        if (existing) {
          if (hasInsp) {
            // Fetch the full tire with its LATEST inspection to compare depths
            existingFull = await this.prisma.tire.findUnique({
              where:   { id: existing.id },
              include: {
                costos:       { orderBy: { fecha: 'asc' } },
                inspecciones: { orderBy: { fecha: 'desc' } },
                eventos:      { orderBy: { fecha: 'asc' }, select: { fecha: true, notas: true } },
              },
            });

            const lastInsp = existingFull?.inspecciones?.[0] ?? null;

            // ── Duplicate / replacement / new-inspection detection ───────────
            // Compare the uploaded depths against the latest inspection:
            //  • All three match exactly → duplicate upload, skip
            //  • All three are deeper by >3mm → tire was replaced on vehicle,
            //    dispose old tire and create a new one in its place
            //  • Otherwise → normal new inspection (wear progression)
            if (lastInsp) {
              const prevInt = lastInsp.profundidadInt ?? 0;
              const prevCen = lastInsp.profundidadCen ?? 0;
              const prevExt = lastInsp.profundidadExt ?? 0;

              const exactMatch =
                profInt === prevInt &&
                profCen === prevCen &&
                profExt === prevExt;

              // If user marked novedad = "cambio", never treat as duplicate
              if (exactMatch && !forceReplacement) {
                // Duplicate upload — same tire, same depths → skip entirely
                warnings.push(`Row ${rowNum}: llanta "${tirePlaca}" pos ${posicion} — profundidades idénticas a última inspección, omitida (duplicado).`);
                continue;
              }

              const REPLACEMENT_THRESHOLD_MM = 3;
              const allDeeper =
                (profInt - prevInt) > REPLACEMENT_THRESHOLD_MM &&
                (profCen - prevCen) > REPLACEMENT_THRESHOLD_MM &&
                (profExt - prevExt) > REPLACEMENT_THRESHOLD_MM;

              // Explicit replacement forces the dispose path, even without depth delta
              if (allDeeper || forceReplacement) {
                // Tire replaced — dispose old tire, then fall through to Branch B
                // to create the new tire in its position.
                const reason = forceReplacement
                  ? `novedad="${novedadRaw}" (reemplazo explícito)`
                  : `profundidades mucho mayores (${prevInt}/${prevCen}/${prevExt} → ${profInt}/${profCen}/${profExt})`;
                warnings.push(
                  `Row ${rowNum}: llanta "${tirePlaca}" pos ${posicion} — ${reason}. ` +
                  `Llanta anterior desmontada, nueva llanta creada.`
                );

                // Dispose: set vida to "fin", unassign from vehicle, record event
                await this.prisma.tire.update({
                  where: { id: existing.id },
                  data: {
                    vidaActual:         VidaValue.fin,
                    vehicleId:          null,
                    posicion:           0,
                    lastVehicleId:      existing.vehicleId ?? null,
                    lastVehiclePlaca:   vehicle?.placa ?? null,
                    lastPosicion:       existing.posicion ?? 0,
                    inventoryEnteredAt: new Date(),
                  },
                });

                await this.prisma.tireEvento.create({
                  data: {
                    tireId: existing.id,
                    tipo:   TireEventType.retiro,
                    fecha:  fechaInspeccion,
                    notas:  VidaValue.fin,
                    metadata: toJson({
                      motivo:   MotivoFinVida.preventivo,
                      reason:   'bulk_upload_replacement_detected',
                      prevDepth: { int: prevInt, cen: prevCen, ext: prevExt },
                      newDepth:  { int: profInt, cen: profCen, ext: profExt },
                    }),
                  },
                });

                tireIdsToRefresh.add(existing.id);
                if (existing.vehicleId) {
                  // Eagerly invalidate the vehicle cache since the tire was removed
                  this.invalidateVehicleCache(existing.vehicleId).catch(() => {});
                  this.cache.del(`analysis:${existing.vehicleId}`).catch(() => {});
                }

                // Reset "existing" so the code falls through to Branch B below
                // which creates a brand new tire at this position
                existing = null;
              }
            }
          }

          // ── Branch A continued: normal new inspection ─────────────────────
          if (existing && hasInsp) {
            const vidaActual  = existingFull?.vidaActual ?? VidaValue.nueva;
            const installDate = existingFull?.fechaInstalacion ?? fechaInstalacion;

            // Use the higher of Excel km vs existing accumulated km
            const bulkCurrentKm = Math.max(existing.kilometrosRecorridos ?? 0, kmEstimados);

            const { costForVida, kmForVida } = resolveVidaCostAndKm({
              costos:           existingFull?.costos       ?? [],
              inspecciones:     existingFull?.inspecciones ?? [],
              eventos:          existingFull?.eventos      ?? [],
              vidaActual,
              currentKm:        bulkCurrentKm,
              installationDate: installDate,
              creationKm:       0,
            });

            const metrics = calcCpkMetrics(
              costForVida,
              kmForVida,
              mesesEnUso,
              existing.profundidadInicial || profundidadInicial,
              minDepth,
              expectedLifetimeKm,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:               existing.id,
                fecha:                fechaInspeccion,
                profundidadInt:       profInt,
                profundidadCen:       profCen,
                profundidadExt:       profExt,
                cpk:                  metrics.cpk,
                cpkProyectado:        metrics.cpkProyectado,
                cpt:                  metrics.cpt,
                cptProyectado:        metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados:  bulkCurrentKm,
                kmActualVehiculo:     kmVehiculo || 0,
                kmEfectivos:          bulkCurrentKm,
                kmProyectado:         metrics.projectedKm,
                imageUrl:             get(row, 'imageurl') || null,
                presionPsi,
                presionRecomendadaPsi: presionRecomendada,
                presionDelta,
                vidaAlMomento:        vidaActual,
                source:               InspeccionSource.bulk_upload,
              },
            });

            // Take the max: never regress accumulated km. Excel may provide
            // an absolute total or a wear-based estimate — either way, we keep
            // the higher value to avoid losing tracked distance.
            const existingKm = existing.kilometrosRecorridos ?? 0;
            const resolvedKm = Math.max(existingKm, kmEstimados);

            await this.prisma.tire.update({
              where: { id: existing.id },
              data:  { kilometrosRecorridos: resolvedKm, diasAcumulados: Math.max(existing.diasAcumulados ?? 0, diasEnUso) },
            });

            tireIdsToRefresh.add(existing.id);
          }
        }

        // ── Branch B: new tire (or replacement — existing was set to null) ───
        if (!existing) {
          let finalTirePlaca = tirePlaca;
          const alreadyExists = await this.prisma.tire.findFirst({
            where: { placa: tirePlaca, companyId },
          });
          if (alreadyExists) {
            finalTirePlaca = tirePlaca + '*';
            warnings.push(`Row ${rowNum}: ID "${tirePlaca}" duplicado — guardado como "${finalTirePlaca}"`);
          }

          const newTire = await this.prisma.tire.create({
            data: {
              placa:                finalTirePlaca,
              marca,
              diseno,
              dimension,
              eje:                  (eje as EjeType) || EjeType.libre,
              posicion,
              profundidadInicial,
              companyId,
              vehicleId:            vehicle?.id ?? null,
              fechaInstalacion,
              kilometrosRecorridos: kmEstimados,
              diasAcumulados:       diasEnUso,
              alertLevel:           TireAlertLevel.ok,
              vidaActual:           vidaAlMomento,
              totalVidas:           0,
              primeraVida:          toJson([]),
            },
          });

          if (costoCell > 0) {
            await this.prisma.tireCosto.create({
              data: {
                tireId:   newTire.id,
                valor:    costoCell,
                fecha:    fechaInstalacion,
                concepto: 'compra_nueva',
              },
            });
          }

          if (vidaValor) {
            await this.prisma.tireEvento.create({
              data: {
                tireId:   newTire.id,
                tipo:     TireEventType.montaje,
                fecha:    fechaInstalacion,
                notas:    vidaValor,
                metadata: toJson({ vidaValor }),
              },
            });
          }

          if (hasInsp) {
            const metrics = calcCpkMetrics(
              costoCell, kmEstimados, mesesEnUso, profundidadInicial, minDepth,
              expectedLifetimeKm,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:               newTire.id,
                fecha:                fechaInspeccion,
                profundidadInt:       profInt,
                profundidadCen:       profCen,
                profundidadExt:       profExt,
                cpk:                  metrics.cpk,
                cpkProyectado:        metrics.cpkProyectado,
                cpt:                  metrics.cpt,
                cptProyectado:        metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados:  kmEstimados,
                kmActualVehiculo:     kmVehiculo || 0,
                kmEfectivos:          kmEstimados,
                kmProyectado:         metrics.projectedKm,
                imageUrl:             get(row, 'imageurl') || null,
                presionPsi,
                presionRecomendadaPsi: presionRecomendada,
                presionDelta,
                vidaAlMomento,
                source:               InspeccionSource.bulk_upload,
              },
            });
          }

          if (needsReencauche) {
            try {
              await this.updateVida(
                newTire.id, 'reencauche1',
                bandaName || diseno,
                C.REENCAUCHE_COST,
                profundidadInicial,
              );
            } catch (e: any) {
              errors.push(`Row ${rowNum}: Reencauche failed for "${finalTirePlaca}" — ${e.message}`);
            }
          }

          tireIdsToRefresh.add(newTire.id);
        }

      } catch (err: any) {
        this.logger.error(`Row ${rowNum} failed: ${err.message}`, err.stack);
        errors.push(`Row ${rowNum}: Unexpected error — ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PERF-FIX: run all analytics refreshes concurrently instead of serially.
    // For a 500-tire upload this is the difference between ~500 sequential DB
    // round-trips (slow) and one fan-out that Postgres handles via its own
    // connection pool.  Promise.allSettled so one failure doesn't abort others.
    // ─────────────────────────────────────────────────────────────────────────
    const refreshResults = await Promise.allSettled(
      [...tireIdsToRefresh].map(tireId =>
        this.refreshTireAnalyticsCache(tireId).catch(e =>
          this.logger.warn(`Analytics refresh failed for tire ${tireId}: ${e.message}`),
        ),
      ),
    );

    refreshResults
      .filter(r => r.status === 'rejected')
      .forEach((r: any) => this.logger.warn(`Analytics refresh error: ${r.reason}`));

    // ─────────────────────────────────────────────────────────────────────────
    // PERF-FIX: collect affected vehicleIds in one pass, then invalidate all
    // caches concurrently.
    // ─────────────────────────────────────────────────────────────────────────
    const affectedVehicleIds = new Set<string>();
    for (const v of vehicleMap.values()) {
      if (v?.id) affectedVehicleIds.add(v.id);
    }

    await Promise.allSettled([
      this.invalidateCompanyCache(companyId),
      ...[...affectedVehicleIds].map(vid =>
        Promise.allSettled([
          this.invalidateVehicleCache(vid),
          this.cache.del(`analysis:${vid}`),
        ]),
      ),
    ]);

    const createdTireIds = [...tireIdsToRefresh];

    // Snapshot the upload so the user has a 7-day window to revert or
    // re-apply with edits. Only records when we actually created/touched
    // tires and the caller asked for it (the default).
    let snapshotId: string | undefined;
    if (opts.recordSnapshot !== false && createdTireIds.length > 0) {
      try {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const snap = await this.prisma.bulkUploadSnapshot.create({
          data: {
            companyId,
            userId:     opts.userId ?? null,
            fileName:   opts.fileName ?? null,
            tireCount:  createdTireIds.length,
            tireIds:    createdTireIds,
            rawRows:    rows as any,
            expiresAt,
          },
          select: { id: true },
        });
        snapshotId = snap.id;
      } catch (err) {
        // Snapshot failure must not break the upload itself.
        this.logger.warn(`Bulk snapshot record failed: ${(err as Error).message}`);
      }
    }

    return {
      message:  `Carga completada. ${processedIds.size} llantas procesadas. ${warnings.length} advertencias. ${errors.length} errores.`,
      success:  processedIds.size,
      errors:   errors.length,
      warnings: warnings.length,
      // IDs of tires actually created/touched in this run — used by the UI to
      // support undoing the last bulk upload.
      createdTireIds,
      snapshotId,
      details:  { errors, warnings },
    };
  }

  /**
   * Bulk-delete tires by ID. Used by the "undo last bulk upload" feature.
   * Cascades to inspecciones / eventos / costos / vida snapshots via Prisma.
   * Scoped to companyId so a tenant cannot delete another tenant's tires.
   */
  // ===========================================================================
  // BULK UPLOAD SNAPSHOTS — 1-week rewind window for bulk uploads
  // ===========================================================================

  /** List non-expired, non-invalidated snapshots for a company. */
  async listRecentBulkUploads(companyId: string) {
    const now = new Date();
    const rows = await this.prisma.bulkUploadSnapshot.findMany({
      where: {
        companyId,
        expiresAt:  { gt: now },
        invalidated: false,
      },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true, uploadedAt: true, expiresAt: true, fileName: true,
        tireCount: true, userId: true, tireIds: true,
      },
      take: 20,
    });
    return rows;
  }

  async getBulkUpload(id: string, companyId: string) {
    const snap = await this.prisma.bulkUploadSnapshot.findFirst({
      where: { id, companyId },
    });
    if (!snap) throw new NotFoundException('Bulk upload snapshot not found');
    const expired = snap.expiresAt.getTime() <= Date.now();
    return { ...snap, expired };
  }

  /**
   * Delete all tires captured by the snapshot and remove the snapshot.
   * Fails fast if the snapshot is already invalidated (a tire was
   * touched) or expired — caller should refresh the list.
   */
  async revertBulkUpload(id: string, companyId: string) {
    const snap = await this.prisma.bulkUploadSnapshot.findFirst({
      where: { id, companyId },
    });
    if (!snap) throw new NotFoundException('Bulk upload snapshot not found');
    if (snap.invalidated) {
      throw new BadRequestException(
        'Esta carga ya no se puede revertir — se inspeccionó o modificó una llanta de la carga.',
      );
    }
    if (snap.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Esta carga expiró (ventana de 7 días).');
    }

    const res = await this.bulkDeleteTires(snap.tireIds, companyId);
    await this.prisma.bulkUploadSnapshot.delete({ where: { id } });
    return { reverted: res.deleted };
  }

  /**
   * Delete the current tires then re-run the upload with edited rows.
   * Produces a fresh snapshot; the old one is replaced.
   */
  async reapplyBulkUpload(
    id: string,
    companyId: string,
    editedRows: Record<string, any>[],
    userId?: string,
  ) {
    const snap = await this.prisma.bulkUploadSnapshot.findFirst({
      where: { id, companyId },
    });
    if (!snap) throw new NotFoundException('Bulk upload snapshot not found');
    if (snap.invalidated) {
      throw new BadRequestException(
        'Esta carga ya no se puede re-aplicar — se inspeccionó o modificó una llanta de la carga.',
      );
    }
    if (snap.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Esta carga expiró (ventana de 7 días).');
    }
    if (!Array.isArray(editedRows) || editedRows.length === 0) {
      throw new BadRequestException('No se recibieron filas para re-aplicar');
    }

    // Delete previously-created tires first so the new run is a clean slate.
    await this.bulkDeleteTires(snap.tireIds, companyId);
    await this.prisma.bulkUploadSnapshot.delete({ where: { id } });

    // Serialise the edited rows back into an xlsx buffer so the existing
    // parser consumes them the same way as a fresh upload.
    const ws = XLSX.utils.json_to_sheet(editedRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    return this.bulkUploadTires(
      { buffer },
      companyId,
      { userId, fileName: snap.fileName ?? `reapplied-${Date.now()}.xlsx` },
    );
  }

  /**
   * Invalidate every active snapshot that contains this tire — called
   * from any mutation path that "commits" user work (inspections, vida
   * changes, etc.) so a later revert can't undo real data.
   */
  async invalidateSnapshotsForTire(tireId: string, reason = 'tire-mutated'): Promise<void> {
    try {
      await this.prisma.bulkUploadSnapshot.updateMany({
        where: {
          tireIds:     { has: tireId },
          invalidated: false,
          expiresAt:   { gt: new Date() },
        },
        data: {
          invalidated:       true,
          invalidatedAt:     new Date(),
          invalidatedReason: reason,
        },
      });
    } catch (err) {
      this.logger.warn(`invalidateSnapshotsForTire failed: ${(err as Error).message}`);
    }
  }

  async bulkDeleteTires(tireIds: string[], companyId: string) {
    if (!Array.isArray(tireIds) || tireIds.length === 0) {
      return { deleted: 0 };
    }

    // Capture affected vehicles BEFORE deletion so we can invalidate their
    // caches afterwards.
    const tires = await this.prisma.tire.findMany({
      where: { id: { in: tireIds }, companyId },
      select: { id: true, vehicleId: true },
    });
    const affectedVehicleIds = new Set(
      tires.map(t => t.vehicleId).filter((v): v is string => !!v),
    );

    const result = await this.prisma.tire.deleteMany({
      where: { id: { in: tireIds }, companyId },
    });

    await Promise.allSettled([
      this.invalidateCompanyCache(companyId),
      ...[...affectedVehicleIds].map(vid =>
        Promise.allSettled([
          this.invalidateVehicleCache(vid),
          this.cache.del(`analysis:${vid}`),
        ]),
      ),
    ]);

    return { deleted: result.count };
  }

  // ===========================================================================
  // READ  (unchanged)
  // ===========================================================================

  async findTireById(id: string) {
    const tire = await this.prisma.tire.findUnique({
      where: { id },
      include: {
        inspecciones:  { orderBy: { fecha: 'desc' } },
        costos:        { orderBy: { fecha: 'asc' } },
        eventos:       { orderBy: { fecha: 'desc' } },
        vehicle:       { select: { placa: true, tipovhc: true, tipoOperacion: true } },
        vidaSnapshots: { orderBy: { fechaInicio: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');
    return tire;
  }

  async findTiresByCompany(companyId: string, opts: { slim?: boolean } = {}) {
    const cacheKey = opts.slim ? `${this.tireKey(companyId)}:slim` : this.tireKey(companyId);
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    // Slim mode projects only the fields the Resumen / DetallesLlantas pages
    // actually read. For a 5k-tire company this cuts the payload from ~50 MB
    // (full history with every depth, pressure, image URL, etc.) down to a
    // few MB.  The frontend shape (costos, inspecciones, eventos arrays with
    // the usual names) is preserved so no component needs to change.
    const tires = opts.slim
      ? await this.prisma.tire.findMany({
          where: { companyId },
          select: {
            id: true, placa: true, marca: true, diseno: true, dimension: true, eje: true,
            posicion: true, vehicleId: true, vidaActual: true, profundidadInicial: true,
            kilometrosRecorridos: true, currentCpk: true, lifetimeCpk: true, currentCpt: true,
            currentProfundidad: true, currentPresionPsi: true, projectedProfundidad: true,
            projectedAlertLevel: true, projectedHealthScore: true, projectedDaysToLimit: true,
            projectedKmRemaining: true, projectedDateEOL: true, healthScore: true,
            alertLevel: true, lastInspeccionDate: true, fechaInstalacion: true,
            createdAt: true, updatedAt: true,
            costos: {
              orderBy: { fecha: 'desc' },
              select: { valor: true, fecha: true, concepto: true },
            },
            inspecciones: {
              orderBy: { fecha: 'desc' },
              take: 12, // last year-ish of inspections is plenty for charts
              select: {
                fecha: true, cpk: true, cpkProyectado: true, kmProyectado: true,
                kilometrosEstimados: true, profundidadInt: true, profundidadCen: true,
                profundidadExt: true, vidaAlMomento: true,
              },
            },
            eventos: {
              where: { tipo: 'montaje' }, // only the vida-history ones the UI cares about
              select: { tipo: true, fecha: true, notas: true },
            },
            vehicle: { select: { placa: true, tipovhc: true, tipoOperacion: true } },
          },
        })
      : await this.prisma.tire.findMany({
          where: { companyId },
          include: {
            inspecciones: { orderBy: { fecha: 'desc' } },
            costos:       true,
            eventos:      true,
            vehicle:      { select: { placa: true, tipovhc: true, tipoOperacion: true } },
          },
        });

    // Slim cache lives shorter — a user typically reloads the page within
    // minutes of an edit, and the slim projection is cheap to rebuild.
    const ttl = opts.slim ? 10 * 60 * 1000 : TireService.TTL_COMPANY;
    await this.cache.set(cacheKey, tires, ttl);
    return tires;
  }

  /**
   * Cursor-paginated tire fetch for the dashboard. Designed for distributor
   * accounts with 100k+ tires where loading the full set in one go is
   * impractical — even the slim projection blows past the browser's sane
   * payload budget.
   *
   * Contract:
   *   - Order is (companyId, id asc) which is covered by Tire_companyId_id_idx
   *     so each page is an O(log n) seek, not a full scan.
   *   - `cursor` is the last id from the previous page. First call: omit.
   *   - Returns `{ data, nextCursor }`. When nextCursor is null, you're done.
   *   - Same slim projection + Redis cache as findTiresByCompany, keyed by
   *     (companyId, cursor) so pages are cached independently.
   */
  async findTiresPaged(params: {
    companyId: string;
    cursor?: string | null;
    limit?:  number;
  }) {
    // Larger pages = fewer round-trips. 20k-tire accounts now finish in ~10
    // requests instead of 40. 2,000 is the sweet spot: big enough to cut
    // latency, small enough to keep each JSON response under ~3 MB gzipped.
    const limit = Math.min(Math.max(params.limit ?? 2000, 1), 2000);
    const cursor = params.cursor?.trim() || null;
    const cacheKey = `${this.tireKey(params.companyId)}:pg:${cursor ?? 'first'}:${limit}`;

    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const where: Prisma.TireWhereInput = { companyId: params.companyId };
    if (cursor) where.id = { gt: cursor };

    // Fetch one extra row so we know if there's another page without a
    // second round-trip to count.
    const rows = await this.prisma.tire.findMany({
      where,
      orderBy: { id: 'asc' },
      take:    limit + 1,
      select: {
        id: true, placa: true, marca: true, diseno: true, dimension: true, eje: true,
        posicion: true, vehicleId: true, vidaActual: true, profundidadInicial: true,
        kilometrosRecorridos: true, currentCpk: true, lifetimeCpk: true, currentCpt: true,
        currentProfundidad: true, currentPresionPsi: true, projectedProfundidad: true,
        projectedAlertLevel: true, projectedHealthScore: true, projectedDaysToLimit: true,
        projectedKmRemaining: true, projectedDateEOL: true, healthScore: true,
        alertLevel: true, lastInspeccionDate: true, fechaInstalacion: true,
        createdAt: true, updatedAt: true,
        costos: {
          orderBy: { fecha: 'desc' },
          select: { valor: true, fecha: true, concepto: true },
        },
        inspecciones: {
          orderBy: { fecha: 'desc' },
          take: 12,
          select: {
            fecha: true, cpk: true, cpkProyectado: true, kmProyectado: true,
            kilometrosEstimados: true, profundidadInt: true, profundidadCen: true,
            profundidadExt: true, vidaAlMomento: true,
          },
        },
        eventos: {
          where: { tipo: 'montaje' },
          select: { tipo: true, fecha: true, notas: true },
        },
        vehicle: { select: { placa: true, tipovhc: true, tipoOperacion: true } },
      },
    });

    const hasMore = rows.length > limit;
    const data    = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    const payload = { data, nextCursor, limit };
    await this.cache.set(cacheKey, payload, 10 * 60 * 1000);
    return payload;
  }

  /**
   * Lightweight paginated tire search — designed for distributor dashboards
   * that may manage 200k+ tires. Returns only the latest inspection per tire,
   * skips full cost/event history to keep payloads small.
   */
  async searchTires(opts: {
    companyId: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const take = Math.min(opts.limit ?? 50, 200);
    const skip = opts.offset ?? 0;
    const q    = opts.q?.trim().toLowerCase();

    const where: Prisma.TireWhereInput = { companyId: opts.companyId };

    if (q) {
      where.OR = [
        { placa: { contains: q, mode: 'insensitive' } },
        { marca: { contains: q, mode: 'insensitive' } },
        { diseno: { contains: q, mode: 'insensitive' } },
        { id:    { contains: q, mode: 'insensitive' } },
      ];
    }

    const [tires, total] = await Promise.all([
      this.prisma.tire.findMany({
        where,
        take,
        skip,
        orderBy: [{ lastInspeccionDate: 'desc' }],
        include: {
          inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
          vehicle:      { select: { placa: true, tipovhc: true } },
        },
      }),
      this.prisma.tire.count({ where }),
    ]);

    return { data: tires, total, limit: take, offset: skip };
  }

  /**
   * Lightweight paginated tire list for a company — returns summary data only.
   * Used by alert screens and distributor overviews that need to process
   * large fleets without pulling full inspection/cost history.
   */
  async listTiresSummary(opts: {
    companyId: string;
    limit?: number;
    offset?: number;
    alertLevel?: TireAlertLevel;
  }) {
    const take = Math.min(opts.limit ?? 100, 500);
    const skip = opts.offset ?? 0;

    const where: Prisma.TireWhereInput = { companyId: opts.companyId };
    if (opts.alertLevel) where.alertLevel = opts.alertLevel;

    const [tires, total] = await Promise.all([
      this.prisma.tire.findMany({
        where,
        take,
        skip,
        orderBy: [{ lastInspeccionDate: 'desc' }],
        include: {
          inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
          costos:       { orderBy: { fecha: 'desc' }, take: 1 },
          vehicle:      { select: { placa: true, tipovhc: true } },
        },
      }),
      this.prisma.tire.count({ where }),
    ]);

    return { data: tires, total, limit: take, offset: skip };
  }

  async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');

    const cacheKey = this.vehicleKey(vehicleId);
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      where:   { vehicleId },
      include: {
        inspecciones:  { orderBy: { fecha: 'desc' } },
        costos:        { orderBy: { fecha: 'asc'  } },
        eventos:       { orderBy: { fecha: 'asc'  } },
        vidaSnapshots: { orderBy: { fechaInicio: 'asc' } },
      },
    });

    await this.cache.set(cacheKey, tires, TireService.TTL_VEHICLE);
    return tires;
  }

  async findAllTires() {
    const cacheKey = 'tires:all';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      include: { inspecciones: { orderBy: { fecha: 'desc' }, take: 1 } },
    });

    await this.cache.set(cacheKey, tires, TireService.TTL_VEHICLE);
    return tires;
  }

  // ===========================================================================
  // INSPECTOR KPIs — used by the distributor dashboard to track who
  // inspected what and how often. Aggregates by inspeccionadoPorId when
  // present, otherwise by normalised name (lowercased, trimmed) so a
  // technician who inspected a few without being logged in still gets
  // credited. Returns per-inspector totals and (optionally) per-month
  // breakdowns.
  // ===========================================================================
  async getInspectorStats(params: {
    companyId: string;
    from?: string;
    to?: string;
    groupBy: 'total' | 'month';
  }) {
    const rangeFrom = params.from ? new Date(params.from) : new Date(Date.now() - 90 * 86_400_000);
    const rangeTo   = params.to   ? new Date(params.to)   : new Date();
    // Include the whole "to" day so the caller can pass YYYY-MM-DD.
    rangeTo.setHours(23, 59, 59, 999);

    const rows = await this.prisma.inspeccion.findMany({
      where: {
        fecha: { gte: rangeFrom, lte: rangeTo },
        tire:  { companyId: params.companyId },
      },
      select: {
        fecha:                  true,
        inspeccionadoPorId:     true,
        inspeccionadoPorNombre: true,
        tire: { select: { vehicleId: true, placa: true } },
      },
      orderBy: { fecha: 'desc' },
    });

    // Build per-inspector aggregate. Key preference: userId > normalised
    // name > "(Sin identificar)" for rows that never captured either.
    type Bucket = {
      key: string;
      inspeccionadoPorId: string | null;
      nombre: string;
      count: number;
      tires: Set<string>;
      vehicles: Set<string>;
      firstInspection: Date | null;
      lastInspection: Date | null;
      byMonth: Map<string, number>;
    };

    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const id    = r.inspeccionadoPorId ?? null;
      const name  = (r.inspeccionadoPorNombre ?? '').trim();
      const key   = id ?? (name ? `name:${name.toLowerCase()}` : 'unknown');
      const label = id
        ? (name || 'Usuario')
        : (name || '(Sin identificar)');

      let b = buckets.get(key);
      if (!b) {
        b = {
          key,
          inspeccionadoPorId: id,
          nombre: label,
          count: 0,
          tires: new Set(),
          vehicles: new Set(),
          firstInspection: null,
          lastInspection: null,
          byMonth: new Map(),
        };
        buckets.set(key, b);
      }
      b.count += 1;
      b.tires.add(r.tire.placa);
      if (r.tire.vehicleId) b.vehicles.add(r.tire.vehicleId);
      const f = new Date(r.fecha);
      if (!b.firstInspection || f < b.firstInspection) b.firstInspection = f;
      if (!b.lastInspection  || f > b.lastInspection)  b.lastInspection  = f;
      const monthKey = f.toISOString().slice(0, 7); // YYYY-MM
      b.byMonth.set(monthKey, (b.byMonth.get(monthKey) ?? 0) + 1);
    }

    const inspectors = Array.from(buckets.values())
      .map((b) => ({
        inspeccionadoPorId: b.inspeccionadoPorId,
        nombre:             b.nombre,
        totalInspecciones:  b.count,
        llantasUnicas:      b.tires.size,
        vehiculosUnicos:    b.vehicles.size,
        firstInspection:    b.firstInspection,
        lastInspection:     b.lastInspection,
        porMes: params.groupBy === 'month'
          ? Array.from(b.byMonth.entries())
              .sort(([a], [c]) => (a < c ? -1 : 1))
              .map(([mes, count]) => ({ mes, count }))
          : undefined,
      }))
      .sort((a, b) => b.totalInspecciones - a.totalInspecciones);

    return {
      from:  rangeFrom.toISOString(),
      to:    rangeTo.toISOString(),
      total: rows.length,
      inspectors,
    };
  }

  // ===========================================================================
  // UPDATE INSPECTION  (bug fixes noted inline)
  // ===========================================================================

  async updateInspection(tireId: string, dto: UpdateInspectionDto) {
    if (dto.profundidadInt === 0 && dto.profundidadCen === 0 && dto.profundidadExt === 0) {
      return this.prisma.tire.findUnique({ where: { id: tireId } });
    }

    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc'  } },
        inspecciones: { orderBy: { fecha: 'asc'  } },
        eventos:      { orderBy: { fecha: 'asc'  } },
        vehicle:      true,
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    const vehicle      = tire.vehicle ?? null;
    const odometerSent = !!(dto.newKilometraje && dto.newKilometraje > 0 && vehicle);
    const newVehicleKm = dto.newKilometraje || 0;
    const priorTireKm  = tire.kilometrosRecorridos || 0;

    let kilometrosRecorridos: number;
    const kmDelta = dto.kmDelta ?? 0;

    // ── Precompute signals used by both the "unreasonable delta" guard
    // and the new "km missing / no growth" fallback. ─────────────────────
    const newMinDepth  = calcMinDepth(dto.profundidadInt, dto.profundidadCen, dto.profundidadExt);
    const prevLastInsp = tire.inspecciones.length > 0
      ? tire.inspecciones[tire.inspecciones.length - 1]
      : null;
    const prevMinDepth = prevLastInsp
      ? calcMinDepth(prevLastInsp.profundidadInt, prevLastInsp.profundidadCen, prevLastInsp.profundidadExt)
      : tire.profundidadInicial;
    const mmWornSinceLast = prevLastInsp
      ? Math.max(prevMinDepth - newMinDepth, 0)
      : Math.max(tire.profundidadInicial - newMinDepth, 0);
    const daysSinceLastInsp = prevLastInsp
      ? Math.max(
          Math.floor(
            ((dto.fecha ? new Date(dto.fecha).getTime() : Date.now()) -
              new Date(prevLastInsp.fecha).getTime()) / C.MS_POR_DIA,
          ),
          0,
        )
      : Math.max(
          Math.floor(
            ((dto.fecha ? new Date(dto.fecha).getTime() : Date.now()) -
              new Date(tire.fechaInstalacion ?? tire.createdAt).getTime()) / C.MS_POR_DIA,
          ),
          0,
        );
    const usableDepthForEst = Math.max(tire.profundidadInicial - C.LIMITE_LEGAL_MM, 1);
    const expectedLifetimeKm = C.STANDARD_TIRE_EXPECTED_KM; // 80 000

    if (dto.forceKm !== undefined && dto.forceKm >= 0) {
      kilometrosRecorridos = dto.forceKm;
    } else if (kmDelta > 0) {
      kilometrosRecorridos = priorTireKm + kmDelta;
    } else if (odometerSent && tire.inspecciones.length > 0) {
      const lastKnownVehicleKm =
        tire.inspecciones[tire.inspecciones.length - 1].kmActualVehiculo
        ?? vehicle.kilometrajeActual
        ?? 0;
      const rawDelta = Math.max(newVehicleKm - lastKnownVehicleKm, 0);

      const KM_PER_MM_SANITY = 10_000; // above this ratio the delta is suspect
      const deltaIsUnreasonable =
        mmWornSinceLast > 0 && rawDelta / mmWornSinceLast >= KM_PER_MM_SANITY;

      if (rawDelta <= 0) {
        // User entered the same vehicle odometer as last time (or lower).
        // Estimate movement from wear + days — averaging when both exist.
        const estimated = estimateKmDelta({
          mmWorn: mmWornSinceLast,
          daysElapsed: daysSinceLastInsp,
          usableDepth: usableDepthForEst,
          expectedLifetimeKm,
        });
        kilometrosRecorridos = priorTireKm + estimated;
      } else if (deltaIsUnreasonable) {
        // Known bulk-upload issue: vehicle km starts at 0 so the first
        // real delta is enormous. Fall back to wear-based extrapolation
        // but never regress the tire odometer.
        const totalMmWorn = Math.max(tire.profundidadInicial - newMinDepth, 0);
        const estimatedTotalKm = usableDepthForEst > 0
          ? Math.round((expectedLifetimeKm / usableDepthForEst) * totalMmWorn)
          : priorTireKm;
        kilometrosRecorridos = Math.max(estimatedTotalKm, priorTireKm);
      } else {
        kilometrosRecorridos = priorTireKm + rawDelta;
      }
    } else {
      // No odometer provided AND no explicit delta. Estimate using the
      // same wear + days signal so the tire's km keeps moving forward
      // inspection to inspection — otherwise CPK is stuck.
      const estimated = estimateKmDelta({
        mmWorn: mmWornSinceLast,
        daysElapsed: daysSinceLastInsp,
        usableDepth: usableDepthForEst,
        expectedLifetimeKm,
      });
      kilometrosRecorridos = priorTireKm + estimated;
    }

    const now              = dto.fecha ? new Date(dto.fecha) : new Date();
    const fechaInstalacion = dto.fechaInstalacion
      ? new Date(dto.fechaInstalacion)
      : (tire.fechaInstalacion ?? now);

    const diasEnUso = Math.max(
      Math.floor((now.getTime() - new Date(fechaInstalacion).getTime()) / C.MS_POR_DIA),
      1,
    );
    const mesesEnUso = diasEnUso / 30;

    const minDepth = calcMinDepth(dto.profundidadInt, dto.profundidadCen, dto.profundidadExt);

    // PERF-FIX: prefer actual km over time-based estimate; only fall back when
    // we genuinely have no odometer data at all.
    const effectiveKm =
      kilometrosRecorridos > 0 ? kilometrosRecorridos :
      odometerSent         ? newVehicleKm           :
      mesesEnUso > 0       ? Math.round(mesesEnUso * C.KM_POR_MES) :
      0;

    const { costForVida, kmForVida } = resolveVidaCostAndKm({
      costos:           tire.costos,
      inspecciones:     tire.inspecciones,
      eventos:          tire.eventos,
      vidaActual:       tire.vidaActual ?? VidaValue.nueva,
      currentKm:        effectiveKm,
      installationDate: tire.fechaInstalacion ?? now,
      creationKm:       0, // tires start at 0 km for their first vida
    });

    const metrics = calcCpkMetrics(
      costForVida,
      kmForVida,
      mesesEnUso,
      tire.profundidadInicial,
      minDepth,
    );

    // Lifetime CPK: total costs (all vidas) ÷ total km lived. Captured on
    // every inspection so dashboards can chart it over time without
    // re-aggregating costs on the read path.
    const lifetimeTotalCost = tire.costos.reduce((s, c) => s + (c.valor ?? 0), 0);
    const lifetimeCpkAtInspection = effectiveKm > 0 && lifetimeTotalCost > 0
      ? parseFloat((lifetimeTotalCost / effectiveKm).toFixed(2))
      : null;

    const presionPsi: number | null = dto.presionPsi ?? null;
    const presionRecomendada =
      dto.presionRecomendadaPsi
      ?? resolvePresionRecomendada(vehicle, tire.posicion)
      ?? null;
    const presionDelta = (presionPsi != null && presionRecomendada != null)
      ? presionPsi - presionRecomendada
      : null;

    const source: InspeccionSource = dto.source ?? InspeccionSource.manual;

    const inspeccionadoPorId:     string | null = dto.inspeccionadoPorId     ?? null;
    const inspeccionadoPorNombre: string | null = dto.inspeccionadoPorNombre ?? null;

    // Handle up to 2 photos per inspection. dto.imageUrls is the new
    // canonical path; dto.imageUrl is kept for older clients still
    // posting a single photo. Each entry may be either an existing S3
    // URL (preserved) or a data:image/... payload (uploaded to S3).
    const rawImages: string[] = [];
    if (Array.isArray(dto.imageUrls) && dto.imageUrls.length > 0) {
      rawImages.push(...dto.imageUrls.slice(0, 3));
    } else if (dto.imageUrl) {
      rawImages.push(dto.imageUrl);
    }

    const finalImageUrls = await Promise.all(
      rawImages.map(async (img, idx) => {
        if (img?.startsWith('data:')) {
          const [header, b64] = img.split(',');
          const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
          return this.s3.uploadInspectionImage(
            Buffer.from(b64, 'base64'), tireId, mime, idx,
          );
        }
        return img;
      }),
    );
    const finalImageUrl = finalImageUrls[0] ?? null;

    const cvProfundidadInt: number | null = dto.cvProfundidadInt ?? null;
    const cvProfundidadCen: number | null = dto.cvProfundidadCen ?? null;
    const cvProfundidadExt: number | null = dto.cvProfundidadExt ?? null;
    const cvConfidence:     number | null = dto.cvConfidence     ?? null;
    const cvModelVersion:   string | null = dto.cvModelVersion   ?? null;

    await this.prisma.inspeccion.create({
      data: {
        tireId,
        fecha:                 now,
        profundidadInt:        dto.profundidadInt,
        profundidadCen:        dto.profundidadCen,
        profundidadExt:        dto.profundidadExt,
        cpk:                   metrics.cpk,
        lifetimeCpk:           lifetimeCpkAtInspection,
        cpkProyectado:         metrics.cpkProyectado,
        cpt:                   metrics.cpt,
        cptProyectado:         metrics.cptProyectado,
        diasEnUso,
        mesesEnUso,
        kilometrosEstimados:   kilometrosRecorridos,
        kmActualVehiculo: odometerSent ? newVehicleKm : (vehicle?.kilometrajeActual || 0),
        kmEfectivos:           effectiveKm,
        kmProyectado:          metrics.projectedKm,
        imageUrl:              finalImageUrl,
        imageUrls:             finalImageUrls,
        presionPsi,
        presionRecomendadaPsi: presionRecomendada,
        presionDelta,
        vidaAlMomento:         tire.vidaActual ?? VidaValue.nueva,
        source,
        inspeccionadoPorId,
        inspeccionadoPorNombre,
        cvProfundidadInt,
        cvProfundidadCen,
        cvProfundidadExt,
        cvConfidence,
        cvModelVersion,
      },
    });

    await Promise.all([
      this.prisma.tire.update({
        where: { id: tireId },
        data:  {
          kilometrosRecorridos,
          diasAcumulados:     diasEnUso,
          lastInspeccionDate: now,
        },
      }),
      odometerSent
        ? this.prisma.vehicle.update({
            where: { id: vehicle.id },
            data:  { kilometrajeActual: newVehicleKm },
          })
        : Promise.resolve(),
    ]);

    const updatedTire = await this.refreshTireAnalyticsCache(tireId);

    // Any bulk-upload snapshot containing this tire is now "committed
    // work" — a blind revert would destroy the inspection we just wrote.
    this.invalidateSnapshotsForTire(tireId, 'inspection').catch(() => {});

    await this.notificationsService.deleteByTire(tireId);

    // ── Single source of truth: buildTireAnalysis generates all recommendations ──
    try {
      const analysis = this.buildTireAnalysis(updatedTire);
      const recs = analysis.recomendaciones;

      if (recs.length > 0) {
        // Delete any existing unexecuted notifications for this tire — replace with fresh analysis
        await this.prisma.notification.deleteMany({
          where: { tireId, executed: false },
        });

        {
          // Determine the most appropriate actionType from the top recommendation
          const topRec = recs[0];
          let actionType = 'inspect';
          let priority = 1;

          if (topRec.includes('Retiro') || topRec.includes('retirar') || topRec.includes('Retirar')) {
            actionType = 'remove_from_service';
            priority = 3;
          } else if (topRec.includes('alineación') || topRec.includes('Alineación')) {
            actionType = 'pressure_adjust';
            priority = 2;
          } else if (topRec.includes('presión') || topRec.includes('Presión') || topRec.includes('Sobreinflado') || topRec.includes('sobreinflado')) {
            actionType = 'pressure_adjust';
            priority = 2;
          } else if (topRec.includes('reencauche') || topRec.includes('Reencauche') || topRec.includes('Regrabado')) {
            actionType = 'retread';
            priority = 2;
          } else if (topRec.includes('rotar') || topRec.includes('Rotar') || topRec.includes('Emparejar')) {
            actionType = 'rotate';
            priority = 2;
          }

          const isCritical = updatedTire.alertLevel === TireAlertLevel.critical
            || topRec.includes('🔴');

          // Use top recommendation as title, additional ones as message body
          const cleanTitle = topRec.replace(/^[🔴🟡🟢⚠️\s]+/, '').substring(0, 120);
          const additionalRecs = recs.slice(1).map(r => r.replace(/^[🔴🟡🟢⚠️\s]+/, '')).join(' | ');

          await this.notificationsService.createNotification({
            title: `${updatedTire.placa} P${updatedTire.posicion}`,
            message: cleanTitle,
            type: isCritical ? 'critical' : 'warning',
            tireId,
            vehicleId: updatedTire.vehicleId ?? undefined,
            companyId: updatedTire.companyId ?? undefined,
            actionType,
            actionPayload: { tireId, position: updatedTire.posicion, vehicleId: updatedTire.vehicleId },
            actionLabel: additionalRecs || undefined,
            groupKey: updatedTire.vehicleId ?? undefined,
            priority,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Notification creation failed for tire ${tireId}: ${err.message}`);
    }

    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await Promise.allSettled([
        this.invalidateVehicleCache(tire.vehicleId),
        this.cache.del(`analysis:${tire.vehicleId}`),
      ]);
    }

    // Fire-and-forget: enrich catalog with fresh crowd data after each inspection
    this.catalogService
      .enrichFromTireData(tire.marca, tire.dimension, tire.diseno)
      .catch((err) => this.logger.warn(`Crowdsource enrich failed: ${err.message}`));

    return updatedTire;
  }

  // ===========================================================================
  // UPDATE VIDA  (unchanged — correct as-is)
  // ===========================================================================

  async updateVida(
    tireId: string,
    newValor: string | undefined,
    banda?: string,
    costo?: number,
    profundidadInicial?: number | string,
    proveedor?: string,
    desechoData?: {
      causales:             string;
      milimetrosDesechados: number;
      imageUrls?:           string[];
    },
    bandaMarca?: string,
    motivoFinOverride?: MotivoFinVida,
    notasRetiro?: string,
  ) {
    if (!newValor) throw new BadRequestException(`El campo 'valor' es obligatorio`);

    const normalizedValor = newValor.toLowerCase() as VidaValue;
    const newIndex        = VIDA_SEQUENCE.indexOf(normalizedValor);
    if (newIndex < 0) throw new BadRequestException(`"${newValor}" no es un valor válido`);

    let parsedProfundidad: number | null = null;
    if (normalizedValor !== VidaValue.fin) {
      if (profundidadInicial === undefined || profundidadInicial === null || profundidadInicial === '') {
        throw new BadRequestException('La profundidad inicial es requerida.');
      }
      parsedProfundidad = typeof profundidadInicial === 'string'
        ? parseFloat(profundidadInicial)
        : Number(profundidadInicial);
      if (isNaN(parsedProfundidad) || parsedProfundidad <= 0) {
        throw new BadRequestException('La profundidad inicial debe ser mayor a 0.');
      }
    }

    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        eventos:      { orderBy: { fecha: 'asc' } },
        inspecciones: { orderBy: { fecha: 'asc' } },
        costos:       { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    const currentVida  = tire.vidaActual ?? this.resolveCurrentVida(tire.eventos);
    const currentIndex = VIDA_SEQUENCE.indexOf(currentVida);

    if (newIndex <= currentIndex) {
      throw new BadRequestException(
        `Debe avanzar en la secuencia. Vida actual: "${currentVida}".`,
      );
    }

    const now = new Date();

    const fechaInicioCurrentVida = this.resolveVidaStartDate(
      tire.eventos,
      currentVida,
      tire.fechaInstalacion ?? tire.createdAt,
    );

    const vidaInsps  = tire.inspecciones.filter(
      (i: any) => new Date(i.fecha) >= fechaInicioCurrentVida,
    );
    const vidaCostos = tire.costos.filter(
      (c: any) => new Date(c.fecha) >= fechaInicioCurrentVida,
    );

    let finalDesechoImageUrls: string[] = [];
    if (normalizedValor === VidaValue.fin && desechoData?.imageUrls?.length) {
      finalDesechoImageUrls = await Promise.all(
        desechoData.imageUrls.slice(0, 3).map(async (img, idx) => {
          if (img.startsWith('data:')) {
            const [header, b64] = img.split(',');
            const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
            return this.s3.uploadDesechoImage(Buffer.from(b64, 'base64'), tireId, idx, mime);
          }
          return img;
        }),
      );
    }

    const motivoFin: MotivoFinVida | undefined =
      motivoFinOverride
      ?? (normalizedValor.startsWith('reencauche') ? MotivoFinVida.reencauche :
          normalizedValor === VidaValue.fin        ? MotivoFinVida.desgaste   :
          undefined);

    const snapshotPayload = buildVidaSnapshotPayload({
      tire,
      vida:        currentVida,
      vidaInsps,
      vidaCostos,
      fechaInicio: fechaInicioCurrentVida,
      fechaFin:    now,
      bandaNombre: banda?.trim(),
      bandaMarca:  bandaMarca?.trim(),
      proveedor,
      motivoFin,
      notasRetiro,
      desechoData: normalizedValor === VidaValue.fin && desechoData
        ? { ...desechoData, imageUrls: finalDesechoImageUrls }
        : undefined,
    });

    await this.prisma.tireVidaSnapshot.create({
      data: {
        ...snapshotPayload,
        tireId,
        companyId: tire.companyId,
      },
    });

    if (normalizedValor.startsWith('reencauche') && parsedProfundidad !== null) {
      const reencaucheCost = typeof costo === 'number' && costo > 0 ? costo : C.REENCAUCHE_COST;

      const metrics = calcCpkMetrics(
        reencaucheCost, 0, 0, parsedProfundidad, parsedProfundidad,
      );

      await this.prisma.inspeccion.create({
        data: {
          tireId,
          fecha:               now,
          profundidadInt:      parsedProfundidad,
          profundidadCen:      parsedProfundidad,
          profundidadExt:      parsedProfundidad,
          cpk:                 metrics.cpk,
          cpkProyectado:       metrics.cpkProyectado,
          cpt:                 metrics.cpt,
          cptProyectado:       metrics.cptProyectado,
          diasEnUso:           0,
          mesesEnUso:          0,
          kilometrosEstimados: tire.kilometrosRecorridos || 0,
          kmActualVehiculo:    (tire as any).vehicle?.kilometrajeActual ?? 0,
          kmEfectivos:         0,
          kmProyectado:        metrics.projectedKm,
          vidaAlMomento:       normalizedValor,
          source:              InspeccionSource.manual,
        },
      });
    }

    const updateData: Prisma.TireUpdateInput = {
      vidaActual: normalizedValor,
      totalVidas: { increment: 1 },
    };

    if (normalizedValor !== VidaValue.fin && parsedProfundidad !== null) {
      updateData.profundidadInicial = parsedProfundidad;
    }

    if (banda?.trim()) updateData.diseno = banda.trim();

    // On retread the carcass keeps its casing but the new tread band has its
    // own brand (e.g. Michelin carcass + Contitread band = Continental brand).
    // We denormalize the new brand onto Tire.marca so fleet reports and the
    // marketplace reflect the retread brand. Fallback: if no explicit marca
    // was captured, use the banda name (customer-facing terminology
    // sometimes treats band name and brand as synonymous).
    if (normalizedValor.startsWith('reencauche')) {
      const newMarca = bandaMarca?.trim() || banda?.trim();
      if (newMarca) updateData.marca = newMarca;
    }

    if (normalizedValor.startsWith('reencauche')) {
      const costoValue = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? C.REENCAUCHE_COST);

      if (costoValue > 0) {
        await this.prisma.tireCosto.create({
          data: { tireId, valor: costoValue, fecha: now, concepto: 'reencauche' },
        });
      }
    }

    await this.prisma.tireEvento.create({
      data: {
        tireId,
        tipo:     TireEventType.reencauche,
        fecha:    now,
        notas:    normalizedValor,
        metadata: toJson({
          vidaValor:  normalizedValor,
          proveedor:  proveedor ?? null,
          banda:      banda      ?? null,
        }),
      },
    });

    if (normalizedValor === VidaValue.reencauche1) {
      const lastInsp = tire.inspecciones.at(-1);
      const costoVal = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? 0);

      updateData.primeraVida = toJson([{
        diseno:     banda?.trim() || tire.diseno,
        cpk:        lastInsp?.cpk ?? 0,
        costo:      costoVal,
        kilometros: tire.kilometrosRecorridos || 0,
      }]);
    }

    if (normalizedValor === VidaValue.fin) {
      if (!desechoData?.causales || desechoData.milimetrosDesechados === undefined) {
        throw new BadRequestException('Información de desecho incompleta');
      }

      updateData.vehicle        = { disconnect: true };
      updateData.inventoryBucket = { disconnect: true };
      updateData.lastVehicleId      = null;
      updateData.lastVehiclePlaca   = null;
      updateData.lastPosicion       = null;
      updateData.inventoryEnteredAt = null;

      updateData.desechos = toJson({
        causales:             desechoData.causales,
        milimetrosDesechados: desechoData.milimetrosDesechados,
        // remanente = mm of tread still left when the tire was discarded.
        // dineroPerdido = COP value of that wasted tread.
        remanente:            desechoData.milimetrosDesechados ?? 0,
        dineroPerdido:        snapshotPayload.desechoRemanente ?? 0,
        fecha:                now.toISOString(),
        imageUrls:            finalDesechoImageUrls,
      });
    }

    const finalTire = await this.prisma.tire.update({
      where:   { id: tireId },
      data:    updateData,
      include: { inspecciones: true, costos: true, eventos: true },
    });

    // ── History hook: close the open entry for this tire, and re-open
    //    a fresh one for reencauche (same vehicle/position, new vida).
    //    'fin' already disconnects the tire from the vehicle above, so
    //    we only close — no new entry.
    if (normalizedValor === VidaValue.fin) {
      await this.closeOpenHistory(tireId, 'fin');
    } else if (normalizedValor.toString().startsWith('reencauche')) {
      await this.closeOpenHistory(tireId, 'reencauche');
      if (tire.vehicleId && typeof tire.posicion === 'number' && tire.posicion > 0) {
        // vidaActual is already updated on `finalTire` so openHistoryEntry
        // reads the new vida from the DB.
        await this.openHistoryEntry(tireId, tire.vehicleId, tire.posicion);
      }
    }

    await this.notificationsService.deleteByTire(tireId);
    // Vida change is a commit-level event — freeze any bulk-upload
    // snapshot that includes this tire.
    this.invalidateSnapshotsForTire(tireId, 'vida').catch(() => {});
    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await Promise.allSettled([
        this.invalidateVehicleCache(tire.vehicleId),
        this.cache.del(`analysis:${tire.vehicleId}`),
      ]);
    }
    return finalTire;
  }

  // ===========================================================================
  // UPDATE EVENTO  (unchanged)
  // ===========================================================================

  async updateEvento(tireId: string, newValor: string) {
    const tire = await this.prisma.tire.findUnique({
      where:  { id: tireId },
      select: { id: true, companyId: true },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    await this.prisma.tireEvento.create({
      data: {
        tireId,
        tipo:  TireEventType.inspeccion,
        fecha: new Date(),
        notas: newValor,
      },
    });

    await this.invalidateCompanyCache(tire.companyId);

    return this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: { eventos: { orderBy: { fecha: 'asc' } } },
    });
  }

  // ===========================================================================
  // UPDATE POSITIONS  (unchanged)
  // ===========================================================================

  async updatePositions(
    updates: Record<string, string | string[]>,
    vehicleId?: string,
    placa?: string,
  ) {
    // Prefer unique vehicleId — placa can match multiple rows post-v2.
    let vehicle: { id: string; companyId: string | null } | null = null;
    if (vehicleId) {
      vehicle = await this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, companyId: true },
      });
    } else if (placa) {
      // Scope to the tires' company so the right row is picked when the
      // placa is duplicated across orphan + active vehicles.
      const allTireIds = Object.values(updates).flatMap((v) => Array.isArray(v) ? v : [v]);
      const tireCompanies = await this.prisma.tire.findMany({
        where:  { id: { in: allTireIds } },
        select: { companyId: true },
      });
      const companyIds = [...new Set(tireCompanies.map((t) => t.companyId).filter(Boolean))] as string[];
      vehicle = await this.prisma.vehicle.findFirst({
        where: {
          placa,
          ...(companyIds.length === 1 ? { companyId: companyIds[0] } : {}),
        },
        select: { id: true, companyId: true },
      });
    }
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Flatten the { pos: ids } map to [(tireId, position)] pairs so we can
    // loop once for both the tire.update and the history hook.
    const changes = Object.entries(updates).flatMap(([pos, ids]) => {
      const arr = Array.isArray(ids) ? ids : [ids];
      const position = parseInt(pos, 10) || 0;
      return arr.map((tireId) => ({ tireId, position }));
    });

    await this.prisma.$transaction(
      changes.map(({ tireId, position }) =>
        this.prisma.tire.update({
          where: { id: tireId },
          data:  { posicion: position, vehicleId: vehicle.id },
        }),
      ),
    );

    // History: close any open entry (rotation) and open a fresh one at the
    // new position. Runs after the tire.update so openHistoryEntry reads
    // the up-to-date tire record. Parallel + best-effort.
    await Promise.allSettled(
      changes.map(({ tireId, position }) =>
        (async () => {
          await this.closeOpenHistory(tireId, 'rotacion');
          await this.openHistoryEntry(tireId, vehicle.id, position);
        })(),
      ),
    );

    await Promise.allSettled([
      this.invalidateCompanyCache(vehicle.companyId),
      this.invalidateVehicleCache(vehicle.id),
      this.cache.del(`analysis:${vehicle.id}`),
    ]);
    return { message: 'Positions updated successfully' };
  }

  // ===========================================================================
  // ANALYZE TIRES FOR VEHICLE  (unchanged)
  // ===========================================================================

  async analyzeTires(vehiclePlaca: string) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
    if (!vehicle) throw new NotFoundException(`Vehicle ${vehiclePlaca} not found`);

    const cacheKey = `analysis:${vehicle.id}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      where:   { vehicleId: vehicle.id },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' }, take: 5 },
        costos:       true,
      },
    });
    if (!tires.length) throw new NotFoundException(`No tires for vehicle ${vehiclePlaca}`);

    const result = { vehicle, tires: tires.map(t => this.buildTireAnalysis(t)) };
    await this.cache.set(cacheKey, result, TireService.TTL_VEHICLE);
    return result;
  }

  // ===========================================================================
  // REMOVE INSPECTION  (unchanged)
  // ===========================================================================

  /**
   * Edit an existing inspection in-place — only updates the fields provided.
   * Does NOT recalculate CPK/km unless depth values changed.
   */
  async editInspection(
    tireId: string,
    fecha: string,
    updates: {
      fecha?: string;
      profundidadInt?: number;
      profundidadCen?: number;
      profundidadExt?: number;
      inspeccionadoPorNombre?: string;
      inspeccionadoPorId?: string;
      kilometrosEstimados?: number;
      presionPsi?: number;
      imageUrls?: string[];
      fechaInstalacion?: string;
    },
  ) {
    const insp = await this.prisma.inspeccion.findFirst({
      where: { tireId, fecha: new Date(fecha) },
    });
    if (!insp) throw new NotFoundException('Inspection not found');

    const tire = await this.prisma.tire.findUnique({
      where: { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc' } },
        inspecciones: { orderBy: { fecha: 'asc' } },
        eventos:      { orderBy: { fecha: 'asc' } },
        vehicle:      true,
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    // --- Handle fechaInstalacion change (tire-level) ---
    if (updates.fechaInstalacion) {
      const newInstall = new Date(updates.fechaInstalacion);

      // Guard: cannot be in the future
      if (newInstall.getTime() > Date.now()) {
        throw new BadRequestException('La fecha de instalacion no puede ser en el futuro');
      }

      await this.prisma.tire.update({
        where: { id: tireId },
        data: { fechaInstalacion: newInstall },
      });

      // Only update diasEnUso and mesesEnUso — CPK does NOT change (it depends on km/cost, not date)
      // CPT does change because CPT = cost / months
      const totalCost = tire.costos.reduce((s, c) => s + c.valor, 0);

      for (const ins of tire.inspecciones) {
        const inspDate = new Date(ins.fecha);
        const diasEnUso = Math.max(
          Math.floor((inspDate.getTime() - newInstall.getTime()) / C.MS_POR_DIA),
          1,
        );
        const mesesEnUso = diasEnUso / 30;
        const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

        await this.prisma.inspeccion.update({
          where: { id: ins.id },
          data: { diasEnUso, mesesEnUso, cpt },
        });
      }

      this.logger.log(`editInspection: updated fechaInstalacion to ${newInstall.toISOString()}, updated dias/meses for ${tire.inspecciones.length} inspections`);
    }

    // --- If inspection date changed, move any matching cost entry too ---
    if (updates.fecha !== undefined) {
      const oldDate = new Date(insp.fecha);
      const newDate = new Date(updates.fecha);
      // Find a cost entry on the same day as the old inspection date
      const matchingCost = tire.costos.find(c => {
        const costDate = new Date(c.fecha);
        return costDate.toISOString().split('T')[0] === oldDate.toISOString().split('T')[0];
      });
      if (matchingCost) {
        await this.prisma.tireCosto.update({
          where: { id: matchingCost.id },
          data: { fecha: newDate },
        });
        this.logger.log(`editInspection: moved cost ${matchingCost.id} from ${oldDate.toISOString().split('T')[0]} to ${newDate.toISOString().split('T')[0]}`);
      }
    }

    // --- Handle per-inspection field edits ---
    const data: any = {};
    if (updates.fecha !== undefined) data.fecha = new Date(updates.fecha);
    if (updates.profundidadInt !== undefined) data.profundidadInt = updates.profundidadInt;
    if (updates.profundidadCen !== undefined) data.profundidadCen = updates.profundidadCen;
    if (updates.profundidadExt !== undefined) data.profundidadExt = updates.profundidadExt;
    if (updates.inspeccionadoPorNombre !== undefined) data.inspeccionadoPorNombre = updates.inspeccionadoPorNombre;
    if (updates.inspeccionadoPorId !== undefined) data.inspeccionadoPorId = updates.inspeccionadoPorId;
    if (updates.presionPsi !== undefined) {
      data.presionPsi = updates.presionPsi;
      if (insp.presionRecomendadaPsi != null) {
        data.presionDelta = updates.presionPsi - insp.presionRecomendadaPsi;
      }
    }
    if (updates.kilometrosEstimados !== undefined) {
      data.kilometrosEstimados = updates.kilometrosEstimados;
      data.kmEfectivos = updates.kilometrosEstimados;
    }

    // Replace the photo set. Accepts existing S3 URLs (preserved) and
    // data:image/... payloads (uploaded here). Any URL present on the old
    // inspection but missing from the new list is deleted from S3 so we
    // don't leak storage.
    if (updates.imageUrls !== undefined) {
      const slice = updates.imageUrls.slice(0, 3);
      const newUrls = await Promise.all(
        slice.map(async (img, idx) => {
          if (img?.startsWith('data:')) {
            const [header, b64] = img.split(',');
            const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
            return this.s3.uploadInspectionImage(
              Buffer.from(b64, 'base64'), tireId, mime, idx,
            );
          }
          return img;
        }),
      );
      const oldUrls = insp.imageUrls?.length ? insp.imageUrls : (insp.imageUrl ? [insp.imageUrl] : []);
      const keepSet = new Set(newUrls);
      const orphans = oldUrls.filter((u) => u && !keepSet.has(u));
      await Promise.allSettled(orphans.map((u) => this.s3.deleteByUrl(u)));
      data.imageUrls = newUrls;
      data.imageUrl  = newUrls[0] ?? null;
    }

    // Recalculate CPK if depths OR km changed
    const depthChanged =
      updates.profundidadInt !== undefined ||
      updates.profundidadCen !== undefined ||
      updates.profundidadExt !== undefined;
    const kmChanged = updates.kilometrosEstimados !== undefined;

    if (depthChanged || kmChanged) {
      const newInt = updates.profundidadInt ?? insp.profundidadInt;
      const newCen = updates.profundidadCen ?? insp.profundidadCen;
      const newExt = updates.profundidadExt ?? insp.profundidadExt;
      const minDepth = calcMinDepth(newInt, newCen, newExt);
      const effectiveKm = updates.kilometrosEstimados ?? insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
      const installDate = updates.fechaInstalacion
        ? new Date(updates.fechaInstalacion)
        : (tire.fechaInstalacion ?? new Date());
      const inspDate = updates.fecha ? new Date(updates.fecha) : new Date(insp.fecha);
      const diasEnUso = Math.max(
        Math.floor((inspDate.getTime() - installDate.getTime()) / C.MS_POR_DIA),
        1,
      );
      const mesesEnUso = diasEnUso / 30;

      // For CPK, we need the total cost and total km for the current vida.
      // costForVida comes from TireCosto entries.
      // kmForVida = currentKm - kmAtVidaStart. We must use the TIRE's total
      // accumulated km, not the inspection's snapshot, to avoid the case where
      // the inspection being edited IS the only one (kmForVida would be 0).
      const totalTireKm = updates.kilometrosEstimados ?? tire.kilometrosRecorridos ?? effectiveKm;

      // Get cost directly — sum all costos for this tire
      const totalCost = tire.costos.reduce((s, c) => s + c.valor, 0);

      // Simple CPK: total cost / total km
      const cpk = totalTireKm > 0 ? totalCost / totalTireKm : 0;
      const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

      // Projected CPK using depth-based extrapolation
      const usableDepth = tire.profundidadInicial - 3; // 3mm legal limit
      const mmWorn = tire.profundidadInicial - minDepth;
      const mmLeft = Math.max(minDepth - 3, 0);
      let projectedKm = 0;
      if (usableDepth > 0 && totalTireKm > 0 && mmWorn > 0) {
        projectedKm = totalTireKm + (totalTireKm / mmWorn) * mmLeft;
      }
      const cpkProyectado = projectedKm > 0 ? totalCost / projectedKm : 0;
      const projectedMonths = projectedKm > 0 ? projectedKm / 7000 : 0; // ~7000 km/month
      const cptProyectado = projectedMonths > 0 ? totalCost / projectedMonths : 0;

      data.cpk = cpk;
      data.cpkProyectado = cpkProyectado;
      data.cpt = cpt;
      data.cptProyectado = cptProyectado;
      data.kmProyectado = projectedKm;
      data.diasEnUso = diasEnUso;
      data.mesesEnUso = mesesEnUso;

      this.logger.log(
        `editInspection ${insp.id}: totalCost=${totalCost} totalKm=${totalTireKm} ` +
        `cpk=${cpk.toFixed(2)} cpkProy=${cpkProyectado.toFixed(2)} cpt=${cpt.toFixed(2)}`,
      );
    }

    // Update the inspection if there are changes
    if (Object.keys(data).length > 0) {
      await this.prisma.inspeccion.update({
        where: { id: insp.id },
        data,
      });
    }

    // If km changed on the latest inspection, update the tire's accumulated km
    if (kmChanged) {
      const allInspections = [...tire.inspecciones].sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
      );
      if (allInspections[0]?.id === insp.id) {
        await this.prisma.tire.update({
          where: { id: tireId },
          data: { kilometrosRecorridos: updates.kilometrosEstimados },
        });
      }
    }

    // Refresh all cached analytics from the updated inspections
    await this.refreshTireAnalyticsCache(tireId);
    // Lock down any bulk-upload snapshot that included this tire.
    this.invalidateSnapshotsForTire(tireId, 'inspection-edit').catch(() => {});
    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await Promise.allSettled([
        this.invalidateVehicleCache(tire.vehicleId),
        this.cache.del(`analysis:${tire.vehicleId}`),
      ]);
    }

    return this.findTireById(tireId);
  }

  async editCosto(tireId: string, costoId: string, newValor?: number, newFecha?: string) {
    const costo = await this.prisma.tireCosto.findFirst({
      where: { id: costoId, tireId },
    });
    if (!costo) throw new NotFoundException('Cost entry not found');

    const data: any = {};
    if (newValor !== undefined) data.valor = newValor;
    if (newFecha !== undefined) data.fecha = new Date(newFecha);

    if (Object.keys(data).length === 0) return costo;

    await this.prisma.tireCosto.update({ where: { id: costoId }, data });

    // Refresh analytics since cost change affects CPK
    await this.refreshTireAnalyticsCache(tireId);
    const tire = await this.prisma.tire.findUniqueOrThrow({
      where: { id: tireId },
      select: { companyId: true, vehicleId: true },
    });
    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await Promise.allSettled([
        this.invalidateVehicleCache(tire.vehicleId),
        this.cache.del(`analysis:${tire.vehicleId}`),
      ]);
    }

    return this.findTireById(tireId);
  }

  async removeInspection(tireId: string, fecha: string) {
    const insp = await this.prisma.inspeccion.findFirst({
      where:  { tireId, fecha: new Date(fecha) },
      select: { id: true },
    });
    if (!insp) throw new NotFoundException('Inspection not found');

    const tireForCache = await this.prisma.tire.findUniqueOrThrow({
      where:  { id: tireId },
      select: { companyId: true, vehicleId: true },
    });

    await this.prisma.inspeccion.delete({ where: { id: insp.id } });
    await this.refreshTireAnalyticsCache(tireId);
    await this.invalidateCompanyCache(tireForCache.companyId);
    if (tireForCache.vehicleId) {
      await Promise.allSettled([
        this.invalidateVehicleCache(tireForCache.vehicleId),
        this.cache.del(`analysis:${tireForCache.vehicleId}`),
      ]);
    }
    return { message: 'Inspección eliminada' };
  }

  // ===========================================================================
  // ASSIGN / UNASSIGN TIRES  (unchanged)
  // ===========================================================================

  async assignTiresToVehicle(tireIds: string[], vehicleId?: string, vehiclePlaca?: string) {
    // vehicleId is unambiguous. Placa is a fallback (legacy callers) and
    // may match multiple rows post-merquepro-v2 — in that case we scope
    // to the tires' company to pick the right one.
    let vehicle: { id: string; companyId: string | null } | null = null;
    if (vehicleId) {
      vehicle = await this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, companyId: true },
      });
    } else if (vehiclePlaca) {
      const tireCompanies = await this.prisma.tire.findMany({
        where:  { id: { in: tireIds } },
        select: { companyId: true },
      });
      const companyIds = [...new Set(tireCompanies.map((t) => t.companyId).filter(Boolean))] as string[];
      vehicle = await this.prisma.vehicle.findFirst({
        where: {
          placa: vehiclePlaca,
          ...(companyIds.length === 1 ? { companyId: companyIds[0] } : {}),
        },
        select: { id: true, companyId: true },
      });
    }
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Clear every inventory-side field: the tire is going back onto a
    // vehicle, so it is no longer in any bucket and the lastVehicle*
    // snapshot (used by the "return to vehicle" flow) is no longer needed.
    // Without this the tire would appear in BOTH the bucket panel and the
    // vehicle layout after a drag from bucket → position.
    await this.prisma.tire.updateMany({
      where: { id: { in: tireIds } },
      data: {
        vehicleId:          vehicle.id,
        inventoryBucketId:  null,
        inventoryEnteredAt: null,
        lastVehicleId:      null,
        lastVehiclePlaca:   null,
        lastPosicion:       null,
      },
    });

    await Promise.allSettled([
      this.invalidateCompanyCache(vehicle.companyId),
      this.invalidateVehicleCache(vehicle.id),
    ]);
    return { message: 'Tires assigned successfully', count: tireIds.length };
  }

  async unassignTiresFromVehicle(tireIds: string[]) {
    const tiresBeforeUnassign = await this.prisma.tire.findMany({
      where:  { id: { in: tireIds } },
      select: { id: true, vehicleId: true, posicion: true, companyId: true,
                vehicle: { select: { placa: true } } },
    });

    const now = new Date();

    await this.prisma.$transaction(
      tiresBeforeUnassign.map((t) =>
        this.prisma.tire.update({
          where: { id: t.id },
          data: {
            vehicleId:          null,
            posicion:           0,
            lastVehicleId:      t.vehicleId   ?? null,
            lastVehiclePlaca:   t.vehicle?.placa ?? null,
            lastPosicion:       t.posicion    ?? 0,
            inventoryEnteredAt: now,
          },
        }),
      ),
    );

    // Close open history entries — one per tire. Runs after the tire rows
    // have been updated so closeOpenHistory reads the final km/CPK state.
    await Promise.allSettled(
      tiresBeforeUnassign.map((t) => this.closeOpenHistory(t.id, 'desvinculado')),
    );

    const sample = tiresBeforeUnassign[0];
    if (sample) {
      await Promise.allSettled([
        this.invalidateCompanyCache(sample.companyId),
        sample.vehicleId ? this.invalidateVehicleCache(sample.vehicleId) : Promise.resolve(),
        sample.vehicleId ? this.cache.del(`analysis:${sample.vehicleId}`) : Promise.resolve(),
      ]);
    }
    return { message: 'Tires unassigned successfully', count: tireIds.length };
  }

  // ===========================================================================
  // EDIT TIRE  (bug-fix: cache invalidation order corrected)
  // ===========================================================================

  async editTire(tireId: string, dto: EditTireDto) {
    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc' } },
        inspecciones: { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    const updateData: Prisma.TireUpdateInput = {};

    if (dto.marca              !== undefined) updateData.marca              = dto.marca;
    if (dto.diseno             !== undefined) updateData.diseno             = dto.diseno;
    if (dto.vehicleId !== undefined) {
      updateData.vehicle = dto.vehicleId
        ? { connect: { id: dto.vehicleId } }
        : { disconnect: true };
    }
    if (dto.dimension          !== undefined) updateData.dimension          = dto.dimension;
    if (dto.eje                !== undefined) updateData.eje                = dto.eje;
    if (dto.posicion           !== undefined) updateData.posicion           = dto.posicion;
    if (dto.profundidadInicial !== undefined) updateData.profundidadInicial = dto.profundidadInicial;
    if (dto.companyId !== undefined) {
      updateData.company = { connect: { id: dto.companyId } };
    }

    if (
      dto.kilometrosRecorridos !== undefined &&
      dto.kilometrosRecorridos !== tire.kilometrosRecorridos
    ) {
      updateData.kilometrosRecorridos = dto.kilometrosRecorridos;
    }

    if (dto.inspectionEdit) {
      const { fecha, profundidadInt, profundidadCen, profundidadExt } = dto.inspectionEdit;

      const insp = await this.prisma.inspeccion.findFirst({
        where:  { tireId, fecha: new Date(fecha) },
        select: { id: true, mesesEnUso: true, kilometrosEstimados: true },
      });
      if (!insp) throw new NotFoundException('Inspection not found');

      const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;
      const costToDate  = tire.costos
        .filter(c => toDateOnly(c.fecha.toISOString()) <= toDateOnly(fecha))
        .reduce((s, c) => s + c.valor, 0);
      const minDepth = calcMinDepth(profundidadInt, profundidadCen, profundidadExt);
      const km       = insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
      const metrics  = calcCpkMetrics(costToDate, km, insp.mesesEnUso ?? 1, profInicial, minDepth);

      await this.prisma.inspeccion.update({
        where: { id: insp.id },
        data:  {
          profundidadInt,
          profundidadCen,
          profundidadExt,
          cpk:           metrics.cpk,
          cpkProyectado: metrics.cpkProyectado,
          cpt:           metrics.cpt,
          cptProyectado: metrics.cptProyectado,
          kmProyectado:  metrics.projectedKm,
        },
      });
    }

    if (dto.costoEdit) {
      const { fecha: costoFecha, newValor } = dto.costoEdit;

      const costRow = await this.prisma.tireCosto.findFirst({
        where:  { tireId, fecha: new Date(costoFecha) },
        select: { id: true },
      });
      if (!costRow) throw new NotFoundException('Cost entry not found');

      await this.prisma.tireCosto.update({
        where: { id: costRow.id },
        data:  { valor: newValor },
      });

      const updatedCostos = tire.costos.map(c =>
        toDateOnly(c.fecha.toISOString()) === toDateOnly(costoFecha)
          ? { ...c, valor: newValor }
          : c,
      );

      const affectedInsps = tire.inspecciones.filter(
        i => toDateOnly(i.fecha.toISOString()) >= toDateOnly(costoFecha),
      );

      await Promise.all(
        affectedInsps.map(insp => {
          const costToDate  = updatedCostos
            .filter(c => toDateOnly(c.fecha.toISOString()) <= toDateOnly(insp.fecha.toISOString()))
            .reduce((s, c) => s + c.valor, 0);
          const minDepth    = calcMinDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
          const km          = insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
          const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;
          const metrics     = calcCpkMetrics(costToDate, km, insp.mesesEnUso ?? 1, profInicial, minDepth);

          return this.prisma.inspeccion.update({
            where: { id: insp.id },
            data:  {
              cpk:           metrics.cpk,
              cpkProyectado: metrics.cpkProyectado,
              cpt:           metrics.cpt,
              cptProyectado: metrics.cptProyectado,
              kmProyectado:  metrics.projectedKm,
            },
          });
        }),
      );
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.tire.update({ where: { id: tireId }, data: updateData });
    }

    // BUG-FIX: invalidate AFTER the update commits.
    // If companyId changed, invalidate both old and new company caches.
    const invalidations: Promise<any>[] = [
      this.invalidateCompanyCache(tire.companyId),
    ];
    if (dto.companyId && dto.companyId !== tire.companyId) {
      invalidations.push(this.invalidateCompanyCache(dto.companyId));
    }
    if (tire.vehicleId) {
      invalidations.push(
        this.invalidateVehicleCache(tire.vehicleId),
        this.cache.del(`analysis:${tire.vehicleId}`),
      );
    }
    await Promise.allSettled(invalidations);

    return this.refreshTireAnalyticsCache(tireId);
  }

  // ===========================================================================
  // ANALYTICS CACHE REFRESH  — BUG-1 FIXED
  //
  // The original code called calcHealthScore(...) but never captured its return
  // value.  `healthScore` was then used as an undeclared variable, causing a
  // ReferenceError (or silently `undefined` in non-strict JS) on every single
  // inspection write — meaning every tire was stored with healthScore = null
  // and alertLevel = ok regardless of actual condition.
  //
  // Fix: destructure { healthScore } from the return value.
  // ===========================================================================

  async refreshTireAnalyticsCache(tireId: string) {
    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        inspecciones: { orderBy: { fecha: 'asc' } },
        costos:       { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found for cache refresh');

    const inspecciones = tire.inspecciones;

    if (!inspecciones.length) {
      return this.prisma.tire.update({
        where: { id: tireId },
        data:  {
          currentCpk:           null,
          lifetimeCpk:          null,
          currentCpt:           null,
          currentProfundidad:   null,
          currentPresionPsi:    null,
          cpkTrend:             null,
          projectedKmRemaining: null,
          projectedDateEOL:     null,
          healthScore:          null,
          alertLevel:           TireAlertLevel.ok,
        },
        include: { inspecciones: true, costos: true, eventos: true },
      });
    }

    // Lifetime CPK: all costs (nueva purchase + every retread) over the
    // tire's full odometer. This is the metric used by company-wide
    // dashboards; per-life CPK stays in currentCpk for vida-specific views.
    const lifetimeTotalCost = tire.costos.reduce((s, c) => s + (c.valor ?? 0), 0);
    const lifetimeTotalKm   = tire.kilometrosRecorridos || 0;
    // Same floor as calcCpkMetrics — below 5k km a tire hasn't driven
    // enough for its lifetime CPK to be meaningful.
    const lifetimeCpk = lifetimeTotalKm >= 5_000 && lifetimeTotalCost > 0
      ? parseFloat((lifetimeTotalCost / lifetimeTotalKm).toFixed(2))
      : null;

    const latest   = inspecciones[inspecciones.length - 1];
    const pInt     = latest.profundidadInt;
    const pCen     = latest.profundidadCen;
    const pExt     = latest.profundidadExt;
    const minDepth = calcMinDepth(pInt, pCen, pExt);
    const avgDepth = (pInt + pCen + pExt) / 3;

    const vidaActual       = tire.vidaActual ?? VidaValue.nueva;
    const vidaInspecciones = inspecciones.filter(i => i.vidaAlMomento === vidaActual);

    // BUG-2 NOTE: in refreshTireAnalyticsCache the array is already asc-sorted
    // (orderBy fecha asc), so .slice(-5) correctly gives the most recent 5.
    const last5    = vidaInspecciones.slice(-5);
    const cpkTrend = calcCpkTrend(
      last5.map(i => i.cpk ?? 0).filter(v => v > 0),
    );

    // ─── BUG-1 FIX: destructure the return value ─────────────────────────────
    const { healthScore } = calcHealthScore({
      profundidadInicial: tire.profundidadInicial,
      pInt, pCen, pExt,
      cpkTrend,
      presionPsi:            latest.presionPsi,
      presionRecomendadaPsi: latest.presionRecomendadaPsi,
      pesoCarga:             null,
      cargaMaxLlanta:        null,
    });
    // ─────────────────────────────────────────────────────────────────────────

    const alertLevel = deriveAlertLevel(healthScore, minDepth);

    const projectedKm      = latest.kmProyectado ?? 0;
    const currentKm        = tire.kilometrosRecorridos || 0;
    const kmLeft           = Math.max(projectedKm - currentKm, 0);
    const daysLeft         = kmLeft > 0 ? (kmLeft / C.KM_POR_MES) * 30 : 0;
    const projectedDateEOL = daysLeft > 0
      ? new Date(Date.now() + daysLeft * C.MS_POR_DIA)
      : null;

    const updatedTire = await this.prisma.tire.update({
      where: { id: tireId },
      data:  {
        currentCpk:           latest.cpk,
        lifetimeCpk,
        currentCpt:           latest.cpt,
        currentProfundidad:   avgDepth,
        currentPresionPsi:    latest.presionPsi ?? null,
        cpkTrend,
        projectedKmRemaining: kmLeft > 0 ? Math.round(kmLeft) : null,
        projectedDateEOL,
        healthScore,
        alertLevel,
        lastInspeccionDate:   latest.fecha,
        // Reset projections to fresh inspection data
        projectedProfundidad:    avgDepth,
        projectedAlertLevel:     alertLevel,
        projectedHealthScore:    healthScore,
        projectedDaysToLimit:    kmLeft > 0 ? Math.round((kmLeft / C.KM_POR_MES) * 30) : null,
        degradationRateMmPerDay: null, // recomputed by next cron run
        projectionUpdatedAt:     new Date(),
      },
      include: { inspecciones: true, costos: true, eventos: true },
    });

    // ── Auto-generate notifications for significant alerts ──────────────────
    try {
      const recomendaciones = this.buildTireAnalysis(updatedTire).recomendaciones;

      const tireWithRelations = await this.prisma.tire.findUnique({
        where: { id: tireId },
        select: {
          id: true, companyId: true, vehicleId: true, placa: true,
          marca: true, posicion: true, currentProfundidad: true,
          currentPresionPsi: true, alertLevel: true,
          vehicle: { select: { placa: true, drivers: true } },
          company: { select: { agentSettings: true } },
        },
      });

      if (tireWithRelations && tireWithRelations.companyId) {
        const priorityMap: Record<string, number> = { critical: 3, warning: 2, watch: 1, ok: 0 };
        const priority = priorityMap[tireWithRelations.alertLevel] ?? 0;

        if (priority >= 1) {
          const actionType = tireWithRelations.alertLevel === 'critical'
            ? 'remove_from_service'
            : tireWithRelations.alertLevel === 'warning'
              ? 'retread'
              : 'inspect';

          const existing = await this.prisma.notification.findFirst({
            where: { tireId, actionType, executed: false },
          });

          if (!existing) {
            const notification = await this.notificationsService.createNotification({
              title: recomendaciones[0] || `Alerta: llanta ${tireWithRelations.placa}`,
              message: recomendaciones.join(' | '),
              type: tireWithRelations.alertLevel === 'critical' ? 'critical'
                : tireWithRelations.alertLevel === 'warning' ? 'warning' : 'info',
              tireId,
              vehicleId: tireWithRelations.vehicleId ?? undefined,
              companyId: tireWithRelations.companyId,
              actionType,
              actionPayload: {
                tireId,
                currentDepth: tireWithRelations.currentProfundidad,
                position: tireWithRelations.posicion,
                vehicleId: tireWithRelations.vehicleId,
              },
              actionLabel: recomendaciones[0] || 'Revisar llanta',
              groupKey: tireWithRelations.vehicleId ?? undefined,
              priority,
            });

            // Check agent settings for auto-send to drivers
            const settings = tireWithRelations.company?.agentSettings as any;
            if (settings?.agentEnabled && settings?.alertMode === 'agent_auto') {
              const drivers = tireWithRelations.vehicle?.drivers ?? [];
              if (drivers.length > 0) {
                await this.notificationsService.markSentToDriver(notification.id);
              }
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to create notification for tire ${tireId}: ${err.message}`);
    }

    // ── Dual tire harmony check ─────────────────────────────────────────────
    try {
      if (updatedTire.dualPartnerId) {
        const partner = await this.prisma.tire.findUnique({
          where: { id: updatedTire.dualPartnerId },
          select: { id: true, placa: true, currentProfundidad: true, companyId: true, vehicleId: true },
        });
        if (partner && partner.currentProfundidad != null && avgDepth > 0) {
          const dualDelta = Math.abs(avgDepth - partner.currentProfundidad);
          if (dualDelta >= C.DUAL_HARMONY_MAX_DELTA_MM) {
            const existing = await this.prisma.notification.findFirst({
              where: { tireId, actionType: 'rotate', executed: false },
            });
            if (!existing) {
              await this.notificationsService.createNotification({
                title: `Gemelas descompensadas: ${updatedTire.placa} ↔ ${partner.placa}`,
                message: `Diferencia de ${dualDelta.toFixed(1)}mm entre gemelas. La llanta con mayor diámetro asume toda la carga mientras la otra se arrastra, causando desgaste masivo por fricción y riesgo de separación de banda. Emparejar urgente.`,
                type: 'warning',
                tireId,
                vehicleId: updatedTire.vehicleId ?? undefined,
                companyId: updatedTire.companyId ?? undefined,
                actionType: 'rotate',
                actionPayload: { tireId, partnerId: partner.id, dualDelta },
                actionLabel: `Emparejar gemelas (Δ${dualDelta.toFixed(1)}mm)`,
                groupKey: updatedTire.vehicleId ?? undefined,
                priority: 2,
              });
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Dual harmony check failed for tire ${tireId}: ${err.message}`);
    }

    return updatedTire;
  }

  // ===========================================================================
  // PRIVATE: BUILD TIRE ANALYSIS  — BUG-2 FIXED
  //
  // The original code called vidaSorted.slice(0, 5) to get the most recent
  // inspections for CPK trend. BUT vidaSorted is already sorted newest-first
  // (sort by fecha descending), so slice(0,5) gives the OLDEST 5 inspections
  // (indices 0-4 from the front = the first in the sorted-by-desc array, i.e.
  // the newest), wait — actually since we sort descending, index 0 IS the
  // newest. Let's re-check: sorted = newest first. slice(0,5) = top 5 newest.
  // That is correct for the in-memory sort. BUT the cpkTrend regression feeds
  // them as [cpk_newest, cpk_2nd_newest, ...], meaning x=0 maps to the newest
  // value. The trend slope would then be negative when CPK is IMPROVING over
  // time — the opposite of what we want. Fix: reverse the slice so x=0 is the
  // oldest, making a positive slope indicate degradation (CPK increasing).
  // ===========================================================================

  private buildTireAnalysis(tire: any): TireAnalysis {
    const inspecciones: any[] = tire.inspecciones ?? [];

    if (!inspecciones.length) {
      return {
        id: tire.id,
        posicion: tire.posicion,
        profundidadActual: null,
        alertLevel: TireAlertLevel.watch,
        healthScore: 0,
        recomendaciones: ['🔴 Inspección requerida: Sin datos para análisis.'],
        cpkTrend: null,
        projectedDateEOL: null,
        desechos: tire.desechos ?? null,
      };
    }

    const sorted = [...inspecciones].sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );

    const latest = sorted[0];

    const pInt = Number(latest.profundidadInt) || 0;
    const pCen = Number(latest.profundidadCen) || 0;
    const pExt = Number(latest.profundidadExt) || 0;

    const profundidadActual = (pInt + pCen + pExt) / 3;
    const minDepth = calcMinDepth(pInt, pCen, pExt);

    const vidaActual = tire.vidaActual ?? VidaValue.nueva;
    const vidaSorted = sorted.filter(i => i.vidaAlMomento === vidaActual);

    // BUG-2 FIX: take the 5 most-recent inspections for the current vida, then
    // reverse so that index 0 = oldest, making a positive regression slope mean
    // CPK is increasing (degrading) — consistent with how `deriveAlertLevel`
    // and the recommendation engine interpret `cpkTrend > 0`.
    const recentForTrend = vidaSorted.slice(0, 5).reverse();
    const cpkTrend = calcCpkTrend(
      recentForTrend.map(i => i.cpk ?? 0).filter(Boolean),
    );

    // ─── BUG-1 FIX (also applies here): destructure healthScore ──────────────
    const { healthScore } = calcHealthScore({
      profundidadInicial: tire.profundidadInicial,
      pInt,
      pCen,
      pExt,
      cpkTrend,
      presionPsi: latest.presionPsi ?? null,
      presionRecomendadaPsi: latest.presionRecomendadaPsi ?? null,
      pesoCarga: null,
      cargaMaxLlanta: null,
    });
    // ─────────────────────────────────────────────────────────────────────────

    const alertLevel = deriveAlertLevel(healthScore, minDepth);

    const recomendaciones: { msg: string; priority: number }[] = [];

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. DESGASTE CRÍTICO
    // ═══════════════════════════════════════════════════════════════════════════
    if (minDepth <= C.LIMITE_LEGAL_MM) {
      recomendaciones.push({ priority: 100, msg: `Retirar de servicio. Profundidad ${minDepth.toFixed(1)}mm — limite legal alcanzado.` });
    }

    // 2. RETIRO ÓPTIMO
    if (minDepth <= C.OPTIMAL_RETIREMENT_MM && minDepth > C.LIMITE_LEGAL_MM) {
      recomendaciones.push({ priority: 96, msg: `Retirar para reencauche. Profundidad ${minDepth.toFixed(1)}mm — preservar casco ahora.` });
    } else if (minDepth <= 4 && minDepth > C.OPTIMAL_RETIREMENT_MM) {
      recomendaciones.push({ priority: 88, msg: `Programar retiro. Profundidad ${minDepth.toFixed(1)}mm — zona optima para reencauche.` });
    }

    // 3. REGRABADO
    if (tire.isRegrabable && minDepth >= C.REGRABADO_MIN_MM && minDepth <= C.REGRABADO_MAX_MM && tire.vidaActual !== VidaValue.fin) {
      recomendaciones.push({ priority: 82, msg: `Regrebar llanta. ${minDepth.toFixed(1)}mm — gana 10-15% vida extra antes de reencauchar.` });
    }

    // 4. PRESIÓN (solo si hay datos de PSI)
    if (latest.presionPsi != null && latest.presionRecomendadaPsi != null) {
      const diff = latest.presionPsi - latest.presionRecomendadaPsi;
      if (diff <= -C.PRESSURE_UNDER_CRIT_PSI) {
        recomendaciones.push({ priority: 95, msg: `Inflar urgente. ${Math.abs(Math.round(diff))} PSI por debajo de lo recomendado (${latest.presionRecomendadaPsi} PSI).` });
      } else if (diff <= -C.PRESSURE_UNDER_WARN_PSI) {
        recomendaciones.push({ priority: 80, msg: `Subir presion a ${latest.presionRecomendadaPsi} PSI. Actualmente ${Math.abs(Math.round(diff))} PSI por debajo.` });
      } else if (diff >= 8) {
        recomendaciones.push({ priority: 70, msg: `Bajar presion a ${latest.presionRecomendadaPsi} PSI. Actualmente ${Math.round(diff)} PSI por encima.` });
      }
    }

    // 5. ALINEACIÓN
    const shoulderDelta = Math.abs(pInt - pExt);
    const centerVsAvgShoulders = Math.abs(pCen - (pInt + pExt) / 2);

    if (shoulderDelta >= C.ALIGNMENT_SEVERE_MM) {
      const worstSide = pInt < pExt ? 'interior' : 'exterior';
      recomendaciones.push({ priority: 92, msg: `Alinear ejes urgente. Diferencia ${shoulderDelta.toFixed(1)}mm entre hombros (desgaste ${worstSide}).` });
    } else if (shoulderDelta >= C.ALIGNMENT_WARN_MM && centerVsAvgShoulders < 1.5) {
      const worstSide = pInt < pExt ? 'interior' : 'exterior';
      recomendaciones.push({ priority: 83, msg: `Revisar alineacion. ${shoulderDelta.toFixed(1)}mm diferencia entre hombros (lado ${worstSide}).` });
    }

    // 6. PATRONES DE DESGASTE (solo si no hay problema de alineación)
    const maxDelta = Math.max(Math.abs(pInt - pCen), Math.abs(pExt - pCen), Math.abs(pInt - pExt));

    if (maxDelta > 3 && shoulderDelta < C.ALIGNMENT_WARN_MM) {
      recomendaciones.push({ priority: 85, msg: 'Revision mecanica. Desgaste irregular >3mm entre zonas (presion, carga o suspension).' });
    } else if (pCen < pInt && pCen < pExt && shoulderDelta < C.ALIGNMENT_WARN_MM) {
      // Only add if we don't already have a PSI-based pressure rec (avoid contradiction)
      if (!recomendaciones.some(r => r.msg.includes('presion') || r.msg.includes('Inflar') || r.msg.includes('PSI'))) {
        recomendaciones.push({ priority: 70, msg: 'Reducir presion. Centro mas gastado que hombros — indica sobreinflado.' });
      }
    } else if (pCen > pInt && pCen > pExt && shoulderDelta < C.ALIGNMENT_WARN_MM) {
      if (!recomendaciones.some(r => r.msg.includes('presion') || r.msg.includes('Inflar') || r.msg.includes('PSI'))) {
        recomendaciones.push({ priority: 75, msg: 'Aumentar presion. Hombros mas gastados que centro — indica baja presion o sobrecarga.' });
      }
    }

    // 7. APLICACIÓN INCORRECTA
    if (tire.tipoDiseno) {
      const validAxles = VALID_DESIGN_AXLE[tire.tipoDiseno] ?? [];
      if (validAxles.length > 0 && !validAxles.includes(tire.eje)) {
        recomendaciones.push({ priority: 87, msg: `Reubicar llanta. Diseno "${tire.tipoDiseno}" no es compatible con eje "${tire.eje}".` });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 8. DUAL (GEMELA) TIRE HARMONY — paired tires must match in depth
    // ═══════════════════════════════════════════════════════════════════════════
    if (tire.dualPartnerId) {
      // Note: the dual partner's depth should be passed in tire context
      // We store this check here for the recommendation text; the actual
      // comparison happens at the vehicle-level analysis
      // This is handled in refreshTireAnalyticsCache with a dual lookup
    }

    // 9. CPK — only evaluate CPK alerts when the tire has meaningful wear.
    // A barely-used tire (e.g. 16mm left out of 22mm) naturally has very high
    // CPK because km is low. We need at least ~50% of usable depth worn to
    // have a meaningful CPK signal.
    const usableDepthForCpk = tire.profundidadInicial - C.LIMITE_LEGAL_MM;
    const mmWornForCpk      = tire.profundidadInicial - minDepth;
    const wearFraction      = usableDepthForCpk > 0 ? mmWornForCpk / usableDepthForCpk : 0;
    const hasMeaningfulWear = wearFraction >= 0.5; // at least 50% of usable tread worn

    const cpk = latest.cpk ?? null;
    // Use cpkProyectado for the comparison since it accounts for remaining life.
    // Threshold: compare against market-average CPK (roughly 150-200 COP/km for
    // truck tires). Only alert if BOTH the projected CPK is high AND the tire
    // has actual wear to validate the calculation.
    const cpkProy = latest.cpkProyectado ?? null;
    if (hasMeaningfulWear && cpkProy != null && cpkProy > 250) {
      recomendaciones.push({ priority: 90, msg: `Evaluar reemplazo. CPK proyectado ${Math.round(cpkProy)} COP/km — por encima del promedio.` });
    }
    // CPK trend: only meaningful when there's wear to compare
    if (hasMeaningfulWear && cpkTrend != null && cpkTrend > 0.1) {
      recomendaciones.push({ priority: 75, msg: 'Investigar causa de degradacion. CPK esta aumentando.' });
    }

    // 10. ROTACIÓN
    const lastRotation = (tire.eventos ?? [])
      .filter((e: any) => e.tipo === 'rotacion')
      .sort((a: any, b: any) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())[0];
    const kmSinceRotation = lastRotation
      ? tire.kilometrosRecorridos - (lastRotation.metadata?.kmAtEvent ?? 0)
      : tire.kilometrosRecorridos;

    if (kmSinceRotation >= C.ROTATION_INTERVAL_KM && minDepth > C.OPTIMAL_RETIREMENT_MM) {
      recomendaciones.push({ priority: 65, msg: `Rotar llanta. ${Math.round(kmSinceRotation / 1000)}K km sin rotacion.` });
    }

    // 11. ENVEJECIMIENTO
    if (tire.diasAcumulados > 180 && tire.kilometrosRecorridos < 20000) {
      recomendaciones.push({ priority: 60, msg: 'Revisar flancos. Muchos dias con bajo uso — posible resequedad.' });
    }

    // 12. SIN PROBLEMAS
    if (recomendaciones.length === 0) {
      recomendaciones.push({ priority: 10, msg: 'Sin anomalias. Llanta en buen estado.' });
    }

    return {
      id: tire.id,
      posicion: tire.posicion,
      profundidadActual,
      alertLevel,
      healthScore,
      recomendaciones: recomendaciones
        .sort((a, b) => b.priority - a.priority)
        .map(r => r.msg),
      cpkTrend,
      projectedDateEOL: tire.projectedDateEOL ?? null,
      desechos: tire.desechos ?? null,
    };
  }
}