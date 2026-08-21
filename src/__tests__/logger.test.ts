import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../shared/logger";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs info with context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test");
    logger.info("hello", { key: "value" });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.level).toBe("info");
    expect(logged.context).toBe("test");
    expect(logged.message).toBe("hello");
    expect(logged.key).toBe("value");
    expect(logged.timestamp).toBeTruthy();
  });

  it("logs warn", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("ctx");
    logger.warn("bad");
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.level).toBe("warn");
  });

  it("logs error", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("ctx");
    logger.error("fail");
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.level).toBe("error");
  });

  it("logs debug", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("ctx");
    logger.debug("trace");
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.level).toBe("debug");
  });
});
