const ELIGIBILITY = {
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  ELIGIBLE: 'ELIGIBLE',
  GROUP_PENDING: 'GROUP_PENDING',
  GROUP_VERIFIED: 'GROUP_VERIFIED',
};

const REFERRAL_STATUS = {
  PENDING: 'PENDING',
  VALID: 'VALID',
};

const REFERRAL_TOKEN_LENGTH = 8;
const REFERRAL_TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralToken() {
  let token = '';
  for (let i = 0; i < REFERRAL_TOKEN_LENGTH; i++) {
    token += REFERRAL_TOKEN_CHARS.charAt(Math.floor(Math.random() * REFERRAL_TOKEN_CHARS.length));
  }
  return token;
}

export class KiwiState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    try {
      const body = await request.json();
      const action = body.action;
      const result = await this.handleAction(action, body);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('KiwiState error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  async handleAction(action, body) {
    switch (action) {
      case 'getOrCreateUser':
        return this.getOrCreateUser(body.userId, body.firstName, body.lastName, body.username);
      case 'getUser':
        return this.getUser(body.userId);
      case 'updateUserField':
        return this.updateUserField(body.userId, body.field, body.value);
      case 'processReferral':
        return this.processReferral(body.referralToken, body.referredUserId, body.firstName, body.lastName, body.username);
      case 'getReferralCount':
        return this.getReferralCount(body.userId);
      case 'getConfig':
        return this.getConfig();
      case 'setConfig':
        return this.setConfig(body.config);
      case 'verifyGroupMembership':
        return this.verifyGroupMembership(body.userId, body.groupId);
      case 'getAccessStats':
        return this.getAccessStats();
      case 'saveQuizState':
        return this.saveQuizState(body.chatId, body.state);
      case 'getQuizState':
        return this.getQuizState(body.chatId);
      case 'deleteQuizState':
        return this.deleteQuizState(body.chatId);
      case 'scheduleQuiz':
        return this.scheduleQuiz(body);
      case 'listScheduledQuizzes':
        return this.listScheduledQuizzes();
      case 'getDueQuizzes':
        return this.getDueQuizzes();
      case 'removeScheduledQuiz':
        return this.removeScheduledQuiz(body.scheduleId);
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  async getOrCreateUser(userId, firstName, lastName, username) {
    const userKey = `user:${userId}`;
    let user = await this.storage.get(userKey);

    if (!user) {
      const referralToken = generateReferralToken();
      user = {
        telegramUserId: userId,
        username: username || '',
        firstName: firstName || '',
        lastName: lastName || '',
        eligibility: ELIGIBILITY.NOT_ELIGIBLE,
        referralToken: referralToken,
        referrerId: null,
        referralCount: 0,
        groupId: null,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };
      await this.storage.put(userKey, user);
    } else {
      user.lastActiveAt = new Date().toISOString();
      if (firstName && firstName !== user.firstName) user.firstName = firstName;
      if (lastName && lastName !== user.lastName) user.lastName = lastName;
      if (username && username !== user.username) user.username = username;
      await this.storage.put(userKey, user);
    }

    return { user };
  }

  async getUser(userId) {
    const user = await this.storage.get(`user:${userId}`);
    return { user };
  }

  async updateUserField(userId, field, value) {
    const userKey = `user:${userId}`;
    const user = await this.storage.get(userKey);
    if (!user) {
      return { error: 'User not found' };
    }

    const allowedFields = ['eligibility', 'groupId', 'referralCount', 'username', 'firstName', 'lastName'];
    if (!allowedFields.includes(field)) {
      return { error: `Field '${field}' cannot be updated directly` };
    }

    user[field] = value;
    user.lastActiveAt = new Date().toISOString();
    await this.storage.put(userKey, user);

    return { success: true, user };
  }

  async processReferral(referralToken, referredUserId, firstName, lastName, username) {
    const referralKey = `referral:${referralToken}`;
    const referral = await this.storage.get(referralKey);

    if (!referral) {
      return { error: 'Invalid referral token' };
    }

    if (referral.referredUserId === referredUserId) {
      return { error: 'Self-referral not allowed' };
    }

    if (referral.referredUserId !== null) {
      return { error: 'Referral already used' };
    }

    const referredUser = await this.getOrCreateUser(referredUserId, firstName, lastName, username);

    if (referredUser.user.referrerId !== null && referredUser.user.referrerId !== referral.referrerId) {
      return { error: 'User already has a different referrer' };
    }

    referral.referredUserId = referredUserId;
    referral.status = REFERRAL_STATUS.VALID;
    referral.validatedAt = new Date().toISOString();
    await this.storage.put(referralKey, referral);

    const referrer = await this.getUser(referral.referrerId);
    if (referrer.user) {
      referrer.user.referralCount = (referrer.user.referralCount || 0) + 1;
      await this.storage.put(`user:${referral.referrerId}`, referrer.user);
    }

    const config = await this.getConfig();
    const requiredReferrals = (config && config.requiredReferrals) || 2;

    if (referrer.user && referrer.user.referralCount >= requiredReferrals && referrer.user.eligibility !== ELIGIBILITY.ELIGIBLE) {
      referrer.user.eligibility = ELIGIBILITY.ELIGIBLE;
      await this.storage.put(`user:${referral.referrerId}`, referrer.user);
    }

    if (referredUser.user.eligibility === ELIGIBILITY.NOT_ELIGIBLE) {
      referredUser.user.referrerId = referral.referrerId;
      await this.storage.put(`user:${referredUserId}`, referredUser.user);
    }

    return {
      success: true,
      referral: referral,
      referrerUpdated: referrer.user ? referrer.user.eligibility === ELIGIBILITY.ELIGIBLE : false,
      referredUser: referredUser.user,
    };
  }

  async getReferralCount(userId) {
    const user = await this.getUser(userId);
    if (user.user) {
      return { referralCount: user.user.referralCount || 0, user: user.user };
    }
    return { referralCount: 0, user: null };
  }

  async getConfig() {
    const config = await this.storage.get('config:access');
    if (!config) {
      const defaultConfig = {
        groupId: null,
        groupInviteLink: 'https://t.me/kiwi_quiz_group',
        requiredReferrals: 2,
        referralRequired: true,
        groupVerification: true,
      };
      await this.storage.put('config:access', defaultConfig);
      return defaultConfig;
    }
    return config;
  }

  async setConfig(config) {
    await this.storage.put('config:access', config);
    return { success: true, config };
  }

  async verifyGroupMembership(userId, groupId) {
    const TELEGRAM_API = `https://api.telegram.org/bot${this.env.BOT_TOKEN}`;
    let isMember = false;

    try {
      const res = await fetch(`${TELEGRAM_API}/getChatMember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: groupId, user_id: userId }),
      });
      const result = await res.json();
      if (result.ok && result.result) {
        const status = result.result.status;
        isMember = (status === 'member' || status === 'administrator' || status === 'creator');
      }
    } catch (e) {
      console.error(`Group membership check failed for user ${userId} in group ${groupId}:`, e.message);
    }

    if (isMember) {
      const userKey = `user:${userId}`;
      const user = await this.storage.get(userKey);
      if (user) {
        user.eligibility = ELIGIBILITY.GROUP_VERIFIED;
        user.lastActiveAt = new Date().toISOString();
        await this.storage.put(userKey, user);
        return { success: true, isMember: true, user };
      }
    }

    return { success: true, isMember, user: await this.getUser(userId) };
  }

  async getAccessStats() {
    const users = await this.storage.list({ prefix: 'user:' });
    let total = 0, eligible = 0, groupVerified = 0;

    for (const value of Object.values(users.value || users)) {
      total++;
      if (value.eligibility === ELIGIBILITY.ELIGIBLE || value.eligibility === ELIGIBILITY.GROUP_PENDING) eligible++;
      if (value.eligibility === ELIGIBILITY.GROUP_VERIFIED) groupVerified++;
    }

    const referrals = await this.storage.list({ prefix: 'referral:' });
    let pendingReferrals = 0, validReferrals = 0;
    for (const ref of Object.values(referrals.value || referrals)) {
      if (ref.status === REFERRAL_STATUS.VALID) validReferrals++;
      else pendingReferrals++;
    }

    return { total, eligible, groupVerified, pendingReferrals, validReferrals };
  }

  async saveQuizState(chatId, quizState) {
    const key = `quiz:${chatId}`;
    await this.storage.put(key, {
      ...quizState,
      savedAt: new Date().toISOString(),
    });
    return { success: true };
  }

  async getQuizState(chatId) {
    return await this.storage.get(`quiz:${chatId}`);
  }

  async deleteQuizState(chatId) {
    await this.storage.delete(`quiz:${chatId}`);
    return { success: true };
  }

  async scheduleQuiz({ chatId, hostId, questionCount, timerSeconds, scheduledTime }) {
    const scheduleId = `schedule:${chatId}:${Date.now()}`;
    const entry = {
      scheduleId,
      chatId,
      hostId,
      questionCount,
      timerSeconds,
      scheduledTime,
      createdAt: new Date().toISOString(),
    };
    await this.storage.put(scheduleId, entry);
    return { success: true, schedule: entry };
  }

  async listScheduledQuizzes() {
    const result = await this.storage.list({ prefix: 'schedule:' });
    const schedules = Object.values(result.value || result)
      .filter(s => new Date(s.scheduledTime).getTime() > Date.now())
      .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
    return { schedules };
  }

  async getDueQuizzes() {
    const now = Date.now();
    const result = await this.storage.list({ prefix: 'schedule:' });
    const due = [];
    const toRemove = [];
    for (const [key, entry] of Object.entries(result.value || result)) {
      if (new Date(entry.scheduledTime).getTime() <= now) {
        due.push(entry);
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      await this.storage.delete(key);
    }
    return { due };
  }

  async removeScheduledQuiz(scheduleId) {
    await this.storage.delete(scheduleId);
    return { success: true };
  }
}

export { ELIGIBILITY, REFERRAL_STATUS, generateReferralToken };
