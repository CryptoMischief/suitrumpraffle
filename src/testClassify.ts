import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const SUITRUMP = process.env.SUITRUMP_TYPE!;
const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('mainnet');
const DIGEST = process.argv[2];

(async () => {
  if (!DIGEST) {
    console.error('Usage: ts-node src/testClassify.ts <txDigest>');
    process.exit(1);
  }
  const client = new SuiClient({ url: RPC_URL });
  const tx = await client.getTransactionBlock({
    digest: DIGEST,
    options: { showBalanceChanges: true },
  });
  const changes = (tx.balanceChanges ?? []) as Array<any>;
  const sum = changes
    .filter((c) => c.coinType === SUITRUMP)
    .reduce((a, c) => a + Number(c.amount), 0);
  const verdict = sum > 0 ? 'BUY ✅' : sum < 0 ? 'SELL ❌' : 'NO CHANGE';
  console.log('SUITRUMP delta:', sum, verdict);
})();
