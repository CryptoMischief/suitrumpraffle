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

export let eventMonitorTimerId = null;

/*export const fetchTokenTradeTransactionsFlowX = async (chatId: string) => {
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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (parsedEvent?.coin_out?.name === config.TOKEN_ADDRESS) {
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapFlowX.get(JSON.stringify(event.id))) {
          return;
        }

        eventMapFlowX.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_in.name
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.coin_out.name
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
}; */

/*export const fetchTokenTradeTransactionsCetus = async (chatId: string) => {
  let tokenTradeEvents: any[] = [];

  try {
    const [poolRes, routerRes] = await Promise.all([
      client.queryEvents({
        query: { MoveEventType: config.MOVE_EVENT_TYPE_CETUS_POOL },
        limit: 100,
        order: "descending",
      }),
      client.queryEvents({
        query: { MoveEventType: config.MOVE_EVENT_TYPE_CETUS_ROUTER },
        limit: 100,
        order: "descending",
      }),
    ]);

    const allEvents = [...(poolRes.data || []), ...(routerRes.data || [])];
    if (allEvents.length === 0) return;

    allEvents.forEach((event) => {
      const parsedEvent = event.parsedJson as any;

      // Check that SUITRUMP is the output (buy)
      const tokenOut = parsedEvent?.target?.name || parsedEvent?.coin_b?.name;
      const tokenIn = parsedEvent?.from?.name || parsedEvent?.coin_a?.name;

      if (tokenOut === config.TOKEN_ADDRESS) {
        const eventId = event.id;
        if (!eventId) return;
        if (eventMapCetus.get(JSON.stringify(event.id))) return;

        eventMapCetus.set(JSON.stringify(event.id), event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (const event of tokenTradeEvents) {
      const decimal_a = await getTokenMetadata("0x" + (event.parsedJson?.from?.name || event.parsedJson?.coin_a?.name));
      const decimal_b = await getTokenMetadata("0x" + (event.parsedJson?.target?.name || event.parsedJson?.coin_b?.name));
      const sender = event.sender;

      await index.sendTransactionMessage(chatId, sender, event, decimal_a, decimal_b, "cetus");
    }
  } catch (error) {
    console.error("Error fetching Cetus token trade transactions:", error);
  }
};
*/
export const fetchRouterConfirmEvents = async (chatId: string) => {
  const tokenTradeEvents: any[] = [];

  try {
    // ✅ Query BOTH router event types — SwapEvent and ConfirmSwapEvent
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

    // Combine both responses
    const allEvents = [...(swapRes.data || []), ...(confirmRes.data || [])];
    if (allEvents.length === 0) return;

    allEvents.forEach((event) => {
      const parsed = event.parsedJson as any;
      const tokenOut = parsed?.target?.name;
      if (tokenOut !== config.TOKEN_ADDRESS) return;

      const tx = event.id.txDigest;
      if (eventMapRouter.get(tx)) return;
      eventMapRouter.set(tx, true);

      tokenTradeEvents.push(event);
    });

    for (const event of tokenTradeEvents) {
      const decIn = await getTokenMetadata("0x" + event.parsedJson.from.name);
      const decOut = await getTokenMetadata("0x" + event.parsedJson.target.name);
      const sender = event.sender;

      console.log(`[router] Detected swap on tx: ${event.id.txDigest}`);

      await index.sendTransactionMessage(
        chatId,
        sender,
        event,
        decIn,
        decOut,
        "router"
      );
    }
  } catch (err) {
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

    for (let i = 0; i < tokenTradeEvents.length; i++) {
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

/*export const fetchTokenTradeTransactionsBlueMove = async (chatId: string) => {
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
    console.error("Error fetching token trade transactions:", error);
  }
}; */

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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      if (parsedEvent?.tokenout?.name === config.TOKEN_ADDRESS) { // Added: Check tokenout.name for SUITRUMP buys
        const eventId = event.id;
        if (!eventId) return;

        if (eventMapSuiRewardsMe.get(JSON.stringify(event.id))) {
          return; // Added: Skip duplicate events
        }
        eventMapSuiRewardsMe.set(JSON.stringify(event.id), event.id); // Added: Store event ID to track duplicates
        tokenTradeEvents.push(event);
      }
    });

    for (let i = 0; i < tokenTradeEvents.length; i++) {
      const decimal_a = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.tokenin.name // Added: Use tokenin.name for input token metadata
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.tokenout.name // Added: Use tokenout.name for output token metadata
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

    response.data.filter((event) => {
      const parsedEvent = event.parsedJson as any;
      // Modified: Normalize type_out and TOKEN_ADDRESS for comparison
      if (parsedEvent?.type_out?.toLowerCase().trim() === config.TOKEN_ADDRESS.toLowerCase().trim()) {
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
        "0x" + tokenTradeEvents[i].parsedJson.type_in // Modified: Ensure type_in is prefixed correctly
      );
      const decimal_b = await getTokenMetadata(
        "0x" + tokenTradeEvents[i].parsedJson.type_out // Modified: Ensure type_out is prefixed correctly
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
  // console.log("monitoring...");

try {
  await Promise.all([
    fetchRouterConfirmEvents(chatId),        // ✅ unified router watcher
    fetchTokenTradeTransactionsSettle(chatId),
    fetchTokenTradeTransactionsSuiRewardsMe(chatId),
    fetchTokenTradeTransactionsAftermath(chatId),
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
