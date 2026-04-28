import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== ADDITIONAL DIRTY PATTERNS ===\n');

  // Check for case variants (not UPPERCASE)
  const caseVariants = await prisma.$queryRaw`
    SELECT id, marca, diseno, dimension
    FROM "Tire"
    WHERE 
      (marca ~ '[a-z]' AND marca != 'LOWER(marca)')
      OR (diseno ~ '[a-z]' AND diseno != 'LOWER(diseno)')
    LIMIT 20
  `;
  
  console.log('Entries with lowercase letters:', caseVariants.length);
  console.table(caseVariants);

  // Count empty/NULL by field
  const nullCount = await prisma.$queryRaw`
    SELECT 
      SUM(CASE WHEN marca IS NULL OR marca = '' THEN 1 ELSE 0 END) as empty_marca,
      SUM(CASE WHEN diseno IS NULL OR diseno = '' THEN 1 ELSE 0 END) as empty_diseno,
      SUM(CASE WHEN dimension IS NULL OR dimension = '' THEN 1 ELSE 0 END) as empty_dimension,
      COUNT(*) as total
    FROM "Tire"
  `;
  console.log('\nEmpty/NULL count by field:');
  console.table(nullCount);

  // Sample brand/design combos from the import data
  console.log('\n=== SAMPLE BRAND/DESIGN COMBOS FROM TIRE TABLE ===\n');
  const combos = await prisma.$queryRaw`
    SELECT DISTINCT marca, diseno, dimension
    FROM "Tire"
    WHERE marca != '' AND diseno != ''
    LIMIT 10
  `;
  console.table(combos);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
