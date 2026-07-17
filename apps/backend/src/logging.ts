import { createLogger } from '@lilypad/shared';

/**
 * One structured logger per subsystem (no println debugging). Each carries its
 * own `name` so logs are filterable: `{name: "signaling", ...}`.
 */
export const log = {
  server: createLogger('server'),
  signaling: createLogger('signaling'),
  session: createLogger('session'),
  turn: createLogger('turn'),
  security: createLogger('security'),
  pairing: createLogger('pairing'),
  audit: createLogger('audit'),
};
