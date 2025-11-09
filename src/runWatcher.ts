// src/runWatcher.ts
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { BuysWatcher, type Cursor, type CursorStore, type DexEntry, type Sink } from './buysWatcher';

const SUITRUMP_TYPE = process.env.SUITRUMP_TYPE;
const RPC_URL = process.env.SUI_RPC_URL; // optional; falls back to mainnet default inside BuysWatcher

// To fill real event types, run:
//   npm run tx:events <known_SUITRUMP_trade_tx_digest_on_this_venue>
// Then paste the printed "0x...::module::Struct" strings into eventType.
// TODO: Replace these placeholder event types with the ACTUAL package IDs + event struct names
// Use the helper we discussed (printTxEvents.ts) to discover the exact strings from real tx digests.
const DEXES: DexEntry[] = [
  // CETUS CLMM (pool swap)
  { name: 'cetus-clmm', eventType: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent' },

  // CETUS Router / Aggregator
  { name: 'cetus-router-swap',    eventType: '0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17::router::SwapEvent' },
  { name: 'cetus-router-confirm', eventType: '0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17::router::ConfirmSwapEvent' },

  // Asset-level routed swap (emits alongside routed paths)
  { name: 'asset-router',         eventType: '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::AssetSwap' },
  { name: 'cetus-lbp',            eventType: '0x5a5c1d10e4782dbbdec3eb8327ede04bd078b294b97cfdba447b11b846b383ac::lb_pair::SwapEvent' },
  { name: 'pool-25929e7f',        eventType: '0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d::pool::Swap' },

  // TURBOS (generic swap shows SUITRUMP leg in type params)
  { name: 'turbos-swap',          eventType: '0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Swap_Event<0x2::sui::SUI, 0xdeb831e796f16f8257681c0d5d4108fa94333060300b2459133a96631bf470b8::suitrump::SUITRUMP>' },
  { name: 'suidex-pair-swap',     eventType: '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a::pair::Swap<0x2::sui::SUI, 0xdeb831e796f16f8257681c0d5d4108fa94333060300b2459133a96631bf470b8::suitrump::SUITRUMP>' },
  { name: 'suidex-router-hop',    filterKind: 'moveFunction', functionFilter: { package: '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a', module: 'router', function: 'swap_exact_token0_to_mid_then_mid_to_token1' } },

  // AFTERMATH v2
  { name: 'aftermath-swap-v2',    eventType: '0xc4049b2d1cc0f6e017fda8260e4377cecd236bd7f56a54fee120816e72e2e0dd::events::SwapEventV2' },
  { name: 'aftermath-swap-done',  eventType: '0xd675e6d727bb2d63087cc12008bb91e399dc7570100f72051993ec10c0428f4a::events::SwapCompletedEventV2' },

  // “trade/*” router (flash-swap style legs observed)
  { name: 'trade-swap',           eventType: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent' },
  { name: 'trade-repay-flash',    eventType: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent' },

  // Extra pools/emitter packages seen in routed paths
  { name: 'pool-91bfbc38',        eventType: '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::SwapEvent' },
  { name: 'pool-e74104c6',        eventType: '0xe74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239::pool::SwapEvent' },

  // NEW from your latest digest:
  { name: 'pool-4a35d3df',        eventType: '0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d::pool::SwapEvent' },
  { name: 'settle-17c0b1f7',      eventType: '0x17c0b1f7a6ad73f51268f16b8c06c049eecc2f28a270cdd29c06e3d2dea23302::settle::Swap' },
];

// ---- Storage (Mongo-backed cursor + dedupe) ----
class MongoCursorStore implements CursorStore {
  private col; private seenCol;
  constructor(private db: any) {
    this.col = db.collection('dex_cursors');
    this.seenCol = db.collection('seen_events');
  }
  async get(dex: string) {
    const d = await this.col.findOne({ dex });
    return d?.cursor ?? null;
  }
  async set(dex: string, cursor: Cursor) {
    await this.col.updateOne({ dex }, { $set: { dex, cursor } }, { upsert: true });
  }
  async seen(key: string) {
    return !!(await this.seenCol.findOne({ key }));
  }
  async markSeen(key: string) {
    await this.seenCol.updateOne({ key }, { $set: { key, at: new Date() } }, { upsert: true });
  }
}

class MemoryStore implements CursorStore {
  private c = new Map<string, Cursor>();
  private seenSet = new Set<string>();
  async get(dex: string) {
    return this.c.get(dex) ?? null;
  }
  async set(dex: string, cursor: Cursor) {
    this.c.set(dex, cursor ?? null);
  }
  async seen(key: string) {
    return this.seenSet.has(key);
  }
  async markSeen(key: string) {
    this.seenSet.add(key);
  }
}

// ---- Output (replace with your Telegram sink when ready) ----
class ConsoleSink implements Sink {
  async notifyBuy(p: { dex: string; txDigest: string; amount?: string; symbol?: string }) {
    console.log(`🟢 ${p.dex} BUY ${p.symbol ?? ''} ${p.amount ?? ''} — ${p.txDigest}`);
  }
}

async function main() {
  if (!SUITRUMP_TYPE) {
    throw new Error('Missing SUITRUMP_TYPE in .env (format: 0x<package>::<module>::<STRUCT>)');
  }

  const useMemory = process.env.USE_MEMORY_STORE === 'true';

  let store: CursorStore;
  let mongo: MongoClient | null = null;
  let db: any = null;

  if (useMemory) {
    store = new MemoryStore();
  } else {
    if (!process.env.MONGO_URI) {
      throw new Error('Missing MONGO_URI in .env (or set USE_MEMORY_STORE=true to skip Mongo)');
    }
    mongo = await MongoClient.connect(process.env.MONGO_URI);
    db = mongo.db(process.env.MONGO_DB ?? 'monitorbot');
    store = new MongoCursorStore(db);
  }

  const watcher = new BuysWatcher({
    rpcUrl: RPC_URL,
    suitrumpType: SUITRUMP_TYPE,
    dexes: DEXES,
    store,
    sink: new ConsoleSink(),
  });

  try {
    await watcher.runOncePerDex();
  } finally {
    if (mongo) await mongo.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
