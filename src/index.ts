import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

import {
  CHART,
  DEFAULT_TOKEN_DECIMALS,
  TELEGRAM,
  TOKEN_NAME,
  TWITTER,
  VIDEO_PATH,
  WEBSITE,
} from "./config";
import * as database from "./db";
import { initSession } from "./session";
import * as instance from "./utils";
import {
  eventMonitorTimerId,
  fetchSuiNsAddress,
  fetchSuiNsName,
  getSuiPrice,
  getSuitrumpMarketCap,
  monitoringEvents,
} from "./web3";

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const owner = "7140524343";
let botUsername: string;

const BOT_COMMAND_HELP = "/help";
const BOT_COMMAND_START = "/start";
const BOT_COMMAND_STOP = "/stop";
const BOT_COMMAND_START_RAFFLE = "/startraffle";
const BOT_COMMAND_RAFFLE_STATS = "/rafflestats";
const BOT_COMMAND_LEADERBOARD = "/leaderboard";
const BOT_COMMAND_TICKET = "/ticket";
const BOT_COMMAND_ADD_TICKETS = "/addtickets";
const BOT_COMMAND_ENDORSE = "/endorse";

const bot = new TelegramBot(token, {
  polling: {
    interval: 3000,
    autoStart: true,
    params: { timeout: 10 },
  },
});

bot.getMe().then((me) => {
  console.log("legend, me =", me);
  botUsername = me.username;
});

const botCommands = [
  { command: "/start", description: "Start Monitoring (Group Owner Only)" },
  { command: "/stop", description: "Stop Monitoring (Group Owner Only)" },
  { command: "/startraffle", description: "Start Raffle (Admin, e.g., /startraffle 50 24)" },
  { command: "/addtickets", description: "Add Tickets (Admin, e.g., /addtickets 0x123 100)" },
  { command: "/endorse", description: "Endorse user (e.g., /endorse @SuiNs message)" },
  { command: "/rafflestats", description: "Show Raffle Stats" },
  { command: "/leaderboard", description: "Show Top Holders" },
  { command: "/ticket", description: "Check Tickets (e.g., /ticket 0x123)" },
  { command: "/help", description: "Show Commands" },
];

bot.setMyCommands(botCommands).then(() => console.log("Commands set!")).catch(console.error);

/* ================================
   Helper functions
================================== */

const isAdminMsg = async (msg: any) => {
  const msgType = msg?.chat?.type;
  if (msgType === "supergroup" || msgType === "group") {
    const ownerId = await getGroupOwner(msg.chat.id);
    if (ownerId && msg.from.id === ownerId) {
      console.log(`👑 Group Owner sent a message: ${msg.text}`);
      return true;
    } else {
      console.log(`User ${msg.from.username}: ${msg.text}`);
    }
  }
  return false;
};

const isEndorseEnabled = async (msg: any, address: string) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayAmount = await database.getEndorseCountByDay({
    endorser: msg.from.id,
    timestamp: { $gte: twentyFourHoursAgo },
  });
  if (typeof dayAmount !== "number") return instance.ENDORSE_DISABLED;
  if (dayAmount > 2) return instance.ENDORSE_EXCEEDS;

  const endorseCount = await database.getEndorseCountByDay({
    sender: address,
    endorser: msg.from.id,
    timestamp: { $gte: twentyFourHoursAgo },
  });
  if (typeof endorseCount !== "number") return instance.ENDORSE_DISABLED;
  if (endorseCount > 0) return instance.IS_ALREADY_ENDORSED;
  return instance.ENDORSE_ENABLED;
};

async function getGroupOwner(chatId: string) {
  try {
    const admins = await bot.getChatAdministrators(chatId);
    const owner = admins.find((admin) => admin.status === "creator");
    return owner ? owner.user.id : null;
  } catch (error) {
    console.error("Error fetching owner:", error);
    return null;
  }
}

const scheduleMessage = async (chatId: string, date: Date) => {
  const now = new Date();
  const delay = date.getTime() - now.getTime();
  if (delay < 0) return;

  setTimeout(async () => {
    try {
      const address = await database.getRaffleWinner();
      const raffle = (await database.selectRaffle()) as { prize?: number } | null;
      const suins = await fetchSuiNsName(address as string);
      const messageContent = `🔴 Raffle has ended!
🏆 Winner: <code>${suins}</code>
💰 Prize: ${raffle?.prize ?? "Unknown"} SUI`;

      await bot.sendMessage(
        chatId,
        messageContent,
        instance.sendMessageOption as TelegramBot.SendMessageOptions
      );
      console.log("Scheduled message sent successfully.");
    } catch (error) {
      console.log("Error sending scheduled message:", error);
    }
  }, delay);
};

/* ================================
   Message Listener
================================== */

bot.on("message", async (message) => {
  try {
    const session = initSession(message);
    if (!message.entities) return;

    const commandEntity = message.entities.find((e) => e.type === "bot_command");
    if (!commandEntity) return;

    const commandFresh = (message.text as string).substring(
      commandEntity.offset,
      commandEntity.offset + commandEntity.length
    );
    const command = commandFresh.replace(`@${botUsername}`, "");

    if (command === BOT_COMMAND_START) {
      if (await isAdminMsg(message)) {
        await bot.sendMessage(session.chatId, "✅ Successfully started!", instance.sendMessageOption);
        await monitoringEvents(session.chatId);
      }
    } else if (command === BOT_COMMAND_STOP) {
      if (await isAdminMsg(message)) {
        clearInterval(eventMonitorTimerId);
        await bot.sendMessage(session.chatId, "✅ Successfully stopped!", instance.sendMessageOption);
      }
    } else if (command === BOT_COMMAND_HELP) {
      await bot.sendMessage(session.chatId, instance.getHelpMessage(), instance.sendMessageOption);
    }
  } catch (error) {
    try {
      await bot.sendMessage(
        message.chat.id,
        `😢 Sorry, something went wrong! Please try again later.`,
        instance.sendMessageOption
      );
    } catch (error2) {
      console.log("message:", error2);
    }
  }
});

/* ================================
   Transaction Handler
================================== */

export const sendTransactionMessage = async (
  chatId: string,
  sender: string,
  data: any,
  decimal_a: number = DEFAULT_TOKEN_DECIMALS,
  decimal_b: number = DEFAULT_TOKEN_DECIMALS,
  flag: string
) => {
  if (!data) return;

  let message = "";
  const suiPrice = await getSuiPrice();
  let inputPrice = 0;
  let inputAmount = 0;
  let inputSymbol = "";
  let outputAmount = 0;

  try {
    message = `📌 ${TOKEN_NAME} BUY \n\n`;

    // ✅ Safeguarded DEX parsing
     if (flag === "cetus" || flag === "bluemove") {
      const a2b = data?.parsedJson?.a2b;
      const coinA = data?.parsedJson?.coin_a?.name || data?.parsedJson?.coin_in?.name || "";
      const coinB = data?.parsedJson?.coin_b?.name || data?.parsedJson?.coin_out?.name || "";
      inputAmount = (data?.parsedJson?.amount_in || 0) / 10 ** decimal_a;
      inputSymbol = (a2b ? coinA : coinB).split("::").pop() || "UNKNOWN";
      outputAmount = (data?.parsedJson?.amount_out || 0) / 10 ** decimal_b;
    } else if (flag === "settle" || flag === "flowx") {
      const coinIn = data?.parsedJson?.coin_in?.name || "";
      inputAmount = (data?.parsedJson?.amount_in || 0) / 10 ** decimal_a;
      inputSymbol = coinIn.split("::").pop() || "UNKNOWN";
      outputAmount = (data?.parsedJson?.amount_out || 0) / 10 ** decimal_b;
    } else if (flag === "suirewardsme") {
      const tokenIn = data?.parsedJson?.tokenin?.name || "";
      inputAmount = (data?.parsedJson?.amountin || 0) / 10 ** decimal_a;
      inputSymbol = tokenIn.split("::").pop() || "UNKNOWN";
      outputAmount = (data?.parsedJson?.amountout || 0) / 10 ** decimal_b;
    } else if (flag === "aftermath") {
      const typeIn = data?.parsedJson?.type_in || "";
      inputAmount = (data?.parsedJson?.amount_in || 0) / 10 ** decimal_a;
      inputSymbol = typeIn.split("::").pop() || "UNKNOWN";
      outputAmount = (data?.parsedJson?.amount_out || 0) / 10 ** decimal_b;
    } else if (flag === "router") {
      const fromName = data?.parsedJson?.from?.name || "";
      inputAmount = (data?.parsedJson?.amount_in || 0) / 10 ** decimal_a;
      inputSymbol = fromName.split("::").pop() || "SUI";
      outputAmount = (data?.parsedJson?.amount_out || 0) / 10 ** decimal_b;
    } else return;

    if (inputSymbol === "SUI") inputPrice = inputAmount * suiPrice;

    const emojiCount = Math.floor(outputAmount / 100000) || 1;
    const emojis = "🏆".repeat(emojiCount);
    message += `${emojis}\n\n`;

    const suiNsName = await fetchSuiNsName(sender);
    message += `👤 Buyer: <code>${suiNsName}</code>\n`;
    message += `💸 Invest: ${inputAmount} ${inputSymbol} ${
      inputSymbol === "SUI" ? `($${inputPrice.toFixed(4)})` : ""
    }\n`;
    message += `💰 Bought: ${outputAmount} SUITRUMP\n`;

    const marketCap = await getSuitrumpMarketCap();
    if (marketCap !== null) {
      message += `🎰 Market Cap: $${marketCap.toLocaleString()}\n`;

      try {
        const dexInfo: Record<string, { name: string; emoji: string }> = {
          aftermath: { name: "Aftermath", emoji: "🦈" },
          cetus: { name: "Cetus", emoji: "🐳" },
          settle: { name: "BlueFin", emoji: "🐟" },
          bluemove: { name: "BlueMove", emoji: "🌊" },
          flowx: { name: "FlowX", emoji: "💧" },
          suirewardsme: { name: "SuiRewardsMe", emoji: "🍃" },
          router: { name: data?.parsedJson?.dex || "Router", emoji: "🔄" },
        };
        const dex =
          dexInfo?.[flag?.toLowerCase?.()] ??
          { name: data?.parsedJson?.dex || flag?.toUpperCase?.() || "Unknown", emoji: "🔄" };
        message += `🌐 DEX: ${dex.name} ${dex.emoji}\n\n`;
      } catch (err) {
        console.warn("DEX block fallback used:", err);
        message += "🌐 DEX: Router 🔄\n\n";
      }
    }

    message += `🛰 TxDigest: <a href="https://suiscan.xyz/mainnet/tx/${data.id.txDigest}">
${instance.shortenAddress(data.id.txDigest)}</a>\n\n`;
    message += `📈 Chart: <a href="${CHART}">DexScreener</a>\n`;
    message += `🔗 Links: <a href="${WEBSITE}">Website</a> | <a href="${TELEGRAM}">Telegram</a> | <a href="${TWITTER}">Twitter</a>`;

    await Promise.all([
      bot.sendVideo(chatId, VIDEO_PATH, {
        caption: message,
        parse_mode: "HTML",
      }),
      database.addTxEvent({
        sender:
          flag === "aftermath"
            ? data.parsedJson.swapper
            : data.parsedJson.wallet || data.sender,
        amount: outputAmount,
        endorser: null,
      }),
    ]);
  } catch (error) {
    console.log("sendMessage err:", error);
  }
};

/* ================================
   Alert
================================== */

export const sendAlert = async (chatId: string, userName: string) => {
  if (!userName) return;
  try {
    const message = `🙍‍♂️ User @${userName} logged in successfully.\n\n`;
    await bot.sendMessage(chatId, message, instance.sendMessageOption);
  } catch (error) {
    console.log("sendMessage err:", error);
  }
};

database.init();
console.log("Hello, Bot Was Started Successfully!!!");
