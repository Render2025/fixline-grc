import type { Env } from '../types';

export class PilotModeError extends Error {}

/** All report-processing and release entry points fail closed outside the human pilot. */
export function requireHumanPilot(env: Env): void {
  if (env.PILOT_MODE !== 'human') {
    throw new PilotModeError('FixLine is unavailable because HUMAN_PROCESSING is not configured.');
  }
}
