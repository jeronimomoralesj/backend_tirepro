/**
 * Seed script: loads master.xlsx into the tire_master_catalog table.
 *
 * Usage:  npx tsx scripts/seed-catalog.ts
 */
import { PrismaClient, EjeType } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as path from 'path';

const prisma = new PrismaClient();

const EJE_MAP: Record<string, EjeType> = {
  direccion: EjeType.direccion,
  traccion:  EjeType.traccion,
  libre:     EjeType.libre,
  remolque:  EjeType.remolque,
};

async function main() {
  const file = path.resolve(__dirname, '../../master.xlsx');
  console.log(`Reading ${file}…`);

  const wb = XLSX.readFile(file);
  const ws = wb.Sheets['Base de Datos Maestra'];
  const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Row 0 is the header mapping (column labels)
  const headerRow = raw[0];
  const dataRows  = raw.slice(1);

  // Map the ugly __EMPTY_N keys to our field names using the header row
  const KEY = Object.keys(headerRow);

  console.log(`Found ${dataRows.length} SKUs to import.`);

  let imported = 0;
  let skipped  = 0;

  // Process in batches of 100
  const BATCH = 100;
  for (let i = 0; i < dataRows.length; i += BATCH) {
    const batch = dataRows.slice(i, i + BATCH);

    const records = batch
      .map((row) => {
        // Column mapping (verified from xlsx header row):
        // 0=Marca 1=Modelo 2=Dimensión 3=Ancho 4=Perfil 5=Rin 6=Pos
        // 7=Eje 8=Terreno 9=%Pav 10=%Dest 11=RTD 12=IdxCarga 13=Vel
        // 14=PSI 15=Peso 16=KmReales 17=KmFabrica 18=Reenc 19=VidasReenc
        // 20=Precio 21=Segmento 22=Notas 23=Tipo 24=Constr 25=SKU 26=Fuente 27=URL
        const marca     = String(row[KEY[0]] ?? '').trim();
        const modelo    = String(row[KEY[1]] ?? '').trim();
        const dimension = String(row[KEY[2]] ?? '').trim();
        const skuRef    = String(row[KEY[25]] ?? '').trim();

        if (!marca || !modelo || !dimension || !skuRef) return null;

        const anchoRaw    = row[KEY[3]];
        const perfilRaw   = row[KEY[4]];
        const rinRaw      = row[KEY[5]];
        const posicion    = String(row[KEY[6]] ?? '').trim() || null;
        const ejeRaw      = String(row[KEY[7]] ?? '').trim().toLowerCase();
        const terreno     = String(row[KEY[8]] ?? '').trim() || null;
        const pctPav      = Number(row[KEY[9]]) || 100;
        const pctDest     = Number(row[KEY[10]]) || 0;
        const rtd         = Number(row[KEY[11]]) || null;
        const indiceCarga = String(row[KEY[12]] ?? '').trim() || null;
        const vel         = String(row[KEY[13]] ?? '').trim() || null;
        const psi         = Number(row[KEY[14]]) || null;
        const peso        = Number(row[KEY[15]]) || null;
        const kmReales    = Number(row[KEY[16]]) || null;
        const kmFabrica   = Number(row[KEY[17]]) || null;
        const reencRaw    = String(row[KEY[18]] ?? '').trim().toLowerCase();
        const vidasReenc  = Number(row[KEY[19]]) || 0;
        const precio      = Number(row[KEY[20]]) || null;
        const segmento    = String(row[KEY[21]] ?? '').trim() || null;
        const notas       = String(row[KEY[22]] ?? '').trim() || null;
        const tipo        = String(row[KEY[23]] ?? '').trim() || null;
        const constr      = String(row[KEY[24]] ?? '').trim() || null;
        const fuente      = String(row[KEY[26]] ?? '').trim() || null;
        const url         = String(row[KEY[27]] ?? '').trim() || null;

        const cpkEstimado = (precio && kmReales && kmReales > 0)
          ? Math.round((precio / kmReales) * 100) / 100
          : null;

        return {
          marca,
          modelo,
          dimension,
          skuRef,
          anchoMm:             anchoRaw ? Number(anchoRaw) || null : null,
          perfil:              perfilRaw ? String(perfilRaw) : null,
          rin:                 rinRaw ? String(rinRaw) : null,
          posicion,
          ejeTirePro:          EJE_MAP[ejeRaw] ?? null,
          terreno,
          pctPavimento:        pctPav,
          pctDestapado:        pctDest,
          rtdMm:               rtd,
          indiceCarga,
          indiceVelocidad:     vel,
          psiRecomendado:      psi,
          pesoKg:              peso,
          kmEstimadosReales:   kmReales,
          kmEstimadosFabrica:  kmFabrica,
          reencauchable:       reencRaw === 'si' || reencRaw === 'yes',
          vidasReencauche:     vidasReenc,
          precioCop:           precio,
          cpkEstimado,
          segmento,
          tipo,
          construccion:        constr,
          notasColombia:       notas,
          fuente,
          url,
        };
      })
      .filter(Boolean) as any[];

    if (!records.length) continue;

    // Upsert by skuRef
    await Promise.all(
      records.map((r) =>
        prisma.tireMasterCatalog.upsert({
          where:  { skuRef: r.skuRef },
          update: r,
          create: r,
        }),
      ),
    );

    imported += records.length;
    skipped  += batch.length - records.length;
    process.stdout.write(`\r  Imported ${imported} / ${dataRows.length}…`);
  }

  console.log(`\n✅ Done. Imported: ${imported}, Skipped: ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
