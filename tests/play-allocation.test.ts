import assert from "node:assert/strict";
import test from "node:test";
import type { PlayIdentity } from "../src/domain/play";
import {
  completePlayAllocation,
  PLAY_ALLOCATION_VERSION,
  PlayAllocationError,
  type PlayAllocationState,
  preparePlayAllocation,
} from "../src/server/play-allocation";

const blockId = "01".repeat(16);
const otherBlockId = "02".repeat(16);
const arrangements = {
  1: ["HAAAA", "AHAAA", "AAHAA", "AAAHA", "AAAAH"],
  2: [
    "HHAAA",
    "HAHAA",
    "HAAHA",
    "HAAAH",
    "AHHAA",
    "AHAHA",
    "AHAAH",
    "AAHHA",
    "AAHAH",
    "AAAHH",
  ],
};

function identities(order: string): PlayIdentity[] {
  return [...order].map((identity) => (identity === "H" ? "HUMAN" : "AI"));
}

function compact(order: PlayIdentity[]): string {
  return order.map((identity) => (identity === "HUMAN" ? "H" : "A")).join("");
}

function existingState(order = "AHAAA", nextIndex = 0): PlayAllocationState {
  return {
    version: PLAY_ALLOCATION_VERSION,
    blockId,
    order: identities(order),
    nextIndex: nextIndex as PlayAllocationState["nextIndex"],
  };
}

function randomness(
  humanCount: 1 | 2,
  arrangement: number,
  initialTrailingAI = 0,
) {
  const draws = [humanCount - 1, arrangement];
  const bounds: number[] = [];
  return {
    bounds,
    options: {
      randomInt(maxExclusive: number) {
        bounds.push(maxExclusive);
        assert(draws.length > 0, "unexpected random draw");
        return draws.shift()!;
      },
      randomBytes(size: number) {
        assert.equal(size, 16);
        return Buffer.alloc(size, 2);
      },
      initialTrailingAI,
    },
  };
}

test("each complete block consumes exactly five slots with its one-or-two-human quota", () => {
  for (const humans of [1, 2] as const) {
    for (const [index] of arrangements[humans].entries()) {
      const random = randomness(humans, index);
      let { state } = preparePlayAllocation(null, random.options);
      const modes: PlayIdentity[] = [];
      for (let turn = 1; turn <= 5; turn += 1) {
        const prepared = preparePlayAllocation(state);
        assert.equal(prepared.policy.slot, turn);
        assert.equal(prepared.policy.blockId, otherBlockId);
        assert.deepEqual(Object.keys(prepared.policy).sort(), [
          "blockId",
          "slot",
          "version",
        ]);
        modes.push(prepared.mode);
        state = completePlayAllocation(state, prepared.policy, prepared.mode);
        assert.equal(state.nextIndex, turn);
      }
      assert.equal(modes.filter((mode) => mode === "HUMAN").length, humans);
      assert.equal(state.nextIndex, 5);
    }
  }
});

test("quota is chosen uniformly before uniformly indexing eligible arrangements", () => {
  const expectedCounts = { 1: [5, 4, 3, 2, 1], 2: [10, 10, 9, 7, 4] };
  for (const humans of [1, 2] as const) {
    for (let trailingAI = 0; trailingAI <= 4; trailingAI += 1) {
      const seen = new Set<string>();
      const count = expectedCounts[humans][trailingAI];
      for (let index = 0; index < count; index += 1) {
        const random = randomness(humans, index, trailingAI);
        const { state } = preparePlayAllocation(undefined, random.options);
        assert.deepEqual(random.bounds, [2, count]);
        seen.add(compact(state.order));
      }
      assert.equal(seen.size, count);
      const expected = arrangements[humans].filter(
        (order) => order.indexOf("H") + trailingAI <= 4,
      );
      assert.deepEqual([...seen].sort(), expected.sort());
    }
  }
});

test("cancelled or expired invitations reserve the same unconsumed identity", () => {
  for (let nextIndex = 0; nextIndex < 5; nextIndex += 1) {
    const state = existingState("AAHAH", nextIndex);
    const untouched = structuredClone(state);
    const first = preparePlayAllocation(state);
    for (let retry = 0; retry < 8; retry += 1) {
      const retryInvitation = preparePlayAllocation(first.state, {
        randomInt() {
          throw new Error("existing plan must not be reshuffled");
        },
        randomBytes() {
          throw new Error("existing block ID must not be replaced");
        },
        initialTrailingAI: 99,
      });
      assert.deepEqual(retryInvitation, first);
    }
    assert.deepEqual(state, untouched);
  }
});

test("consuming a slot does not mutate its stored state or policy", () => {
  const first = preparePlayAllocation(existingState());
  const original = structuredClone(first);
  const advanced = completePlayAllocation(
    first.state,
    first.policy,
    first.mode,
  );
  assert.equal(advanced.nextIndex, 1);
  assert.notEqual(advanced, first.state);
  assert.deepEqual(first, original);
});

test("an exhausted block obtains a fresh ID and respects the previous AI streak", () => {
  for (const previousOrder of [...arrangements[1], ...arrangements[2]]) {
    const previous = existingState(previousOrder, 5);
    const trailingAI = 4 - previousOrder.lastIndexOf("H");
    for (const humans of [1, 2] as const) {
      const eligible = arrangements[humans].filter(
        (order) => trailingAI + order.indexOf("H") <= 4,
      );
      for (let index = 0; index < eligible.length; index += 1) {
        // Initial history is irrelevant once an actual tracked block exists.
        const random = randomness(humans, index, 99);
        const next = preparePlayAllocation(previous, random.options);
        assert.equal(next.state.nextIndex, 0);
        assert.equal(next.state.blockId, otherBlockId);
        assert.equal(next.policy.slot, 1);
        assert(
          !`${previousOrder}${compact(next.state.order)}`.includes("AAAAA"),
        );
        assert.equal(previous.nextIndex, 5);
      }
    }
  }
});

test("a pre-existing run of five AI games, clamped to four, starts with a human", () => {
  for (const humans of [1, 2] as const) {
    const count = humans === 1 ? 1 : 4;
    for (let index = 0; index < count; index += 1) {
      const { options } = randomness(humans, index, 4);
      const next = preparePlayAllocation(null, options);
      assert.equal(next.mode, "HUMAN");
      assert.equal(
        next.state.order.filter((mode) => mode === "HUMAN").length,
        humans,
      );
    }
  }
});

test("completion rejects stale slots, mismatched identities, and repeated consumption", () => {
  const first = preparePlayAllocation(existingState());
  const advanced = completePlayAllocation(
    first.state,
    first.policy,
    first.mode,
  );
  const second = preparePlayAllocation(advanced);
  for (const [state, policy, mode] of [
    [advanced, first.policy, first.mode],
    [first.state, second.policy, first.mode],
    [first.state, { ...first.policy, blockId: otherBlockId }, first.mode],
    [first.state, first.policy, "HUMAN"],
    [first.state, first.policy, "ai"],
    [existingState("AHAAA", 5), { ...first.policy, slot: 5 }, "AI"],
    [null, first.policy, first.mode],
    [undefined, first.policy, first.mode],
  ] as const) {
    assert.throws(
      () => completePlayAllocation(state, policy, mode),
      PlayAllocationError,
    );
  }
});

test("an old block's room cannot consume a slot after rollover", () => {
  const original = preparePlayAllocation(existingState());
  const next = preparePlayAllocation(
    existingState("AHAAA", 5),
    randomness(1, 0).options,
  );
  assert.throws(
    () => completePlayAllocation(next.state, original.policy, next.mode),
    PlayAllocationError,
  );
  assert.throws(
    () =>
      preparePlayAllocation(existingState("AHAAA", 5), {
        ...randomness(1, 0).options,
        randomBytes: (size) => Buffer.alloc(size, 1),
      }),
    PlayAllocationError,
  );
});

test("malformed non-null state fails closed instead of silently creating a plan", () => {
  const good = existingState();
  const malformed: unknown[] = [
    "{}",
    JSON.stringify(good),
    false,
    0,
    [],
    {},
    { ...good, version: "legacy" },
    { ...good, blockId: "not-a-block-id" },
    { ...good, blockId: "AF".repeat(16) },
    { ...good, order: identities("AAAAA") },
    { ...good, order: identities("HHHAA") },
    { ...good, order: identities("HAAA") },
    { ...good, order: identities("HAAAAA") },
    { ...good, order: ["HUMAN", "AI", "AI", "AI", "other"] },
    { ...good, nextIndex: -1 },
    { ...good, nextIndex: 6 },
    { ...good, nextIndex: 1.5 },
    { ...good, nextIndex: "0" },
    { ...good, nextIndex: Number.NaN },
    { ...good, extra: true },
  ];
  for (const value of malformed) {
    assert.throws(() => preparePlayAllocation(value), PlayAllocationError);
    assert.throws(
      () =>
        completePlayAllocation(value, preparePlayAllocation(good).policy, "AI"),
      PlayAllocationError,
    );
  }
});

test("invalid room policy is rejected and cannot carry a future plan", () => {
  const { state, mode, policy } = preparePlayAllocation(existingState());
  for (const invalid of [
    null,
    undefined,
    JSON.stringify(policy),
    {},
    { ...policy, version: "wrong-version" },
    { ...policy, slot: 0 },
    { ...policy, slot: 6 },
    { ...policy, slot: 1.5 },
    { ...policy, order: state.order },
  ]) {
    assert.throws(
      () => completePlayAllocation(state, invalid, mode),
      PlayAllocationError,
    );
  }
});

test("invalid initial history and invalid injected entropy fail closed", () => {
  for (const initialTrailingAI of [-1, 5, 1.5, Number.NaN]) {
    assert.throws(
      () => preparePlayAllocation(null, { initialTrailingAI }),
      PlayAllocationError,
    );
  }
  for (const invalid of [-1, 2, 1.5, Number.NaN]) {
    assert.throws(
      () => preparePlayAllocation(null, { randomInt: () => invalid }),
      PlayAllocationError,
    );
  }
  assert.throws(
    () =>
      preparePlayAllocation(null, {
        ...randomness(1, 5).options,
      }),
    PlayAllocationError,
  );
  assert.throws(
    () =>
      preparePlayAllocation(null, {
        ...randomness(1, 0).options,
        randomBytes: () => new Uint8Array(15),
      }),
    PlayAllocationError,
  );
});

test("production entropy yields a valid private block", () => {
  const { state, policy } = preparePlayAllocation(null);
  assert.match(state.blockId, /^[a-f0-9]{32}$/);
  assert.equal(state.nextIndex, 0);
  assert.deepEqual(policy, {
    version: PLAY_ALLOCATION_VERSION,
    blockId: state.blockId,
    slot: 1,
  });
  assert.equal(state.order.length, 5);
  assert(
    [1, 2].includes(state.order.filter((mode) => mode === "HUMAN").length),
  );
});
