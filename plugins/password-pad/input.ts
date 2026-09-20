export const GRID_SIZE = 6;
export const CONFIRM_KEY = "＃";
export const MAX_INPUT_LENGTH = 32;

/** Serializable public view: the provider never sends the daily answer. */
export type ChallengeView = {
  id: string;
  revision: number;
  title: string;
  cells: string[];
  size: number;
  expiresAt: number;
};
