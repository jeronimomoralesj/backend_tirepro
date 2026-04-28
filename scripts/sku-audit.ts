import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== 1. TIRE TABLE STATISTICS ===\n');

  // Distinct (marca, diseno, dimension) triples
  const triples = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT (marca, diseno, dimension)) as distinct_skus
    FROM "Tire"
  `;
  console.log('Distinct (marca, diseno, dimension) triples:', triples);

  // Distinct marcas and disenos
  const brands = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT marca) as distinct_marcas,
           COUNT(DISTINCT diseno) as distinct_disenos
    FROM "Tire"
  `;
  console.log('Distinct counts:', brands);

  // Top 20 marcas
  const topMarcas = await prisma.$queryRaw`
    SELECT marca, COUNT(*) as count
    FROM "Tire"
    GROUP BY marca
    ORDER BY count DESC
    LIMIT 20
  `;
  console.log('\nTop 20 Marcas:');
  console.table(topMarcas);

  // Dirty entries
  const dirty = await prisma.$queryRaw`
    SELECT id, marca, diseno, dimension
    FROM "Tire"
    WHERE 
      marca = '' OR marca = 'N/A' OR marca = 'DESCONOCIDA' OR marca = 'n/a'
      OR diseno = '' OR diseno = 'N/A' OR diseno = 'DESCONOCIDA' OR diseno = 'n/a'
      OR dimension = '' OR dimension = 'N/A' OR dimension = 'DESCONOCIDA' OR dimension = 'n/a'
    LIMIT 30
  `;
  console.log('\n30 Suspicious/Dirty Entries:');
  console.table(dirty);

  console.log('\n=== 2. REFERENCE TABLES ===\n');

  // TireMasterCatalog row count
  const catalogCount = await prisma.tireMasterCatalog.count();
  console.log('TireMasterCatalog row count:', catalogCount);

  // BrandInfo row count
  const brandInfoCount = await prisma.brandInfo.count();
  console.log('BrandInfo row count:', brandInfoCount);

  // Sample TireMasterCatalog rows
  const catalogSample = await prisma.tireMasterCatalog.findMany({ take: 1 });
  console.log('\nTireMasterCatalog schema:');
  if (catalogSample.length > 0) {
    const fields = Object.keys(catalogSample[0]);
    console.log('Key fields:', fields.filter(f => ['marca', 'modelo', 'dimension', 'skuRef', 'precioCop', 'reencauchable'].includes(f)));
  }

  console.log('\n=== 3. TIRE-TO-CATALOG LINKING ===\n');

  // Get total tire count
  const tireCount = await prisma.tire.count();
  console.log('Total Tire records:', tireCount);

  // Check how many tires have marca/diseno/dimension
  const withIdentity = await prisma.$queryRaw`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN marca IS NOT NULL AND marca != '' THEN 1 ELSE 0 END) as with_marca,
           SUM(CASE WHEN diseno IS NOT NULL AND diseno != '' THEN 1 ELSE 0 END) as with_diseno,
           SUM(CASE WHEN dimension IS NOT NULL AND dimension != '' THEN 1 ELSE 0 END) as with_dimension
    FROM "Tire"
  `;
  console.log('Tire identity field coverage:', withIdentity);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
