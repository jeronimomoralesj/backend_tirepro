/**
 * Delete every client of a given distribuidor and all of their data.
 *
 * The distribuidor itself is NOT deleted — only its linked client companies
 * (fleets) and everything those companies own.
 *
 * Per client company we delete (or null-out, where FKs require it):
 *   - DistributorAccess rows (client ↔ distribuidor link)
 *   - PurchaseOrders (as company OR as distributor)
 *   - BidRequests (as company OR winner) — cascades invitations & responses
 *   - BidInvitations / BidResponses where the client acted as distributor
 *   - DistributorListings (cascades reviews) and their MarketplaceOrders
 *   - MarketplaceOrders where the client acted as distributor
 *   - Per-user: DistributorReview rows, and null-out MarketplaceOrder.userId,
 *     Message.authorId, Inspeccion.inspeccionadoPorId
 *   - Then the Company row — cascades:
 *     User, Vehicle, Tire, Notification, CompanySnapshot, TireVidaSnapshot,
 *     TireRecommendation, TireInventoryBucket, and everything downstream of
 *     those (Inspeccion, TireEvento, TireCosto, Extra, UserVehicleAccess,
 *     VehicleInspection, VehicleDriver, Income, ...).
 *
 * Usage:
 *   npx tsx scripts/delete-distribuidor-clients.ts "Merquellantas"            # dry-run
 *   npx tsx scripts/delete-distribuidor-clients.ts "Merquellantas" --confirm  # actually delete
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const nameArg = args.find((a) => !a.startsWith('--'));

  if (!nameArg) {
    console.error('Usage: npx tsx scripts/delete-distribuidor-clients.ts "<Distribuidor Name>" [--confirm]');
    process.exit(1);
  }

  console.log(`\nMode: ${confirm ? 'LIVE (will delete)' : 'DRY-RUN (no changes)'}`);
  console.log(`Distribuidor: "${nameArg}"\n`);

  const distribuidor = await prisma.company.findFirst({
    where: { name: nameArg, plan: 'distribuidor' },
    select: { id: true, name: true },
  });

  if (!distribuidor) {
    console.error(`No distribuidor found with name "${nameArg}" and plan = distribuidor.`);
    process.exit(1);
  }

  console.log(`Found distribuidor: ${distribuidor.name} (${distribuidor.id})`);

  const accesses = await prisma.distributorAccess.findMany({
    where: { distributorId: distribuidor.id },
    select: { companyId: true },
  });
  const clientIds = accesses.map((a) => a.companyId);

  if (clientIds.length === 0) {
    console.log('This distribuidor has no clients. Nothing to do.');
    return;
  }

  const clients = await prisma.company.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, name: true, plan: true },
  });

  console.log(`\nClients to delete (${clients.length}):`);
  for (const c of clients) {
    console.log(`  - ${c.name}  (${c.id})  plan=${c.plan}`);
  }

  const userIdsForImpact = (
    await prisma.user.findMany({
      where: { companyId: { in: clientIds } },
      select: { id: true },
    })
  ).map((u) => u.id);

  const [
    userCount,
    vehicleCount,
    tireCount,
    inspCount,
    notifCount,
    vidaSnapCount,
    recoCount,
    bucketCount,
    snapshotCount,
    orderCount,
    bidReqCount,
    listingCount,
    marketOrderCount,
  ] = await Promise.all([
    prisma.user.count({ where: { companyId: { in: clientIds } } }),
    prisma.vehicle.count({ where: { companyId: { in: clientIds } } }),
    prisma.tire.count({ where: { companyId: { in: clientIds } } }),
    prisma.inspeccion.count({ where: { tire: { companyId: { in: clientIds } } } }),
    prisma.notification.count({ where: { companyId: { in: clientIds } } }),
    prisma.tireVidaSnapshot.count({ where: { companyId: { in: clientIds } } }),
    prisma.tireRecommendation.count({ where: { companyId: { in: clientIds } } }),
    prisma.tireInventoryBucket.count({ where: { companyId: { in: clientIds } } }),
    prisma.companySnapshot.count({ where: { companyId: { in: clientIds } } }),
    prisma.purchaseOrder.count({
      where: { OR: [{ companyId: { in: clientIds } }, { distributorId: { in: clientIds } }] },
    }),
    prisma.bidRequest.count({
      where: { OR: [{ companyId: { in: clientIds } }, { winnerId: { in: clientIds } }] },
    }),
    prisma.distributorListing.count({ where: { distributorId: { in: clientIds } } }),
    prisma.marketplaceOrder.count({
      where: {
        OR: [
          { distributorId: { in: clientIds } },
          ...(userIdsForImpact.length > 0 ? [{ userId: { in: userIdsForImpact } }] : []),
        ],
      },
    }),
  ]);

  console.log('\nImpact summary (rows that will be removed or nulled):');
  console.log(`  Users ........................ ${userCount}`);
  console.log(`  Vehicles ..................... ${vehicleCount}`);
  console.log(`  Tires ........................ ${tireCount}`);
  console.log(`  Inspecciones ................. ${inspCount}`);
  console.log(`  Notifications ................ ${notifCount}`);
  console.log(`  TireVidaSnapshots ............ ${vidaSnapCount}`);
  console.log(`  TireRecommendations .......... ${recoCount}`);
  console.log(`  TireInventoryBuckets ......... ${bucketCount}`);
  console.log(`  CompanySnapshots ............. ${snapshotCount}`);
  console.log(`  PurchaseOrders ............... ${orderCount}`);
  console.log(`  BidRequests (+cascade) ....... ${bidReqCount}`);
  console.log(`  DistributorListings .......... ${listingCount}`);
  console.log(`  MarketplaceOrders ............ ${marketOrderCount}`);

  if (!confirm) {
    console.log('\nDry-run only. Re-run with --confirm to actually delete.\n');
    return;
  }

  console.log('\nProceeding with deletion in 5 seconds… (Ctrl+C to abort)');
  await new Promise((r) => setTimeout(r, 5000));

  await prisma.$transaction(
    async (tx) => {
      for (const cid of clientIds) {
        console.log(`\nDeleting company ${cid} ...`);

        const userIds = (
          await tx.user.findMany({ where: { companyId: cid }, select: { id: true } })
        ).map((u) => u.id);

        if (userIds.length > 0) {
          await tx.message.updateMany({
            where: { authorId: { in: userIds } },
            data: { authorId: null },
          });
          await tx.marketplaceOrder.updateMany({
            where: { userId: { in: userIds } },
            data: { userId: null },
          });
          await tx.distributorReview.deleteMany({ where: { userId: { in: userIds } } });
          await tx.inspeccion.updateMany({
            where: { inspeccionadoPorId: { in: userIds } },
            data: { inspeccionadoPorId: null },
          });
        }

        await tx.distributorAccess.deleteMany({
          where: { OR: [{ companyId: cid }, { distributorId: cid }] },
        });
        await tx.purchaseOrder.deleteMany({
          where: { OR: [{ companyId: cid }, { distributorId: cid }] },
        });
        await tx.bidRequest.deleteMany({
          where: { OR: [{ companyId: cid }, { winnerId: cid }] },
        });
        await tx.bidInvitation.deleteMany({ where: { distributorId: cid } });
        await tx.bidResponse.deleteMany({ where: { distributorId: cid } });

        const listings = await tx.distributorListing.findMany({
          where: { distributorId: cid },
          select: { id: true },
        });
        if (listings.length > 0) {
          const listingIds = listings.map((l) => l.id);
          await tx.marketplaceOrder.deleteMany({ where: { listingId: { in: listingIds } } });
          await tx.distributorListing.deleteMany({ where: { distributorId: cid } });
        }
        await tx.marketplaceOrder.deleteMany({ where: { distributorId: cid } });

        await tx.company.delete({ where: { id: cid } });
        console.log(`  ✓ company ${cid} deleted (cascade handled the rest)`);
      }
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 },
  );

  console.log(`\n✅ Done. ${clientIds.length} client companies deleted from "${distribuidor.name}".\n`);
}

main()
  .catch((err) => {
    console.error('\n❌ Deletion failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
