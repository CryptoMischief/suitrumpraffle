// src/buysWatcher.ts
import { SuiClient, getFullnodeUrl, type SuiEventFilter } from '@mysten/sui/client';

export type DexEntry = {
  name: string;
  eventType?: string;
  filterKind?: 'event' | 'module' | 'moveFunction';
  functionFilter?: { package: string; module: string; function: string };
};
export type Cursor = { txDigest: string; eventSeq: string } | string | null;

export interface CursorStore {
  get(dex: string): Promise<Cursor>;
  set(dex: string, cursor: Cursor): Promise<void>;
  seen(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
}

export interface Sink {
  notifyBuy(p: {
    dex: string; txDigest: string; amount?: string; symbol?: string; approxUsd?: number; link?: string;
  }): Promise<void>;
}

type EventFilter = Extract<
  SuiEventFilter,
  { MoveEventType: string } | { MoveModule: { package: string; module: string } }
>;

const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);

export class BuysWatcher {
  private client: SuiClient;
  private SUITRUMP_TYPE: string;
  private txCache = new Map<string, any>();

  constructor(
    private opts: {
      rpcUrl?: string;
      suitrumpType: string;
      dexes: DexEntry[];
      store: CursorStore;
      sink: Sink;
    }
  ) {
    this.client = new SuiClient({ url: this.opts.rpcUrl ?? getFullnodeUrl('mainnet') });
    this.SUITRUMP_TYPE = this.opts.suitrumpType;
  }

  async runOncePerDex() {
    for (const dex of this.opts.dexes) await this.processDex(dex);
  }

  private buildFilter(dex: DexEntry): EventFilter {
    const eventType = dex.eventType;
    if (!eventType) {
      throw new Error(`Missing eventType for dex ${dex.name}`);
    }

    if (dex.filterKind === 'module') {
      const m = eventType.match(/^(0x[0-9a-f]{64})::([A-Za-z0-9_]+)/i);
      if (!m) throw new Error(`Invalid module identifier for ${dex.name}: ${eventType}`);
      const [, pkg, module] = m;
      return { MoveModule: { package: pkg, module } };
    }

    // Prefer an exact MoveEventType match when the string looks well-formed
    if (/^(0x[0-9a-f]{64})::[A-Za-z0-9_]+::[A-Za-z0-9_]+(?:<.+>)?$/i.test(eventType)) {
      return { MoveEventType: eventType };
    }

    // Fall back to module-level filtering if we can still recover package/module info
    const m = eventType.match(/^(0x[0-9a-f]{64})::([A-Za-z0-9_]+)::/i);
    if (m) {
      const [, pkg, module] = m;
      return { MoveModule: { package: pkg, module } };
    }

    throw new Error(`Invalid eventType format: ${eventType}`);
  }

  private async processDex(dex: DexEntry) {
    if (dex.filterKind === 'moveFunction' && dex.functionFilter) {
      await this.processDexByFunction(dex);
      return;
    }
    if (!dex.eventType) {
      throw new Error(`Missing eventType for dex ${dex.name}`);
    }
    const pageLimit =
      dex.filterKind === 'module' ? Math.max(1, MAX_PAGES * 5) : MAX_PAGES;
    let pages = 0;
    const storedCursor = await this.opts.store.get(dex.name);
    let eventCursor =
      storedCursor && typeof storedCursor !== 'string'
        ? storedCursor
        : null;
    let hasNext = true;

    while (hasNext && pages < pageLimit) {
      const filter = this.buildFilter(dex);

      const res = await this.queryEventsWithRetry({
        query: filter,
        cursor: eventCursor ?? undefined,
        limit: 50,
        order: 'descending',
      });

      for (const ev of res.data) {
        const key = `${ev.id.txDigest}:${ev.id.eventSeq}`;
        if (await this.opts.store.seen(key)) continue;
        const typeStr = ev.type ?? '';
        const isSwapLike = /::Swap[A-Za-z_]*</i.test(typeStr);
        if (!isSwapLike) {
          await this.opts.store.markSeen(key);
          continue;
        }
        if (!typeStr.includes(this.SUITRUMP_TYPE)) {
          await this.opts.store.markSeen(key);
          continue;
        }

        const tx = await this.fetchTransaction(ev.id.txDigest);

        if (this.isSuitrumpBuyByNetDelta(tx)) {
          const amount = this.extractSuitrumpChange(tx)?.abs;
          await this.opts.sink.notifyBuy({
            dex: dex.name,
            txDigest: ev.id.txDigest,
            amount,
            symbol: 'SUITRUMP',
            link: `https://suiscan.xyz/mainnet/tx/${ev.id.txDigest}`,
          });
        }

        await this.opts.store.markSeen(key);
      }

      eventCursor = res.nextCursor ?? null;
      await this.opts.store.set(dex.name, eventCursor);
      hasNext = !!res.hasNextPage;
      pages += 1;
    }
  }

  private async processDexByFunction(dex: DexEntry) {
    const pageLimit = Math.max(1, MAX_PAGES * 5);
    let pages = 0;
    const filter = dex.functionFilter!;
    let cursor = await this.opts.store.get(dex.name);
    let cursorValue =
      typeof cursor === 'string'
        ? cursor
        : cursor && 'txDigest' in cursor
        ? cursor.txDigest
        : null;
    let hasNext = true;

    while (hasNext && pages < pageLimit) {
      const res = await this.client.queryTransactionBlocks({
        filter: { MoveFunction: filter },
        cursor: cursorValue ?? undefined,
        limit: 50,
        order: 'descending',
        options: { showInput: true },
      });

      for (const tx of res.data) {
        const digest = tx.digest;
        if (!digest) continue;
        const key = `${digest}:0`;
        if (await this.opts.store.seen(key)) continue;

        const typeArgs =
          tx.transaction?.data?.transaction?.kind === 'ProgrammableTransaction'
            ? tx.transaction.data.transaction.transactions
                .flatMap((item: any) =>
                  item.MoveCall?.type_arguments ?? []
                )
            : [];

        if (!typeArgs.includes(this.SUITRUMP_TYPE)) {
          await this.opts.store.markSeen(key);
          continue;
        }

        const fullTx = await this.fetchTransaction(digest);

        if (this.isSuitrumpBuyByNetDelta(fullTx)) {
          const amount = this.extractSuitrumpChange(fullTx)?.abs;
          await this.opts.sink.notifyBuy({
            dex: dex.name,
            txDigest: digest,
            amount,
            symbol: 'SUITRUMP',
            link: `https://suiscan.xyz/mainnet/tx/${digest}`,
          });
        }

        await this.opts.store.markSeen(key);
      }

      cursorValue = res.nextCursor ?? null;
      await this.opts.store.set(dex.name, cursorValue ?? null);
      hasNext = !!res.hasNextPage;
      pages += 1;
    }
  }

  private async fetchTransaction(digest: string) {
    if (this.txCache.has(digest)) return this.txCache.get(digest);
    const tx = await this.getTransactionWithRetry(digest);
    if (this.txCache.size > 500) this.txCache.clear();
    this.txCache.set(digest, tx);
    return tx;
  }

  private async getTransactionWithRetry(digest: string, attempt = 0): Promise<any> {
    try {
      return await this.client.getTransactionBlock({
        digest,
        options: { showEvents: true, showBalanceChanges: true, showEffects: true },
      });
    } catch (err) {
      if (this.isRateLimitError(err) && attempt < 5) {
        const delay = 200 * 2 ** attempt;
        await this.sleep(delay);
        return this.getTransactionWithRetry(digest, attempt + 1);
      }
      throw err;
    }
  }

  private async queryEventsWithRetry(args: Parameters<SuiClient['queryEvents']>[0], attempt = 0) {
    try {
      return await this.client.queryEvents(args);
    } catch (err) {
      if (this.isRateLimitError(err) && attempt < 5) {
        const delay = 200 * 2 ** attempt;
        await this.sleep(delay);
        return this.queryEventsWithRetry(args, attempt + 1);
      }
      throw err;
    }
  }

  private isRateLimitError(err: unknown): err is { status: number } {
    return typeof err === 'object' && err !== null && 'status' in err && (err as any).status === 429;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isSuitrumpBuyByNetDelta(tx: any): boolean {
    const changes = tx.balanceChanges as Array<{ coinType: string; amount: string }> | undefined;
    if (!changes) return false;
    return changes.some((c) => c.coinType === this.SUITRUMP_TYPE && Number(c.amount) > 0);
  }

  private extractSuitrumpChange(tx: any): { abs: string; sign: number } | null {
    const changes = tx.balanceChanges as Array<{ coinType: string; amount: string }> | undefined;
    if (!changes) return null;
    const sum = changes
      .filter((c) => c.coinType === this.SUITRUMP_TYPE)
      .reduce((acc, c) => acc + Number(c.amount), 0);
    if (sum === 0) return null;
    return { abs: Math.abs(sum).toString(), sign: Math.sign(sum) };
  }
}
