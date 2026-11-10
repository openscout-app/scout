import { afterEach, expect, test } from "bun:test";

import { waitForScoutFlight } from "./scout-broker.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubBroker(storedFlight: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(path);
    // The hot set no longer holds the flight: history rotation evicted it.
    if (path === "/v1/snapshot") return jsonResponse({ flights: {} });
    if (path.startsWith("/v1/flights/")) {
      return storedFlight ? jsonResponse({ flight: storedFlight }) : jsonResponse({ error: "flight_not_found" }, 404);
    }
    return jsonResponse({ error: "unexpected" }, 500);
  }) as typeof fetch;
  return paths;
}

test("a flight rotated out of the snapshot hot set is still found in durable storage", async () => {
  const paths = stubBroker({ id: "flt-rotated", invocationId: "inv-rotated", state: "completed", summary: "replied." });

  const flight = await waitForScoutFlight("http://broker.test", "flt-rotated", { timeoutSeconds: 2 });

  expect(flight.state).toBe("completed");
  expect(paths).toEqual(["/v1/snapshot", "/v1/flights/flt-rotated"]);
});

test("a flight missing from both the hot set and storage is still reported as gone", async () => {
  stubBroker(null);

  await expect(waitForScoutFlight("http://broker.test", "flt-gone", { timeoutSeconds: 2 }))
    .rejects.toThrow("Flight flt-gone is no longer available.");
});
