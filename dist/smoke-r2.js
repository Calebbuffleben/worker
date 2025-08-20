"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const r2_1 = require("./r2");
const env_1 = require("./env");
async function main() {
    console.log('R2 endpoint:', env_1.env.R2_ENDPOINT);
    try {
        const buckets = await (0, r2_1.listBuckets)();
        console.log('Buckets:', buckets.Buckets?.map(b => b.Name));
    }
    catch (e) {
        console.warn('ListBuckets not permitted for these credentials. Skipping bucket list.');
    }
    console.log('Listing objects on bucket:', env_1.env.R2_BUCKET, 'prefix: ""');
    const objs = await (0, r2_1.list)('');
    console.log('Objects KeyCount:', objs.KeyCount, 'IsTruncated:', objs.IsTruncated);
    console.log('Smoke OK');
}
main().catch((err) => {
    console.error('Smoke test failed:', err);
    process.exit(1);
});
