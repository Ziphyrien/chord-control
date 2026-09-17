import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { Challenges } from "../plugins/password-pad/src/challenges.ts";
import { accepts, makeBoard, passwordFor } from "../plugins/password-pad/src/board.ts";
const fixed = () => new Date(2026, 10, 11, 12); // 22W requires two clicks on the same cell.
const input = (view, text = "22W", confirm = true) =>
  Array.from(text)
    .map((letter) => view.cells.indexOf(letter))
    .concat(confirm ? [view.cells.indexOf("＃")] : []);
function fixture(t, now = fixed) {
  const challenges = new Challenges(() => {}, now);
  t.onTestFinished(() => challenges.dispose());
  return { challenges, result: challenges.request("打开控制中心") };
}

test("single, repeated and nonadjacent clicks accept contiguous password with decoys", async (t) => {
  for (const text of ["22W", "W222WW2"]) {
    const { challenges, result } = fixture(t);
    const view = challenges.view();
    assert.equal(view.cells.filter((cell) => cell === "＃").length, 1);
    const sequence = input(view, text);
    assert.equal(challenges.submit(view.id, view.revision, sequence), true);
    assert.equal(await result, true);
    assert.equal(challenges.view(), null);
    assert.equal(challenges.submit(view.id, view.revision, sequence), false);
  }
  const cells = Array(36).fill("X");
  cells[0] = "2";
  cells[35] = "W";
  cells[9] = "＃";
  assert.equal(accepts(cells, "22W", [0, 0, 35, 9]), true);
});

test("only the full contiguous answer followed by one final fullwidth confirmation succeeds", () => {
  const cells = makeBoard("22W");
  const view = { cells };
  for (const sequence of [
    input(view, "2W2W"),
    input(view, "22W", false),
    input(view, "22W＃2"),
    input(view, "2".repeat(32) + "W"),
    [cells.indexOf("＃")],
    [-1],
    [36],
    [0.5],
    ["0"],
    [null],
    null,
  ])
    assert.equal(accepts(cells, "22W", sequence), false);
  assert.equal(accepts(cells, "22W", input(view, "W".repeat(29) + "22W")), true);
});

test("five attempts close the request; stale revisions do not consume an attempt", async (t) => {
  const { challenges, result } = fixture(t);
  const initial = challenges.view();
  for (let attempt = 0; attempt < 5; attempt++) {
    const view = challenges.view();
    assert.equal(view.revision, attempt);
    assert.equal(challenges.submit(view.id, view.revision, []), false);
    for (let replay = 0; replay < 8; replay++)
      assert.equal(challenges.submit(initial.id, initial.revision, input(initial)), false);
  }
  assert.equal(await result, false);
  assert.equal(challenges.view(), null);
});

test("request expiry is 120 seconds even without polling", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => vi.useRealTimers());
  const { challenges, result } = fixture(t);
  const view = challenges.view();
  assert.equal(view.expiresAt - fixed().getTime(), 120000);
  vi.advanceTimersByTime(119999);
  assert.equal(challenges.pending, true);
  vi.advanceTimersByTime(1);
  assert.equal(await result, false);
  assert.equal(challenges.pending, false);
});

test("date rollover invalidates a challenge that has not expired", async (t) => {
  let now = new Date(2026, 10, 11, 23, 59, 30);
  const { challenges, result } = fixture(t, () => now);
  const view = challenges.view();
  now = new Date(2026, 10, 12, 0, 0, 1);
  assert(now.getTime() < view.expiresAt);
  assert.equal(challenges.submit(view.id, view.revision, input(view)), false);
  assert.equal(await result, false);
});

test("head-only FIFO, abort, X-close and disposal resolve pending authorizations", async (t) => {
  const challenges = new Challenges(() => {}, fixed);
  t.onTestFinished(() => challenges.dispose());
  const abort = new AbortController();
  const first = challenges.request("first", abort.signal);
  const second = challenges.request("second");
  const stale = challenges.view();
  const copy = challenges.view();
  copy.cells.fill("X");
  assert.notDeepEqual(copy.cells, challenges.view().cells, "public view is a copy");
  abort.abort();
  assert.equal(await first, false);
  assert.equal(challenges.view().title, "second");
  assert.equal(challenges.submit(stale.id, stale.revision, input(stale)), false);
  challenges.close();
  assert.equal(await second, false);
  challenges.dispose();
  assert.equal(await challenges.request("after disposal"), false);
});

test("queue bound and pre-aborted contexts fail closed", async (t) => {
  const challenges = new Challenges(() => {}, fixed);
  t.onTestFinished(() => challenges.dispose());
  const results = Array.from({ length: 12 }, (_, index) => challenges.request(String(index)));
  assert.equal(await challenges.request("overflow"), false);
  assert.equal(await challenges.request("aborted", AbortSignal.abort()), false);
  challenges.close();
  assert.deepEqual(await Promise.all(results), Array(12).fill(false));
});

test("all leap-year dates contain required letters and exactly one randomly placed ＃", () => {
  const positions = new Set();
  for (let day = 1; day <= 366; day++) {
    const date = new Date(2028, 0, day, 12);
    const answer = `${date.getMonth() + 1 + date.getDate()}${["S", "M", "T", "W", "T", "F", "S"][date.getDay()]}`;
    assert.equal(passwordFor(date), answer);
    const cells = makeBoard(answer);
    assert.equal(cells.length, 36);
    assert.equal(cells.filter((cell) => cell === "＃").length, 1);
    for (const letter of answer) assert(cells.includes(letter));
    positions.add(cells.indexOf("＃"));
  }
  assert(positions.size > 1);
});
