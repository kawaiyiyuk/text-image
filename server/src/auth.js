import crypto from 'node:crypto';

/** @param {{ auth: { username: string; password: string; tokenTtlMs: number } }} config */
export function createAuth(config) {
  const sessions = new Map();
  const enabled = Boolean(config.auth?.username && config.auth?.password);

  function issueToken() {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenTtlMs = config.auth.tokenTtlMs || 7 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + tokenTtlMs;
    sessions.set(token, expiresAt);
    return { token, expiresAt, tokenTtlMs };
  }

  function verifyToken(token) {
    if (!token || typeof token !== 'string') {
      return false;
    }
    const expiresAt = sessions.get(token);
    if (!expiresAt || Date.now() > expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function pruneExpired() {
    const now = Date.now();
    for (const [t, exp] of sessions) {
      if (now > exp) {
        sessions.delete(t);
      }
    }
  }

  function middleware(req, res, next) {
    if (!enabled) {
      next();
      return;
    }
    pruneExpired();
    const raw = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(raw);
    const token = m ? m[1] : '';
    if (!verifyToken(token)) {
      res.status(401).json({
        success: false,
        message: '未登录或登录已过期',
        code: 'UNAUTHORIZED'
      });
      return;
    }
    next();
  }

  function loginHandler(req, res) {
    if (!enabled) {
      res.json({
        success: true,
        data: { token: null, authRequired: false }
      });
      return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();
    if (username !== config.auth.username || password !== config.auth.password) {
      res.status(401).json({
        success: false,
        message: '账号或密码错误'
      });
      return;
    }
    const session = issueToken();
    res.json({
      success: true,
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        tokenTtlMs: session.tokenTtlMs,
        authRequired: true
      }
    });
  }

  return {
    enabled,
    middleware,
    loginHandler
  };
}
