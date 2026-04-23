/**
 * Runs only the analytics post-passes from import-merquepro.ts:
 *   0a. Synthesize Inspeccion from currentstate for tires with no real inspection
 *   0b. Position-collision cleanup (by latest inspection date)
 *    1. Retread cycle detection via depth reversal + vidaActual sync
 *    A. Derive kilometrosRecorridos from inspection mileage range
 *    B. Recompute currentCpk = sum(costos) / km
 *    C. Sync latest inspection snapshot onto tire
 *
 * Use this after import-merquepro.ts succeeds on tires + inspections but
 * fails in a post-pass — lets you re-run just the post-passes without the
 * ~60-minute tire+inspection refresh.
 *
 *   npx ts-node scripts/merquepro-postpass.ts --apply
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  if (!APPLY) {
    console.log('◇ Pass --apply to run. No-op in dry mode.');
    return;
  }
  console.log('▶ Merquepro post-passes');

  console.log('0a. Synthesizing inspections from currentstate…');
  const synth = await prisma.$executeRawUnsafe(`
    INSERT INTO inspecciones (
      id, "tireId", "fecha",
      "profundidadInt", "profundidadCen", "profundidadExt",
      "presionPsi", "kilometrosEstimados", "kmActualVehiculo", "kmEfectivos",
      "inspeccionadoPorNombre", "vidaAlMomento",
      "externalSourceId", "sourceMetadata", "createdAt"
    )
    SELECT
      gen_random_uuid()::text,
      t.id,
      COALESCE(
        (t."sourceMetadata"->'_currentState'->>'createdDate')::timestamp,
        t."fechaInstalacion",
        NOW()
      ),
      GREATEST(COALESCE((t."sourceMetadata"->'_currentState'->>'currentInternalDepth')::numeric, 0), 0),
      GREATEST(COALESCE((t."sourceMetadata"->'_currentState'->>'currentCentralDepth')::numeric, 0), 0),
      GREATEST(COALESCE((t."sourceMetadata"->'_currentState'->>'currentExternalDepth')::numeric, 0), 0),
      NULL,
      NULLIF(FLOOR((t."sourceMetadata"->'_currentState'->>'currentKm')::numeric)::int, 0),
      NULLIF(FLOOR((t."sourceMetadata"->'_currentState'->>'currentKm')::numeric)::int, 0),
      NULLIF(FLOOR((t."sourceMetadata"->'_currentState'->>'mileageTraveled')::numeric)::int, 0),
      NULLIF(t."sourceMetadata"->'_currentState'->>'adviser', ''),
      CASE
        WHEN t."sourceMetadata"->'_currentState'->>'state' = 'Desecho'    THEN 'fin'::"VidaValue"
        WHEN t."sourceMetadata"->'_currentState'->>'state' = 'Reencauche' THEN t."vidaActual"
        ELSE 'nueva'::"VidaValue"
      END,
      'merquepro:insp:synthetic:' || t.id,
      jsonb_build_object('source', 'merquepro_synthetic_from_currentstate'),
      NOW()
    FROM "Tire" t
    WHERE t."externalSourceId" LIKE 'merquepro:%'
      AND t."sourceMetadata"->'_currentState' IS NOT NULL
      AND (
            (t."sourceMetadata"->'_currentState'->>'currentExternalDepth') IS NOT NULL
         OR (t."sourceMetadata"->'_currentState'->>'currentCentralDepth')  IS NOT NULL
         OR (t."sourceMetadata"->'_currentState'->>'currentInternalDepth') IS NOT NULL
      )
      AND NOT EXISTS (SELECT 1 FROM inspecciones i WHERE i."tireId" = t.id)
  `);
  console.log(`  synthesized inspections: ${synth}`);

  console.log('0b. Resolving (vehicle, posicion) collisions…');
  const collision = await prisma.$executeRawUnsafe(`
    WITH last_insp AS (
      SELECT "tireId", MAX("fecha") AS last_fecha
        FROM inspecciones GROUP BY "tireId"
    ),
    ranked AS (
      SELECT t.id, t."vehicleId", t."posicion",
             ROW_NUMBER() OVER (
               PARTITION BY t."vehicleId", t."posicion"
               ORDER BY COALESCE(li.last_fecha, t."fechaInstalacion", t."createdAt") DESC,
                        t."updatedAt" DESC, t.id DESC
             ) AS rn
        FROM "Tire" t
        LEFT JOIN last_insp li ON li."tireId" = t.id
       WHERE t."externalSourceId" LIKE 'merquepro:%'
         AND t."vehicleId" IS NOT NULL AND t."posicion" > 0
    ),
    losers AS (
      SELECT r.id, t."vehicleId", v.placa AS v_placa, t."posicion"
        FROM ranked r
        JOIN "Tire" t ON t.id = r.id
        LEFT JOIN "Vehicle" v ON v.id = r."vehicleId"
       WHERE r.rn > 1
    )
    UPDATE "Tire" t
       SET "vehicleId" = NULL, "posicion" = 0,
           "lastVehicleId" = l."vehicleId",
           "lastVehiclePlaca" = l.v_placa,
           "lastPosicion" = l."posicion",
           "inventoryEnteredAt" = NOW()
      FROM losers l
     WHERE t.id = l.id
  `);
  console.log(`  resolved collisions: ${collision} tires bumped to inventory`);

  console.log('1. Detecting retread cycles from depth reversals…');
  const cycles = await prisma.$executeRawUnsafe(`
    WITH ordered AS (
      SELECT i.id, i."tireId", i."fecha",
             ((COALESCE(i."profundidadInt",0)+COALESCE(i."profundidadCen",0)+COALESCE(i."profundidadExt",0))/3.0)::numeric AS avg_depth,
             LAG((COALESCE(i."profundidadInt",0)+COALESCE(i."profundidadCen",0)+COALESCE(i."profundidadExt",0))/3.0) OVER (
               PARTITION BY i."tireId" ORDER BY i."fecha" ASC, i.id ASC
             ) AS prev_avg
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
      WHERE t."externalSourceId" LIKE 'merquepro:%'
    ),
    reversals AS (
      SELECT "tireId", "fecha", avg_depth, prev_avg,
             ROW_NUMBER() OVER (PARTITION BY "tireId" ORDER BY "fecha" ASC) AS rev_idx
      FROM ordered
      WHERE prev_avg IS NOT NULL AND prev_avg > 0 AND avg_depth - prev_avg >= 5
    )
    INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, metadata, "createdAt")
    SELECT gen_random_uuid()::text, r."tireId", 'reencauche'::"TireEventType", r."fecha",
           CASE WHEN r.rev_idx = 1 THEN 'reencauche1' WHEN r.rev_idx = 2 THEN 'reencauche2' ELSE 'reencauche3' END,
           jsonb_build_object('source','merquepro_depth_reversal','avg_depth_before',r.prev_avg,'avg_depth_after',r.avg_depth,'cycle_index',r.rev_idx),
           NOW()
    FROM reversals r
    WHERE NOT EXISTS (
      SELECT 1 FROM tire_eventos e
       WHERE e."tireId" = r."tireId"
         AND e.tipo = 'reencauche'::"TireEventType"
         AND e.notas = CASE WHEN r.rev_idx = 1 THEN 'reencauche1' WHEN r.rev_idx = 2 THEN 'reencauche2' ELSE 'reencauche3' END
    )
  `);
  console.log(`  retread cycles logged: ${cycles}`);

  const vidaSync = await prisma.$executeRawUnsafe(`
    WITH counts AS (
      SELECT "tireId", COUNT(*) AS cycles
        FROM tire_eventos
       WHERE tipo = 'reencauche'::"TireEventType"
         AND notas IN ('reencauche1','reencauche2','reencauche3')
       GROUP BY "tireId"
    )
    UPDATE "Tire" t
       SET "totalVidas" = GREATEST(t."totalVidas", c.cycles::int),
           "vidaActual" = CASE
             WHEN t."vidaActual" = 'fin'::"VidaValue" THEN 'fin'::"VidaValue"
             WHEN c.cycles >= 3 THEN 'reencauche3'::"VidaValue"
             WHEN c.cycles = 2  THEN 'reencauche2'::"VidaValue"
             WHEN c.cycles = 1  THEN 'reencauche1'::"VidaValue"
             ELSE t."vidaActual"
           END
      FROM counts c
     WHERE t.id = c."tireId" AND t."externalSourceId" LIKE 'merquepro:%'
  `);
  console.log(`  vidaActual synced from cycle count: ${vidaSync} tires`);

  console.log('A0. Backfilling km from currentstate.mileageTraveled…');
  const a0 = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "kilometrosRecorridos" = LEAST(
         FLOOR((t."sourceMetadata"->'_currentState'->>'mileageTraveled')::numeric)::int,
         250000
       )
     WHERE t."externalSourceId" LIKE 'merquepro:%'
       AND t."kilometrosRecorridos" = 0
       AND (t."sourceMetadata"->'_currentState'->>'mileageTraveled') IS NOT NULL
       AND (t."sourceMetadata"->'_currentState'->>'mileageTraveled')::numeric > 0
  `);
  console.log(`  backfilled km from currentstate: ${a0} tires`);

  console.log('A. Deriving km from inspection ranges…');
  const a = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "kilometrosRecorridos" = LEAST((ik.max_km - ik.min_km)::int, 250000)
      FROM (
        SELECT "tireId", MIN("kmActualVehiculo") AS min_km, MAX("kmActualVehiculo") AS max_km
          FROM inspecciones WHERE "kmActualVehiculo" IS NOT NULL AND "kmActualVehiculo" > 0
         GROUP BY "tireId" HAVING COUNT(*) >= 2
      ) ik
     WHERE t.id = ik."tireId"
       AND t."externalSourceId" LIKE 'merquepro:%'
       AND t."kilometrosRecorridos" = 0
       AND (ik.max_km - ik.min_km) >= 500
  `);
  console.log(`  derived km from inspections: ${a} tires`);

  console.log('B. Recomputing currentCpk…');
  const b = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "currentCpk" = CASE
         WHEN (cs.total / t."kilometrosRecorridos") > 500 THEN NULL
         ELSE ROUND((cs.total / t."kilometrosRecorridos")::numeric, 2)
       END
      FROM (SELECT "tireId", SUM(valor)::numeric AS total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id = cs."tireId"
       AND t."externalSourceId" LIKE 'merquepro:%'
       AND t."kilometrosRecorridos" > 0
       AND cs.total > 0
  `);
  console.log(`  recomputed currentCpk: ${b} tires`);

  console.log('C. Syncing latest inspection snapshot…');
  const c = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "lastInspeccionDate" = sub.fecha,
           "currentProfundidad" = sub.avg_depth,
           "currentPresionPsi" = COALESCE(sub.presion, t."currentPresionPsi")
      FROM (
        SELECT DISTINCT ON ("tireId")
               "tireId", "fecha",
               ("profundidadInt" + "profundidadCen" + "profundidadExt") / 3 AS avg_depth,
               "presionPsi" AS presion
          FROM inspecciones
         ORDER BY "tireId", "fecha" DESC
      ) sub
     WHERE t.id = sub."tireId"
       AND t."externalSourceId" LIKE 'merquepro:%'
  `);
  console.log(`  synced latest inspection snapshot: ${c} tires`);

  console.log('✅ Post-passes done.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
