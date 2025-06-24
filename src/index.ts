import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

import {
  CHART,
  DEFAULT_TOKEN_DECIMALS,
  TELEGRAM,
  TOKEN_NAME,
  TWITTER,
  VIDEO_PATH,
  WEBSITE,
} from './config';
import * as database from './db';
import { initSession } from './session';
import * as instance from './utils';
import {
  eventMonitorTimerId,
  fetchSuiNsAddress,
  fetchSuiNsName,
  getSuiPrice,
  getSuitrumpMarketCap,
  monitoringEvents,
} from './web3';


dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const owner = "7140524343"
let botUsername: string;

const BOT_COMMAND_HELP = "/help"; // help
const BOT_COMMAND_START = "/start"; // start bot
const BOT_COMMAND_STOP = "/stop"; // stop bot
const BOT_COMMAND_START_RAFFLE = "/startraffle"; // start raffle for only group owner
const BOT_COMMAND_RAFFLE_STATS = "/rafflestats";
const BOT_COMMAND_LEADERBOARD = "/leaderboard";
const BOT_COMMAND_TICKET = "/ticket";
const BOT_COMMAND_ADD_TICKETS = "/addtickets";
const BOT_COMMAND_ENDORSE = "/endorse";

const bot = new TelegramBot(token, {
  polling: {
    interval: 3000,
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
});

bot.getMe().then((me) => {
  console.log("legend, me = ", me);
  botUsername = me.username;
});

const botCommands = [
  { command: "/start", description: "Start Monitoring (Group Owner Only)" },
  { command: "/stop", description: "Stop Monitoring (Group Owner Only)" },
  {
    command: "/startraffle",
    description: "Start Raffle (Admin, e.g., /startraffle 50 24)",
  },
  {
    command: "/addtickets",
    description: "Add Tickets (Admin, e.g., /addtickets 0x123 100)",
  },
  {
    command: "/endorse",
    description: "Endorse user (e.g., /endorse @SuiNs message)",
  },
  { command: "/rafflestats", description: "Show Raffle Stats" },
  { command: "/leaderboard", description: "Show Top Holders" },
  { command: "/ticket", description: "Check Tickets (e.g., /ticket 0x123)" },
  { command: "/help", description: "Show Commands" },
];

bot
  .setMyCommands(botCommands)
  .then(() => console.log("Commands set!"))
  .catch(console.error);

bot.on("message", async (message) => {
  try {
    const session = initSession(message);

    if (!message.entities) {
      return;
    }
    // const username = message.from.username;
    // sendAlert(owner, username);

    const commandEntity = message.entities.find(
      (entity) => entity.type === "bot_command"
    );

    if (!commandEntity) {
      return;
    }

    const commandFresh = (message.text as string).substring(
      commandEntity.offset,
      commandEntity.offset + commandEntity.length
    );

    const command = commandFresh.replace(`@${botUsername}`, "");

    if (command === BOT_COMMAND_START) {
      if (await isAdminMsg(message)) {
        await bot.sendMessage(
          session.chatId,
          "✅ Successfully started!",
          instance.sendMessageOption as TelegramBot.SendMessageOptions
        );
        await monitoringEvents(session.chatId);
      }
    } else if (command == BOT_COMMAND_STOP) {
      if (await isAdminMsg(message)) {
        clearInterval(eventMonitorTimerId);
        await bot.sendMessage(
          session.chatId,
          "✅ Successfully stopped!",
          instance.sendMessageOption as TelegramBot.SendMessageOptions
        );
      }
    } else if (command == BOT_COMMAND_HELP) {
      await bot.sendMessage(
        session.chatId,
        instance.getHelpMessage(),
        instance.sendMessageOption as TelegramBot.SendMessageOptions
      );
    } else if (command == BOT_COMMAND_TICKET) {
      const params = message.text.split(" ");
      let walletAddress = params[1];
      if (walletAddress.startsWith("@")) {
        walletAddress = await fetchSuiNsAddress(walletAddress.substring(1));
      }
      const amount = await database.getTotalTickets({
        sender: walletAddress,
      });
      await bot.sendMessage(
        session.chatId,
        `💳 Wallet Address: ${instance.shortenAddress(walletAddress)}
💸 Tickets: ${amount.toLocaleString()}`,
        instance.sendMessageOption as TelegramBot.SendMessageOptions
      );
    } else if (command == BOT_COMMAND_START_RAFFLE) {
      if (await isAdminMsg(message)) {
        const params = message.text.split(" ");
        const prize = params[1];
        const duration = params[2];
        const isAdded = await database.addRaffle({
          prize: Number(prize),
          duration: Number(duration),
          winner: "0x00",
        });
        if (isAdded) {
          await bot.sendMessage(
            session.chatId,
            `🟢 Raffle Started!\n
💰 Prize Pool: ${prize} SUI
⏳ Duration: ${duration} hours
🎟 Buy SUITRUMP to earn tickets!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
          scheduleMessage(
            session.chatId,
            new Date(Date.now() + Number(duration) * 3600000 + 1000)
          );
        } else if (prize === undefined || duration === undefined) {
          await bot.sendMessage(
            session.chatId,
            `🔴 Invalid command!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else {
          await bot.sendMessage(
            session.chatId,
            `🔴 Raffle is already running!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        }
      }
    } else if (command == BOT_COMMAND_RAFFLE_STATS) {
      const isGroup = instance.isGroupMsg(session.type);
      if (isGroup) {
        const raffle: any = await database.selectRaffle();
        if (
          raffle &&
          Date.now() - new Date(raffle.timestamp).getTime() <
            raffle.duration * 3600000
        ) {
          const timeleft =
            raffle.duration * 3600000 - (Date.now() - raffle.timestamp);
          const amount = await database.getTotalTickets();
          const userCount = await database.getTotalSenders();

          await bot.sendMessage(
            session.chatId,
            `📊 Raffle Stats\n
⏰ Time left on the raffle: ${instance.calculateTime(timeleft)}
💸 Total tickets awarded: ${amount.toLocaleString()}
💰 Prize Pool: ${raffle.prize} SUI
👥 Total Players: ${userCount}
          `,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else if (raffle) {
          const adderss = await database.getRaffleWinner();
          const suins = await fetchSuiNsName(adderss as string);
          await bot.sendMessage(
            session.chatId,
            `🔴 Raffle has ended!
🏆 Winner: <code>${suins}</code>`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else {
          await bot.sendMessage(
            session.chatId,
            `🔴 No raffle is currently running!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        }
      }
    } else if (command == BOT_COMMAND_LEADERBOARD) {
      const isGroup = instance.isGroupMsg(session.type);
      if (isGroup) {
        const raffle: any = await database.selectRaffle();
        if (
          raffle &&
          Date.now() - new Date(raffle.timestamp).getTime() <
            raffle.duration * 3600000
        ) {
          const topHolders = await database.getTopHolders();

          await bot.sendMessage(
            session.chatId,
            `📊 Top Ticket Holders\n
${topHolders}`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else if (raffle) {
          const address = await database.getRaffleWinner();
          const suins = await fetchSuiNsName(address as string);
          await bot.sendMessage(
            session.chatId,
            `🔴 Raffle has ended!
🏆 Winner: ${suins}`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else {
          await bot.sendMessage(
            session.chatId,
            `🔴 No raffle is currently running!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        }
      }
    } else if (command == BOT_COMMAND_ADD_TICKETS) {
      if (await isAdminMsg(message)) {
        const params = message.text.split(" ");
        let walletAddress = params[1];
        const amount = params[2];
        if (walletAddress === undefined || amount === undefined) {
          await bot.sendMessage(
            session.chatId,
            `🔴 Invalid command!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
          return;
        }
        const raffle: any = await database.selectRaffle();
        if (
          raffle &&
          Date.now() - new Date(raffle.timestamp).getTime() <
            raffle.duration * 3600000
        ) {
          if (walletAddress.startsWith("@")) {
            walletAddress = await fetchSuiNsAddress(walletAddress.substring(1));
          }
          await database.addTxEvent({
            sender: walletAddress,
            amount: Number(amount),
            endorser: null,
          }),
            await bot.sendMessage(
              session.chatId,
              `🟢 Tickets are added!`,
              instance.sendMessageOption as TelegramBot.SendMessageOptions
            );
        } else {
          await bot.sendMessage(
            session.chatId,
            `🔴 No raffle is currently running!`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        }
      }
    } else if (command == BOT_COMMAND_ENDORSE) {
      const params = message.text.split(" ");
      let suins = params[1];
      const content = message.text.substring((params[0] + params[1]).length + 1);
      if (suins === undefined || content === undefined) {
        await bot.sendMessage(
          session.chatId,
          `🔴 Invalid command!`,
          instance.sendMessageOption as TelegramBot.SendMessageOptions
        );
        return;
      }
      if (!suins.startsWith("@")) {
        await bot.sendMessage(
          session.chatId,
          `🔴 Invalid command!`,
          instance.sendMessageOption as TelegramBot.SendMessageOptions
        );
        return;
      }
      const raffle: any = await database.selectRaffle();
      if (
        raffle &&
        Date.now() - new Date(raffle.timestamp).getTime() <
          raffle.duration * 3600000
      ) {
        const address = await fetchSuiNsAddress(suins.substring(1));
        const flag = await isEndorseEnabled(message, address);
        if (flag === instance.ENDORSE_DISABLED) {
          await bot.sendMessage(
            session.chatId,
            `🔴 Endorse Error`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else if (flag === instance.IS_ALREADY_ENDORSED) {
          await bot.sendMessage(
            session.chatId,
            `🔴 You can endorse this name once a day.`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else if (flag === instance.ENDORSE_EXCEEDS) {
          await bot.sendMessage(
            session.chatId,
            `🔴 You can't endorse more than 3 times a day.`,
            instance.sendMessageOption as TelegramBot.SendMessageOptions
          );
        } else {
          if (address === "") {
            await bot.sendMessage(
              session.chatId,
              `🔴 No user with <code>${suins}</code> SuiNs name`,
              instance.sendMessageOption as TelegramBot.SendMessageOptions
            );
          } else {
            await database.addTxEvent({
              sender: address,
              amount: Number(instance.ENDORSE_BONUS),
              endorser: message.from.id,
            });
            await bot.sendMessage(
              session.chatId,
               `🏆 <code>${suins}</code> was Endorsed and got 5000 raffle tickets!\n\n📄 Message - ${content}`,
                 instance.sendMessageOption as TelegramBot.SendMessageOptions
            );
          }
        }
      } else {
        await bot.sendMessage(
          session.chatId,
          `🔴 No raffle is currently running!`,
          instance.sendMessageOption as TelegramBot.SendMessageOptions
        );
      }
    }
  } catch (error) {
    try {
      await bot.sendMessage(
        message.chat.id,
        `😢 Sorry, Something went wrong! Please try again later!\n Error 1`,
        instance.sendMessageOption as TelegramBot.SendMessageOptions
      );
    } catch (error) {
      console.log("message: ", error);
    }
  }
});

export const sendTransactionMessage = async (
  chatId: string,
  sender: string,
  data: any,
  decimal_a: number = DEFAULT_TOKEN_DECIMALS,
  decimal_b: number = DEFAULT_TOKEN_DECIMALS,
  flag: string
) => {
  if (data === null) return;
  let message = "";
  const suiPrice = await getSuiPrice();
  let inputPrice = 0;
  let inputAmount = 0;
  let inputSymbol = "";
  let outputAmount = 0;

  try {
    message = `\u{1F4CC} ${TOKEN_NAME} BUY \n\n`;

    if (flag === "cetus" || flag === "bluemove") {
      inputAmount = data.parsedJson.a2b
        ? data.parsedJson.amount_in / 10 ** decimal_a
        : data.parsedJson.amount_in / 10 ** decimal_b;
      inputSymbol = data.parsedJson.a2b
        ? data.parsedJson.coin_a.name.split("::").pop()
        : data.parsedJson.coin_b.name.split("::").pop();
      outputAmount = data.parsedJson.a2b
        ? data.parsedJson.amount_out / 10 ** decimal_b
        : data.parsedJson.amount_out / 10 ** decimal_a;
    } else if (flag === "settle") {
      inputAmount = data.parsedJson.amount_in / 10 ** decimal_a;
      inputSymbol = data.parsedJson.coin_in.name.split("::").pop();
      outputAmount = data.parsedJson.amount_out / 10 ** decimal_b;
    } else if (flag === "flowx") {
      inputAmount = data.parsedJson.amount_in / 10 ** decimal_a;
      inputSymbol = data.parsedJson.coin_in.name.split("::").pop();
      outputAmount = data.parsedJson.amount_out / 10 ** decimal_b;
    } else {
      return;
    }

    if (inputSymbol === "SUI") {
      inputPrice = inputAmount * suiPrice;
    }

    // Calculate emoji count (1 per 50,000 SUITRUMP, min 1)
    const emojiCount = Math.floor(outputAmount / 500000) || 1;
    const emojis = "🏆".repeat(emojiCount); // Standard Unicode smiley face

    message += `${emojis}`; // Emoji on its own line after "SUI TRUMP BUY"
    const suiNsName = await fetchSuiNsName(sender);
    message += `\n\n👤 Buyer: <code>${suiNsName}</code>`;
    message += `\n💸 Invest: ${inputAmount} ${inputSymbol} ${
      inputSymbol === "SUI" ? `($${inputPrice.toFixed(4)})` : ""
    }\n`; // Extra newline before "Invest"
    message += `💰 Bought: ${outputAmount} SUITRUMP\n`;
    const marketCap = await getSuitrumpMarketCap();
    if (marketCap !== null) {
      message += `🎰 Market Cap: $${marketCap.toLocaleString()}\n`;
    }
    message += `🛰 TxDigest: <a href="https://suiscan.xyz/mainnet/tx/${
      data.id.txDigest
    }">${instance.shortenAddress(data.id.txDigest)}</a>\n\n`;

    message += `📈 Chart:  <a href="${CHART}">DexScreener</a>\n`;
    message += `🔗 Links:  <a href="${WEBSITE}">Website</a>`;
    message += ` | <a href="${TELEGRAM}">Telegram</a>`;
    message += ` | <a href="${TWITTER}">Twitter</a>`;

    await Promise.all([
      bot.sendVideo(chatId, VIDEO_PATH, {
        caption: message,
        parse_mode: "HTML",
      }),
      await database.addTxEvent({
        sender: data.parsedJson.swapper || data.sender, // Fallback to sender if swapper is unavailable
        amount: outputAmount,
        endorser: null,
      }),
    ]);
  } catch (error) {
    console.log("sendMessage err: ", error);
  }
};

export const sendAlert = async (chatId: string, userName: string) => {
  let message = "";

  if (userName === null) return;

  try {
    message = `🙍‍♂️ User @${userName} logged in successfully. \n\n`;

    await bot.sendMessage(
      chatId,
      message,
      instance.sendMessageOption as TelegramBot.SendMessageOptions
    );
  } catch (error) {
    console.log("sendMessage err: ", error);
  }
};

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
  console.log("endorse count = ", dayAmount);
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

  if (delay < 0) {
    console.log("Scheduled time is in the past. Message not sent.");
    return;
  }

  setTimeout(async () => {
    try {
      const adderss = await database.getRaffleWinner();
      const raffle = (await database.selectRaffle()) as {
        prize?: number;
      } | null; // Allow missing prize
      const suins = await fetchSuiNsName(adderss as string);

      const messageContent = `🔴 Raffle has ended!
🏆 Winner: <code>${suins}</code>
💰 Prize: ${raffle?.prize ?? "Unknown"} SUI`; // Fallback if prize is missing

      await bot.sendMessage(
        chatId,
        messageContent,
        instance.sendMessageOption as TelegramBot.SendMessageOptions
      );
      console.log("Scheduled message sent successfully.");
    } catch (error) {
      console.log("Error sending scheduled message: ", error);
    }
  }, delay);
};

database.init();
console.log("Hello, Bot Was Started Successfully!!!");
