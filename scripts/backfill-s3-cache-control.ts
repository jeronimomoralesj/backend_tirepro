/**
 * Backfill `Cache-Control: public, max-age=31536000, immutable` on every
 * existing object in the tireproimages S3 bucket.
 *
 * New uploads carry the header automatically (see s3.service.ts), but
 * historical objects were stored without one — and Google Image / Merchant
 * Center treat the absence as "ephemeral", which can suppress the image
 * from Shopping results.
 *
 * Strategy: list all objects, then for each one issue a CopyObject from
 * the same key onto itself with `MetadataDirective: REPLACE`. CopyObject
 * keeps the bytes and ContentType but lets us inject a new Cache-Control.
 *
 * Run once. Safe to re-run — idempotent.
 *
 * Usage:
 *   npx ts-node scripts/backfill-s3-cache-control.ts            # all objects
 *   npx ts-node scripts/backfill-s3-cache-control.ts marketplace # only one prefix
 *
 * Requires: AWS_REGION, AWS_BUCKET_NAME (or S3_BUCKET_NAME), and standard
 * AWS credentials in the environment.
 */
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME ?? process.env.S3_BUCKET_NAME ?? 'tireproimages';
const PREFIX = process.argv[2] ?? '';
const TARGET_CACHE = 'public, max-age=31536000, immutable';

const s3 = new S3Client({ region: REGION });

async function main() {
  console.log(`Backfilling Cache-Control on s3://${BUCKET}/${PREFIX || '(root)'}`);
  let token: string | undefined = undefined;
  let total = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      total++;
      try {
        // Check current Cache-Control. Skip if already set correctly so
        // re-runs are cheap (CopyObject costs vs HeadObject is ~100x).
        const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        if (head.CacheControl === TARGET_CACHE) {
          skipped++;
          continue;
        }
        await s3.send(
          new CopyObjectCommand({
            Bucket: BUCKET,
            Key: obj.Key,
            CopySource: `/${BUCKET}/${encodeURIComponent(obj.Key)}`,
            CacheControl: TARGET_CACHE,
            ContentType: head.ContentType,
            MetadataDirective: 'REPLACE',
          }),
        );
        updated++;
        if (updated % 100 === 0) console.log(`  ${updated} updated · ${skipped} skipped · ${total} scanned`);
      } catch (err: any) {
        errors++;
        console.warn(`  ! ${obj.Key}: ${err.message ?? err}`);
      }
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  console.log(`Done. ${updated} updated, ${skipped} already-set, ${errors} errors, ${total} scanned.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
