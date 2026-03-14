import { PrismaClient, VidaValue, MotivoFinVida } from '@prisma/client';

const prisma = new PrismaClient();
const MS_POR_DIA = 86_400_000;

async function main() {
  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
      costos:       { orderBy: { fecha: 'asc' } },
      eventos:      { orderBy: { fecha: 'asc' } },
    },
  });

  console.log(`Processing ${tires.length} tires...`);
  let created = 0, skipped = 0, failed = 0;

  for (const tire of tires) {
    try {
      // ── 1. Resolve vidaActual from eventos ──────────────────────────────
      const VIDA_SET = new Set(['nueva','reencauche1','reencauche2','reencauche3','fin']);
      const vidaEvt = [...tire.eventos]
        .filter(e => VIDA_SET.has(e.notas ?? ''))
        .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime())
        .at(-1);
      const vidaActual: VidaValue = (vidaEvt?.notas as VidaValue) ?? VidaValue.nueva;

      // ── 2. Update Tire cached columns ───────────────────────────────────
      const lastInsp = tire.inspecciones.at(-1);
      const minDepth = lastInsp
        ? Math.min(lastInsp.profundidadInt, lastInsp.profundidadCen, lastInsp.profundidadExt)
        : null;
      const avgDepth = lastInsp
        ? (lastInsp.profundidadInt + lastInsp.profundidadCen + lastInsp.profundidadExt) / 3
        : null;

      await prisma.tire.update({
        where: { id: tire.id },
        data: {
          vidaActual,
          currentCpk:         lastInsp?.cpk          ?? null,
          currentCpt:         lastInsp?.cpt          ?? null,
          currentProfundidad: avgDepth,
          lastInspeccionDate: lastInsp?.fecha         ?? null,
        },
      });

      // ── 3. Backfill vidaAlMomento on all inspecciones ───────────────────
      if (tire.inspecciones.length > 0) {
        await prisma.inspeccion.updateMany({
          where: { tireId: tire.id },
          data:  { vidaAlMomento: vidaActual },
        });
      }

      // ── 4. Create TireVidaSnapshot if none exists ───────────────────────
      const existingSnapshot = await prisma.tireVidaSnapshot.findFirst({
        where: { tireId: tire.id },
      });
      if (existingSnapshot) { skipped++; continue; }

      if (!tire.inspecciones.length && !tire.costos.length) { skipped++; continue; }

      const fechaInicio  = tire.fechaInstalacion ?? tire.createdAt;
      const fechaFin     = new Date();
      const diasTotales  = Math.max(
        Math.floor((fechaFin.getTime() - fechaInicio.getTime()) / MS_POR_DIA), 0,
      );
      const mesesTotales = diasTotales / 30;
      const firstInsp    = tire.inspecciones.at(0);
      const profInicial  = tire.profundidadInicial;
      const profFinal    = lastInsp
        ? (lastInsp.profundidadInt + lastInsp.profundidadCen + lastInsp.profundidadExt) / 3
        : profInicial;
      const mmDesgastados = Math.max(profInicial - profFinal, 0);
      const kmTotales     = tire.kilometrosRecorridos ?? 0;
      const costoTotal    = tire.costos.reduce((s, c) => s + c.valor, 0);
      const costoInicial  = tire.costos.at(0)?.valor ?? 0;

      const cpkData = tire.inspecciones
        .map(i => i.cpk).filter((v): v is number => v != null && v > 0);
      const cpkAvg  = cpkData.length
        ? cpkData.reduce((a, b) => a + b, 0) / cpkData.length : null;

      let motivoFin: MotivoFinVida | null = null;
      if (vidaActual === VidaValue.fin)        motivoFin = MotivoFinVida.desgaste;
      else if (vidaActual !== VidaValue.nueva) motivoFin = MotivoFinVida.reencauche;

      await prisma.tireVidaSnapshot.create({
        data: {
          tireId:            tire.id,
          companyId:         tire.companyId,
          vida:              vidaActual,
          marca:             tire.marca,
          diseno:            tire.diseno,
          dimension:         tire.dimension,
          eje:               tire.eje,
          posicion:          tire.posicion ?? null,
          costoInicial,
          costoTotal,
          fechaInicio,
          fechaFin,
          diasTotales,
          mesesTotales,
          profundidadInicial: profInicial,
          profundidadFinal:   profFinal,
          mmDesgastados,
          mmDesgastadosPorMes:    mesesTotales > 0 ? mmDesgastados / mesesTotales : null,
          mmDesgastadosPor1000km: kmTotales    > 0 ? (mmDesgastados / kmTotales) * 1000 : null,
          profundidadIntFinal: lastInsp?.profundidadInt ?? null,
          profundidadCenFinal: lastInsp?.profundidadCen ?? null,
          profundidadExtFinal: lastInsp?.profundidadExt ?? null,
          desgasteIrregular: lastInsp ? Math.max(
            Math.abs(lastInsp.profundidadInt - lastInsp.profundidadCen),
            Math.abs(lastInsp.profundidadCen - lastInsp.profundidadExt),
            Math.abs(lastInsp.profundidadInt - lastInsp.profundidadExt),
          ) > 3 : false,
          kmTotales,
          kmProyectadoFinal:  lastInsp?.kmProyectado  ?? null,
          cpkFinal:           lastInsp?.cpk            ?? null,
          cptFinal:           lastInsp?.cpt            ?? null,
          cpkProyectadoFinal: lastInsp?.cpkProyectado  ?? null,
          cptProyectadoFinal: lastInsp?.cptProyectado  ?? null,
          cpkAvg,
          cpkMin: cpkData.length ? Math.min(...cpkData) : null,
          cpkMax: cpkData.length ? Math.max(...cpkData) : null,
          totalInspecciones: tire.inspecciones.length,
          firstInspeccionId: firstInsp?.id  ?? null,
          lastInspeccionId:  lastInsp?.id   ?? null,
          motivoFin,
          dataSource: 'backfill',
        },
      });

      created++;
      if (created % 50 === 0) console.log(`  ${created} snapshots created...`);

    } catch (e: any) {
      failed++;
      console.error(`  FAILED tire ${tire.id}: ${e.message}`);
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}, Failed: ${failed}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());