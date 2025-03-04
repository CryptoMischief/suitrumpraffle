export const sessions = new Map();

export const initSession = (message) => {
  const sessionId = getSessionId(message);
  if (!isExistSession(sessionId)) {
    const fromId = message?.from?.id;
    const chatId = message?.chat?.id;
    const username = message?.chat?.username;
    const type = message?.chat?.type;

    const session = {
      fromId: fromId ? fromId : undefined,
      chatId: chatId ? chatId : undefined,
      username: username ? username : undefined,
      type: type ? type : "private",
    };

    console.log(`======== init session: ${session.fromId}-${session.chatId}`);
    sessions.set(`${session.fromId}-${session.chatId}`, session);

    return session;
  }

  return getSession(sessionId);
};

const getSessionId = (message) => {
  return `${message.from.id}-${message.chat.id}`;
};

const getSession = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    throw "NO SESSION on getSession";
  }
  return session;
};

const isExistSession = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }
  return true;
};