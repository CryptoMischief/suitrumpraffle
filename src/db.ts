import mongoose from 'mongoose';

import * as instance from './utils';
import { fetchSuiNsName } from './web3';

export const init = () => {
  return new Promise(async (resolve: any, reject: any) => {
    mongoose
      .connect(`mongodb://localhost:27017/${process.env.DB_NAME}`)
      .then(() => {
        console.log(`Connected to MongoDB "${process.env.DB_NAME}"...`);
        resolve();
      })
      .catch((err) => {
        console.error("Could not connect to MongoDB...", err);
        reject();
      });
  });
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
    RaffleSchema.findOne(params).then(async (raffle) => {
      resolve(raffle);
    });
  });
}

export async function addTxEvent(params: any = {}) {
  return new Promise(async (resolve) => {
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
    TxEventSchema.find(params).then(async (items) => {
      const totalTicket = items.reduce((sum, item) => sum + item.ticket, 0);
      resolve(totalTicket);
    });
  });
}

export async function getEndorseCountByDay(params = {}) {
  return new Promise((resolve) => {
    TxEventSchema.find(params).then((items) => {
      const count = items.length;
      resolve(count);
    });
  });
}

export async function getTotalSenders(params = {}) {
  return new Promise(async (resolve) => {
    TxEventSchema.find(params).then(async (items) => {
      const uniqueSenders = new Set(items.map((item) => item.sender)).size;
      resolve(uniqueSenders);
    });
  });
}

export async function getRaffleWinner(params = {}) {
  return new Promise(async (resolve, reject) => {
    try {
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
