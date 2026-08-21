import { describe, it, expect } from "vitest";
import { CloseCode } from "../shared/types";

describe("CloseCode", () => {
  it("defines all required close codes", () => {
    expect(CloseCode.BAD_OUTER_CREDENTIAL).toBe(4401);
    expect(CloseCode.HOST_OFFLINE).toBe(4404);
    expect(CloseCode.PEER_DROPPED).toBe(4408);
    expect(CloseCode.WRONG_CELL).toBe(4409);
    expect(CloseCode.LIMIT_EXCEEDED).toBe(4429);
    expect(CloseCode.DRAINING).toBe(4503);
  });
});

describe("Protocol constants", () => {
  it("has correct protocol constants", async () => {
    const proto = await import("../shared/protocol");
    expect(proto.HOST_PROOF_TRANSCRIPT_DOMAIN).toBe("FABRICA-relay-host-proof/v1");
    expect(proto.HOST_CHALLENGE_PLAINTEXT_DOMAIN).toBe("FABRICA-relay-host-challenge/v1");
    expect(proto.RELAY_HOST_PROOF_CLOCK_SKEW_MS).toBe(30000);
    expect(proto.MAX_HOST_PROOF_CHALLENGE_WINDOW_MS).toBe(10000);
    expect(proto.PING_INTERVAL_MS).toBe(15000);
  });
});
