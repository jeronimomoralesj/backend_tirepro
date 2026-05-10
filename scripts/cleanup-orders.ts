/**
 * Pre-launch order cleanup. Wipes ALL marketplace orders + their
 * payments, payouts, and surveys so the production marketplace starts
 * the launch with a clean order ledger.
 *
 * Scope (production-safe, dry-run by default):
 *   - order_surveys        (cascades from order anyway, deleted explicitly for clarity)
 *   - marketplace_orders
 *   - marketplace_payments (every Payment exists only to fund an Order;
 *                           with all orders gone, payments are orphans)
 *   - payouts              (same — only created against orders)
 *
 * Out of scope (NOT touched):
 *   - users, companies, distributors, listings, plates, catalog, brand info
 *   - bank accounts attached to distributors (these are configuration, not data)
 *
 * Usage:
 *   npx tsx scripts/cleanup-orders.ts              # dry-run, prints counts + sample
 *   npx tsx scripts/cleanup-orders.ts --confirm    # actually delete
 *
 * Safety:
 *   - Refuses to run without --confirm; default is dry-run.
 *   - Prints a sample of what would be deleted so the operator can spot
 *     anything that looks like a real (non-test) order before confirming.
 *   - Runs all deletes inside a transaction so a partial failure rolls
 *     back instead of leaving the DB in a half-cleaned state.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CONFIRM = process.argv.includes('--confirm');
const FORCE   = process.argv.includes('--force'); // skip the email-pattern sanity check

function maskEmail(e: string | null | undefined): string {
  if (!e) return '(none)';
  const [user, domain] = e.split('@');
  if (!domain) return e;
  const head = user.slice(0, 2);
  return `${head}***@${domain}`;
}

function fmtCOP(n: number | null | undefined): string {
  if (n == null) return '-';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' MARKETPLACE ORDER CLEANUP');
  console.log(`  Mode: ${CONFIRM ? '🔴 DELETE (--confirm passed)' : '🟢 DRY-RUN (default)'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Inventory ──────────────────────────────────────────────────────────────
  const [orderCount, paymentCount, payoutCount, surveyCount] = await Promise.all([
    prisma.marketplaceOrder.count(),
    prisma.payment.count(),
    prisma.payout.count(),
    prisma.orderSurvey.count(),
  ]);

  console.log('Current row counts:');
  console.log(`  marketplace_orders:   ${orderCount.toString().padStart(6)}`);
  console.log(`  marketplace_payments: ${paymentCount.toString().padStart(6)}`);
  console.log(`  payouts:              ${payoutCount.toString().padStart(6)}`);
  console.log(`  order_surveys:        ${surveyCount.toString().padStart(6)}`);
  console.log();

  if (orderCount === 0 && paymentCount === 0 && payoutCount === 0 && surveyCount === 0) {
    console.log('✅ Nothing to clean. All four tables are already empty.');
    return;
  }

  // ── Sample preview ─────────────────────────────────────────────────────────
  const sample = await prisma.marketplaceOrder.findMany({
    take: 25,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      buyerEmail: true,
      buyerName: true,
      status: true,
      paymentStatus: true,
      totalCop: true,
      createdAt: true,
      deliveryMode: true,
    },
  });

  console.log('Most-recent orders (sample, up to 25):');
  console.log(
    '  ' +
      ['id', 'createdAt', 'status', 'pmt', 'mode', 'total', 'buyer'].join(' · ').padEnd(80),
  );
  for (const o of sample) {
    console.log(
      `  ${o.id.slice(0, 8)} · ${o.createdAt.toISOString().slice(0, 16)} · ${(o.status ?? '-').padEnd(10)} · ${(o.paymentStatus ?? '-').padEnd(8)} · ${(o.deliveryMode ?? '-').padEnd(9)} · ${fmtCOP(o.totalCop).padEnd(12)} · ${maskEmail(o.buyerEmail)}`,
    );
  }
  console.log();

  // ── Sanity check — flag emails that don't look like throwaway test data ────
  const TEST_PATTERNS = [
    /@test\./i,
    /test@/i,
    /demo@/i,
    /example\./i,
    /@tirepro/i,
    /\+test/i,
    /qa@/i,
    /noreply/i,
  ];

  const suspicious = sample.filter(
    (o) => !TEST_PATTERNS.some((re) => re.test(o.buyerEmail ?? '')),
  );

  if (suspicious.length > 0 && !FORCE) {
    console.log('⚠️  Found orders with emails that DON\'T match common test patterns:');
    for (const o of suspicious.slice(0, 10)) {
      console.log(`     ${o.id.slice(0, 8)} · ${maskEmail(o.buyerEmail)} · ${o.createdAt.toISOString().slice(0, 10)} · ${fmtCOP(o.totalCop)}`);
    }
    console.log(
      `     ${suspicious.length} out of ${sample.length} sampled don't match obvious test patterns.\n`,
    );
    console.log(
      '     If these are all dummy/internal orders, re-run with --force to bypass this check.\n',
    );
  }

  if (!CONFIRM) {
    console.log('🟢 Dry-run complete. No data changed.');
    console.log('   Re-run with --confirm to delete all rows in those 4 tables.');
    console.log('   Re-run with --confirm --force if the sanity check above is a false alarm.');
    return;
  }

  if (suspicious.length > 0 && !FORCE) {
    console.log('🛑 Aborting: --confirm requires --force when non-test-looking emails exist.');
    process.exit(2);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  console.log('🔴 Deleting…');
  const result = await prisma.$transaction(async (tx) => {
    const surveys  = await tx.orderSurvey.deleteMany({});
    const orders   = await tx.marketplaceOrder.deleteMany({});
    const payments = await tx.payment.deleteMany({});
    const payouts  = await tx.payout.deleteMany({});
    return { surveys, orders, payments, payouts };
  });

  console.log(`  order_surveys:        ${result.surveys.count}`);
  console.log(`  marketplace_orders:   ${result.orders.count}`);
  console.log(`  marketplace_payments: ${result.payments.count}`);
  console.log(`  payouts:              ${result.payouts.count}`);
  console.log();

  const [afterO, afterP, afterPo, afterS] = await Promise.all([
    prisma.marketplaceOrder.count(),
    prisma.payment.count(),
    prisma.payout.count(),
    prisma.orderSurvey.count(),
  ]);
  console.log('After:');
  console.log(`  marketplace_orders:   ${afterO}`);
  console.log(`  marketplace_payments: ${afterP}`);
  console.log(`  payouts:              ${afterPo}`);
  console.log(`  order_surveys:        ${afterS}`);
  console.log();
  console.log('✅ Cleanup complete.');
}

main()
  .catch((err) => {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
