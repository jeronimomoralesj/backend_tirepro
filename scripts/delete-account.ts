/**
 * Delete a single user by email and (optionally) a single company by name.
 *
 * Same cleanup pattern as delete-distribuidor-clients.ts but scoped down
 * for the one-off "wipe a test account + its company" case. The company
 * delete cascades — User, Vehicle, Tire, Inspeccion, Notification,
 * TireVidaSnapshot, TireRecommendation, TireInventoryBucket, plus the
 * downstream rows (TireEvento, TireCosto, UserVehicleAccess, ...) all
 * disappear with it.
 *
 * Usage:
 *   # dry-run, just inspect
 *   npx tsx scripts/delete-account.ts \
 *     --email "moraljero1234567890@gmail.com" \
 *     --company "Jero comp"
 *
 *   # actually delete
 *   npx tsx scripts/delete-account.ts \
 *     --email "moraljero1234567890@gmail.com" \
 *     --company "Jero comp" \
 *     --confirm
 *
 *   # email only (user but no company)
 *   npx tsx scripts/delete-account.ts --email foo@example.com --confirm
 *
 *   # company only (every user inside it gets deleted by cascade)
 *   npx tsx scripts/delete-account.ts --company "Test Co" --confirm
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const email   = getFlag('email')?.toLowerCase().trim();
  const company = getFlag('company')?.trim();
  const confirm = process.argv.includes('--confirm');

  if (!email && !company) {
    console.error('Provide --email "<email>" and/or --company "<name>" (at least one).');
    process.exit(1);
  }

  console.log(`\nMode: ${confirm ? 'LIVE (will delete)' : 'DRY-RUN (no changes)'}`);
  if (email)   console.log(`User email   : ${email}`);
  if (company) console.log(`Company name : "${company}"`);
  console.log('');

  // --- Resolve targets ------------------------------------------------------

  const targetUser = email
    ? await prisma.user.findUnique({
        where:  { email },
        select: { id: true, name: true, email: true, companyId: true },
      })
    : null;

  if (email && !targetUser) {
    console.error(`No user found with email "${email}". Aborting.`);
    process.exit(1);
  }

  const targetCompany = company
    ? await prisma.company.findFirst({
        where:  { name: { equals: company, mode: 'insensitive' } },
        select: { id: true, name: true, plan: true },
      })
    : null;

  if (company && !targetCompany) {
    console.error(`No company found with name "${company}". Aborting.`);
    process.exit(1);
  }

  if (targetUser) {
    console.log(`Found user   : ${targetUser.name} <${targetUser.email}>  (${targetUser.id})  companyId=${targetUser.companyId ?? '—'}`);
  }
  if (targetCompany) {
    console.log(`Found company: ${targetCompany.name}  (${targetCompany.id})  plan=${targetCompany.plan}`);
  }

  // --- Impact summary -------------------------------------------------------

  if (targetCompany) {
    const cid = targetCompany.id;
    const [users, vehicles, tires, insp, notif, vidaSnaps, recos, buckets, snaps, orders, bidReqs, listings, marketOrders] = await Promise.all([
      prisma.user.count({ where: { companyId: cid } }),
      prisma.vehicle.count({ where: { companyId: cid } }),
      prisma.tire.count({ where: { companyId: cid } }),
      prisma.inspeccion.count({ where: { tire: { companyId: cid } } }),
      prisma.notification.count({ where: { companyId: cid } }),
      prisma.tireVidaSnapshot.count({ where: { companyId: cid } }),
      prisma.tireRecommendation.count({ where: { companyId: cid } }),
      prisma.tireInventoryBucket.count({ where: { companyId: cid } }),
      prisma.companySnapshot.count({ where: { companyId: cid } }),
      prisma.purchaseOrder.count({ where: { OR: [{ companyId: cid }, { distributorId: cid }] } }),
      prisma.bidRequest.count({    where: { OR: [{ companyId: cid }, { winnerId: cid }] } }),
      prisma.distributorListing.count({ where: { distributorId: cid } }),
      prisma.marketplaceOrder.count({ where: { distributorId: cid } }),
    ]);
    console.log('\nCompany cascade impact:');
    console.log(`  Users ................... ${users}`);
    console.log(`  Vehicles ................ ${vehicles}`);
    console.log(`  Tires ................... ${tires}`);
    console.log(`  Inspecciones ............ ${insp}`);
    console.log(`  Notifications ........... ${notif}`);
    console.log(`  TireVidaSnapshots ....... ${vidaSnaps}`);
    console.log(`  TireRecommendations ..... ${recos}`);
    console.log(`  TireInventoryBuckets .... ${buckets}`);
    console.log(`  CompanySnapshots ........ ${snaps}`);
    console.log(`  PurchaseOrders .......... ${orders}`);
    console.log(`  BidRequests (+cascade) .. ${bidReqs}`);
    console.log(`  DistributorListings ..... ${listings}`);
    console.log(`  MarketplaceOrders ....... ${marketOrders}`);
  }

  if (targetUser && !targetCompany) {
    // User-only path — fewer rows to count since the company isn't going away.
    const [insp, msgs, marketOrders, reviews, access] = await Promise.all([
      prisma.inspeccion.count({ where: { inspeccionadoPorId: targetUser.id } }),
      prisma.message.count({ where: { authorId: targetUser.id } }),
      prisma.marketplaceOrder.count({ where: { userId: targetUser.id } }),
      prisma.distributorReview.count({ where: { userId: targetUser.id } }),
      prisma.userVehicleAccess.count({ where: { userId: targetUser.id } }),
    ]);
    console.log('\nUser-only impact:');
    console.log(`  Inspecciones (will be nulled-out, NOT deleted) ... ${insp}`);
    console.log(`  Messages (authorId nulled) ........................ ${msgs}`);
    console.log(`  MarketplaceOrders (userId nulled) ................. ${marketOrders}`);
    console.log(`  DistributorReviews (deleted) ...................... ${reviews}`);
    console.log(`  UserVehicleAccess (deleted by cascade) ............ ${access}`);
  }

  if (!confirm) {
    console.log('\nDry-run only. Re-run with --confirm to actually delete.\n');
    return;
  }

  console.log('\nProceeding with deletion in 5 seconds… (Ctrl+C to abort)');
  await new Promise((r) => setTimeout(r, 5000));

  await prisma.$transaction(
    async (tx) => {
      // --- Company path first: nuking the company also nukes every user
      //     inside it (including targetUser, if their companyId matches).
      if (targetCompany) {
        const cid = targetCompany.id;
        const userIds = (
          await tx.user.findMany({ where: { companyId: cid }, select: { id: true } })
        ).map((u) => u.id);

        if (userIds.length > 0) {
          await tx.message.updateMany({
            where: { authorId: { in: userIds } },
            data:  { authorId: null },
          });
          await tx.marketplaceOrder.updateMany({
            where: { userId: { in: userIds } },
            data:  { userId: null },
          });
          await tx.distributorReview.deleteMany({ where: { userId: { in: userIds } } });
          await tx.inspeccion.updateMany({
            where: { inspeccionadoPorId: { in: userIds } },
            data:  { inspeccionadoPorId: null },
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
        await tx.bidResponse.deleteMany({  where: { distributorId: cid } });

        const listings = await tx.distributorListing.findMany({
          where:  { distributorId: cid },
          select: { id: true },
        });
        if (listings.length > 0) {
          const listingIds = listings.map((l) => l.id);
          await tx.marketplaceOrder.deleteMany({ where: { listingId:  { in: listingIds } } });
          await tx.distributorListing.deleteMany({ where: { distributorId: cid } });
        }
        await tx.marketplaceOrder.deleteMany({ where: { distributorId: cid } });

        await tx.company.delete({ where: { id: cid } });
        console.log(`  ✓ company "${targetCompany.name}" deleted`);
      }

      // --- User path — only runs when the user wasn't already wiped by the
      //     company cascade above.
      if (targetUser) {
        const stillThere = await tx.user.findUnique({ where: { id: targetUser.id }, select: { id: true } });
        if (!stillThere) {
          console.log(`  · user <${targetUser.email}> already removed via company cascade`);
        } else {
          await tx.message.updateMany({
            where: { authorId: targetUser.id },
            data:  { authorId: null },
          });
          await tx.marketplaceOrder.updateMany({
            where: { userId: targetUser.id },
            data:  { userId: null },
          });
          await tx.distributorReview.deleteMany({ where: { userId: targetUser.id } });
          await tx.inspeccion.updateMany({
            where: { inspeccionadoPorId: targetUser.id },
            data:  { inspeccionadoPorId: null },
          });
          await tx.user.delete({ where: { id: targetUser.id } });
          console.log(`  ✓ user <${targetUser.email}> deleted`);
        }
      }
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 },
  );

  console.log('\nDone.\n');
}

main()
  .catch((err) => {
    console.error('\nDeletion failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
