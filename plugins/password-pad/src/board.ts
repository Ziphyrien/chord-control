import { randomInt } from "node:crypto";
import { CONFIRM_KEY, GRID_SIZE, MAX_INPUT_LENGTH } from "../input.ts";
const LETTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function passwordFor(date: Date): string {
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    date.getDay()
  ];
  return `${date.getMonth() + 1 + date.getDate()}${weekday[0]}`;
}
export function localDay(date: Date): string {
  return `${date.getFullYear()}/${date.getMonth()}/${date.getDate()}`;
}
export function makeBoard(answer: string): string[] {
  const cells = [...new Set(answer), CONFIRM_KEY];
  while (cells.length < GRID_SIZE * GRID_SIZE) cells.push(LETTERS[randomInt(LETTERS.length)]);
  for (let end = cells.length - 1; end > 0; end--) {
    const selected = randomInt(end + 1);
    [cells[end], cells[selected]] = [cells[selected], cells[end]];
  }
  return cells;
}
export function accepts(cells: string[], answer: string, sequence: unknown): boolean {
  if (!Array.isArray(sequence) || sequence.length < 2 || sequence.length > MAX_INPUT_LENGTH + 1)
    return false;
  if (!sequence.every((index) => Number.isInteger(index) && index >= 0 && index < cells.length))
    return false;
  const letters = sequence.map((index: number) => cells[index]);
  if (letters.pop() !== CONFIRM_KEY || letters.includes(CONFIRM_KEY)) return false;
  return letters.join("").includes(answer);
}
