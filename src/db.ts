import mongoose from 'mongoose';

import * as instance from './utils';
import { fetchSuiNsName } from './web3';

type RaffleRecord = {
  prize: number;
  duration: number;
  winner: string;
  timestamp: Date;
};

type TxEventRecord = {
  sender: string;
  amount: number;
  ticket: number;
  endorser: string | null;
  timestamp: Date;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

let useMemoryStore = process.env.USE_MEMORY_STORE === "true";

const memoryState: {
  raffle: RaffleRecord | null;
  txEvents: TxEventRecord[];
} = {
  raffle: null,
  txEvents: [],
};

const matchesParams = <T extends Record<string, any>>(
  item: T,
  params: Record<string, any>
) => {
  return Object.entries(params ?? {}).every(([key, value]) => {
    const itemValue = item[key];

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "$gte" in value
    ) {
      const compareValue = value.$gte;
      const itemTime =
        itemValue instanceof Date
          ? itemValue.getTime()
          : new Date(itemValue).getTime();
      const compareTime =
        compareValue instanceof Date
          ? compareValue.getTime()
          : new Date(compareValue).getTime();
      return itemTime >= compareTime;
    }

    if (
      (typeof itemValue === "string" || typeof itemValue === "number") &&
      (typeof value === "string" || typeof value === "number")
    ) {
      return String(itemValue) === String(value);
    }

    return itemValue === value;
  });
};

export const init = async () => {
  if (useMemoryStore) {
    console.log("Using in-memory raffle store (Mongo disabled).");
    return;
  }

  const mongoUri = process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017";
  const mongoDbName = process.env.MONGO_DB ?? "monitorbot";

  try {
    await mongoose.connect(mongoUri, { dbName: mongoDbName });
    console.log(`Connected to MongoDB "${mongoDbName}"...`);
  } catch (err) {
    console.error(
      `Could not connect to MongoDB at ${mongoUri}/${mongoDbName}. Falling back to in-memory store.`,
      err
    );
    useMemoryStore = true;
  }
};

const RaffleSchema = mongoose.model(
  "Raffle",
  new mongoose.Schema({
    prize: Number,
    duration: Number,
    winner: { type: String, default: "0x00" },
    timestamp: { type: Date, default: Date.now },
  })
);

const TxEventSchema = mongoose.model(
  "TxEvent",
  new mongoose.Schema({
    sender: String,
    amount: Number,
    ticket: Number,
    endorser: String,
    timestamp: { type: Date, default: Date.now },
  })
);

export async function addRaffle(params: any = {}) {
  return new Promise(async (resolve) => {
    if (useMemoryStore) {
      try {
        let item = memoryState.raffle;

        if (
          item &&
          Date.now() - item.timestamp.getTime() >
            item.duration * ONE_HOUR_MS
        ) {
          item.prize =
            params.prize !== undefined ? params.prize : item.prize ?? 0;
          item.duration =
            params.duration !== undefined ? params.duration : item.duration ?? 0;
          item.winner =
            params.winner !== undefined ? params.winner : item.winner ?? "0x00";
          item.timestamp =
            params.timestamp !== undefined
              ? new Date(params.timestamp)
              : new Date();
          memoryState.txEvents = [];
          resolve(true);
          return;
        } else if (!item) {
          memoryState.raffle = {
            prize: params.prize ?? 0,
            duration: params.duration ?? 0,
            winner: params.winner ?? "0x00",
            timestamp:
              params.timestamp !== undefined
                ? new Date(params.timestamp)
                : new Date(),
          };
          resolve(true);
          return;
        }
        resolve(false);
      } catch (err) {
        resolve(false);
      }
      return;
    }

    try {
      let item: any = await selectRaffle();

      if (
        item &&
        Date.now() - new Date(item.timestamp).getTime() >
          item.duration * 60 * 60 * 1000
      ) {
        if (params.prize !== undefined) item.prize = params.prize;
        if (params.duration !== undefined) item.duration = params.duration;
        if (params.winner !== undefined) item.winner = params.winner;
        if (params.timestamp !== undefined) {
          item.timestamp = params.timestamp;
        } else {
          item.timestamp = Date.now();
        }

        await item.save();
        await TxEventSchema.deleteMany({});
        resolve(true);
      } else if (!item) {
        item = new RaffleSchema();
        item.prize = params.prize;
        item.duration = params.duration;
        item.winner = params.winner;
        await item.save();
        resolve(true);
      }
      resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

export async function selectRaffle(params = {}) {
  return new Promise(async (resolve) => {
    if (useMemoryStore) {
      if (!memoryState.raffle) {
        resolve(null);
        return;
      }
      if (Object.keys(params).length === 0) {
        resolve(memoryState.raffle);
        return;
      }
      resolve(matchesParams(memoryState.raffle, params) ? memoryState.raffle : null);
      return;
    }
    RaffleSchema.findOne(params).then(async (raffle) => {
      resolve(raffle);
    });
  });
}

export async function addTxEvent(params: any = {}) {
  return new Promise(async (resolve) => {
    if (useMemoryStore) {
      try {
        const raffle = memoryState.raffle;
        if (
          raffle &&
          Date.now() - raffle.timestamp.getTime() <
            raffle.duration * ONE_HOUR_MS
        ) {
          const ticket = Math.floor(params.amount);
          memoryState.txEvents.push({
            sender: params.sender,
            amount: params.amount,
            ticket,
            endorser:
              params.endorser !== undefined && params.endorser !== null
                ? String(params.endorser)
                : null,
            timestamp: new Date(),
          });
          resolve(true);
          return;
        }
        resolve(false);
      } catch (err) {
        resolve(false);
      }
      return;
    }

    try {
      let raffle: any = await selectRaffle();
      if (
        raffle &&
        Date.now() - new Date(raffle.timestamp).getTime() <
          raffle.duration * 60 * 60 * 1000
      ) {
        const item = new TxEventSchema();
        item.sender = params.sender;
        item.amount = params.amount;
        item.ticket = Math.floor(params.amount);
        item.endorser = params.endorser;
        await item.save();
        resolve(true);
      }
      resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

export async function getTotalTickets(params = {}) {
  return new Promise(async (resolve) => {
    if (useMemoryStore) {
      const items = memoryState.txEvents.filter((item) =>
        matchesParams(item, params)
      );
      const totalTicket = items.reduce((sum, item) => sum + item.ticket, 0);
      resolve(totalTicket);
      return;
    }
    TxEventSchema.find(params).then(async (items) => {
      const totalTicket = items.reduce((sum, item) => sum + item.ticket, 0);
      resolve(totalTicket);
    });
  });
}

export async function getEndorseCountByDay(params = {}) {
  return new Promise((resolve) => {
    if (useMemoryStore) {
      const items = memoryState.txEvents.filter((item) =>
        matchesParams(item, params)
      );
      resolve(items.length);
      return;
    }
    TxEventSchema.find(params).then((items) => {
      const count = items.length;
      resolve(count);
    });
  });
}

export async function getTotalSenders(params = {}) {
  return new Promise(async (resolve) => {
    if (useMemoryStore) {
      const items = memoryState.txEvents.filter((item) =>
        matchesParams(item, params)
      );
      const uniqueSenders = new Set(items.map((item) => item.sender)).size;
      resolve(uniqueSenders);
      return;
    }
    TxEventSchema.find(params).then(async (items) => {
      const uniqueSenders = new Set(items.map((item) => item.sender)).size;
      resolve(uniqueSenders);
    });
  });
}

export async function getRaffleWinner(params = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      if (useMemoryStore) {
        const raffle = memoryState.raffle;
        if (raffle && raffle.winner !== "0x00") {
          resolve(raffle.winner);
          return;
        }

        const items = memoryState.txEvents.filter((item) =>
          matchesParams(item, params)
        );
        if (items.length === 0) {
          resolve(null);
          return;
        }

        const ticketsBySender = items.reduce<Record<string, number>>(
          (acc, item) => {
            acc[item.sender] = (acc[item.sender] || 0) + item.ticket;
            return acc;
          },
          {}
        );

        Object.entries(ticketsBySender).forEach(([sender, tickets]) => {
          ticketsBySender[sender] = instance.getTickets(Number(tickets));
        });

        const totalTickets = Object.values(ticketsBySender).reduce(
          (sum: number, tickets: number) => sum + tickets,
          0
        );
        const winningTicket = Math.floor(Math.random() * Number(totalTickets));

        let cumulativeTickets = 0;
        for (const [sender, tickets] of Object.entries(ticketsBySender)) {
          cumulativeTickets += Number(tickets);
          if (winningTicket < cumulativeTickets) {
            if (raffle) {
              memoryState.raffle = {
                ...raffle,
                winner: sender,
              };
            }
            resolve(sender);
            return;
          }
        }
        resolve(null);
        return;
      }

      const raffle: any = await selectRaffle();
      if (raffle && raffle.winner !== "0x00") {
        resolve(raffle.winner);
        return;
      }

      const items = await TxEventSchema.find(params);
      if (items.length === 0) {
        resolve(null);
        return;
      }

      const ticketsBySender = items.reduce((acc, item) => {
        acc[item.sender] = (acc[item.sender] || 0) + item.ticket;
        return acc;
      }, {});

      Object.entries(ticketsBySender).forEach(([sender, tickets]) => {
        ticketsBySender[sender] = instance.getTickets(tickets as number);
      });

      const totalTickets = Object.values(ticketsBySender).reduce(
        (sum: number, tickets: number) => sum + tickets,
        0
      );
      const winningTicket = Math.floor(Math.random() * Number(totalTickets));

      console.log("winningTicket = ", winningTicket);

      let cumulativeTickets = 0;
      for (const [sender, tickets] of Object.entries(ticketsBySender)) {
        cumulativeTickets += Number(tickets);
        if (winningTicket < cumulativeTickets) {
          if (raffle) {
            await addRaffle({
              prize: raffle.prize,
              duration: raffle.duration,
              winner: sender,
              timestamp: raffle.timestamp,
            });
          }
          resolve(sender);
          return;
        }
      }
      resolve(null);
    } catch (err) {
      reject(err);
    }
  });
}

export async function getTopHolders(params = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      if (useMemoryStore) {
        const items = memoryState.txEvents.filter((item) =>
          matchesParams(item, params)
        );
        if (items.length === 0) {
          resolve(null);
          return;
        }

        const ticketsBySender = items.reduce<Record<string, number>>(
          (acc, item) => {
            acc[item.sender] = (acc[item.sender] || 0) + item.ticket;
            return acc;
          },
          {}
        );

        Object.entries(ticketsBySender).forEach(([sender, tickets]) => {
          ticketsBySender[sender] = instance.getTickets(Number(tickets));
        });

        const sortedSenders = Object.entries(ticketsBySender).sort(
          ([, ticketsA], [, ticketsB]) =>
            Number(ticketsB) - Number(ticketsA)
        );

        const senderRanking = [];
        for (const [sender, tickets] of sortedSenders) {
          const name = await fetchSuiNsName(sender);
          senderRanking.push({ sender: name, tickets });
        }

        const topSenders = senderRanking
          .slice(0, 10)
          .map(
            (item, index) =>
              `${instance.getHolderRankingLogo(index)} <code>${
                item.sender
              }</code> ${item.tickets.toLocaleString()}`
          )
          .join("\n");

        resolve(topSenders);
        return;
      }

      const items = await TxEventSchema.find(params);
      if (items.length === 0) {
        resolve(null);
        return;
      }

      const ticketsBySender = items.reduce((acc, item) => {
        acc[item.sender] = (acc[item.sender] || 0) + item.ticket;
        return acc;
      }, {});

      Object.entries(ticketsBySender).forEach(([sender, tickets]) => {
        ticketsBySender[sender] = instance.getTickets(Number(tickets));
      });

      // console.log("ticketsBySender2 = ", ticketsBySender);

      const sortedSenders = Object.entries(ticketsBySender).sort(
        ([, ticketsA], [, ticketsB]) => Number(ticketsB) - Number(ticketsA)
      );

      let senderRanking = [];
      let name = "";

      for (const [sender, tickets] of sortedSenders) {
        name = await fetchSuiNsName(sender);
        senderRanking.push({ sender: name, tickets: tickets });
      }

      const topSenders = senderRanking
        .slice(0, 10)
        .map(
          (item, index) =>
            `${instance.getHolderRankingLogo(index)} <code>${
              item.sender
            }</code> ${item.tickets.toLocaleString()}`
        )
        .join("\n");

      // console.log("topSenders = ", topSenders);

      resolve(topSenders);
    } catch (err) {
      reject(err);
    }
  });
}
