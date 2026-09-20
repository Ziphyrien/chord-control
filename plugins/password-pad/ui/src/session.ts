import { CONFIRM_KEY, GRID_SIZE, MAX_INPUT_LENGTH, type ChallengeView } from "../../input.ts";
import type { Json } from "../../../../shared/protocol.ts";
import { message } from "../../../../shared/validation.ts";

export interface PadState {
  view: ChallengeView | null;
  count: number;
  busy: boolean;
  message: string;
}
type Rpc = (method: string, input?: Json) => Promise<Json>;
function challenge(value: Json): ChallengeView | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    typeof value.title !== "string" ||
    typeof value.expiresAt !== "number" ||
    value.size !== GRID_SIZE ||
    !Array.isArray(value.cells) ||
    value.cells.length !== GRID_SIZE ** 2 ||
    !value.cells.every((cell) => typeof cell === "string" && /^(?:[A-Z0-9]|＃)$/.test(cell)) ||
    value.cells.filter((cell) => cell === CONFIRM_KEY).length !== 1
  )
    throw new Error("密保盘加载失败，请稍后重试");
  return value as unknown as ChallengeView;
}

/** One state owner keeps displayed cells, clicked indices and RPC revisions together. */
export class PadSession {
  private view: ChallengeView | null = null;
  private sequence: number[] = [];
  private busy = false;
  private message = "";
  private active = false;
  private loaded = false;
  private readError = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  private readonly rpc: Rpc;
  private readonly changed: (state: PadState) => void;
  constructor(rpc: Rpc, changed: (state: PadState) => void) {
    this.rpc = rpc;
    this.changed = changed;
  }
  private emit(): void {
    this.changed({
      view: this.view ? { ...this.view, cells: [...this.view.cells] } : null,
      count: this.sequence.length,
      busy: this.busy || !this.active || !this.loaded,
      message: this.message,
    });
  }
  start(): void {
    if (this.active) return;
    this.active = true;
    this.emit();
    void this.refresh();
  }
  pause(): void {
    this.active = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.view = null;
    this.sequence = [];
    this.busy = false;
    this.loaded = false;
    this.message = "";
    this.readError = false;
    this.emit();
  }
  async refresh(): Promise<void> {
    if (!this.active || this.busy || this.reading) return;
    clearTimeout(this.timer);
    const epoch = this.epoch;
    this.reading = (async () => {
      try {
        const next = challenge(await this.rpc("challenge"));
        if (!this.active || epoch !== this.epoch) return;
        this.loaded = true;
        if (this.readError) this.message = "";
        this.readError = false;
        if (next?.id !== this.view?.id || next?.revision !== this.view?.revision) {
          this.view = next;
          this.sequence = [];
        }
        this.emit();
      } catch (error) {
        if (this.active && epoch === this.epoch) {
          this.message = message(error);
          this.loaded = true;
          this.readError = true;
          this.view = null;
          this.sequence = [];
          this.emit();
        }
      }
    })();
    try {
      await this.reading;
    } finally {
      this.reading = undefined;
      if (this.active && !this.busy)
        this.timer = setTimeout(
          () => {
            void this.refresh();
          },
          epoch === this.epoch ? 750 : 0,
        );
    }
  }
  backspace(): void {
    if (!this.active || this.busy) return;
    this.sequence.pop();
    this.emit();
  }
  async select(index: number): Promise<void> {
    if (
      !this.active ||
      this.busy ||
      !this.view ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.view.cells.length
    )
      return;
    if (this.view.cells[index] !== CONFIRM_KEY) {
      if (this.sequence.length < MAX_INPUT_LENGTH) {
        this.sequence.push(index);
        this.message = "";
      } else this.message = `最多输入 ${MAX_INPUT_LENGTH} 位，请点击 ＃ 确认`;
      this.emit();
      return;
    }
    const input = {
      id: this.view.id,
      revision: this.view.revision,
      sequence: [...this.sequence, index],
    };
    const epoch = ++this.epoch;
    this.busy = true;
    clearTimeout(this.timer);
    this.emit();
    try {
      const result = await this.rpc("submit", input);
      if (!this.active || epoch !== this.epoch) return;
      this.message =
        result && typeof result === "object" && !Array.isArray(result) && result.approved === true
          ? "验证成功"
          : result &&
              typeof result === "object" &&
              !Array.isArray(result) &&
              result.retryable === false
            ? "本次验证已结束，请重新发起操作"
            : "验证未通过，请重新输入";
    } catch (error) {
      if (this.active && epoch === this.epoch) this.message = message(error);
    } finally {
      if (this.active && epoch === this.epoch) {
        this.view = null;
        this.sequence = [];
        this.busy = false;
        this.emit();
        // An older poll must drain before the post-submit refresh can start.
        await this.reading;
        await this.refresh();
      }
    }
  }
}
