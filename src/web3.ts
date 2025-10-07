import axios from "axios";
import dotenv from "dotenv";
import { SuiClient, SuiEvent } from "@mysten/sui/client";
import * as config from "./config";
import * as index from "./index";

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const client = new SuiClient({ url: RPC_URL });

let eventMapRouter = new Map<string, any>();
let eventMapSettle = new Map<string, any>();
let eventMapSuiRewardsMe = new Map<string, any>();
let eventMapAftermath = new Map<string, any>();
let eventMapBlueMove = new Map<string, any>();

export let eventMonitorTimerId: any = null;

/* ===========================
   🛰️ FETCH FUNCTIONS
=========================== */

export const fetchRouterConfirmEvents = async (chatId: string) => {
  const tokenTradeEvents: SuiEvent[] = [];

  try {
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

    let allEvents = [...(swapRes.data || []), ...(confirmRes.data || [])];
    if (allEvents.length === 0) return;

    const swapEventIds = new Set(swapRes.data?.map((e: any) => e.id) || []);

    for (const event of allEvents) {
      const parsed = event.parsedJson as any;
      const tokenOut =
        parsed?.target?.name ||
        parsed?.coin_out?.name ||
        parsed?.coin_b?.name ||
        parsed?.type_out ||
        "";

      if (tokenOut !== config.TOKEN_ADDRESS) continue;

      const tx = event.id.txDigest;
      if (eventMapRouter.get(tx)) continue;
      eventMapRouter.set(tx, true);

      tokenTradeEvents.push(event);
    }

    for (const event of tokenTradeEvents) {
      const decIn = await getTokenMetadata(
        "0x" +
          (event.parsedJson.from?.name ||
            event.parsedJson.coin_a?.name ||
            event.parsedJson.coin_in?.name ||
            "")
      );
      const decOut = await getTokenMetadata("0x" + config.TOKEN_ADDRESS);
      const sender =
        (event.parsedJson?.wallet as string) ||
        (event.parsedJson?.swapper as string) ||
        event.sender;

      let dex = "router";
      if (swapEventIds.has(event.id)) dex = "cetus";
      else dex = (event.parsedJson?.dex as string) || "router";

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
  } catch (err: any) {
    if (String(err).includes("Could not find the referenced transaction events"))
      return;
    console.error("Error fetching router Swap/Confirm events:", err);
  }
};

/* ===========================
   🐟 SETTLE
=========================== */
export const fetchTokenTradeTransactionsSettle = async (chatId: string) => {
  const tokenTradeEvents: SuiEvent[] = [];

  try {
    const response = await client.queryEvents({
      query: { MoveEventType: config.MOVE_EVENT_TYPE_SETTLE },
      limit: 100,
      order: "descending",
    });

    if (!response?.data?.length) return;

    response.data.forEach((event) => {
      const parsed = event.parsedJson as any;
      if (parsed?.coin_out?.name === config.TOKEN_ADDRESS) {
        const id = JSON.stringify(event.id);
        if (eventMapSettle.get(id)) return;
        eventMapSettle.set(id, event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (const ev of tokenTradeEvents) {
      const decA = await getTokenMetadata("0x" + ev.parsedJson.coin_in.name);
      const decB = await getTokenMetadata("0x" + ev.parsedJson.coin_out.name);
      const sender = ev.parsedJson.sender;

      await index.sendTransactionMessage(chatId, sender, ev, decA, decB, "settle");
    }
  } catch (err) {
    console.error("Error fetching token trade transactions:", err);
  }
};

/* ===========================
   🌊 BLUEMOVE
=========================== */
export const fetchTokenTradeTransactionsBlueMove = async (chatId: string) => {
  const tokenTradeEvents: SuiEvent[] = [];
  try {
    const response = await client.queryEvents({
      query: { MoveEventType: config.MOVE_EVENT_TYPE_BLUEMOVE },
      limit: 100,
      order: "descending",
    });

    if (!response?.data?.length) return;

    response.data.forEach((event) => {
      const parsed = event.parsedJson as any;
      if (
        (parsed?.coin_a?.name === config.TOKEN_ADDRESS && !parsed?.a2b) ||
        (parsed?.coin_b?.name === config.TOKEN_ADDRESS && parsed?.a2b)
      ) {
        const id = JSON.stringify(event.id);
        if (eventMapBlueMove.get(id)) return;
        eventMapBlueMove.set(id, event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (const ev of tokenTradeEvents) {
      const decA = await getTokenMetadata("0x" + ev.parsedJson.coin_a.name);
      const decB = await getTokenMetadata("0x" + ev.parsedJson.coin_b.name);
      const sender = ev.sender;
      await index.sendTransactionMessage(chatId, sender, ev, decA, decB, "bluemove");
    }
  } catch (err) {
    console.error("Error fetching BlueMove token trade transactions:", err);
  }
};

/* ===========================
   🍃 SUIREWARDSME
=========================== */
export const fetchTokenTradeTransactionsSuiRewardsMe = async (chatId: string) => {
  const tokenTradeEvents: SuiEvent[] = [];
  try {
    const response = await client.queryEvents({
      query: { MoveEventType: config.MOVE_EVENT_TYPE_SUIREWARDSME },
      limit: 100,
      order: "descending",
    });

    if (!response?.data?.length) return;

    response.data.forEach((event) => {
      const parsed = event.parsedJson as any;
      if (parsed?.tokenout?.name === config.TOKEN_ADDRESS) {
        const id = JSON.stringify(event.id);
        if (eventMapSuiRewardsMe.get(id)) return;
        eventMapSuiRewardsMe.set(id, event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (const ev of tokenTradeEvents) {
      const decA = await getTokenMetadata("0x" + ev.parsedJson.tokenin.name);
      const decB = await getTokenMetadata("0x" + ev.parsedJson.tokenout.name);
      const sender = ev.parsedJson.wallet || ev.sender;
      await index.sendTransactionMessage(
        chatId,
        sender,
        ev,
        decA,
        decB,
        "suirewardsme"
      );
    }
  } catch (err) {
    console.error("Error fetching SuiRewardsMe token trade transactions:", err);
  }
};

/* ===========================
   🦈 AFTERMATH
=========================== */
export const fetchTokenTradeTransactionsAftermath = async (chatId: string) => {
  const tokenTradeEvents: SuiEvent[] = [];
  try {
    const response = await client.queryEvents({
      query: { MoveEventType: config.MOVE_EVENT_TYPE_AFTERMATH },
      limit: 100,
      order: "descending",
    });

    if (!response?.data?.length) return;

    response.data.forEach((event) => {
      const parsed = event.parsedJson as any;
      if (parsed?.type_out === config.TOKEN_ADDRESS) {
        const id = JSON.stringify(event.id);
        if (eventMapAftermath.get(id)) return;
        eventMapAftermath.set(id, event.id);
        tokenTradeEvents.push(event);
      }
    });

    for (const ev of tokenTradeEvents) {
      const decA = await getTokenMetadata("0x" + ev.parsedJson.type_in);
      const decB = await getTokenMetadata("0x" + ev.parsedJson.type_out);
      const sender = ev.parsedJson.swapper;
      await index.sendTransactionMessage(chatId, sender, ev, decA, decB, "aftermath");
    }
  } catch (err) {
    console.error("Error fetching Aftermath token trade transactions:", err);
  }
};

/* ===========================
   🔎 SUPPORTING UTILITIES
=========================== */
export const fetchSuiNsName = async (addr: string) => {
  try {
    const res = await client.resolveNameServiceNames({ address: addr });
    if (!res?.data?.length) return addr;
    console.log("suins name =", res.data[0]);
    return "@" + res.data[0].split(".")[0];
  } catch {
    console.error("Error fetching SuiNs name");
    return addr;
  }
};

export const fetchSuiNsAddress = async (label: string) => {
  try {
    const res = await client.resolveNameServiceAddress({ name: label + ".sui" });
    if (!res) return "";
    console.log("suins address =", res);
    return res;
  } catch (err) {
    console.error("Error fetching SuiNs address:", err);
    return "";
  }
};

export const getSuiPrice = async () => {
  try {
    const res = await axios.get("https://api.coinbase.com/v2/prices/SUI-USD/spot");
    return Number(res.data.data.amount);
  } catch (err) {
    console.error("Error fetching SUI price:", err);
    return 0;
  }
};

export const getSuitrumpMarketCap = async () => {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/sui-trump");
    return res.data?.market_data?.market_cap?.usd || null;
  } catch (err) {
    console.error("Error fetching SUITRUMP market cap:", err);
    return null;
  }
};

/* ===========================
   🔁 MONITOR LOOP
=========================== */
export const monitoringEvents = async (chatId: string) => {
  try {
    await Promise.all([
      fetchRouterConfirmEvents(chatId),
      fetchTokenTradeTransactionsSettle(chatId),
      fetchTokenTradeTransactionsSuiRewardsMe(chatId),
      fetchTokenTradeTransactionsAftermath(chatId),
      fetchTokenTradeTransactionsBlueMove(chatId),
    ]);
  } catch (err) {
    console.log("monitoringEvents err:", err);
  }

  if (eventMonitorTimerId) clearInterval(eventMonitorTimerId);
  eventMonitorTimerId = setInterval(() => monitoringEvents(chatId), 15000);
};

/* ===========================
   🧮 TOKEN METADATA
=========================== */
export const getTokenMetadata = async (tokenAddress: string) => {
  try {
    const res = await client.getCoinMetadata({ coinType: tokenAddress });
    return res?.decimals || config.DEFAULT_TOKEN_DECIMALS;
  } catch (err) {
    console.error(err);
    return config.DEFAULT_TOKEN_DECIMALS;
  }
};
