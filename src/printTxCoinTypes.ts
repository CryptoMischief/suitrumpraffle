import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('mainnet');
const DIGEST = process.argv[2];

if (!DIGEST) {
  console.error('Usage: ts-node src/printTxCoinTypes.ts <txDigest>');
  process.exit(1);
}

(async () => {
  const client = new SuiClient({ url: RPC_URL });
  const tx = await client.getTransactionBlock({
    digest: DIGEST,
    options: { showBalanceChanges: true },
  });

  const set = new Set<string>();
  for (const c of tx.balanceChanges ?? []) {
    set.add((c as any).coinType);
  }
  console.log(`Coin types in balance changes for ${DIGEST}:`);
  for (const t of set) console.log(' -', t);
})();
