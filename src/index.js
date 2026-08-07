import { QUIZ_QUESTIONS, QUESTION_COUNT } from './questions.js';

const BOT_TOKEN = "8878135109:AAGfF679A-zFsW8sunqXIlJazU0LYH7SW2Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const OWNER_ID = 123456789;
const DEFAULT_TIMER = 15;
const DEFAULT_QUESTION_COUNT = QUESTION_COUNT;

const ROLE = { OWNER: 'OWNER', HOST: 'HOST', PARTICIPANT: 'PARTICIPANT' };
const VERIFICATION_STATUS = { PENDING: 'PENDING', VERIFIED: 'VERIFIED', REJECTED: 'REJECTED', REVOKED: 'REVOKED' };
const QUIZ_STATE = { INACTIVE: 'INACTIVE', ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ENDED: 'ENDED' };

const hosts = new Set([OWNER_ID]);
const quizSessions = new Map();
const participantRecords = new Map();
const globalScores = new Map();
const cleanupLog = [];

function normalizeAnswer(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s/g, '');
}

function checkAnswer(normalizedAnswer, question) {
  const correct = normalizeAnswer(question.correctAnswer);
  if (normalizedAnswer === correct) return true;
  for (const accepted of question.acceptedAnswers) {
    if (normalizedAnswer === normalizeAnswer(accepted)) return true;
  }
  return false;
}

function getUserRole(userId) {
  if (userId === OWNER_ID) return ROLE.OWNER;
  if (hosts.has(userId)) return ROLE.HOST;
  const record = participantRecords.get(userId);
  if (record && record.verificationStatus === VERIFICATION_STATUS.VERIFIED) return ROLE.PARTICIPANT;
  return null;
}

function isAuthorized(userId, minRole) {
  const role = getUserRole(userId);
  if (!role) return false;
  const rank = { [ROLE.PARTICIPANT]: 1, [ROLE.HOST]: 2, [ROLE.OWNER]: 3 };
  return rank[role] >= rank[minRole];
}

function formatDisplayName(user) {
  if (user.first_name && user.last_name) return `${user.first_name} ${user.last_name}`;
  return user.first_name || user.username || 'Unknown';
}

async function tgMethod(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tgMethod('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tgMethod('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
}

async function deleteMessage(chatId, messageId) {
  return tgMethod('deleteMessage', { chat_id: chatId, message_id: messageId });
}

async function unbanChatMember(chatId, userId) {
  return tgMethod('unbanChatMember', { chat_id: chatId, user_id: userId });
}

async function banUser(chatId, userId, deleteMessages = true) {
  return tgMethod('banChatMember', { chat_id: chatId, user_id: userId, delete_message: deleteMessages });
}

async function answerCallbackQuery(callbackId, text = '', showAlert = false) {
  return tgMethod('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: showAlert });
}

function createQuizSession(chatId, hostId, questionCount, timerSeconds) {
  const quizId = `quiz_${chatId}_${Date.now()}`;
  const session = {
    quizId,
    chatId,
    hostId,
    state: QUIZ_STATE.ACTIVE,
    currentQuestion: 0,
    questionCount,
    timerSeconds,
    answers: [],
    scores: new Map(),
    questionStartTime: null,
    questionMessageId: null,
    timerId: null,
    isFirstCorrect: new Set(),
    createdAt: Date.now(),
    participantIds: [],
  };
  quizSessions.set(chatId, session);
  return session;
}

async function publishQuestion(chatId, session) {
  const qIndex = session.currentQuestion;
  if (qIndex >= session.questionCount) {
    await finishQuiz(chatId, session);
    return;
  }

  const q = QUIZ_QUESTIONS[qIndex];
  if (!q) {
    await finishQuiz(chatId, session);
    return;
  }

  session.questionStartTime = Date.now();
  session.isFirstCorrect.clear();

  const questionText = `🧠 <b>Question ${qIndex + 1}/${session.questionCount}</b>\n\n${q.question}\n\n⏱️ ${session.timerSeconds}s | Reply with your answer!`;

  const sent = await sendMessage(chatId, questionText);
  if (sent.message_id) {
    session.questionMessageId = sent.message_id;
  }

  if (session.timerId) clearTimeout(session.timerId);
  session.timerId = setTimeout(() => {
    handleTimerExpiry(chatId, session);
  }, session.timerSeconds * 1000);
}

async function handleTimerExpiry(chatId, session) {
  const currentSession = quizSessions.get(chatId);
  if (!currentSession || currentSession.state !== QUIZ_STATE.ACTIVE) return;
  if (currentSession.currentQuestion !== session.currentQuestion) return;

  const qIndex = currentSession.currentQuestion;
  const q = QUIZ_QUESTIONS[qIndex];

  await sendMessage(chatId, `⏰ <b>Time's up!</b> Answers for Question ${qIndex + 1} are now closed.`);

  const correctCount = currentSession.answers
    .filter(a => a.questionId === q.id && a.correct).length;

  await sendMessage(chatId, `📊 Question ${qIndex + 1} results: ${correctCount} correct answer(s).`);

  currentSession.currentQuestion++;
  await publishQuestion(chatId, currentSession);
}

async function handleAnswer(chatId, userId, displayName, username, text) {
  const session = quizSessions.get(chatId);
  if (!session || session.state !== QUIZ_STATE.ACTIVE) return;

  if (!session.participantIds.includes(userId)) {
    const role = getUserRole(userId);
    if (role !== ROLE.HOST && role !== ROLE.OWNER) return;
  }

  const questionStartTime = session.questionStartTime;
  if (!questionStartTime) return;

  const elapsed = Date.now() - questionStartTime;
  const timeLimit = session.timerSeconds * 1000;
  if (elapsed >= timeLimit) return;

  if (session.answers.some(a => a.userId === userId && a.questionId === QUIZ_QUESTIONS[session.currentQuestion].id)) return;

  const q = QUIZ_QUESTIONS[session.currentQuestion];
  if (!q) return;

  const rawAnswer = text;
  const normalized = normalizeAnswer(text);
  const isCorrect = checkAnswer(normalized, q);
  const points = isCorrect ? (session.isFirstCorrect.has(userId) ? 0.5 : 1) : 0;

  const answerRecord = {
    userId,
    displayName,
    username,
    questionId: q.id,
    timestamp: Date.now(),
    rawAnswer,
    normalizedAnswer: normalized,
    correct: isCorrect,
    points: isCorrect ? q.points : 0,
  };

  session.answers.push(answerRecord);

  if (isCorrect && !session.isFirstCorrect.has(userId)) {
    session.isFirstCorrect.add(userId);
  }

  let userScore = session.scores.get(userId);
  if (!userScore) {
    userScore = { displayName, username, score: 0, correctCount: 0, wrongCount: 0 };
    session.scores.set(userId, userScore);
  }
  userScore.score += isCorrect ? q.points : 0;
  if (isCorrect) userScore.correctCount++;
  else userScore.wrongCount++;
}

async function finishQuiz(chatId, session) {
  session.state = QUIZ_STATE.ENDED;
  if (session.timerId) clearTimeout(session.timerId);

  const sorted = Array.from(session.scores.entries())
    .map(([uid, data]) => ({ uid, ...data }))
    .sort((a, b) => b.score - a.score);

  let results = `🏁 <b>QUIZ COMPLETE!</b>\n\n`;
  results += `📊 <b>Final Results:</b>\n`;
  sorted.forEach((entry, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    results += `${medal} ${entry.displayName} — ${entry.score} points (${entry.correctCount}✅, ${entry.wrongCount}❌)\n`;
  });

  if (sorted.length === 0) {
    results += `\nNo one answered correctly. Better luck next time!`;
  }

  results += `\n\nWinner: ${sorted[0]?.displayName || 'N/A'} — ${sorted[0]?.score || 0} points`;

  await sendMessage(chatId, results);

  for (const [uid, data] of sorted) {
    const existing = globalScores.get(uid);
    if (existing) {
      existing.totalScore += data.score;
      existing.quizzesTaken += 1;
      if (data.score > existing.bestScore) existing.bestScore = data.score;
    } else {
      globalScores.set(uid, {
        displayName: data.displayName,
        totalScore: data.score,
        quizzesTaken: 1,
        bestScore: data.score,
      });
    }
  }

  await cleanupQuiz(chatId, session);
}

async function cleanupQuiz(chatId, session) {
  const errors = [];

  const participants = session.participantIds;
  for (const pid of participants) {
    try {
      const result = await banUser(chatId, pid, false);
      if (!result.ok) {
        await unbanChatMember(chatId, pid);
        try { await banUser(chatId, pid); } catch { /* ignore */ }
      }
    } catch (e) {
      errors.push(`Failed to remove user ${pid}: ${e.message || 'unknown'}`);
    }
  }

  if (session.questionMessageId) {
    try {
      await deleteMessage(chatId, session.questionMessageId);
    } catch (e) {
      errors.push(`Failed to delete question message: ${e.message || 'unknown'}`);
    }
  }

  quizSessions.delete(chatId);

  if (errors.length > 0) {
    cleanupLog.push({ chatId, quizId: session.quizId, timestamp: Date.now(), errors });
    await sendMessage(chatId, `🧹 <b>Cleanup notes:</b>\n${errors.map(e => `• ${e}`).join('\n')}\n\nRoom is now closed. New quiz uses a fresh room.`);
  } else {
    await sendMessage(chatId, `🧹 <b>Quiz room cleaned.</b>\nAll participants removed.\nSee you next quiz! 🚀`);
  }
}

async function sendStartMenu(chatId, userName) {
  await sendMessage(chatId,
    `👋 <b>Welcome to Kiwi Quiz Bot!</b>\n\nI'll help you learn through live interactive quizzes.\n\n📋 <b>Available Commands:</b>\n/start — Show this menu\n/quiz — Host: start a quiz\n/score — Check your score\n/leaderboard — See top performers\n/help — Show help\n\nHost: use /quiz [question_count] [timer_seconds]\nExample: /quiz 10 30`,
    {
      reply_markup: {
        keyboard: [
          [{ text: '🧠 Start Quiz' }, { text: '📊 My Score' }],
          [{ text: '🏆 Leaderboard' }, { text: '📖 Help' }]
        ],
        resize_keyboard: true
      }
    }
  );
}

async function sendHelp(chatId) {
  await sendMessage(chatId,
    `<b>📚 Kiwi Quiz Bot — Help</b>\n\n` +
    `<b>Host Commands:</b>\n` +
    `/quiz [count] [timer] — Start a new quiz (host only)\n` +
    `/next — Advance to next question (host only)\n` +
    `/pause — Pause the current question (host only)\n` +
    `/resume — Resume the current question (host only)\n` +
    `/endquiz — End the quiz early (host only)\n` +
    `/verify [user_id] — Approve a participant (host only)\n` +
    `/addhost [user_id] — Add a host (owner only)\n` +
    `/removehost [user_id] — Remove a host (owner only)\n\n` +
    `<b>Participant Commands:</b>\n` +
    `/quiz — Check if a quiz is running\n` +
    `/score — View your score\n` +
    `/leaderboard — View top performers\n\n` +
    `<b>Answering:</b>\n` +
    `During a quiz, simply type your answer in the group chat!`
  );
}

async function sendLeaderboard(chatId) {
  if (globalScores.size === 0) {
    await sendMessage(chatId, `🏆 <b>Leaderboard</b>\n\nNo scores yet. Be the first to take a quiz! 🏆\n\nUse /quiz to start (hosts only).`);
    return;
  }

  const sorted = Array.from(globalScores.entries())
    .map(([uid, data]) => ({ uid, ...data }))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10);

  let msg = `🏆 <b>Top Performers</b>\n\n`;
  sorted.forEach((entry, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    msg += `${medal} ${entry.displayName} — ${entry.totalScore} pts (${entry.quizzesTaken} quiz${entry.quizzesTaken > 1 ? 'es' : ''}, best: ${entry.bestScore})\n`;
  });

  await sendMessage(chatId, msg);
}

async function sendScore(chatId, userId, displayName) {
  const score = globalScores.get(userId);
  if (!score) {
    await sendMessage(chatId, `📊 <b>${displayName}</b>\n\nNo quiz results yet.\n\nParticipate in a quiz to earn points!`);
    return;
  }
  await sendMessage(chatId,
    `📊 <b>${displayName}</b>'s Stats\n\n` +
    `🏆 Total Score: ${score.totalScore}\n` +
    `🎯 Quizzes Taken: ${score.quizzesTaken}\n` +
    `⭐ Best Score: ${score.bestScore}\n\n` +
    `Keep going! 💪`
  );
}

async function sendPending(chatId, userId, displayName, userName) {
  const pending = [];
  for (const [recordId, record] of participantRecords.entries()) {
    if (record.verificationStatus === VERIFICATION_STATUS.PENDING) {
      pending.push({
        userId: recordId,
        displayName: record.displayName,
        username: record.username,
        status: record.verificationStatus,
      });
    }
  }

  if (pending.length === 0) {
    await sendMessage(chatId, `📋 No pending verification requests.`);
    return;
  }

  let msg = `📋 <b>Pending Verification Requests</b>\n\n`;
  for (const p of pending) {
    msg += `🆔 ${p.userId} | ${p.displayName}` + (p.username ? ` (@${p.username})` : '') + `\n`;
  }

  await sendMessage(chatId, msg);
}

async function handleStartCommand(chatId, userId, firstName, lastName, username) {
  const role = getUserRole(userId);
  const displayName = formatDisplayName({ first_name: firstName, last_name: lastName, username });
  await sendStartMenu(chatId, displayName);
}

async function handleQuizCommand(chatId, userId, firstName, lastName, username, args, ctx) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    const displayName = formatDisplayName({ first_name: firstName, last_name: lastName, username });
    const session = quizSessions.get(chatId);
    if (session && session.state === QUIZ_STATE.ACTIVE) {
      await sendMessage(chatId, `💡 A quiz is currently running! Wait for the next question.`);
      return;
    }
    await sendMessage(chatId, `⚠️ ${displayName}, only authorized hosts can start a quiz.`);
    return;
  }

  if (quizSessions.has(chatId)) {
    await sendMessage(chatId, `⚠️ A quiz session is already active in this group.`);
    return;
  }

  const questionCount = parseInt(args[0]) || DEFAULT_QUESTION_COUNT;
  const timerSeconds = parseInt(args[1]) || DEFAULT_TIMER;

  const session = createQuizSession(chatId, userId, questionCount, timerSeconds);

  await sendMessage(chatId, `🚀 <b>Quiz Starting!</b>\n\n${questionCount} questions | ⏱️ ${timerSeconds}s per question\n\nParticipants: please wait for questions.`);

  await publishQuestion(chatId, session);
}

async function handleNextCommand(chatId, userId) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    await sendMessage(chatId, `⚠️ Only hosts can advance to the next question.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session || session.state !== QUIZ_STATE.ACTIVE) {
    await sendMessage(chatId, `⚠️ No active quiz in this group.`);
    return;
  }

  if (session.timerId) clearTimeout(session.timerId);

  session.currentQuestion++;
  await publishQuestion(chatId, session);
}

async function handlePauseCommand(chatId, userId) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    await sendMessage(chatId, `⚠️ Only hosts can pause the quiz.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session) {
    await sendMessage(chatId, `⚠️ No active quiz.`);
    return;
  }

  if (session.state === QUIZ_STATE.PAUSED) {
    await sendMessage(chatId, `⏸️ Quiz is already paused.`);
    return;
  }

  session.state = QUIZ_STATE.PAUSED;
  if (session.timerId) clearTimeout(session.timerId);
  session.timerId = null;
  await sendMessage(chatId, `⏸️ <b>Quiz paused.</b> Host can resume with /resume`);
}

async function handleResumeCommand(chatId, userId) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    await sendMessage(chatId, `⚠️ Only hosts can resume the quiz.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session) {
    await sendMessage(chatId, `⚠️ No paused quiz found.`);
    return;
  }

  if (session.state !== QUIZ_STATE.PAUSED) {
    await sendMessage(chatId, `⚠️ Quiz is not paused.`);
    return;
  }

  session.state = QUIZ_STATE.ACTIVE;
  const elapsed = Date.now() - session.questionStartTime;
  const remaining = session.timerSeconds * 1000 - elapsed;

  if (remaining <= 0) {
    await handleTimerExpiry(chatId, session);
    return;
  }

  session.timerId = setTimeout(() => {
    handleTimerExpiry(chatId, session);
  }, remaining);

  await sendMessage(chatId, `▶️ <b>Quiz resumed!</b> ${Math.ceil(remaining / 1000)}s remaining.`);
}

async function handleEndQuizCommand(chatId, userId) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    await sendMessage(chatId, `⚠️ Only hosts can end the quiz.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session) {
    await sendMessage(chatId, `⚠️ No active quiz to end.`);
    return;
  }

  session.state = QUIZ_STATE.ENDED;
  if (session.timerId) clearTimeout(session.timerId);

  await sendMessage(chatId, `🛑 <b>Quiz ended by host.</b>`);
  await finishQuiz(chatId, session);
}

async function handleVerifyCommand(chatId, userId, args) {
  const role = getUserRole(userId);
  if (!isAuthorized(userId, ROLE.HOST)) {
    await sendMessage(chatId, `⚠️ Only hosts can verify participants.`);
    return;
  }

  const targetId = parseInt(args[0]);
  if (!targetId) {
    await sendPending(chatId);
    return;
  }

  const record = participantRecords.get(targetId);
  if (!record) {
    await sendMessage(chatId, `⚠️ User ${targetId} has not requested verification.`);
    return;
  }

  record.verificationStatus = VERIFICATION_STATUS.VERIFIED;
  record.verifiedBy = userId;
  record.verifiedAt = Date.now();

  await sendMessage(chatId,
    `✅ <b>User verified!</b>\n` +
    `ID: ${targetId}\n` +
    `Name: ${record.displayName}\n` +
    `Status: ${record.verificationStatus}\n\n` +
    `They are now eligible to participate in quizzes.`
  );

  if (record.requestChatId) {
    try {
      await sendMessage(record.requestChatId,
        `🎉 Your verification is complete! You can now participate in quizzes.\n\n` +
        `When a quiz starts, simply type your answer in the group chat. Good luck! 🍀`
      );
    } catch { /* ignore if user hasn't started a private chat */ }
  }
}

async function handleAddHostCommand(chatId, userId, args) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, `⚠️ Only the owner can add hosts.`);
    return;
  }

  const targetId = parseInt(args[0]);
  if (!targetId) {
    await sendMessage(chatId, `Usage: /addhost [user_id]`);
    return;
  }

  if (hosts.has(targetId)) {
    await sendMessage(chatId, `⚠️ User ${targetId} is already a host.`);
    return;
  }

  hosts.add(targetId);
  await sendMessage(chatId, `✅ User ${targetId} has been added as a host.`);
}

async function handleRemoveHostCommand(chatId, userId, args) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, `⚠️ Only the owner can remove hosts.`);
    return;
  }

  const targetId = parseInt(args[0]);
  if (!targetId) {
    await sendMessage(chatId, `Usage: /removehost [user_id]`);
    return;
  }

  if (targetId === OWNER_ID) {
    await sendMessage(chatId, `⚠️ Cannot remove the owner.`);
    return;
  }

  if (hosts.delete(targetId)) {
    await sendMessage(chatId, `✅ User ${targetId} has been removed as a host.`);
  } else {
    await sendMessage(chatId, `⚠️ User ${targetId} is not a host.`);
  }
}

async function handleAnswerSubmission(chatId, userId, firstName, lastName, username, text) {
  const session = quizSessions.get(chatId);
  if (!session || session.state !== QUIZ_STATE.ACTIVE) return;

  const role = getUserRole(userId);

  if (role === ROLE.HOST || role === ROLE.OWNER) return;

  if (role === null) {
    if (!participantRecords.has(userId)) {
      participantRecords.set(userId, {
        telegramUserId: userId,
        username: username,
        displayName: formatDisplayName({ first_name: firstName, last_name: lastName, username }),
        verificationStatus: VERIFICATION_STATUS.PENDING,
        verificationSource: 'chat_join',
        quizId: session.quizId,
        eligible: false,
        joinedAt: Date.now(),
      });

      if (!session.participantIds.includes(userId)) {
        session.participantIds.push(userId);
      }

      await sendMessage(chatId,
        `📝 ${formatDisplayName({ first_name: firstName, last_name: lastName, username })}, to participate you must be verified first.\n\n` +
        `Please send /verify_request in a private message to the host, or your host will verify you with /verify [user_id].\n\n` +
        `You've been registered as a pending participant.`
      );
      return;
    }
    return;
  }

  if (role === ROLE.PARTICIPANT) {
    if (!session.participantIds.includes(userId)) {
      session.participantIds.push(userId);
    }
  }

  await handleAnswer(chatId, userId, formatDisplayName({ first_name: firstName, last_name: lastName, username }), username, text);
}

async function handleMessage(message, ctx) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;
  const username = message.from.username;
  const text = message.text || '';
  const chatType = message.chat.type;

  const session = quizSessions.get(chatId);
  const commandMatch = text.match(/^\/([a-zA-Z_]+)(?:\s+(.*))?$/);

  if (commandMatch) {
    const command = commandMatch[1];
    const argsStr = commandMatch[2] || '';
    const args = argsStr.trim().split(/\s+/).filter(Boolean);

    switch (command) {
      case 'start':
        await handleStartCommand(chatId, userId, firstName, lastName, username);
        break;
      case 'help':
        await sendHelp(chatId);
        break;
      case 'quiz':
        await handleQuizCommand(chatId, userId, firstName, lastName, username, args, ctx);
        break;
      case 'next':
        await handleNextCommand(chatId, userId);
        break;
      case 'pause':
        await handlePauseCommand(chatId, userId);
        break;
      case 'resume':
        await handleResumeCommand(chatId, userId);
        break;
      case 'endquiz':
        await handleEndQuizCommand(chatId, userId);
        break;
      case 'verify':
        await handleVerifyCommand(chatId, userId, args);
        break;
      case 'addhost':
        await handleAddHostCommand(chatId, userId, args);
        break;
      case 'removehost':
        await handleRemoveHostCommand(chatId, userId, args);
        break;
      case 'score':
        await sendScore(chatId, userId, formatDisplayName({ first_name: firstName, last_name: lastName, username }));
        break;
      case 'leaderboard':
        await sendLeaderboard(chatId);
        break;
      case 'startquiz':
        if (session && session.state === QUIZ_STATE.ACTIVE) {
          await sendMessage(chatId, `⚠️ A quiz is already running.`);
          return;
        }
        await handleQuizCommand(chatId, userId, firstName, lastName, username, [], ctx);
        break;
      default:
        await sendMessage(chatId, `❓ Unknown command. Try /help`);
    }
    return;
  }

  if (text.startsWith('🧠 Start Quiz') || text.startsWith('📊 My Score') || text.startsWith('🏆 Leaderboard') || text.startsWith('📖 Help')) {
    if (text.startsWith('🧠 Start Quiz')) {
      await handleQuizCommand(chatId, userId, firstName, lastName, username, [], ctx);
    } else if (text.startsWith('📊 My Score')) {
      await sendScore(chatId, userId, formatDisplayName({ first_name: firstName, last_name: lastName, username }));
    } else if (text.startsWith('🏆 Leaderboard')) {
      await sendLeaderboard(chatId);
    } else if (text.startsWith('📖 Help')) {
      await sendHelp(chatId);
    }
    return;
  }

  if (session && session.state === QUIZ_STATE.ACTIVE && session.questionStartTime) {
    const elapsed = Date.now() - session.questionStartTime;
    if (elapsed < session.timerSeconds * 1000) {
      await handleAnswerSubmission(chatId, userId, firstName, lastName, username, text);
    }
  }
}

async function handleCallbackQuery(callback, ctx) {
  const callbackId = callback.id;
  const userId = callback.from.id;
  const firstName = callback.from.first_name;
  const lastName = callback.from.last_name;
  const username = callback.from.username;
  const data = callback.data;
  const chatId = callback.message.chat.id;
  const displayName = formatDisplayName({ first_name: firstName, last_name: lastName, username });

  await answerCallbackQuery(callbackId, '', false);

  switch (data) {
    case 'menu_start':
      await handleStartCommand(chatId, userId, firstName, lastName, username);
      break;
    case 'menu_score':
      await sendScore(chatId, userId, displayName);
      break;
    case 'menu_leaderboard':
      await sendLeaderboard(chatId);
      break;
    case 'menu_help':
      await sendHelp(chatId);
      break;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('✅ Kiwi Bot is running!', { status: 200 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        await handleMessage(update.message, ctx);
      }

      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, ctx);
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('❌ Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
};
