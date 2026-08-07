export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: true, message: 'Telegram bot worker is running.' }, 200);
    }

    const update = await request.json().catch(() => null);
    if (!update) {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const botToken = env.BOT_TOKEN || '8878135109:AAGfF679A-zFsW8sunqXIlJazU0LYH7SW2Q';
    const supabaseUrl = env.SUPABASE_URL || 'https://shylzcegyexfwbqytdva.supabase.co';
    const supabaseAnonKey = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNoeWx6Y2VneWV4ZndicXl0ZHZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMDE0MzksImV4cCI6MjEwMTY3NzQzOX0.BiUDS0cV08cyDUcNKKoDbla4fSVcL0EtfsNIidX4a3Q';

    if (update.message) {
      return handleMessage(update, botToken, supabaseUrl, supabaseAnonKey, env);
    }

    if (update.callback_query) {
      return handleCallbackQuery(update, botToken, supabaseUrl, supabaseAnonKey, env);
    }

    return jsonResponse({ ok: true }, 200);
  }
};

const quizQuestions = [
  {
    text: 'What is the first step in identifying an arbitrage opportunity?',
    options: ['Buy immediately', 'Compare prices across platforms', 'Calculate profit', 'Withdraw funds'],
    correct: 1,
    timer: 30
  },
  {
    text: 'Which factor affects the net profit from a trade the most?',
    options: ['Market sentiment', 'Transaction fees', 'Weather', 'Your mood'],
    correct: 1,
    timer: 30
  },
  {
    text: 'What should you verify before executing a trade?',
    options: ['The seller\'s reputation', 'Current price', 'Fees', 'All of the above'],
    correct: 3,
    timer: 30
  },
  {
    text: 'What does "spread" mean in trading?',
    options: ['The difference between buy and sell price', 'A type of sandwich', 'A marketing strategy', 'A social media post'],
    correct: 0,
    timer: 30
  },
  {
    text: 'What\'s the most important risk to consider in arbitrage?',
    options: ['Price changes during the trade', 'Your internet speed', 'Your mood', 'The color of the platform'],
    correct: 0,
    timer: 30
  }
];

const quizSessions = new Map();

async function handleMessage(update, botToken, supabaseUrl, supabaseAnonKey, env) {
  const message = update.message;
  const chatId = message.chat.id;
  const telegramId = message.from?.id;
  const username = message.from?.username || message.from?.first_name || 'user';

  const text = message.text || '';
  const command = text.trim();

  if (!telegramId) {
    return jsonResponse({ ok: false, error: 'Missing telegram id' }, 400);
  }

  if (command === '/start') {
    await ensureUser(supabaseUrl, supabaseAnonKey, telegramId, username);
    await sendTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: `Welcome to KiwiBot! 👋\nUse the menu below to start a quiz, check your score, or see the leaderboard.`,
      reply_markup: {
        keyboard: [
          [{ text: '/quiz' }, { text: '/score' }],
          [{ text: '/leaderboard' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
    return jsonResponse({ ok: true }, 200);
  }

  if (command === '/quiz') {
    const profile = await ensureUser(supabaseUrl, supabaseAnonKey, telegramId, username);
    const session = {
      chatId,
      telegramId,
      username,
      profile,
      score: 0,
      currentQuestionIndex: -1,
      active: true,
      timerTimeout: null,
      countdownTimeout: null
    };
    quizSessions.set(chatId, session);
    await startNextQuestion(session, botToken, supabaseUrl, supabaseAnonKey, env);
    return jsonResponse({ ok: true }, 200);
  }

  if (command === '/score') {
    const profile = await getUserProfile(supabaseUrl, supabaseAnonKey, telegramId);
    const scoreText = profile
      ? `Your current score: ${profile.total_score}\nQuizzes taken: ${profile.quizzes_taken}`
      : 'You have not registered yet. Start the bot with /start first.';
    await sendTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: scoreText
    });
    return jsonResponse({ ok: true }, 200);
  }

  if (command === '/leaderboard') {
    const leaderboard = await getLeaderboard(supabaseUrl, supabaseAnonKey);
    if (!leaderboard.length) {
      await sendTelegram(botToken, 'sendMessage', {
        chat_id: chatId,
        text: 'No scores yet. Be the first to take the quiz!'
      });
      return jsonResponse({ ok: true }, 200);
    }

    const content = leaderboard
      .map((entry, index) => `${index + 1}. ${entry.username || 'Anonymous'} — ${entry.total_score} pts`)
      .join('\n');

    await sendTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: `Top 10 leaderboard:\n${content}`
    });
    return jsonResponse({ ok: true }, 200);
  }

  await sendTelegram(botToken, 'sendMessage', {
    chat_id: chatId,
    text: 'Use /start to register, /quiz to begin, /score to check your score, or /leaderboard to view rankings.'
  });
  return jsonResponse({ ok: true }, 200);
}

async function handleCallbackQuery(update, botToken, supabaseUrl, supabaseAnonKey, env) {
  const callbackQuery = update.callback_query;
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from?.id;
  const data = callbackQuery.data || '';

  if (!telegramId) {
    return jsonResponse({ ok: false, error: 'Missing sender id' }, 400);
  }

  await sendTelegram(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Answer received.'
  });

  const session = quizSessions.get(chatId);
  if (!session || !session.active) {
    return jsonResponse({ ok: true }, 200);
  }

  const [prefix, questionIndex, optionIndex] = data.split(':');
  if (prefix !== 'answer') {
    return jsonResponse({ ok: true }, 200);
  }

  const currentIndex = Number(questionIndex);
  const selectedIndex = Number(optionIndex);
  if (Number.isNaN(currentIndex) || Number.isNaN(selectedIndex)) {
    return jsonResponse({ ok: true }, 200);
  }

  if (session.currentQuestionIndex !== currentIndex) {
    return jsonResponse({ ok: true }, 200);
  }

  clearTimeout(session.timerTimeout);
  clearTimeout(session.countdownTimeout);

  const question = quizQuestions[currentIndex];
  const isCorrect = selectedIndex === question.correct;
  if (isCorrect) {
    session.score += 1;
  }

  await updateUserScore(supabaseUrl, supabaseAnonKey, telegramId, isCorrect, false);

  const answerText = isCorrect
    ? '✅ Correct! Moving to the next question.'
    : `❌ Wrong. The correct answer was: ${question.options[question.correct]}. Moving to the next question.`;

  await sendTelegram(botToken, 'sendMessage', {
    chat_id: chatId,
    text: answerText
  });

  await startNextQuestion(session, botToken, supabaseUrl, supabaseAnonKey, env);
  return jsonResponse({ ok: true }, 200);
}

async function startNextQuestion(session, botToken, supabaseUrl, supabaseAnonKey, env) {
  if (!session.active) {
    return;
  }

  clearTimeout(session.timerTimeout);
  clearTimeout(session.countdownTimeout);

  session.currentQuestionIndex += 1;
  if (session.currentQuestionIndex >= quizQuestions.length) {
    await finishQuiz(session, botToken, supabaseUrl, supabaseAnonKey);
    return;
  }

  const question = quizQuestions[session.currentQuestionIndex];
  const initialRemaining = question.timer;
  const keyboard = {
    inline_keyboard: [
      question.options.map((option, index) => ({
        text: `${String.fromCharCode(65 + index)}. ${option}`,
        callback_data: `answer:${session.currentQuestionIndex}:${index}`
      }))
    ]
  };

  const questionText = `Question ${session.currentQuestionIndex + 1}/${quizQuestions.length}\n${question.text}\n\nTime left: ${initialRemaining}s`;
  const sent = await sendTelegram(botToken, 'sendMessage', {
    chat_id: session.chatId,
    text: questionText,
    reply_markup: keyboard
  });

  session.messageId = sent?.result?.message_id;
  session.questionStartedAt = Date.now();

  await tickQuestionCountdown(session, botToken, question, initialRemaining, supabaseUrl, supabaseAnonKey, env);
}

async function tickQuestionCountdown(session, botToken, question, remainingSeconds, supabaseUrl, supabaseAnonKey, env) {
  if (!session.active || session.currentQuestionIndex >= quizQuestions.length) {
    return;
  }

  if (remainingSeconds <= 0) {
    await handleQuestionTimeout(session, botToken, supabaseUrl, supabaseAnonKey, env);
    return;
  }

  const text = `Question ${session.currentQuestionIndex + 1}/${quizQuestions.length}\n${question.text}\n\nTime left: ${remainingSeconds}s`;
  const keyboard = {
    inline_keyboard: [
      question.options.map((option, index) => ({
        text: `${String.fromCharCode(65 + index)}. ${option}`,
        callback_data: `answer:${session.currentQuestionIndex}:${index}`
      }))
    ]
  };

  if (session.messageId) {
    await sendTelegram(botToken, 'editMessageText', {
      chat_id: session.chatId,
      message_id: session.messageId,
      text,
      reply_markup: keyboard
    });
  }

  session.countdownTimeout = setTimeout(() => {
    tickQuestionCountdown(session, botToken, question, remainingSeconds - 1, supabaseUrl, supabaseAnonKey, env);
  }, 1000);

  session.timerTimeout = setTimeout(() => {
    handleQuestionTimeout(session, botToken, supabaseUrl, supabaseAnonKey, env);
  }, question.timer * 1000);
}

async function handleQuestionTimeout(session, botToken, supabaseUrl, supabaseAnonKey, env) {
  clearTimeout(session.timerTimeout);
  clearTimeout(session.countdownTimeout);

  if (!session.active) {
    return;
  }

  const question = quizQuestions[session.currentQuestionIndex];
  const wrongAnswerText = `⏰ Time is up! The correct answer was: ${question.options[question.correct]}. Moving to the next question.`;
  await sendTelegram(botToken, 'sendMessage', {
    chat_id: session.chatId,
    text: wrongAnswerText
  });

  await updateUserScore(supabaseUrl, supabaseAnonKey, session.telegramId, false, false);
  await startNextQuestion(session, botToken, supabaseUrl, supabaseAnonKey, env);
}

async function finishQuiz(session, botToken, supabaseUrl, supabaseAnonKey) {
  clearTimeout(session.timerTimeout);
  clearTimeout(session.countdownTimeout);
  session.active = false;

  await updateUserScore(supabaseUrl, supabaseAnonKey, session.telegramId, false, true);
  await sendTelegram(botToken, 'sendMessage', {
    chat_id: session.chatId,
    text: `Quiz complete! 🎉\nYour final score: ${session.score}/${quizQuestions.length}`
  });
  quizSessions.delete(session.chatId);
}

async function ensureUser(supabaseUrl, supabaseAnonKey, telegramId, username) {
  const existing = await getUserProfile(supabaseUrl, supabaseAnonKey, telegramId);
  if (existing) {
    return existing;
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/users?on_conflict=telegram_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      Prefer: 'return=representation'
    },
    body: JSON.stringify([{
      telegram_id: telegramId,
      username,
      total_score: 0,
      quizzes_taken: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }])
  });

  if (!res.ok) {
    console.error('Failed to create user in Supabase', await res.text());
  }

  return getUserProfile(supabaseUrl, supabaseAnonKey, telegramId);
}

async function getUserProfile(supabaseUrl, supabaseAnonKey, telegramId) {
  const res = await fetch(`${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegramId}&select=id,telegram_id,username,total_score,quizzes_taken`, {
    method: 'GET',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    }
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function updateUserScore(supabaseUrl, supabaseAnonKey, telegramId, isCorrect, quizCompleted) {
  if (!telegramId) {
    return;
  }

  const profile = await getUserProfile(supabaseUrl, supabaseAnonKey, telegramId);
  if (!profile) {
    return;
  }

  const nextScore = profile.total_score + (isCorrect ? 1 : 0);
  const nextQuizzes = profile.quizzes_taken + (quizCompleted ? 1 : 0);

  const res = await fetch(`${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegramId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    },
    body: JSON.stringify({
      total_score: nextScore,
      quizzes_taken: nextQuizzes,
      updated_at: new Date().toISOString()
    })
  });

  if (!res.ok) {
    console.error('Failed to update score in Supabase', await res.text());
  }
}

async function getLeaderboard(supabaseUrl, supabaseAnonKey) {
  const res = await fetch(`${supabaseUrl}/rest/v1/users?select=telegram_id,username,total_score,quizzes_taken&order=total_score.desc&limit=10`, {
    method: 'GET',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    }
  });

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function sendTelegram(botToken, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Telegram ${method} failed`, errorText);
    return null;
  }

  return response.json();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
