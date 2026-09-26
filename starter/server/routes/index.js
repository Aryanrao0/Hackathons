// Route registration. The router is deliberately tiny: first match wins, so specific paths
// are registered before parameterised ones ('/members/me' before '/members/:userId').
//
// Every route goes through on(): an authenticated handler is wrapped in auditDenials(), so a
// refusal is written to the audit log in one place instead of being remembered per route.
// Success rows are written by the handlers themselves, inside their transactions.

import { auditDenials } from '../audit.js';
import { authRoutes } from './auth.js';
import { orgRoutes } from './orgs.js';
import { inviteRoutes } from './invites.js';
import { deviceRoutes } from './devices.js';
import { sessionRoutes } from './sessions.js';

export function registerRoutes(router, deps) {
  const { db } = deps;

  // on('post', '/v1/orgs/:org/grants', 'grant.create', handler, (params) => ({ targetType, targetId }))
  const on = (method, pattern, action, handler, target = () => ({})) => {
    router[method](pattern, (ctx, params, res) => {
      if (!ctx.userId) return handler(ctx, params, res);   // public route: no caller to audit
      return auditDenials(db, ctx, { action, ...target(params) }, () => handler(ctx, params, res));
    });
  };

  authRoutes(on, deps);
  orgRoutes(on, deps);
  inviteRoutes(on, deps);
  deviceRoutes(on, deps);
  sessionRoutes(on, deps);
}
