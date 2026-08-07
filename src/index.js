const BOT_TOKEN = "8878135109:AAGfF679A-zFsW8sunqXIlJazU0LYH7SW2Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const QUIZ_QUESTIONS = [
  {
    id: 1,
    question: "What is the first step in identifying an arbitrage opportunity?",
    options: ["Buy immediately", "Compare prices across platforms", "Calculate profit", "Withdraw funds"],
    correct: 1,
    timer: 30,
  },
  {
    id: 2,
    question: "Which factor affects the net profit from a trade the most?",
    options: ["Market sentiment", "Transaction fees", "Weather", "Your mood"],
    correct: 1,
    timer: 30,
  },
  {
    id: 3,
    question: "What should you verify before executing a trade?",
    options: ["The seller's reputation", "Current price", "Fees", "All of the above"],
    correct: 3,
    timer: 30,
  },
  {
    id: 4,
    question: "What does 'spread' mean in trading?",
    options: ["The difference between buy and sell price", "A type of sandwich", "A marketing strategy", "A social media post"],
    correct: 0,
    timer: 30,
  },
  {
    id: 5,
    question: "What's the most important risk to consider in arbitrage?",
    options: ["Price changes during the trade", "Your internet speed", "Your mood", "The color of the platform"],
    correct: 0,
    timer: 30,
  },
];

const sessions = new Map();

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', ...extra })
  });
}

async function sendMenu(chatId) {
  await sendMessage(chatId,
    `👋 <b>Welcome to Kiwi Learning Bot!</b>\n\nI'll help you learn through interactive quizzes.\n\n📋 <b>Commands:</b>\n/quiz - Start a timed quiz\n/score - Check your score\n/leaderboard - See top performers\n\n🚀 Ready to learn? Try /quiz!`,
    {
      reply_markup: {
        keyboard: [
          [{ text: '🧠 Start Quiz' }, { text: '📊 My Score' }],
          [{ text: '🏆 Leaderboard' }]
        ],
        resize_keyboard: true
      }
    }
  );
}

async function sendQuestion(chatId, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  const qIndex = session.currentQuestion;
  if (qIndex >= QUIZ_QUESTIONS.length) {
    await finishQuiz(chatId, userId);
    return;
  }

  const q = QUIZ_QUESTIONS[qIndex];

  const options = q.options.map((opt, idx) => ({
    text: `${String.fromCharCode(65 + idx)}. ${opt}`,
    callback_data: `ans_${userId}_${q.id}_${idx}`
  }));

  const keyboard = [];
  for (let i = 0; i < options.length; i += 2) {
    keyboard.push(options.slice(i, i + 2));
  }

  await sendMessage(chatId,
    `🧠 <b>Question ${qIndex + 1}/${QUIZ_QUESTIONS.length}</b>\n\n${q.question}\n\n⏱️ ${q.timer}s`,
    { reply_markup: { inline_keyboard: keyboard } }
  );

  const timerId = setTimeout(async () => {
    const currentSession = sessions.get(userId);
    if (!currentSession || currentSession.currentQuestion !== qIndex) return;

    await sendMessage(chatId, `⏰ Time's up! Moving to next question.`);
    currentSession.currentQuestion++;
    setTimeout(() => sendQuestion(chatId, userId), 1000);
  }, q.timer * 1000);

  session.timerId = timerId;
}

async function finishQuiz(chatId, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  const total = QUIZ_QUESTIONS.length;
  const score = session.score;
  const pct = Math.round((score / total) * 100);

  let message = `🏁 <b>QUIZ COMPLETE!</b>\n\n`;
  message += `📊 <b>Score:</b> ${score}/${total} (${pct}%)\n\n`;
  if (pct >= 80) message += `🌟 Excellent work!\n\n`;
  else if (pct >= 60) message += `👍 Good effort! Review and try again.\n\n`;
  else message += `📚 Keep learning! Try reviewing the material first.\n\n`;

  message += `🔄 Try again with /quiz`;

  sessions.delete(userId);
  await sendMessage(chatId, message);
}

async function handleUpdate(update) {
  if (update.message) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text || '';

    if (text === '/start') {
      await sendMenu(chatId);
      return;
    }

    if (text === '/quiz' || text === '🧠 Start Quiz') {
      if (sessions.has(userId)) {
        await sendMessage(chatId, "⚠️ You already have an active quiz! Complete it first.");
        return;
      }

      sessions.set(userId, {
        userId: userId,
        currentQuestion: 0,
        score: 0,
        answers: [],
        timerId: null
      });

      await sendQuestion(chatId, userId);
      return;
    }

    if (text === '/score' || text === '📊 My Score') {
      await sendMessage(chatId, `📊 <b>Your Stats</b>\n\nTotal Score: 0 pts\nQuizzes Taken: 0\n\nKeep going! 💪`);
      return;
    }

    if (text === '/leaderboard' || text === '🏆 Leaderboard') {
      await sendMessage(chatId, `🏆 <b>Leaderboard</b>\n\nNo scores yet. Be the first! 🏆`);
      return;
    }

    await sendMessage(chatId, `❓ Unknown command. Try /start`);
  }

  if (update.callback_query) {
    const callback = update.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const userId = callback.from.id;

    const parts = data.split('_');
    if (parts[0] !== 'ans') return;

    const targetUserId = parseInt(parts[1]);
    const questionId = parseInt(parts[2]);
    const selectedIdx = parseInt(parts[3]);

    if (targetUserId !== userId) {
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Not your quiz!" })
      });
      return;
    }

    const session = sessions.get(userId);
    if (!session) {
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Quiz expired. Start a new one!" })
      });
      return;
    }

    const qIndex = session.currentQuestion;
    if (qIndex >= QUIZ_QUESTIONS.length) return;

    const q = QUIZ_QUESTIONS[qIndex];
    if (q.id !== questionId) return;

    if (session.timerId) {
      clearTimeout(session.timerId);
      session.timerId = null;
    }

    const isCorrect = selectedIdx === q.correct;
    if (isCorrect) session.score++;

    session.answers.push(selectedIdx);
    session.currentQuestion++;

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback.id })
    });

    await sendMessage(chatId, isCorrect ? '✅ Correct!' : '❌ Wrong answer.');
    setTimeout(() => sendQuestion(chatId, userId), 1000);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('✅ Kiwi Bot is running!', { status: 200 });
    }

    try {
      const update = await request.json();
      await handleUpdate(update);
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('❌ Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
};
