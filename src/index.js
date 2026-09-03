import { QUIZ_QUESTIONS, QUESTION_COUNT } from './questions.js';
import { KiwiState, ELIGIBILITY, REFERRAL_STATUS } from './kiwi-state.js';

let ROOT_ADMIN_ID = 7224762410;
let TELEGRAM_API;
const BOT_USERNAME = 'kiwi010_bot';
const DEFAULT_TIMER = 15;
const DEFAULT_QUESTION_COUNT = QUESTION_COUNT;

const ROLE = { ROOT: 'ROOT', OWNER: 'OWNER', HOST: 'HOST', PARTICIPANT: 'PARTICIPANT' };
const VERIFICATION_STATUS = { PENDING: 'PENDING', VERIFIED: 'VERIFIED', REJECTED: 'REJECTED', REVOKED: 'REVOKED' };
const QUIZ_STATE = { INACTIVE: 'INACTIVE', ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ENDED: 'ENDED' };

const hosts = new Set([ROOT_ADMIN_ID]);
const quizSessions = new Map();
const participantRecords = new Map();
const globalScores = new Map();
const cleanupLog = [];

let _kiwiStateEnv = null;

function setKiwiStateEnv(env) {
  _kiwiStateEnv = env;
}

async function callKiwiState(action, data = {}) {
  if (!_kiwiStateEnv) {
    console.error('KiwiState: env not initialized');
    return { error: 'State not initialized' };
  }
  if (!_kiwiStateEnv.KIWI_STATE) {
    console.error('KiwiState: KIWI_STATE binding not found');
    return { error: 'State binding not found' };
  }
  try {
    const id = _kiwiStateEnv.KIWI_STATE.idFromName('kiwi-global');
    const stub = _kiwiStateEnv.KIWI_STATE.get(id);
    const payload = { action, ...data };
    const res = await stub.fetch('https://kiwi-state.internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error('KiwiState call failed:', error.message);
    return { error: `State call failed: ${error.message}` };
  }
}

async function getOrCreateUser(env, userId, firstName, lastName, username) {
  if (_kiwiStateEnv === null) setKiwiStateEnv(env);
  const result = await callKiwiState('getOrCreateUser', { userId, firstName, lastName, username });
  if (result && result.user) {
    return result.user;
  }
  console.warn(`getOrCreateUser failed for ${userId}: ${JSON.stringify(result)}`);
  return {
    telegramUserId: userId,
    username: username || '',
    firstName: firstName || '',
    lastName: lastName || '',
    eligibility: ELIGIBILITY.NOT_ELIGIBLE,
    referralToken: null,
    referrerId: null,
    referralCount: 0,
    groupId: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

async function getUserReferralCount(userId) {
  const result = await callKiwiState('getReferralCount', { userId });
  return result.referralCount || 0;
}

async function processReferralStart(env, userId, referralToken, firstName, lastName, username) {
  const result = await callKiwiState('processReferral', { referralToken, referredUserId: userId, firstName, lastName, username });
  return result;
}

async function getAccessConfig() {
  const result = await callKiwiState('getConfig', {});
  return result;
}

async function verifyGroupMembership(userId, groupId) {
  const result = await callKiwiState('verifyGroupMembership', { userId, groupId });
  return result;
}

function isRootAdmin(userId) {
  return Number(userId) === Number(ROOT_ADMIN_ID);
}

function isAuthorizedHost(userId) {
  if (isRootAdmin(userId)) return true;
  return hosts.has(userId) || hosts.has(Number(userId));
}

function getUserRole(userId) {
  if (isRootAdmin(userId)) return ROLE.ROOT;
  if (hosts.has(userId)) return ROLE.HOST;
  const record = participantRecords.get(userId);
  if (record && record.verificationStatus === VERIFICATION_STATUS.VERIFIED) return ROLE.PARTICIPANT;
  return null;
}

function isAuthorized(userId, minRole) {
  const role = getUserRole(userId);
  if (!role) return false;
  const rank = { [ROLE.PARTICIPANT]: 1, [ROLE.HOST]: 2, [ROLE.OWNER]: 3, [ROLE.ROOT]: 4 };
  return rank[role] >= rank[minRole];
}

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

async function pinChatMessage(chatId, messageId) {
  return tgMethod('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
}

async function unpinChatMessage(chatId, messageId) {
  return tgMethod('unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

async function unpinAllChatMessages(chatId) {
  return tgMethod('unpinAllChatMessages', { chat_id: chatId });
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
    pinnableMessageId: null,
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

  if (session.pinnableMessageId) {
    try { await unpinChatMessage(chatId, session.pinnableMessageId); } catch { /* ignore */ }
  }

  try { await pinChatMessage(chatId, sent.message_id); session.pinnableMessageId = sent.message_id; } catch { /* ignore - no pin permission */ }

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
    if (role !== ROLE.HOST && role !== ROLE.OWNER && role !== ROLE.ROOT) return;
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

  if (session.pinnableMessageId) {
    try {
      await unpinChatMessage(chatId, session.pinnableMessageId);
    } catch (e) {
      /* ignore pin errors */
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

async function sendStartMenu(chatId, userName, userId, eligibility = ELIGIBILITY.NOT_ELIGIBLE) {
  const displayName = formatDisplayName({ first_name: userName, last_name: '', username: '' });
  const role = getUserRole(userId);
  const isHost = role === ROLE.ROOT || role === ROLE.HOST;

  let eligibilityMsg = '';
  if (eligibility === ELIGIBILITY.GROUP_VERIFIED) {
    eligibilityMsg = `\n\n✅ You are fully verified and eligible to participate in quizzes.`;
  } else if (eligibility === ELIGIBILITY.ELIGIBLE) {
    eligibilityMsg = `\n\n⏳ You're eligible. Join the group and verify with /verify.`;
  } else if (eligibility === ELIGIBILITY.GROUP_PENDING) {
    eligibilityMsg = `\n\n⏳ You've joined the group. Verify with /verify.`;
  } else {
    eligibilityMsg = `\n\n⚠️ You're not yet eligible. Get a referral from a current member.`;
  }

  let keyboard;
  if (isHost) {
    keyboard = {
      keyboard: [
        [{ text: '🧠 Start Quiz' }, { text: '📅 Schedule' }],
        [{ text: '⏸️ Pause' }, { text: '▶️ Resume' }, { text: '🛑 End Quiz' }],
        [{ text: '📊 My Score' }, { text: '📈 Status' }],
        [{ text: '🏆 Leaderboard' }, { text: '📖 Help' }],
        [{ text: '👥 Join Group' }, { text: '✅ Verify' }]
      ],
      resize_keyboard: true
    };
  } else {
    keyboard = {
      keyboard: [
        [{ text: '📊 My Score' }, { text: '🏆 Leaderboard' }],
        [{ text: 'ℹ️ How to Play' }, { text: '📖 Help' }],
        [{ text: '👥 Join Group' }, { text: '✅ Verify' }]
      ],
      resize_keyboard: true
    };
  }

  await sendMessage(chatId,
    `👋 <b>Welcome to Kiwi Quiz Bot!</b>\n\nI'll help you learn through live interactive quizzes.${eligibilityMsg}\n\n📋 <b>Available Commands:</b>\n/start — Show this menu\n/score — Check your score\n/leaderboard — See top performers\n/help — Show help\n/join — Get group invite link\n/verify — Verify group membership\n/referrals — Check your referral count\n\n${isHost ? `🧠 Start Quiz — Host: start a quiz\n⏸️ Pause — Host: pause the quiz\n▶️ Resume — Host: resume the quiz\n🛑 End Quiz — Host: end the quiz\n📅 Schedule — Host: schedule a quiz\n📈 Status — Host: show quiz status\n\nHost: /startquiz [question_count] [timer_seconds]\nExample: /startquiz 10 30` : `During a quiz, simply type your answer in the group chat!`}`,
    { reply_markup: keyboard }
  );
}

async function sendHelp(chatId, userId = null) {
  const role = userId !== null ? getUserRole(userId) : null;
  const isHost = role === ROLE.ROOT || role === ROLE.HOST;

  if (isHost) {
    await sendMessage(chatId,
      `<b>📚 Kiwi Quiz Bot — Host Help</b>\n\n` +
      `<b>Quiz Controls:</b>\n` +
      `/startquiz [count] [timer] — Start a quiz (host+, must be group-verified)\n` +
      `/quiz [count] [timer] — Alias for /startquiz\n` +
      `/stopquiz — End the quiz (host+)\n` +
      `/next — Advance to next question (host+)\n` +
      `/pausequiz — Pause timer (host+)\n` +
      `/resumequiz — Resume timer (host+)\n` +
      `/status — Show quiz status (host+)\n` +
      `/schedule HH:MM [count] [timer] — Schedule a quiz (host+)\n` +
      `/scheduled — List scheduled quizzes (host+)\n\n` +
      `<b>Admin Controls:</b>\n` +
      `/resetquiz — Reset quiz session (CEO only)\n` +
      `/hosts — List authorized hosts (host+)\n` +
      `/verify [user_id] — Approve a participant (host+)\n` +
      `/addhost [user_id] — Add a host (CEO only)\n` +
      `/removehost [user_id] — Remove a host (CEO only)\n` +
      `/config [key] [value] — Configure gatekeeper (CEO only)\n` +
      `/stats — Show access statistics (CEO only)\n\n` +
      `<b>Participant Commands:</b>\n` +
      `/score — View your score\n` +
      `/leaderboard — View top performers\n` +
      `/scores — Alias for /leaderboard\n` +
      `/join — Get group invite link\n` +
      `/verify — Verify group membership\n` +
      `/referrals — Check your referral count\n\n` +
      `<b>Answering:</b>\n` +
      `During a quiz, simply type your answer in the group chat!\n\n` +
      `<b>CEO:</b> ${ROOT_ADMIN_ID} has full authorization.`
    );
  } else {
    await sendMessage(chatId,
      `<b>📚 Kiwi Quiz Bot — How to Play</b>\n\n` +
      `<b>Participation:</b>\n` +
      `1️⃣ Get referred by a current member to get a referral credit\n` +
      `2️⃣ Join the quiz group via /join\n` +
      `3️⃣ Verify your membership with /verify\n` +
      `4️⃣ Once verified, you can answer quiz questions\n\n` +
      `<b>Your Commands:</b>\n` +
      `/score — View your score\n` +
      `/leaderboard — See top performers\n` +
      `/scores — Alias for /leaderboard\n` +
      `/join — Get group invite link\n` +
      `/verify — Verify group membership\n` +
      `/referrals — Check your referral count\n` +
      `/help — Show this help\n\n` +
      `<b>During a quiz:</b>\n` +
      `Simply type your answer in the group chat!\n` +
      `A timer counts down for each question.\n` +
      `Results are shown after each question.\n\n` +
      `<b>Note:</b> Only authorized hosts can start and control quizzes.`
    );
  }
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

async function handleStartCommand(chatId, userId, firstName, lastName, username, args = [], env, chatType = 'private') {
  const displayName = formatDisplayName({ first_name: firstName, last_name: lastName, username });

  let referralResult = null;
  let userRecord = null;
  let eligibility = ELIGIBILITY.NOT_ELIGIBLE;

  try {
    const referralToken = args[0] && args[0].startsWith('ref_') ? args[0] : null;
    if (referralToken) {
      const token = referralToken.replace(/^ref_/, '');
      referralResult = await processReferralStart(env, userId, token, firstName, lastName, username);
    }

    userRecord = await getOrCreateUser(env, userId, firstName, lastName, username);
    eligibility = userRecord?.eligibility || ELIGIBILITY.NOT_ELIGIBLE;
  } catch (error) {
    console.error('⚠️ Gatekeeper state access failed, using fallback:', error.message);
  }

  if (isRootAdmin(userId)) {
    console.log(`ROOT ADMIN AUTHORIZED | userId=${userId}`);
  }

  if (chatType === 'private') {
    if (referralResult && referralResult.success) {
      await sendMessage(chatId,
        `🎁 <b>Referral credited!</b>\n\n` +
        `You've been referred by ${referralResult.referrerName || 'a friend'}.\n` +
        `Your account is now <b>eligible</b> for quiz access.\n\n` +
        `Next step: Join the group and verify your membership.`
      );
    } else if (referralResult && referralResult.error) {
      await sendMessage(chatId,
        `⚠️ <b>Referral notice</b>\n\n` +
        `${referralResult.error}\n` +
        `You can still join the group and verify to participate.`
      );
    }

    if (eligibility === ELIGIBILITY.NOT_ELIGIBLE) {
      const config = await getAccessConfigSafe();
      const referralToken = userRecord?.referralToken;
      const referralLink = referralToken ? `https://t.me/${BOT_USERNAME}?start=ref_${referralToken}` : 'Unavailable';
      await sendMessage(chatId,
        `👋 <b>Welcome to Kiwi Quiz Bot!</b>\n\n` +
        `To participate in quizzes, you need to:\n\n` +
        `1️⃣ Get a <b>referral</b> from a current member\n` +
        `2️⃣ Join our group: ${config.groupInviteLink || 'https://t.me/kiwi_quiz_group'}\n` +
        `3️⃣ Verify your membership with /verify\n\n` +
        `Your personal referral link:\n<code>${referralLink}</code>\n\n` +
        `Share this link to invite friends! Each successful referral earns you a credit.`
      );
      return;
    }

    if (eligibility === ELIGIBILITY.ELIGIBLE) {
      const config = await getAccessConfigSafe();
      await sendMessage(chatId,
        `✅ <b>You're eligible!</b>\n\n` +
        `You can now join the quiz group and verify your membership.\n\n` +
        `Group: ${config.groupInviteLink || 'https://t.me/kiwi_quiz_group'}\n\n` +
        `After joining, type /verify to confirm your membership.`
      );
      return;
    }

    if (eligibility === ELIGIBILITY.GROUP_PENDING) {
      const config = await getAccessConfigSafe();
      await sendMessage(chatId,
        `⏳ <b>Nearly there!</b>\n\n` +
        `You've joined the group. Please verify your membership with /verify.\n\n` +
        `If you haven't joined yet:\n${config.groupInviteLink || 'https://t.me/kiwi_quiz_group'}`
      );
      return;
    }

    if (eligibility === ELIGIBILITY.GROUP_VERIFIED) {
      await sendMessage(chatId,
        `🎉 <b>You're fully verified!</b>\n\n` +
        `You can now participate in any active quiz.\n` +
        `Go answer some questions! 🧠`
      );
      return;
    }
  }

  await sendStartMenu(chatId, displayName, userId, eligibility);
}

async function getAccessConfigSafe() {
  try {
    const result = await callKiwiState('getConfig', {});
    if (result.error) {
      throw new Error(result.error);
    }
    return result;
  } catch (error) {
    console.error('getConfig fallback:', error.message);
    return {
      groupId: null,
      groupInviteLink: 'https://t.me/kiwi_quiz_group',
      requiredReferrals: 2,
      groupVerification: true,
    };
  }
}

async function handleVerifyMembership(chatId, userId, env) {
  const config = await getAccessConfigSafe();
  const groupId = config.groupId;

  if (!groupId) {
    await sendMessage(chatId, `⚠️ Group configuration not set. Contact the admin.`);
    return;
  }

  const result = await verifyGroupMembership(userId, groupId);

  if (result.success && result.isMember) {
    const referralCount = await getUserReferralCount(userId);
    await sendMessage(chatId,
      `✅ <b>Group membership verified!</b>\n\n` +
      `You are now fully eligible to participate in quizzes.\n\n` +
      `Your referral count: ${referralCount}\n` +
      `Good luck in the next quiz! 🍀`
    );
  } else {
    await sendMessage(chatId,
      `⚠️ <b>Verification failed.</b>\n\n` +
      `You must join the group first:\n${config.groupInviteLink || 'https://t.me/kiwi_quiz_group'}\n\n` +
      `After joining, try /verify again.`
    );
  }
}

async function handleJoinCommand(chatId, userId, env) {
  const config = await getAccessConfigSafe();
  const inviteLink = config.groupInviteLink || 'https://t.me/kiwi_quiz_group';
  await sendMessage(chatId,
    `👥 <b>Join our quiz group!</b>\n\n` +
    `Click the link below to join:\n${inviteLink}\n\n` +
    `After joining, type /verify to confirm your membership and complete the onboarding.`
  );
}

async function handleReferralsCommand(chatId, userId, env) {
  let count = 0;
  let referralLink = 'Unavailable';
  try {
    count = await getUserReferralCount(userId);
    const userRecord = await getOrCreateUser(env, userId, 'Referral', '', '');
    const token = userRecord?.referralToken;
    if (token) referralLink = `https://t.me/${BOT_USERNAME}?start=ref_${token}`;
  } catch (error) {
    console.error('Referrals command error:', error.message);
  }
  await sendMessage(chatId,
    `🏆 <b>Your Referrals</b>\n\n` +
    `Total successful referrals: ${count}\n\n` +
    `Your referral link:\n<code>${referralLink}</code>\n\n` +
    `Each successful referral earns you a credit toward quiz access!`
  );
}

async function handleStatsCommand(chatId, userId, env) {
  if (!isRootAdmin(userId)) {
    await sendMessage(chatId, `❌ You are not authorized.`);
    return;
  }
  const stats = await callKiwiState('getAccessStats', {});
  let msg = `<b>📊 Access Statistics</b>\n\n`;
  msg += `Total users: ${stats.total || 0}\n`;
  msg += `Eligible users: ${stats.eligible || 0}\n`;
  msg += `Group verified: ${stats.groupVerified || 0}\n`;
  msg += `Pending referrals: ${stats.pendingReferrals || 0}\n`;
  msg += `Successful referrals: ${stats.validReferrals || 0}\n`;
  await sendMessage(chatId, msg);
}

async function handleConfigCommand(chatId, userId, args, env) {
  if (!isRootAdmin(userId)) {
    await sendMessage(chatId, `❌ You are not authorized.`);
    return;
  }

  const key = args[0];
  const value = args.slice(1).join(' ');

  if (!key) {
    const config = await getAccessConfigSafe();
    let msg = `<b>⚙️ Access Configuration</b>\n\n`;
    msg += `Group ID: ${config.groupId || 'Not set'}\n`;
    msg += `Invite Link: ${config.groupInviteLink || 'Not set'}\n`;
    msg += `Referral Required: ${config.referralRequired ? 'Yes' : 'No'}\n`;
    msg += `Group Verification: ${config.groupVerification ? 'Yes' : 'No'}\n`;
    msg += `\nUsage: /config [key] [value]\nKeys: groupId, groupInviteLink, referralRequired, groupVerification`;
    await sendMessage(chatId, msg);
    return;
  }

  if (!value) {
    await sendMessage(chatId, `Usage: /config [key] [value]\n\nSet a configuration value.`);
    return;
  }

  try {
    const existing = await getAccessConfigSafe();
    const updated = { ...existing, [key]: value };
    const setResult = await callKiwiState('setConfig', { config: updated });
    if (setResult.success) {
      await sendMessage(chatId, `✅ Configuration updated: ${key} = ${value}`);
    } else {
      await sendMessage(chatId, `❌ Failed to update configuration: ${setResult.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Config update error:', error.message);
    await sendMessage(chatId, `❌ Error updating configuration.`);
  }
}

async function handleQuizCommand(chatId, userId, firstName, lastName, username, args, ctx, env) {
  const role = getUserRole(userId);
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/quiz`);
    const displayName = formatDisplayName({ first_name: firstName, last_name: lastName, username });
    const session = quizSessions.get(chatId);
    if (session && session.state === QUIZ_STATE.ACTIVE) {
      await sendMessage(chatId, `💡 A quiz is currently running! Wait for the next question.`);
      return;
    }
    await sendMessage(chatId, `⚠️ ${displayName}, only authorized hosts can start a quiz.`);
    return;
  }

  let eligibility = ELIGIBILITY.NOT_ELIGIBLE;
  try {
    const userRecord = await getOrCreateUser(env, userId, firstName, lastName, username);
    eligibility = userRecord?.eligibility || ELIGIBILITY.NOT_ELIGIBLE;
  } catch (error) {
    console.error('Quiz command gatekeeper error:', error.message);
  }

  if (eligibility !== ELIGIBILITY.GROUP_VERIFIED) {
    await sendMessage(chatId, `⚠️ You must be group-verified to start a quiz.\nUse /join to get the invite link and /verify after joining.`);
    return;
  }

  if (quizSessions.has(chatId)) {
    await sendMessage(chatId, `⚠️ A quiz session is already active in this group.`);
    return;
  }

  const questionCount = parseInt(args[0]) || DEFAULT_QUESTION_COUNT;
  const timerSeconds = parseInt(args[1]) || DEFAULT_TIMER;

  const session = createQuizSession(chatId, userId, questionCount, timerSeconds);

  if (isRootAdmin(userId)) {
    console.log(`ROOT ADMIN AUTHORIZED | userId=${userId} command=/quiz`);
  }

  await sendMessage(chatId, `🚀 <b>Quiz Starting!</b>\n\n${questionCount} questions | ⏱️ ${timerSeconds}s per question\n\nParticipants: please wait for questions.`);

  await publishQuestion(chatId, session);
}

async function handleNextCommand(chatId, userId) {
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/next`);
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
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/pause`);
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
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/resume`);
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
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/endquiz`);
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
  if (!isAuthorizedHost(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/verify`);
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
  if (!isRootAdmin(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/addhost`);
    await sendMessage(chatId, `❌ You are not authorized to perform this action.`);
    return;
  }

  const targetId = parseInt(args[0]);
  if (!targetId) {
    await sendMessage(chatId, `Usage: /addhost [user_id]`);
    return;
  }

  if (targetId === ROOT_ADMIN_ID) {
    await sendMessage(chatId, `👑 This user is already the CEO.`);
    return;
  }

  if (hosts.has(targetId)) {
    await sendMessage(chatId, `⚠️ User ${targetId} is already an authorized host.`);
    return;
  }

  hosts.add(targetId);
  console.log(`HOST AUTHORIZED | userId=${targetId} authorizedBy=${userId}`);
  await sendMessage(chatId, `✅ Host authorized.`);
}

async function handleRemoveHostCommand(chatId, userId, args) {
  if (!isRootAdmin(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/removehost`);
    await sendMessage(chatId, `❌ You are not authorized to perform this action.`);
    return;
  }

  const targetId = parseInt(args[0]);
  if (!targetId) {
    await sendMessage(chatId, `Usage: /removehost [user_id]`);
    return;
  }

  if (targetId === ROOT_ADMIN_ID) {
    await sendMessage(chatId, `❌ The CEO cannot be removed.`);
    return;
  }

  if (hosts.delete(targetId)) {
    console.log(`HOST REMOVED | userId=${targetId} removedBy=${userId}`);
    await sendMessage(chatId, `✅ Host authorization removed.`);
  } else {
    await sendMessage(chatId, `⚠️ User ${targetId} is not an authorized host.`);
  }
}

async function handleHostsCommand(chatId, userId) {
  if (!isAuthorized(userId, ROLE.HOST)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/hosts`);
    await sendMessage(chatId, `❌ You are not authorized to perform this action.`);
    return;
  }

  let msg = `👑 <b>Authorization Hierarchy</b>\n\n`;
  if (isRootAdmin(userId)) {
    msg += `👑 <b>CEO:</b> ${ROOT_ADMIN_ID}\n`;
  }
  msg += `\n👑 <b>Authorized Hosts:</b>\n`;
  const hostList = Array.from(hosts).filter(id => id !== ROOT_ADMIN_ID);
  if (hostList.length === 0) {
    msg += `  None yet.\n`;
  } else {
    hostList.forEach(id => {
      msg += `  • ${id}\n`;
    });
  }
  await sendMessage(chatId, msg);
}

async function handleStatusCommand(chatId, userId) {
  if (!isAuthorized(userId, ROLE.HOST)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/status`);
    await sendMessage(chatId, `❌ You are not authorized to perform this action.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session) {
    await sendMessage(chatId, `📋 <b>Quiz Status:</b>\n\nNo active quiz in this group.\nUse /quiz or /startquiz to begin.`);
    return;
  }

  const q = QUIZ_QUESTIONS[session.currentQuestion];
  let msg = `📊 <b>Quiz Status</b>\n\n`;
  msg += `Quiz ID: ${session.quizId}\n`;
  msg += `State: ${session.state}\n`;
  msg += `Question: ${session.currentQuestion + 1}/${session.questionCount}`;
  if (q) msg += ` — ${q.question}`;
  msg += `\n\nParticipants: ${session.participantIds.length}\n`;
  msg += `Scores recorded: ${session.scores.size}`;

  if (session.questionStartTime && session.state === QUIZ_STATE.ACTIVE) {
    const elapsed = Date.now() - session.questionStartTime;
    const remaining = Math.max(0, session.timerSeconds - Math.floor(elapsed / 1000));
    msg += `\n\n⏱️ Time remaining: ${remaining}s`;
  }

  await sendMessage(chatId, msg);
}

async function handleResetQuizCommand(chatId, userId) {
  if (!isRootAdmin(userId)) {
    console.log(`UNAUTHORIZED ADMIN ATTEMPT | userId=${userId} command=/resetquiz`);
    await sendMessage(chatId, `❌ You are not authorized to perform this action.`);
    return;
  }

  const session = quizSessions.get(chatId);
  if (!session) {
    await sendMessage(chatId, `⚠️ No active quiz to reset.`);
    return;
  }

  if (session.timerId) clearTimeout(session.timerId);
  quizSessions.delete(chatId);
  session.participantIds.forEach(pid => {
    participantRecords.delete(pid);
  });

  console.log(`QUIZ RESET | quizId=${session.quizId} resetBy=${userId}`);
  await sendMessage(chatId, `🔄 <b>Quiz session reset.</b>\n\nAll quiz data cleared. Use /quiz to start fresh.`);
}

async function handleAnswerSubmission(chatId, userId, firstName, lastName, username, text, env) {
  const session = quizSessions.get(chatId);
  if (!session || session.state !== QUIZ_STATE.ACTIVE) return;

  const role = getUserRole(userId);

  if (role === ROLE.HOST || role === ROLE.OWNER || role === ROLE.ROOT) return;

  let eligibility = ELIGIBILITY.NOT_ELIGIBLE;
  try {
    const userRecord = await getOrCreateUser(env, userId, firstName, lastName, username);
    eligibility = userRecord?.eligibility || ELIGIBILITY.NOT_ELIGIBLE;
  } catch (error) {
    console.error('Answer submission gatekeeper error:', error.message);
  }

  if (eligibility !== ELIGIBILITY.GROUP_VERIFIED) {
    await sendMessage(chatId,
      `⚠️ ${formatDisplayName({ first_name: firstName, last_name: lastName, username })}, you must complete the verification process to participate.\n\n` +
      `Get a referral, join the group, and verify with /verify in private chat.`
    );
    return;
  }

  if (role === null) {
    if (!participantRecords.has(userId)) {
      participantRecords.set(userId, {
        telegramUserId: userId,
        username: username,
        displayName: formatDisplayName({ first_name: firstName, last_name: lastName, username }),
        verificationStatus: VERIFICATION_STATUS.VERIFIED,
        verificationSource: 'group_verified',
        eligible: true,
        joinedAt: Date.now(),
      });

      if (!session.participantIds.includes(userId)) {
        session.participantIds.push(userId);
      }

      await sendMessage(chatId,
        `✅ ${formatDisplayName({ first_name: firstName, last_name: lastName, username })}, you are verified and can participate!\n\n` +
        `Type your answer for the current question.`
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

async function handleScheduleCommand(chatId, userId, args, env) {
  if (!isAuthorizedHost(userId)) {
    await sendMessage(chatId, `❌ Only hosts can schedule quizzes.`);
    return;
  }

  if (args.length < 1) {
    await sendMessage(chatId, `📅 Usage: /schedule HH:MM [question_count] [timer_seconds]\n\nExample: /schedule 14:30 10 15\n\nSchedules a quiz to start automatically at the given time.`);
    return;
  }

  const timeStr = args[0];
  const timeParts = timeStr.split(':');
  if (timeParts.length !== 2) {
    await sendMessage(chatId, `❌ Invalid time format. Use HH:MM (24-hour format).`);
    return;
  }

  const hours = parseInt(timeParts[0]);
  const minutes = parseInt(timeParts[1]);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    await sendMessage(chatId, `❌ Invalid time. Use HH:MM (24-hour format).`);
    return;
  }

  const now = new Date();
  const scheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
  if (scheduledTime.getTime() <= now.getTime()) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }

  const questionCount = parseInt(args[1]) || DEFAULT_QUESTION_COUNT;
  const timerSeconds = parseInt(args[2]) || DEFAULT_TIMER;

  const result = await callKiwiState('scheduleQuiz', {
    chatId,
    hostId: userId,
    questionCount,
    timerSeconds,
    scheduledTime: scheduledTime.toISOString(),
  });

  if (result.success) {
    await sendMessage(chatId,
      `📅 <b>Quiz scheduled!</b>\n\n` +
      `Time: ${scheduledTime.toLocaleString()}\n` +
      `Questions: ${questionCount}\n` +
      `Timer: ${timerSeconds}s per question\n\n` +
      `The quiz will start automatically. You can list scheduled quizzes with /scheduled.`
    );
  } else {
    await sendMessage(chatId, `❌ Failed to schedule quiz: ${result.error || 'Unknown error'}`);
  }
}

async function handleScheduledCommand(chatId, userId, env) {
  if (!isAuthorizedHost(userId)) {
    await sendMessage(chatId, `❌ Only hosts can view scheduled quizzes.`);
    return;
  }

  const result = await callKiwiState('listScheduledQuizzes', {});
  if (result.error) {
    await sendMessage(chatId, `❌ Failed to list scheduled quizzes: ${result.error}`);
    return;
  }

  const schedules = result.schedules || [];
  if (schedules.length === 0) {
    await sendMessage(chatId, `📅 No scheduled quizzes. Use /schedule HH:MM to schedule one.`);
    return;
  }

  let msg = `📅 <b>Scheduled Quizzes</b>\n\n`;
  for (const s of schedules) {
    const scheduled = new Date(s.scheduledTime);
    msg += `🆔 ${s.scheduleId.substring(8)}\n`;
    msg += `⏰ ${scheduled.toLocaleString()}\n`;
    msg += `❓ ${s.questionCount} questions | ⏱️ ${s.timerSeconds}s\n\n`;
  }
  await sendMessage(chatId, msg);
}

async function handleMessage(message, ctx, env) {
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
        await handleStartCommand(chatId, userId, firstName, lastName, username, args, env, chatType);
        break;
       case 'help':
         await sendHelp(chatId, userId);
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
         if (args.length > 0) {
           await handleVerifyCommand(chatId, userId, args);
         } else {
           await handleVerifyMembership(chatId, userId, env);
         }
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
        await handleQuizCommand(chatId, userId, firstName, lastName, username, [], ctx, env);
        break;
      case 'stopquiz':
        await handleEndQuizCommand(chatId, userId);
        break;
      case 'pausequiz':
        await handlePauseCommand(chatId, userId);
        break;
      case 'resumequiz':
        await handleResumeCommand(chatId, userId);
        break;
       case 'status':
         await handleStatusCommand(chatId, userId);
         break;
        case 'join':
          await handleJoinCommand(chatId, userId, env);
          break;
        case 'referrals':
         await handleReferralsCommand(chatId, userId, env);
         break;
       case 'stats':
         await handleStatsCommand(chatId, userId, env);
         break;
       case 'config':
         await handleConfigCommand(chatId, userId, args, env);
         break;
      case 'scores':
        await sendLeaderboard(chatId);
        break;
      case 'resetquiz':
        await handleResetQuizCommand(chatId, userId);
        break;
       case 'hosts':
         await handleHostsCommand(chatId, userId);
         break;
       case 'schedule':
         await handleScheduleCommand(chatId, userId, args, env);
         break;
       case 'scheduled':
         await handleScheduledCommand(chatId, userId, env);
         break;
       default:
        await sendMessage(chatId, `❓ Unknown command. Try /help`);
    }
    return;
  }

  if (text.startsWith('🧠 Start Quiz') || text.startsWith('📊 My Score') || text.startsWith('🏆 Leaderboard') || text.startsWith('📖 Help') || text.startsWith('ℹ️ How to Play') || text.startsWith('👥 Join Group') || text.startsWith('✅ Verify') || text.startsWith('📅 Schedule') || text.startsWith('⏸️ Pause') || text.startsWith('▶️ Resume') || text.startsWith('🛑 End Quiz') || text.startsWith('📈 Status')) {
    if (text.startsWith('🧠 Start Quiz')) {
      await handleQuizCommand(chatId, userId, firstName, lastName, username, [], ctx, env);
    } else if (text.startsWith('📊 My Score')) {
      await sendScore(chatId, userId, formatDisplayName({ first_name: firstName, last_name: lastName, username }));
    } else if (text.startsWith('🏆 Leaderboard')) {
      await sendLeaderboard(chatId);
    } else if (text.startsWith('📖 Help') || text.startsWith('ℹ️ How to Play')) {
      await sendHelp(chatId, userId);
    } else if (text.startsWith('👥 Join Group')) {
      await handleJoinCommand(chatId, userId, env);
    } else if (text.startsWith('✅ Verify')) {
      await handleVerifyMembership(chatId, userId, env);
    } else if (text.startsWith('📅 Schedule')) {
      await handleScheduledCommand(chatId, userId, env);
    } else if (text.startsWith('⏸️ Pause')) {
      await handlePauseCommand(chatId, userId);
    } else if (text.startsWith('▶️ Resume')) {
      await handleResumeCommand(chatId, userId);
    } else if (text.startsWith('🛑 End Quiz')) {
      await handleEndQuizCommand(chatId, userId);
    } else if (text.startsWith('📈 Status')) {
      await handleStatusCommand(chatId, userId);
    }
    return;
  }

  if (session && session.state === QUIZ_STATE.ACTIVE && session.questionStartTime) {
    const elapsed = Date.now() - session.questionStartTime;
    if (elapsed < session.timerSeconds * 1000) {
      await handleAnswerSubmission(chatId, userId, firstName, lastName, username, text, env);
    }
  }
}

async function handleCallbackQuery(callback, ctx, env) {
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
      await handleStartCommand(chatId, userId, firstName, lastName, username, [], env, 'private');
      break;
    case 'menu_score':
      await sendScore(chatId, userId, displayName);
      break;
    case 'menu_leaderboard':
      await sendLeaderboard(chatId);
      break;
    case 'menu_help':
      await sendHelp(chatId, userId);
      break;
  }
}

export { KiwiState } from './kiwi-state.js';

export default {
  async fetch(request, env, ctx) {
    if (!TELEGRAM_API) {
      TELEGRAM_API = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
    }
    if (env.ROOT_ADMIN_ID) {
      const parsedRoot = parseInt(env.ROOT_ADMIN_ID, 10);
      if (!isNaN(parsedRoot) && parsedRoot !== ROOT_ADMIN_ID) {
        hosts.delete(ROOT_ADMIN_ID);
        ROOT_ADMIN_ID = parsedRoot;
        hosts.add(ROOT_ADMIN_ID);
      }
    }
    setKiwiStateEnv(env);

    if (request.method === 'GET') {
      return new Response('✅ Kiwi Bot is running!', { status: 200 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        try {
          await handleMessage(update.message, ctx, env);
        } catch (error) {
          console.error('❌ Error in handleMessage:', error);
        }
      }

      if (update.callback_query) {
        try {
          await handleCallbackQuery(update.callback_query, ctx, env);
        } catch (error) {
          console.error('❌ Error in handleCallbackQuery:', error);
        }
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('❌ Error:', error);
      return new Response('Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    setKiwiStateEnv(env);
    console.log(`📅 CRON triggered: ${new Date().toISOString()}`);

    try {
      const result = await callKiwiState('getDueQuizzes', {});
      if (result.error) {
        console.error('Failed to get due quizzes:', result.error);
        return;
      }

      const dueQuizzes = result.due || [];
      for (const quiz of dueQuizzes) {
        try {
          await sendMessage(quiz.chatId,
            `🚀 <b>Scheduled quiz starting now!</b>\n\n${quiz.questionCount} questions | ⏱️ ${quiz.timerSeconds}s per question\n\nParticipants: please wait for questions.`
          );
          const session = createQuizSession(quiz.chatId, quiz.hostId, quiz.questionCount, quiz.timerSeconds);
          await publishQuestion(quiz.chatId, session);
        } catch (error) {
          console.error(`Failed to start scheduled quiz ${quiz.scheduleId}:`, error.message);
        }
      }
    } catch (error) {
      console.error('Scheduled handler error:', error.message);
    }
  }
};
