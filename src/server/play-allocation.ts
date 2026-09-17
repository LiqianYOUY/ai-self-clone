import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { PlayIdentity } from "../domain/play";

export const PLAY_ALLOCATION_VERSION = "five-game-mix-v1";

export type PlayAllocationState = {
  version: typeof PLAY_ALLOCATION_VERSION;
  blockId: string;
  order: PlayIdentity[];
  nextIndex: 0 | 1 | 2 | 3 | 4 | 5;
};

/** Frozen room metadata, deliberately excluding the remaining identities. */
export type PlayAllocationPolicy = {
  version: typeof PLAY_ALLOCATION_VERSION;
  blockId: string;
  slot: 1 | 2 | 3 | 4 | 5;
};

/** Internal dependency injection for deterministic tests; never request input. */
type PlayAllocationRandom = {
  randomInt?: (maxExclusive: number) => number;
  randomBytes?: (size: number) => Uint8Array;
  /** Completed AI streak before the first tracked block; bounded by the caller. */
  initialTrailingAI?: number;
};

export class PlayAllocationError extends Error {
  constructor() {
    super("Invalid or stale play allocation.");
    this.name = "PlayAllocationError";
  }
}

const blockIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const stateSchema = z.strictObject({
  version: z.literal(PLAY_ALLOCATION_VERSION),
  blockId: blockIdSchema,
  order: z
    .array(z.enum(["HUMAN", "AI"]))
    .length(5)
    .refine((order) => {
      const humans = order.filter((mode) => mode === "HUMAN").length;
      return humans === 1 || humans === 2;
    }),
  nextIndex: z.number().int().min(0).max(5),
});
const policySchema = z.strictObject({
  version: z.literal(PLAY_ALLOCATION_VERSION),
  blockId: blockIdSchema,
  slot: z.number().int().min(1).max(5),
});

function readState(value: unknown): PlayAllocationState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new PlayAllocationError();
  return parsed.data as PlayAllocationState;
}

function createState(
  options: PlayAllocationRandom,
  trailingAI: number,
  previousBlockId?: string,
): PlayAllocationState {
  if (!Number.isInteger(trailingAI) || trailingAI < 0 || trailingAI > 4) {
    throw new PlayAllocationError();
  }
  const draw = (maxExclusive: number) => {
    const value = (options.randomInt ?? randomInt)(maxExclusive);
    if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
      throw new PlayAllocationError();
    }
    return value;
  };
  const humanCount = draw(2) + 1;
  const candidates: PlayIdentity[][] = [];
  for (let mask = 1; mask < 1 << 5; mask += 1) {
    const order: PlayIdentity[] = Array.from({ length: 5 }, (_, index) =>
      mask & (1 << index) ? "HUMAN" : "AI",
    );
    if (
      order.filter((mode) => mode === "HUMAN").length === humanCount &&
      order.indexOf("HUMAN") + trailingAI <= 4
    ) {
      candidates.push(order);
    }
  }
  // The quota is uniform first, then each permitted arrangement is uniform.
  // Filtering a fixed set avoids unbounded retries at a block boundary.
  const order = candidates[draw(candidates.length)];
  const bytes = (options.randomBytes ?? randomBytes)(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new PlayAllocationError();
  }
  const blockId = Buffer.from(bytes).toString("hex");
  // A reused ID would make an old room's first slot valid in the next block.
  if (blockId === previousBlockId) throw new PlayAllocationError();
  return { version: PLAY_ALLOCATION_VERSION, blockId, order, nextIndex: 0 };
}

/** Reserve the next identity without consuming it when an invitation is made. */
export function preparePlayAllocation(
  value: unknown,
  options: PlayAllocationRandom = {},
): {
  state: PlayAllocationState;
  mode: PlayIdentity;
  policy: PlayAllocationPolicy;
} {
  let state =
    value == null
      ? createState(options, options.initialTrailingAI ?? 0)
      : readState(value);
  if (state.nextIndex === 5) {
    const trailingAI =
      state.order.length - state.order.lastIndexOf("HUMAN") - 1;
    state = createState(options, trailingAI, state.blockId);
  }
  return {
    state,
    mode: state.order[state.nextIndex],
    policy: {
      version: PLAY_ALLOCATION_VERSION,
      blockId: state.blockId,
      slot: (state.nextIndex + 1) as PlayAllocationPolicy["slot"],
    },
  };
}

/** Consume exactly one slot only after that room's final source reply commits. */
export function completePlayAllocation(
  value: unknown,
  policy: unknown,
  mode: string,
): PlayAllocationState {
  const state = readState(value);
  const parsedPolicy = policySchema.safeParse(policy);
  if (
    !parsedPolicy.success ||
    state.nextIndex === 5 ||
    parsedPolicy.data.blockId !== state.blockId ||
    parsedPolicy.data.slot !== state.nextIndex + 1 ||
    mode !== state.order[state.nextIndex]
  ) {
    throw new PlayAllocationError();
  }
  return {
    ...state,
    nextIndex: (state.nextIndex + 1) as PlayAllocationState["nextIndex"],
  };
}
