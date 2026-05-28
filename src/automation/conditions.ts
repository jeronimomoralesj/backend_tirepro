// Generic condition evaluator for automation flows.
//
// Each automation flow's triggerConfig may include a `conditions` array.
// Every condition is { field, op, value }; all conditions are AND-ed.
// The base trigger (alert change / inspection / rotation / scheduled / etc.)
// has to match first; conditions then narrow when the action actually fires.
//
// Why a generic evaluator vs. one bespoke trigger per scenario:
//   * Lets users compose specific cases like "Continental tire on a cabezote
//     rotates from position 1 to position 2" without us adding a dedicated
//     trigger type for every combination.
//   * The whitelist of fields (FIELD_CATALOG) keeps the surface safe — no
//     arbitrary path lookups, no SQL injection, no surprise PII access.

import { PrismaService } from '../prisma/prisma.service';

export type ConditionOp =
  | 'eq' | 'neq'
  | 'in' | 'nin'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null';

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

// Whitelist of filterable fields. Keys are dotted paths users (and the AI
// builder) reference in `field`; values describe where the data comes from
// so the evaluator can fetch it lazily.
export const FIELD_CATALOG: Record<string, { source: 'tire' | 'vehicle' | 'rotation' | 'alert'; column: string; type: 'string' | 'number' | 'boolean' }> = {
  // ── Tire identity & spec
  'tire.marca':              { source: 'tire',    column: 'marca',                type: 'string'  },
  'tire.diseno':             { source: 'tire',    column: 'diseno',               type: 'string'  },
  'tire.dimension':          { source: 'tire',    column: 'dimension',            type: 'string'  },
  'tire.eje':                { source: 'tire',    column: 'eje',                  type: 'string'  },
  'tire.tipoDiseno':         { source: 'tire',    column: 'tipoDiseno',           type: 'string'  },
  'tire.vidaActual':         { source: 'tire',    column: 'vidaActual',           type: 'string'  },
  'tire.totalVidas':         { source: 'tire',    column: 'totalVidas',           type: 'number'  },
  'tire.posicion':           { source: 'tire',    column: 'posicion',             type: 'number'  },
  'tire.placa':              { source: 'tire',    column: 'placa',                type: 'string'  },
  'tire.isRegrabable':       { source: 'tire',    column: 'isRegrabable',         type: 'boolean' },
  // ── Tire current state
  'tire.currentProfundidad': { source: 'tire',    column: 'currentProfundidad',   type: 'number'  },
  'tire.currentPresionPsi':  { source: 'tire',    column: 'currentPresionPsi',    type: 'number'  },
  'tire.currentCpk':         { source: 'tire',    column: 'currentCpk',           type: 'number'  },
  'tire.lifetimeCpk':        { source: 'tire',    column: 'lifetimeCpk',          type: 'number'  },
  'tire.healthScore':        { source: 'tire',    column: 'healthScore',          type: 'number'  },
  'tire.alertLevel':         { source: 'tire',    column: 'alertLevel',           type: 'string'  },
  'tire.kilometrosRecorridos': { source: 'tire',  column: 'kilometrosRecorridos', type: 'number'  },
  'tire.projectedDaysToLimit': { source: 'tire',  column: 'projectedDaysToLimit', type: 'number'  },
  'tire.projectedKmRemaining': { source: 'tire',  column: 'projectedKmRemaining', type: 'number'  },
  // ── Vehicle identity & spec
  'vehicle.placa':           { source: 'vehicle', column: 'placa',                type: 'string'  },
  'vehicle.tipovhc':         { source: 'vehicle', column: 'tipovhc',              type: 'string'  },
  'vehicle.marca':           { source: 'vehicle', column: 'marca',                type: 'string'  },
  'vehicle.cliente':         { source: 'vehicle', column: 'cliente',              type: 'string'  },
  'vehicle.tipoOperacion':   { source: 'vehicle', column: 'tipoOperacion',        type: 'string'  },
  'vehicle.configuracion':   { source: 'vehicle', column: 'configuracion',        type: 'string'  },
  'vehicle.carga':           { source: 'vehicle', column: 'carga',                type: 'string'  },
  'vehicle.pesoCarga':       { source: 'vehicle', column: 'pesoCarga',            type: 'number'  },
  'vehicle.kilometrajeActual': { source: 'vehicle', column: 'kilometrajeActual',  type: 'number'  },
  'vehicle.kmMensualReal':   { source: 'vehicle', column: 'kmMensualReal',        type: 'number'  },
  'vehicle.estadoOperacional': { source: 'vehicle', column: 'estadoOperacional',  type: 'string'  },
  // ── Rotation context (only present for tire_rotation triggers)
  'rotation.fromPosition':   { source: 'rotation', column: 'fromPosition',        type: 'number'  },
  'rotation.toPosition':     { source: 'rotation', column: 'toPosition',          type: 'number'  },
  'rotation.fromVehicleId':  { source: 'rotation', column: 'fromVehicleId',       type: 'string'  },
  'rotation.toVehicleId':    { source: 'rotation', column: 'toVehicleId',         type: 'string'  },
  'rotation.fromPlaca':      { source: 'rotation', column: 'fromPlaca',           type: 'string'  },
  'rotation.toPlaca':        { source: 'rotation', column: 'toPlaca',             type: 'string'  },
  // ── Alert transition (tire_alert_level + inspection_completed)
  'alert.old':               { source: 'alert',    column: 'old',                 type: 'string'  },
  'alert.new':               { source: 'alert',    column: 'new',                 type: 'string'  },
};

export interface ConditionContext {
  tireId?: string;
  vehicleId?: string;
  rotation?: {
    fromPosition?: number;
    toPosition?: number;
    fromVehicleId?: string;
    toVehicleId?: string;
    fromPlaca?: string;
    toPlaca?: string;
  };
  alert?: { old?: string; new?: string };
}

/**
 * Returns true if `conditions` is empty/missing or every condition matches the
 * data resolved from `ctx`. A condition referencing a field whose source data
 * is unavailable (e.g. `vehicle.tipovhc` when the tire has no vehicle) is
 * treated as a non-match — fail-closed so users don't get noisy emails when
 * a filter can't be evaluated.
 */
export async function evaluateConditions(
  conditions: unknown,
  ctx: ConditionContext,
  prisma: PrismaService,
): Promise<boolean> {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;

  // Lazy-load tire + vehicle records only if any condition needs them.
  let tireRow: Record<string, unknown> | null | undefined;
  let vehicleRow: Record<string, unknown> | null | undefined;

  for (const raw of conditions) {
    if (!raw || typeof raw !== 'object') return false;
    const c = raw as Partial<Condition>;
    if (typeof c.field !== 'string' || typeof c.op !== 'string') return false;
    const meta = FIELD_CATALOG[c.field];
    if (!meta) return false;

    let actual: unknown;
    if (meta.source === 'tire') {
      if (!ctx.tireId) return false;
      if (tireRow === undefined) {
        tireRow = await prisma.tire.findUnique({ where: { id: ctx.tireId } }) as Record<string, unknown> | null;
      }
      if (!tireRow) return false;
      actual = tireRow[meta.column];
    } else if (meta.source === 'vehicle') {
      // Prefer explicit vehicleId; otherwise hop from tireRow.vehicleId.
      const vId = ctx.vehicleId ?? (tireRow?.vehicleId as string | undefined);
      if (!vId) {
        // Tire might not be loaded yet — fetch it and try again.
        if (ctx.tireId && tireRow === undefined) {
          tireRow = await prisma.tire.findUnique({ where: { id: ctx.tireId } }) as Record<string, unknown> | null;
        }
        const v2 = ctx.vehicleId ?? (tireRow?.vehicleId as string | undefined);
        if (!v2) return false;
        if (vehicleRow === undefined) {
          vehicleRow = await prisma.vehicle.findUnique({ where: { id: v2 } }) as Record<string, unknown> | null;
        }
      } else if (vehicleRow === undefined) {
        vehicleRow = await prisma.vehicle.findUnique({ where: { id: vId } }) as Record<string, unknown> | null;
      }
      if (!vehicleRow) return false;
      actual = vehicleRow[meta.column];
    } else if (meta.source === 'rotation') {
      if (!ctx.rotation) return false;
      actual = (ctx.rotation as Record<string, unknown>)[meta.column];
    } else if (meta.source === 'alert') {
      if (!ctx.alert) return false;
      actual = (ctx.alert as Record<string, unknown>)[meta.column];
    }

    if (!compareValues(actual, c.op as ConditionOp, c.value, meta.type)) return false;
  }

  return true;
}

function compareValues(
  actual: unknown,
  op: ConditionOp,
  expected: unknown,
  type: 'string' | 'number' | 'boolean',
): boolean {
  // Null/undefined handling: only is_null / is_not_null treat them as valid input.
  if (op === 'is_null') return actual == null;
  if (op === 'is_not_null') return actual != null;
  if (actual == null) return false;

  const a = type === 'number'
    ? Number(actual)
    : type === 'boolean'
      ? Boolean(actual)
      : String(actual);

  switch (op) {
    case 'eq':
      return type === 'string'
        ? String(a).toLowerCase() === String(expected ?? '').toLowerCase()
        : a === coerce(expected, type);
    case 'neq':
      return type === 'string'
        ? String(a).toLowerCase() !== String(expected ?? '').toLowerCase()
        : a !== coerce(expected, type);
    case 'in':
      if (!Array.isArray(expected)) return false;
      return type === 'string'
        ? expected.map(v => String(v).toLowerCase()).includes(String(a).toLowerCase())
        : expected.map(v => coerce(v, type)).includes(a);
    case 'nin':
      if (!Array.isArray(expected)) return true;
      return type === 'string'
        ? !expected.map(v => String(v).toLowerCase()).includes(String(a).toLowerCase())
        : !expected.map(v => coerce(v, type)).includes(a);
    case 'gt':  return type === 'number' && (a as number) >  Number(expected);
    case 'gte': return type === 'number' && (a as number) >= Number(expected);
    case 'lt':  return type === 'number' && (a as number) <  Number(expected);
    case 'lte': return type === 'number' && (a as number) <= Number(expected);
    case 'contains':    return type === 'string' && String(a).toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'starts_with': return type === 'string' && String(a).toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    case 'ends_with':   return type === 'string' && String(a).toLowerCase().endsWith(String(expected ?? '').toLowerCase());
    default: return false;
  }
}

function coerce(v: unknown, type: 'string' | 'number' | 'boolean'): unknown {
  if (type === 'number') return Number(v);
  if (type === 'boolean') return Boolean(v);
  return String(v ?? '');
}
