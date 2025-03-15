import axios from 'axios';
import dotenv from 'dotenv';

import { SuiClient } from '@mysten/sui/client';

import * as config from './config';
import * as index from './index';

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const client = new SuiClient({ url: RPC_URL });

let eventMapCetus = new Map<string, any>();
let eventMapSettle = new Map<string, any>();
let eventMapBlueMove = new Map<string, any>();

export let eventMonitorTimerId = null;

export const fetchTokenTradeTransactionsCetus = async (chatId: string) => {
  let tokenTradeEvents = [];

  try {
    const response = await client.queryEvents({
      query: {
        MoveEventType: config.MOVE_EVENT_TYPE_CETUS,
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

        if (eventMapCetus.get(JSON.stringify(event.id))) {
          return;
        }

        eventMapCetus.set(JSON.stringify(event.id), event.id);
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
        "cetus"
      );
    }
  } catch (error) {
    console.error("Error fetching token trade transactions:", error);
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
      fetchTokenTradeTransactionsCetus(chatId),
      fetchTokenTradeTransactionsSettle(chatId),
      fetchTokenTradeTransactionsBlueMove(chatId),
    ]);
  } catch (err) {
    console.log("monitoringEvents err: ", err);
  }

  if (eventMonitorTimerId) {
    clearInterval(eventMonitorTimerId);
  }

  eventMonitorTimerId = setInterval(() => monitoringEvents(chatId), 3000);
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