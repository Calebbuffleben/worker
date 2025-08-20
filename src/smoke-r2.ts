import { listBuckets, list } from './r2';
import { env } from './env';

async function main() {
  console.log('R2 endpoint:', env.R2_ENDPOINT);
  try {
    const buckets = await listBuckets();
    console.log('Buckets:', buckets.Buckets?.map(b => b.Name));
  } catch (e) {
    console.warn('ListBuckets not permitted for these credentials. Skipping bucket list.');
  }

  console.log('Listing objects on bucket:', env.R2_BUCKET, 'prefix: ""');
  const objs = await list('');
  console.log('Objects KeyCount:', objs.KeyCount, 'IsTruncated:', objs.IsTruncated);
  console.log('Smoke OK');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});


