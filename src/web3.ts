import axios from 'axios';
import dotenv from 'dotenv';

import { SuiClient } from '@mysten/sui/client';

import * as config from './config';
import * as index from './index';

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const client = new SuiClient({ url: RPC_URL });

let eventMapRouter = new Map<string, any>(); // rename from eventMapCetus for clarity
let eventMapSettle = new Map<string, any>();
let eventMapSuiRewardsMe = new Map<string, any>(); // Added: Map to track SuiRewardsMe events to avoid duplicates
let eventMapAftermath = new Map<string, any>(); // Added: Map to track Aftermath events to avoid duplicates
let eventMapBlueMove = new Map<string, any>(); // Added: Map to track BlueMove events to avoid duplicates

export let eventMonitorTimerId = null;

export const fetchRouterConfirmEvents = async (chatId: string) => {
  const tokenTradeEvents: any[] = [];

  try {
    // ✅ Query BOTH router event types so no Cetus or BlueMove buy is missed
    const [swapRes, confirmRes] = await Promise.all([
      client.queryEvents({
        query: { MoveEventType: config.MOVE_EVENT_TYPE_CETUS_ROUTER },
        limit: 100,
        order: "descending",
      }),
      client.queryEvents({
        query: { MoveEventType: config.MOVE_EVENT_TYPE_ROUTER_CONFIRM },
        limit: 100,
        order: "descending",
      }),
    ]);

    // Merge both responses and ensure there’s something to process
    let allEvents = [...(swapRes.data || []), ...(confirmRes.data || [])];
    if (allEvents.length === 0) return;

    // Pre-compute swap event IDs for quick lookup (no event mod needed)
    const swapEventIds = new Set(swapRes.data?.map((e: any) => e.id) || []);

    // Filter to only SUITRUMP-related swaps (robust: check multiple output fields, exact match)
    for (const event of allEvents) {
      const parsed = event.parsedJson as any;
      let tokenOut = parsed?.target?.name || parsed?.coin_out?.name || parsed?.coin_b?.name || parsed?.type_out || '';

      if (tokenOut !== config.TOKEN_ADDRESS) continue;  // ✅ Exact match (no includes—safer)

      const tx = event.id.txDigest;
      if (eventMapRouter.get(tx)) continue; // Skip duplicates
      eventMapRouter.set(tx, true);

      tokenTradeEvents.push(event);
    }

    // Process new detected events
    for (const event of tokenTradeEvents) {
      const decIn = await getTokenMetadata("0x" + (event.parsedJson.from?.name || event.parsedJson.coin_a?.name || event.parsedJson.coin_in?.name || ''));
      const decOut = await getTokenMetadata("0x" + config.TOKEN_ADDRESS);  // Output is always SUITRUMP
      const sender = event.parsedJson?.wallet || event.parsedJson?.swapper || event.sender;
      
      // ✅ Determine DEX without modifying event: check if in swapRes (Cetus), else parsed.dex or router
      let dex = 'router';
      if (swapEventIds.has(event.id)) {
        dex = 'cetus';
      } else {
        dex = event.parsedJson?.dex || 'router';
      }

      console.log(`[router - ${dex}] Detected swap on tx: ${event.id.txDigest}`);

      await index.sendTransactionMessage(
        chatId,
        sender,
        event,
        decIn,
        decOut,
        dex.toLowerCase()
      );
    }

  } catch (err) {
    if (String(err).includes("Could not find the referenced transaction events")) return;
    console.error("Error fetching router Swap/Confirm events:", err);
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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (parsedEvent?.coin_out?.name === config.TOKEN_ADDRESS) {
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapSettle.get(JSON.stringify(event.id))) {
          return;
        }
        eventMapSettle.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i <tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_in.name
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_out.name
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

export const fetchTokenTradeTransactionsBlueMove = async (chatId: string) => {  // Full BlueMove fetch
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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (
        (parsedEvent?.coin_a?.name === config.TOKEN_ADDRESS &&
          !parsedEvent?.a2b) ||
        (parsedEvent?.coin_b?.name === config.TOKEN_ADDRESS && parsedEvent?.a2b)
      ) {
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapBlueMove.get(JSON.stringify(event.id))) {
          return;
        }

        eventMapBlueMove.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_a.name
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_b.name
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
    console.error("Error fetching BlueMove token trade transactions:", error);
  }
};

export const fetchTokenTradeTransactionsSuiRewardsMe = async (chatId: string) => {
  let tokenTradeEvents = [];
  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_SUIREWARDSME,
      },
      limit: 100,
      order: "descending",
    });

    if (response && response.data && response.data.length === 0) return;

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (parsedEvent?.tokenout?.name === config.TOKEN_ADDRESS) {
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapSuiRewardsMe.get(JSON.stringify(event.id))) {
          return;
        }
        eventMapSuiRewardsMe.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.tokenin.name
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.tokenout.name
      );
      const sender = tokenTradeEvents[i].parsedJson.wallet || tokenTradeEvents[i].sender;

      await index.sendTransactionMessage(
        chatId,
        sender,
        tokenTradeEvents[i],
        decimal_a,
        decimal_b,
        "suirewardsme"
      );
    }
  } catch (error) {
    console.error("Error fetching SuiRewardsMe token trade transactions:", error);
  }
};

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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (parsedEvent?.type_out === config.TOKEN_ADDRESS) {
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapAftermath.get(JSON.stringify(event.id))) {
          return;
        }
        eventMapAftermath.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.type_in
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.type_out
      );
      const sender = tokenTradeEvents[i].parsedJson.swapper;
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
    return addr;
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
    console.error("Error fetching SuiNs address:", error);
    return "";
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
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/coins/sui-trump');
    const marketCap = response.data?.market_data?.market_cap?.usd || null;
    return marketCap;
  } catch (err) {
    console.error("Error fetching SUITRUMP market cap:", err);
    return null;
  }
};

export const monitoringEvents = async (chatId: string) => {
  try {
    await Promise.all([
      fetchRouterConfirmEvents(chatId),        // ✅ unified router watcher (now catches Cetus properly)
      fetchTokenTradeTransactionsSettle(chatId),
      fetchTokenTradeTransactionsSuiRewardsMe(chatId),
      fetchTokenTradeTransactionsAftermath(chatId),
      fetchTokenTradeTransactionsBlueMove(chatId),  // ✅ Added: BlueMove watcher
    ]);
  } catch (err) {
    console.log("monitoringEvents err: ", err);
  }

  if (eventMonitorTimerId) {
    clearInterval(eventMonitorTimerId);
  }

  eventMonitorTimerId = setInterval(() => monitoringEvents(chatId), 15000);
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
