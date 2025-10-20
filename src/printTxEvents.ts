import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('mainnet');
const DIGEST = process.argv[2];

if (!DIGEST) {
  console.error('Usage: ts-node src/printTxEvents.ts <txDigest>');
  process.exit(1);
}

(async () => {
  const client = new SuiClient({ url: RPC_URL });
  const tx = await client.getTransactionBlock({
    digest: DIGEST,
    options: { showEvents: true },
  });

  console.log(`Event types for ${DIGEST}:`);
  for (const e of tx.events ?? []) {
    console.log(' -', e.type);
  }
})();
