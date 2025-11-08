import axios from 'axios';
import dotenv from 'dotenv';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

import * as config from './config';
import * as index from './index';

dotenv.config();

const RPC_URL =
  process.env.RPC_URL ?? process.env.SUI_RPC_URL ?? getFullnodeUrl('mainnet');
const client = new SuiClient({ url: RPC_URL });

let eventMapCetus = new Map<string, any>();
let eventMapSettle = new Map<string, any>();
let eventMapBlueMove = new Map<string, any>();
let eventMapFlowX = new Map<string, any>();
let eventMapSuiRewardsMe = new Map<string, any>(); // Added: Map to track SuiRewardsMe events to avoid duplicates
let eventMapAftermath = new Map<string, any>(); // Added: Map to track Aftermath events to avoid duplicates
let eventMapSuiDex = new Map<string, any>(); // Track SuiDex pair swap events
let eventMapCetusRouter = new Map<string, any>();
let eventMapTurbos = new Map<string, any>();
const routerTxSeen = new Set<string>(); // Track SuiDex router multi-hop transactions
const DEBUG_SUIDEX = process.env.DEBUG_SUIDEX === "true";
let cachedMarketCap: number | null = null;
let cachedMarketCapExpiry = 0;
let coingeckoRetryUntil = 0;
let monitoringStartMs = 0;

const extractGenericTypes = (type: string): string[] => {
  const match = type.match(/<(.+)>$/);
  if (!match) return [];
  return match[1].split(',').map((part) => part.trim());
};

const normalizeCoinType = (type: string) =>
  type.startsWith("0x") ? type : `0x${type}`;

const NORMALIZED_TOKEN_TYPE = normalizeCoinType(
  config.TOKEN_ADDRESS
).toLowerCase();

const matchesTokenType = (type?: string | null) => {
  if (typeof type !== "string" || !type.length) return false;
  return normalizeCoinType(type).toLowerCase() === NORMALIZED_TOKEN_TYPE;
};

const isBeforeMonitoringStart = (timestampMs: string | number | undefined) => {
  if (!monitoringStartMs) return false;
  if (!timestampMs) return false;
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts < monitoringStartMs;
};

const resetEventMaps = () => {
  eventMapCetus = new Map();
  eventMapSettle = new Map();
  eventMapBlueMove = new Map();
  eventMapFlowX = new Map();
  eventMapSuiRewardsMe = new Map();
  eventMapAftermath = new Map();
  eventMapSuiDex = new Map();
  eventMapCetusRouter = new Map();
  eventMapTurbos = new Map();
  routerTxSeen.clear();
};

export const resetMonitoringSession = () => {
  monitoringStartMs = Date.now() - 30_000; // allow brief pre-start overlap
  resetEventMaps();
};

export const clearMonitoringSession = () => {
  monitoringStartMs = 0;
  resetEventMaps();
};

export let eventMonitorTimerId = null;

export const fetchTokenTradeTransactionsFlowX = async (chatId: string) => {
  let tokenTradeEvents = [];
  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_FLOWX,
      },
      limit: 100,
      order: "descending",
    });

    if (response && response.data && response.data.length === 0) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      const parsedEvent = event.parsedJson as any;
      if (matchesTokenType(parsedEvent?.coin_out?.name)) {
        const eventId = event.id;
        if (!eventId) continue;

        if (eventMapFlowX.get(JSON.stringify(event.id))) {
          continue;
        }

        eventMapFlowX.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    }

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_in.name)
      );
      const decimal_b = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_out.name)
      );
      const sender = tokenTradeEvents[i].parsedJson.swapper; // Use swapper instead of sender
      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "flowx"
      );
    }
  } catch (error) {
    console.error("Error fetching FlowX token trade transactions:", error);
  }
};

export const fetchTokenTradeTransactionsCetus = async (chatId: string) => {
  const tokenTradeEvents: any[] = [];

  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_CETUS,
      },
      limit: 100,
      order: "descending",
    });

    if (!response?.data?.length) return;

    const suitrumpLower = NORMALIZED_TOKEN_TYPE;
    const suiLower = normalizeCoinType(config.SUI_ADDRESS).toLowerCase();
    const suitrumpDecimals = await getTokenMetadata(NORMALIZED_TOKEN_TYPE);
    const suiDecimals = 9;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      if (!event?.id || eventMapCetus.get(JSON.stringify(event.id))) continue;

      const fullTx = await client.getTransactionBlock({
        digest: event.id.txDigest,
        options: { showBalanceChanges: true, showEvents: false },
      });

      if (isBeforeMonitoringStart(fullTx.timestampMs)) {
        eventMapCetus.set(JSON.stringify(event.id), event.id);
        continue;
      }

      const changes = fullTx.balanceChanges ?? [];
      let suitrumpDelta = BigInt(0);
      let suiDelta = BigInt(0);

      for (const change of changes) {
        const amount = BigInt(change.amount ?? 0);
        const coinType = (change.coinType ?? "").toLowerCase();
        if (coinType === suitrumpLower) {
          suitrumpDelta += amount;
        } else if (coinType === suiLower) {
          suiDelta += amount;
        }
      }

      if (suitrumpDelta <= BigInt(0)) {
        eventMapCetus.set(JSON.stringify(event.id), event.id);
        continue;
      }

      const suiSpent = suiDelta < BigInt(0) ? -suiDelta : BigInt(0);

      (event.parsedJson as any).__clmm = {
        suitrumpAmountRaw: suitrumpDelta.toString(),
        suiAmountRaw: suiSpent.toString(),
      };

      const sender = fullTx.transaction?.data?.sender ?? event.sender;

      tokenTradeEvents.push({ event, sender, suiDecimals, suitrumpDecimals });
      eventMapCetus.set(JSON.stringify(event.id), event.id);
    }

    for (const item of tokenTradeEvents) {
      await index.sendTransactionMessage(
        chatId,
        item.sender,
        item.event,
        item.suiDecimals,
        item.suitrumpDecimals,
        "cetus_clmm"
      );
    }
  } catch (error) {
    console.error("Error fetching token trade transactions:", error);
  }
};

export const fetchTokenTradeTransactionsCetusRouter = async (chatId: string) => {
  const routerEvents: any[] = [];

  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_CETUS_ROUTER,
      },
      limit: 100,
      order: 'descending',
    });

    if (!response?.data?.length) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      if (!event?.id || eventMapCetusRouter.get(JSON.stringify(event.id))) {
        continue;
      }

      const parsed = event.parsedJson as any;
      if (!parsed?.target?.name) continue;

      const targetType = normalizeCoinType(parsed.target.name).toLowerCase();
      if (targetType !== NORMALIZED_TOKEN_TYPE) {
        continue;
      }

      eventMapCetusRouter.set(JSON.stringify(event.id), event.id);
      routerEvents.push(event);
    }

    for (const event of routerEvents) {
      const parsed = event.parsedJson as any;
      const inputType = normalizeCoinType(parsed.from.name);
      const outputType = normalizeCoinType(parsed.target.name);

      const decimal_a = await getTokenMetadata(inputType);
      const decimal_b = await getTokenMetadata(outputType);

      await index.sendTransactionMessage(
        chatId,
        event.sender,
        event,
        decimal_a,
        decimal_b,
        'cetus_router'
      );
    }
  } catch (error) {
    console.error('Error fetching Cetus router swap events:', error);
  }
};

export const fetchTokenTradeTransactionsTurbos = async (chatId: string) => {
  const turbosEvents: any[] = [];

  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_TURBOS,
      },
      limit: 100,
      order: 'descending',
    });

    if (!response?.data?.length) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      if (!event?.id || eventMapTurbos.get(JSON.stringify(event.id))) {
        continue;
      }

      const parsed = event.parsedJson as any;
      if (!parsed) continue;

      const tokenXOut = normalizeCoinType(parsed.token_x_out ?? '');
      const tokenYOut = normalizeCoinType(parsed.token_y_out ?? '');
      const tokenXIn = normalizeCoinType(parsed.token_x_in ?? '');
      const tokenYIn = normalizeCoinType(parsed.token_y_in ?? '');

      const suitrumpLower = NORMALIZED_TOKEN_TYPE;

      let inputType = '';
      let outputType = '';
      let inputAmountRaw = BigInt(0);
      let outputAmountRaw = BigInt(0);

      if (tokenYOut.toLowerCase() === suitrumpLower) {
        outputAmountRaw = BigInt(parsed.amount_y_out ?? 0);
        inputAmountRaw = BigInt(parsed.amount_x_in ?? 0);
        inputType = tokenXIn;
        outputType = tokenYOut;
      } else if (tokenXOut.toLowerCase() === suitrumpLower) {
        outputAmountRaw = BigInt(parsed.amount_x_out ?? 0);
        inputAmountRaw = BigInt(parsed.amount_y_in ?? 0);
        inputType = tokenYIn;
        outputType = tokenXOut;
      } else {
        continue;
      }

      const suitrumpInRaw =
        (tokenXIn.toLowerCase() === suitrumpLower
          ? BigInt(parsed.amount_x_in ?? 0)
          : BigInt(0)) +
        (tokenYIn.toLowerCase() === suitrumpLower
          ? BigInt(parsed.amount_y_in ?? 0)
          : BigInt(0));
      const suitrumpOutRaw =
        (tokenXOut.toLowerCase() === suitrumpLower
          ? BigInt(parsed.amount_x_out ?? 0)
          : BigInt(0)) +
        (tokenYOut.toLowerCase() === suitrumpLower
          ? BigInt(parsed.amount_y_out ?? 0)
          : BigInt(0));

      if (suitrumpOutRaw <= suitrumpInRaw || outputAmountRaw === BigInt(0)) {
        continue;
      }

      eventMapTurbos.set(JSON.stringify(event.id), event.id);
      turbosEvents.push({ event, inputType, outputType, inputAmountRaw, outputAmountRaw });
    }

    for (const item of turbosEvents) {
      const { event, inputType, outputType, inputAmountRaw, outputAmountRaw } = item;

      const decimal_a = await getTokenMetadata(inputType);
      const decimal_b = await getTokenMetadata(outputType);

      event.parsedJson.__computed = {
        inputAmountRaw: inputAmountRaw.toString(),
        outputAmountRaw: outputAmountRaw.toString(),
        inputType,
        outputType,
      };

      await index.sendTransactionMessage(
        chatId,
        event.parsedJson?.user ?? event.sender,
        event,
        decimal_a,
        decimal_b,
        'turbos'
      );
    }
  } catch (error) {
    console.error('Error fetching Turbos swap events:', error);
  }
};

export const fetchTokenTradeTransactionsSettle = async (chatId: string) => {
  let tokenTradeEvents = [];
  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_SETTLE,
      },
      limit: 100,
      order: "descending", // Fetch latest transactions first
    });

    if (response && response.data && response.data.length === 0) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      const parsedEvent = event.parsedJson as any;
      if (matchesTokenType(parsedEvent?.coin_out?.name)) {
        const eventId = event.id;
        if (!eventId) continue;

        if (eventMapSettle.get(JSON.stringify(event.id))) {
          continue;
        }
        eventMapSettle.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    }

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_in.name)
      );
      const decimal_b = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_out.name)
      );
      const sender = tokenTradeEvents[i].parsedJson.sender;

      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "settle"
      );
    }
  } catch (error) {
    console.error("Error fetching token trade transactions:", error);
  }
};

export const fetchTokenTradeTransactionsBlueMove = async (chatId: string) => {
  let tokenTradeEvents = [];

  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_BLUEMOVE,
      },
      limit: 100,
      order: "descending", // Fetch latest transactions first
    });

    if (response && response.data && response.data.length === 0) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      const parsedEvent = event.parsedJson as any;
      if (
        (matchesTokenType(parsedEvent?.coin_a?.name) && !parsedEvent?.a2b) ||
        (matchesTokenType(parsedEvent?.coin_b?.name) && parsedEvent?.a2b)
      ) {
        const eventId = event.id;
        if (!eventId) continue;

        if (eventMapBlueMove.get(JSON.stringify(event.id))) {
          continue;
        }

        eventMapBlueMove.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    }

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_a.name)
      );
      const decimal_b = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.coin_b.name)
      );
      const sender = tokenTradeEvents[i].sender;
      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "bluemove"
      );
    }
  } catch (error) {
    console.error("Error fetching token trade transactions:", error);
  }
};

// Added: Function to fetch and process SuiRewardsMe swap events
export const fetchTokenTradeTransactionsSuiRewardsMe = async (chatId: string) => {
  let tokenTradeEvents = [];
  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_SUIREWARDSME, // Added: Query SuiRewardsMe events
      },
      limit: 100,
      order: "descending", // Added: Fetch latest transactions first
    });

    if (response && response.data && response.data.length === 0) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      const parsedEvent = event.parsedJson as any;
      if (matchesTokenType(parsedEvent?.tokenout?.name)) {
        const eventId = event.id;
        if (!eventId) continue;

        if (eventMapSuiRewardsMe.get(JSON.stringify(event.id))) {
          continue;
        }
        eventMapSuiRewardsMe.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    }

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.tokenin.name) // Added: Use tokenin.name for input token metadata
      );
      const decimal_b = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.tokenout.name) // Added: Use tokenout.name for output token metadata
      );
      const sender = tokenTradeEvents[i].parsedJson.wallet || tokenTradeEvents[i].sender; // Added: Use wallet as sender, fallback to event.sender

      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "suirewardsme" // Added: Pass suirewardsme flag to sendTransactionMessage
      );
    }
  } catch (error) {
    console.error("Error fetching SuiRewardsMe token trade transactions:", error);
  }
};

// Added: Function to fetch and process Aftermath swap events
export const fetchTokenTradeTransactionsAftermath = async (chatId: string) => {
  let tokenTradeEvents = [];
  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_AFTERMATH,
      },
      limit: 100,
      order: "descending",
    });

    if (response && response.data && response.data.length === 0) return;

    for (const event of response.data) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      const parsedEvent = event.parsedJson as any;
      if (matchesTokenType(parsedEvent?.type_out?.trim())) {
        const eventId = event.id;
        if (!eventId) continue;

        if (eventMapAftermath.get(JSON.stringify(event.id))) {
          continue;
        }
        eventMapAftermath.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    }

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.type_in) // Modified: Ensure type_in is prefixed correctly
      );
      const decimal_b = await getTokenMetadata(
        normalizeCoinType(tokenTradeEvents[i].parsedJson.type_out) // Modified: Ensure type_out is prefixed correctly
      );
      const sender = tokenTradeEvents[i].parsedJson.swapper; // Modified: Ensure swapper is used as sender
      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "aftermath"
      );
    }
  } catch (error) {
    console.error("Error fetching Aftermath token trade transactions:", error);
  }
};

export const fetchTokenTradeTransactionsSuiDex = async (chatId: string) => {
  const processPairEvents = async (events: any[]) => {
    const tokenTradeEvents: any[] = [];

    for (const event of events) {
      if (isBeforeMonitoringStart(event.timestampMs)) continue;
      if (!event?.id || eventMapSuiDex.get(JSON.stringify(event.id))) {
        continue;
      }

      const parsedEvent = event.parsedJson as any;
      if (!parsedEvent) continue;

      const typeLower = (event.type ?? "").toLowerCase();
      if (!typeLower.includes("::pair::swap<")) continue;
      if (!typeLower.includes(NORMALIZED_TOKEN_TYPE)) continue;

      const amountOut = BigInt(parsedEvent.amount1_out ?? 0);
      const amountIn = BigInt(parsedEvent.amount1_in ?? 0);
      if (amountOut <= amountIn) continue;

      eventMapSuiDex.set(JSON.stringify(event.id), event.id);
      if (DEBUG_SUIDEX) {
        console.log(
          `[suidex] direct swap detected: ${event.id.txDigest} amountOut=${parsedEvent.amount1_out}`
        );
      }
      tokenTradeEvents.push(event);
    }

    for (const event of tokenTradeEvents) {
      const [coinAType, coinBType] = extractGenericTypes(event.type);
      if (!coinAType || !coinBType) continue;

      const decimal_a = await getTokenMetadata(coinAType);
      const decimal_b = await getTokenMetadata(coinBType);
      const sender = (event.parsedJson as any)?.sender;

      await index.sendTransactionMessage(
        chatId,
        sender,
        event,
        decimal_a,
        decimal_b,
        "suidex"
      );
    }
  };

  try {
    const pairEventTypes = [
      config.MOVE_EVENT_TYPE_SUIDEX_PAIR_SWAP,
      config.MOVE_EVENT_TYPE_SUIDEX_PAIR_SWAP_USDC,
    ].filter(Boolean);

    for (const eventType of pairEventTypes) {
      const response = await client.queryEvents({
        query: {
          MoveEventType: eventType as string,
        },
        limit: 100,
        order: "descending",
      });

      if (response?.data?.length) {
        await processPairEvents(response.data);
      }
    }

    // Router multi-hop swaps that end in SUITRUMP
    const routerResponse = await client.queryTransactionBlocks({
      filter: {
        MoveFunction: {
          package: "0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a",
          module: "router",
          function: "swap_exact_token0_to_mid_then_mid_to_token1",
        },
      },
      limit: 20,
      order: "descending",
      options: { showInput: true },
    });

    for (const tx of routerResponse.data ?? []) {
      const digest = tx.digest;
      if (!digest || routerTxSeen.has(digest)) continue;
      if (isBeforeMonitoringStart(tx.timestampMs)) {
        routerTxSeen.add(digest);
        continue;
      }

      const typeArgs =
        tx.transaction?.data?.transaction?.kind === "ProgrammableTransaction"
          ? tx.transaction.data.transaction.transactions.flatMap(
              (item: any) => item.MoveCall?.type_arguments ?? []
            )
          : [];

      const hasSuitrumpLeg = typeArgs.some(
        (t: string) =>
          normalizeCoinType(t).toLowerCase() === NORMALIZED_TOKEN_TYPE
      );
      if (!hasSuitrumpLeg) {
        routerTxSeen.add(digest);
        continue;
      }

      const fullTx = await client.getTransactionBlock({
        digest,
        options: { showEvents: true },
      });

      if (isBeforeMonitoringStart(fullTx.timestampMs)) {
        routerTxSeen.add(digest);
        continue;
      }

      const swapEvent = (fullTx.events ?? []).find(
        (ev: any) =>
          ev.type?.includes("::pair::Swap<") &&
          ev.type?.toLowerCase().includes(NORMALIZED_TOKEN_TYPE)
      ) as any;
      if (!swapEvent) {
        routerTxSeen.add(digest);
        continue;
      }

      const [coinAType, coinBType] = extractGenericTypes(swapEvent.type);
      if (!coinAType || !coinBType) {
        routerTxSeen.add(digest);
        continue;
      }

      const decimal_a = await getTokenMetadata(coinAType);
      const decimal_b = await getTokenMetadata(coinBType);
      const sender =
        (swapEvent.parsedJson as any)?.sender ??
        fullTx.transaction?.data?.sender ??
        tx.transaction?.data?.sender;

      await index.sendTransactionMessage(
        chatId,
        sender,
        swapEvent,
        decimal_a,
        decimal_b,
        "suidex"
      );

      if (DEBUG_SUIDEX) {
        console.log(
          `[suidex] router hop detected: ${digest} amountOut=${swapEvent.parsedJson?.amount1_out}`
        );
      }

      routerTxSeen.add(digest);
    }
  } catch (error) {
    console.error("Error fetching SuiDex token trade transactions:", error);
  }
};

export const fetchSuiNsName = async (addr: string) => {
  try {
    const response = await client.resolveNameServiceNames({
      address: addr
    });

    if (response && response.data && response.data.length === 0) return addr;
    console.log("suins name = ", response.data[0]);
    const name = "@" + response.data[0].split(".")[0];
    return name;
    
  } catch (error) {
    console.error("Error fetching SuiNs name");
  }
};

export const fetchSuiNsAddress = async (label: string) => {
  label = label + ".sui";
  try {
    const response = await client.resolveNameServiceAddress({
      name: label
    });

    if (!response) return "";
    console.log("suins address = ", response);
    return response;
    
  } catch (error) {
    console.error("Error fetching token trade transactions:", error);
  }
};

export const getSuiPrice = async () => {
  try {
    const response = await axios.get(
      "https://api.coinbase.com/v2/prices/SUI-USD/spot"
    );
    const newSuiPrice = Number(response.data.data.amount);
    return newSuiPrice;
  } catch (err) {
    console.error("Error fetching SUI price:", err);
    return 0;
  }
};

export const getSuitrumpMarketCap = async () => {
  const now = Date.now();
  if (now < coingeckoRetryUntil) {
    return cachedMarketCap;
  }
  if (cachedMarketCap !== null && now < cachedMarketCapExpiry) {
    return cachedMarketCap;
  }

  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/coins/sui-trump',
      { timeout: 5000 }
    );
    const marketCap = response.data?.market_data?.market_cap?.usd ?? null;
    cachedMarketCap = marketCap;
    cachedMarketCapExpiry = Date.now() + 60_000;
    return marketCap;
  } catch (err) {
    const status = (err as any)?.response?.status;
    if (status === 429) {
      const retryHeader =
        (err as any)?.response?.headers?.['retry-after'] ??
        (err as any)?.response?.headers?.['Retry-After'] ??
        60;
      const retrySeconds = Number(retryHeader) || 60;
      coingeckoRetryUntil = Date.now() + retrySeconds * 1000;
    } else {
      console.warn("Error fetching SUITRUMP market cap:", err);
    }
    return cachedMarketCap;
  }
};

export const monitoringEvents = async (chatId: string) => {
  // console.log("monitoring...");

  try {
    await Promise.all([
      fetchTokenTradeTransactionsCetus(chatId),
      fetchTokenTradeTransactionsSettle(chatId),
      fetchTokenTradeTransactionsBlueMove(chatId),
      fetchTokenTradeTransactionsFlowX(chatId), // Add FlowX
      fetchTokenTradeTransactionsSuiRewardsMe(chatId), // Added: Include SuiRewardsMe event monitoring
      fetchTokenTradeTransactionsAftermath(chatId), // Added: Include Aftermath event monitoring
      fetchTokenTradeTransactionsSuiDex(chatId), // Added: Include SuiDex pair monitoring
      fetchTokenTradeTransactionsCetusRouter(chatId),
      fetchTokenTradeTransactionsTurbos(chatId),
    ]);
  } catch (err) {
    console.log("monitoringEvents err: ", err);
  }

  if (eventMonitorTimerId) {
    clearInterval(eventMonitorTimerId);
  }

  eventMonitorTimerId = setInterval(() => monitoringEvents(chatId), 13000);
};

export const getTokenMetadata = async (tokenAddress: string) => {
  try {
    const response = await client.getCoinMetadata({ coinType: tokenAddress });
    if (response) {
      return response.decimals;
    }
    return config.DEFAULT_TOKEN_DECIMALS;
  } catch (error) {
    console.error(error);
    return config.DEFAULT_TOKEN_DECIMALS;
  }
};
