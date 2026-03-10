// migrate.js
// Migrates tire data from MongoDB → PostgreSQL (schema v2).
// Run with: node migrate.js
//
// Schema v2 key differences vs the old migration:
//   - Tire.inspecciones  → Inspeccion table  (normalized rows)
//   - Tire.eventos       → TireEvento table  (normalized rows)
//   - Tire.costo         → TireCosto table   (normalized rows)
//   - No tireCount / vehicleCount on Company or Vehicle
//   - All enums enforced (EjeType, TireEventType)
//   - refreshTireAnalyticsCache() called per tire to populate cached columns

const { MongoClient } = require("mongodb");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Config — edit before running
// ---------------------------------------------------------------------------

const MONGO_URI        = "mongodb+srv://moraljero:Anajaramillo1@cluster0.ffedm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const MONGO_DB_NAME    = "test";
const MONGO_COLLECTION = "tire_data";
const COMPANY_ID       = "453158cc-fc55-4161-9ed8-0fc004bf1ce8";

// ---------------------------------------------------------------------------
// Constants (must match tire.service.ts)
// ---------------------------------------------------------------------------

const LIMITE_LEGAL_MM          = 2;
const KM_POR_MES               = 6_000;
const STANDARD_TIRE_EXPECTED_KM = 80_000;
const SIGNIFICANT_WEAR_MM      = 5;
const MS_POR_DIA               = 86_400_000;

// ---------------------------------------------------------------------------
// Valid enum values
// ---------------------------------------------------------------------------

const VALID_EJE = ['direccion', 'traccion', 'libre', 'remolque', 'repuesto'];
const VALID_TIRE_EVENT_TYPE = ['montaje', 'rotacion', 'reparacion', 'retiro', 'inspeccion', 'reencauche'];
const VIDA_SEQUENCE = ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'];

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function parseDate(obj) {
  if (!obj) return new Date();
  // Handle { day, month, year } shape from Mongo
  if (obj.day && obj.month && obj.year) {
    return new Date(obj.year, obj.month - 1, obj.day);
  }
  // Handle plain date strings or Date objects
  if (obj instanceof Date) return obj;
  if (typeof obj === 'string') {
    const d = new Date(obj);
    return isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}

function safeFloat(v, fallback = 0) {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? fallback : n;
}

function safeInt(v, fallback = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

function normalizeEje(raw) {
  if (!raw) return 'libre';
  const n = raw.toString().toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Common Spanish aliases
  if (n.includes('direcc')) return 'direccion';
  if (n.includes('tracc'))  return 'traccion';
  if (n.includes('remol'))  return 'remolque';
  if (n.includes('repue'))  return 'repuesto';
  if (VALID_EJE.includes(n)) return n;
  return 'libre';
}

function normalizeVida(raw) {
  if (!raw) return null;
  const n = raw.toString().toLowerCase().trim();
  if (n === 'rencauche' || n === 'reencauche') return 'reencauche1';
  if (VIDA_SEQUENCE.includes(n)) return n;
  return null;
}

function calcMinDepth(i, c, e) {
  return Math.min(i, c, e);
}

function calcCpkMetrics(totalCost, km, meses, profundidadInicial, minDepth) {
  const cpk = km    > 0 ? totalCost / km    : 0;
  const cpt = meses > 0 ? totalCost / meses : 0;

  const usableDepth = profundidadInicial - LIMITE_LEGAL_MM;
  const mmWorn      = profundidadInicial - minDepth;
  const mmLeft      = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
  let   projectedKm = 0;

  if (usableDepth > 0 && km > 0) {
    projectedKm = mmWorn >= SIGNIFICANT_WEAR_MM
      ? km + (km / mmWorn) * mmLeft
      : km + (mmLeft / usableDepth) * STANDARD_TIRE_EXPECTED_KM;
  }

  const projectedMonths = projectedKm / KM_POR_MES;
  const cpkProyectado   = projectedKm     > 0 ? totalCost / projectedKm     : 0;
  const cptProyectado   = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm, projectedMonths };
}

function calcCpkTrend(cpkValues) {
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

function calcHealthScore(profundidadInicial, minDepth, cpkTrend, pInt, pCen, pExt) {
  const usable     = Math.max(profundidadInicial - LIMITE_LEGAL_MM, 1);
  const remaining  = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
  const depthScore = Math.min((remaining / usable) * 100, 100);

  const trendRaw   = cpkTrend !== null ? cpkTrend : 0;
  const trendScore = Math.min(Math.max(50 - trendRaw * 100, 0), 100);

  const maxDelta   = Math.max(
    Math.abs(pInt - pCen),
    Math.abs(pCen - pExt),
    Math.abs(pInt - pExt),
  );
  const irregScore = Math.max(100 - maxDelta * 15, 0);

  return Math.round(depthScore * 0.5 + trendScore * 0.3 + irregScore * 0.2);
}

function deriveAlertLevel(healthScore, minDepth) {
  if (minDepth <= LIMITE_LEGAL_MM) return 'critical';
  if (healthScore < 25)            return 'critical';
  if (healthScore < 50)            return 'warning';
  if (healthScore < 70)            return 'watch';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("✅ Connected to MongoDB");

  const db         = client.db(MONGO_DB_NAME);
  const collection = db.collection(MONGO_COLLECTION);
  const cursor     = collection.find({});

  // Validate company exists before starting
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID } });
  if (!company) {
    console.error(`❌ Company ${COMPANY_ID} not found in PostgreSQL. Aborting.`);
    await client.close();
    await prisma.$disconnect();
    return;
  }
  console.log(`✅ Company "${company.name}" found. Starting migration...`);

  const vehicleMap = new Map(); // placa → vehicleId
  let totalTires   = 0;
  let failedTires  = 0;
  const errors     = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    console.log(`\n📄 Processing Mongo doc _id: ${doc._id}`);

    try {
      // =======================================================================
      // 1. VEHICLE
      // =======================================================================

      let vehicleId = null;

      if (doc.placa) {
        const placaKey = doc.placa.toString().toLowerCase().trim();

        if (vehicleMap.has(placaKey)) {
          vehicleId = vehicleMap.get(placaKey);
          console.log(`  ↪ Reusing vehicle ${vehicleId} for placa "${placaKey}"`);
        } else {
          // Check if vehicle already exists in Postgres (idempotent re-runs)
          const existing = await prisma.vehicle.findFirst({ where: { placa: placaKey } });

          if (existing) {
            vehicleId = existing.id;
            vehicleMap.set(placaKey, vehicleId);
            console.log(`  ↪ Found existing vehicle ${vehicleId} for placa "${placaKey}"`);
          } else {
            // Derive kilometrajeActual from last entry of kilometraje_actual array
            let kilometrajeActual = 0;
            if (Array.isArray(doc.kilometraje_actual) && doc.kilometraje_actual.length > 0) {
              kilometrajeActual = safeFloat(doc.kilometraje_actual[doc.kilometraje_actual.length - 1].value);
            }

            const newVehicle = await prisma.vehicle.create({
              data: {
                placa:             placaKey,
                kilometrajeActual: kilometrajeActual,
                carga:             doc.frente    || 'unknown',
                pesoCarga:         safeFloat(doc.pesoCarga),
                tipovhc:           doc.tipovhc   || 'unknown',
                companyId:         COMPANY_ID,
                union:             [],
              },
            });

            vehicleId = newVehicle.id;
            vehicleMap.set(placaKey, vehicleId);
            console.log(`  ✅ Created vehicle ${vehicleId} for placa "${placaKey}"`);
          }
        }
      }

      // =======================================================================
      // 2. TIRE IDENTITY
      // =======================================================================

      const tirePlaca = doc.llanta
        ? doc.llanta.toString().toLowerCase().trim()
        : `migrated-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      // Skip if tire already exists (idempotent re-run support)
      const existingTire = await prisma.tire.findFirst({ where: { placa: tirePlaca } });
      if (existingTire) {
        console.log(`  ⚠️  Tire "${tirePlaca}" already exists. Skipping.`);
        continue;
      }

      const marca              = (doc.marca     || '').toString().toLowerCase().trim();
      const diseno             = (doc.diseno    || '').toString().toLowerCase().trim();
      const dimension          = (doc.dimension || '').toString().toLowerCase().trim();
      const eje                = normalizeEje(doc.eje);
      const profundidadInicial = safeFloat(doc.profundidad_inicial, 22);

      // Position: take first value from pos array
      let posicion = 0;
      if (Array.isArray(doc.pos) && doc.pos.length > 0) {
        posicion = safeInt(doc.pos[0].value);
      }

      // KM traveled: last value from kms array
      let kilometrosRecorridos = 0;
      if (Array.isArray(doc.kms) && doc.kms.length > 0) {
        kilometrosRecorridos = safeFloat(doc.kms[doc.kms.length - 1].value);
      }

      // Days / months accumulated
      let fechaInstalacion = new Date();
      if (Array.isArray(doc.vida) && doc.vida.length > 0) {
        fechaInstalacion = parseDate(doc.vida[0]);
      }
      const diasAcumulados = Math.max(
        Math.floor((Date.now() - fechaInstalacion.getTime()) / MS_POR_DIA), 0,
      );

      // =======================================================================
      // 3. BUILD COST ARRAY
      // =======================================================================

      const costoRows = [];

      if (typeof doc.costo === 'number' && doc.costo > 0) {
        costoRows.push({ valor: doc.costo, fecha: fechaInstalacion });
      } else if (Array.isArray(doc.costo)) {
        for (const entry of doc.costo) {
          const valor = safeFloat(entry.value ?? entry.valor ?? entry);
          if (valor > 0) {
            costoRows.push({ valor, fecha: parseDate(entry) });
          }
        }
      }

      // Default cost so CPK calculations aren't zero-divided
      if (costoRows.length === 0) {
        console.log(`  ⚠️  No cost found for tire "${tirePlaca}", using fallback 2,200,000`);
        costoRows.push({ valor: 2_200_000, fecha: fechaInstalacion });
      }

      const totalCost = costoRows.reduce((s, c) => s + c.valor, 0);

      // =======================================================================
      // 4. BUILD INSPECCION ARRAY
      // =======================================================================

      const inspeccionRows = [];
      const mesesAcumulados = diasAcumulados / 30;

      if (
        Array.isArray(doc.profundidad_int) &&
        Array.isArray(doc.profundidad_cen) &&
        Array.isArray(doc.profundidad_ext)
      ) {
        const cpkArr  = Array.isArray(doc.cpk)      ? doc.cpk      : [];
        const cpkPArr = Array.isArray(doc.cpk_proy) ? doc.cpk_proy : [];
        const cptArr  = Array.isArray(doc.cpt)      ? doc.cpt      : [];
        const cptPArr = Array.isArray(doc.cpt_proy) ? doc.cpt_proy : [];
        const kmsArr  = Array.isArray(doc.kms)      ? doc.kms      : [];

        const len = Math.min(
          doc.profundidad_int.length,
          doc.profundidad_cen.length,
          doc.profundidad_ext.length,
        );

        for (let i = 0; i < len; i++) {
          const pInt = safeFloat(doc.profundidad_int[i].value);
          const pCen = safeFloat(doc.profundidad_cen[i].value);
          const pExt = safeFloat(doc.profundidad_ext[i].value);

          if (pInt === 0 && pCen === 0 && pExt === 0) continue; // skip blank rows

          const fecha    = parseDate(doc.profundidad_int[i]);
          const minDepth = calcMinDepth(pInt, pCen, pExt);

          // Use stored CPK if available, otherwise compute
          let cpk           = cpkArr[i]  ? safeFloat(cpkArr[i].value)  : 0;
          let cpkProyectado = cpkPArr[i] ? safeFloat(cpkPArr[i].value) : 0;
          let cpt           = cptArr[i]  ? safeFloat(cptArr[i].value)  : 0;
          let cptProyectado = cptPArr[i] ? safeFloat(cptPArr[i].value) : 0;
          let kmProyectado  = 0;

          const kmAtInsp = kmsArr[i] ? safeFloat(kmsArr[i].value) : kilometrosRecorridos;
          const diasAtI  = Math.max(
            Math.floor((fecha.getTime() - fechaInstalacion.getTime()) / MS_POR_DIA), 1,
          );
          const mesesAtI = diasAtI / 30;

          if (cpk === 0 || cpkProyectado === 0) {
            const metrics = calcCpkMetrics(totalCost, kmAtInsp, mesesAtI, profundidadInicial, minDepth);
            if (cpk === 0)           cpk           = metrics.cpk;
            if (cpkProyectado === 0) cpkProyectado = metrics.cpkProyectado;
            if (cpt === 0)           cpt           = metrics.cpt;
            if (cptProyectado === 0) cptProyectado = metrics.cptProyectado;
            kmProyectado = metrics.projectedKm;
          }

          inspeccionRows.push({
            fecha,
            profundidadInt:      pInt,
            profundidadCen:      pCen,
            profundidadExt:      pExt,
            cpk,
            cpkProyectado,
            cpt,
            cptProyectado,
            diasEnUso:           diasAtI,
            mesesEnUso:          mesesAtI,
            kilometrosEstimados: kmAtInsp,
            kmActualVehiculo:    kmAtInsp,
            kmEfectivos:         kmAtInsp,
            kmProyectado,
            imageUrl:            null,
          });
        }
      }

      // =======================================================================
      // 5. BUILD EVENTO ARRAY
      // =======================================================================

      const eventoRows = [];

      // Vida states → TireEvento (montaje tipo)
      if (Array.isArray(doc.vida)) {
        for (const entry of doc.vida) {
          const normalizedVida = normalizeVida(entry.value ?? entry.valor);
          if (normalizedVida) {
            eventoRows.push({
              tipo:     'montaje',
              fecha:    parseDate(entry),
              notas:    normalizedVida,
              metadata: { vidaValor: normalizedVida },
            });
          }
        }
      }

      // Generic eventos array
      if (Array.isArray(doc.eventos)) {
        for (const evt of doc.eventos) {
          const rawTipo = (evt.value ?? evt.tipo ?? '').toString().toLowerCase();
          const tipo    = VALID_TIRE_EVENT_TYPE.includes(rawTipo) ? rawTipo : 'inspeccion';
          eventoRows.push({
            tipo,
            fecha: parseDate(evt),
            notas: evt.notas ?? evt.value ?? null,
            metadata: null,
          });
        }
      }

      // =======================================================================
      // 6. COMPUTE ANALYTICS CACHE (so dashboards are immediately fast)
      // =======================================================================

      let currentCpk           = null;
      let currentCpt           = null;
      let currentProfundidad   = null;
      let cpkTrend             = null;
      let projectedKmRemaining = null;
      let projectedDateEOL     = null;
      let healthScore          = null;
      let alertLevel           = 'ok';
      let lastInspeccionDate   = null;

      if (inspeccionRows.length > 0) {
        const sorted   = [...inspeccionRows].sort((a, b) => a.fecha - b.fecha);
        const latest   = sorted[sorted.length - 1];
        const pInt     = latest.profundidadInt;
        const pCen     = latest.profundidadCen;
        const pExt     = latest.profundidadExt;
        const minDepth = calcMinDepth(pInt, pCen, pExt);

        currentCpk         = latest.cpk;
        currentCpt         = latest.cpt;
        currentProfundidad = (pInt + pCen + pExt) / 3;
        lastInspeccionDate = latest.fecha;

        const last5    = sorted.slice(-5);
        cpkTrend       = calcCpkTrend(last5.map(i => i.cpk ?? 0).filter(v => v > 0));
        healthScore    = calcHealthScore(profundidadInicial, minDepth, cpkTrend, pInt, pCen, pExt);
        alertLevel     = deriveAlertLevel(healthScore, minDepth);

        const projKm = latest.kmProyectado ?? 0;
        const kmLeft = Math.max(projKm - kilometrosRecorridos, 0);
        if (kmLeft > 0) {
          projectedKmRemaining = Math.round(kmLeft);
          const daysLeft       = (kmLeft / KM_POR_MES) * 30;
          projectedDateEOL     = new Date(Date.now() + daysLeft * MS_POR_DIA);
        }
      }

      // primeraVida snapshot (if reencauche1 exists in vida)
      let primeraVida = [];
      if (Array.isArray(doc.vida)) {
        const enc1 = doc.vida.find(v => normalizeVida(v.value) === 'reencauche1');
        if (enc1 && inspeccionRows.length > 0) {
          primeraVida = [{
            diseno,
            cpk:        currentCpk ?? 0,
            costo:      costoRows[0]?.valor ?? 0,
            kilometros: kilometrosRecorridos,
          }];
        }
      }

      // =======================================================================
      // 7. WRITE TO POSTGRES
      // =======================================================================

      const newTire = await prisma.tire.create({
        data: {
          placa:                tirePlaca,
          marca,
          diseno,
          profundidadInicial,
          dimension,
          eje,
          posicion,
          kilometrosRecorridos,
          diasAcumulados,
          companyId:            COMPANY_ID,
          vehicleId:            vehicleId ?? null,
          fechaInstalacion,
          alertLevel,
          primeraVida,
          desechos:             doc.desechos ?? null,
          // Cached analytics columns
          currentCpk,
          currentCpt,
          currentProfundidad,
          cpkTrend,
          projectedKmRemaining,
          projectedDateEOL,
          healthScore,
          lastInspeccionDate,
        },
      });

      // Write normalized child records in parallel
      await Promise.all([
        costoRows.length
          ? prisma.tireCosto.createMany({
              data: costoRows.map(c => ({ tireId: newTire.id, valor: c.valor, fecha: c.fecha })),
            })
          : Promise.resolve(),

        inspeccionRows.length
          ? prisma.inspeccion.createMany({
              data: inspeccionRows.map(r => ({ tireId: newTire.id, ...r })),
            })
          : Promise.resolve(),

        eventoRows.length
          ? prisma.tireEvento.createMany({
              data: eventoRows.map(e => ({
                tireId:   newTire.id,
                tipo:     e.tipo,
                fecha:    e.fecha,
                notas:    e.notas ?? null,
                metadata: e.metadata ?? null,
              })),
            })
          : Promise.resolve(),
      ]);

      totalTires++;
      console.log(
        `  ✅ Tire "${tirePlaca}" — ${inspeccionRows.length} inspecciones, ` +
        `${eventoRows.length} eventos, alertLevel: ${alertLevel}`,
      );

    } catch (err) {
      failedTires++;
      const msg = `❌ Failed _id ${doc._id}: ${err.message}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  await client.close();
  await prisma.$disconnect();

  console.log('\n====================================================');
  console.log(`Migration complete.`);
  console.log(`  ✅ Migrated:  ${totalTires} tires`);
  console.log(`  ❌ Failed:    ${failedTires} tires`);
  if (errors.length) {
    console.log('\nFailed records:');
    errors.forEach(e => console.log(' ', e));
  }
  console.log('====================================================');
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});