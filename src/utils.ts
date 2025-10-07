import TelegramBot from "node-telegram-bot-api";

export const sendMessageOption: TelegramBot.SendMessageOptions = {
  disable_web_page_preview: true,
  parse_mode: TelegramBot.ParseMode.HTML,  // Use the enum for type safety
};

export function calculateTime(time: number) {
  const days = Math.floor(time / (1000 * 60 * 60 * 24));
  const hours = Math.floor((time % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((time % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((time % (1000 * 60)) / 1000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  if (seconds > 0) return `${seconds}s`;
  return `0s`;
}

export const isGroupMsg = (msgType: string) => {
  if (msgType === "supergroup" || msgType === "group") {
    return true;
  }
  return false;
};

export const getHelpMessage = () => {
  const message =`📝 Support commands\n
/start - Start Monitoring(Group Owner Only)
/stop - Stop Monitoring(Group Owner Only)
/startraffle - Start Raffle (Admin, e.g., /startraffle 50 24)
/addtickets - Add Tickets (Admin, e.g., /addtickets 0x123 100)
/endorse - Endorse user (e.g., /endorse @SuiNs message)
/rafflestats - Show Raffle Stats
/leaderboard - Show Ticket Holders Ranking
/ticket <code>0x03f855...56fe4</code> - Show Ticket Amount
/help - Show Support Commands`;
  return message;
}

export function shortenAddress(address: string) {
  if (!address || address.length < 12) return address;
  return `${address.substring(0, 6)}...${address.substring(
    address.length - 4,
    address.length
  )}`;
}

export function getTickets(count: number) {
  if (count < 1) return 0;
  if (count < 10 ** 6) return count;
  if (count < 5 * 10 ** 6) return Math.floor(count * 1.03);
  if (count < 2 * 10 ** 7) return Math.floor(count * 1.06);
  if (count < 5 * 10 ** 7) return Math.floor(count * 1.08);
  return Math.floor(count * 1.1);
}

export const getHolderRankingLogo = (index: number) => {
	let logo: string;
	switch (index) {
		case 0:
			logo = '🥇';
			break;
		case 1:
			logo = '🥈';
			break;
		case 2:
			logo = '🥉';
			break;
		case 3:
			logo = '🚀';
			break;
		default:
			logo = '🔥';
	}
	return logo;
}

export const ENDORSE_BONUS = 5000;

export const ENDORSE_DISABLED = 0;
export const IS_ALREADY_ENDORSED = 1;
export const ENDORSE_EXCEEDS = 2;
export const ENDORSE_ENABLED = 3;
