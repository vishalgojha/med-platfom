import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { StubAIClient } from "../ai/client.js";
import { resetConfigForTests } from "../config.js";
import { createServer } from "../server.js";
import { setupTestDb, teardownTestDb } from "./test-helpers.js";
import { StubMessagingAdapter } from "../messaging/stub.js";

function defaultResponder(systemPrompt: string): string {
  if (systemPrompt.includes("SOAP")) {
    return JSON.stringify({
      subjective: "S",
      objective: "O",
      assessment: "A",
      plan: "P"
    });
  }
  if (systemPrompt.includes("clinical decision support")) {
    return JSON.stringify([
      {
        type: "protocol_suggestion",
        severity: "info",
        message: "Triage advice generated for testing.",
        sources: ["stub"]
      }
    ]);
  }
  if (systemPrompt.includes("prior authorization")) {
    return JSON.stringify({ clinicalJustification: "needed" });
  }
  return JSON.stringify({ body: "Please call clinic." });
}

async function startTestServer(input?: {
  responder?: (systemPrompt: string, userMessage: string) => string | Promise<string>;
}) {
  delete process.env.API_TOKEN;
  delete process.env.API_TOKEN_READ;
  delete process.env.API_TOKEN_WRITE;
  delete process.env.API_TOKEN_ADMIN;
  resetConfigForTests();

  const responder = input?.responder ?? ((systemPrompt: string) => defaultResponder(systemPrompt));
  const ai = new StubAIClient((systemPrompt, userMessage) => responder(systemPrompt, userMessage));

  const app = createServer({ aiClient: ai, messaging: new StubMessagingAdapter() });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

test("chat inbound creates session with messages and events", async () => {
  const dbPath = setupTestDb("chat-inbound-basic");
  const svc = await startTestServer();
  try {
    const inboundRes = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "webchat",
        tenantId: "clinic-one",
        user: {
          id: "user-1",
          name: "Rhea",
          phone: "+919999001111",
          language: "en"
        },
        message: {
          id: "m1",
          text: "Patient has fever for two days"
        },
        routing: {
          workflow: "triage_intake",
          specialtyId: "family_medicine"
        }
      })
    });
    assert.equal(inboundRes.status, 200);
    const inboundBody = (await inboundRes.json()) as {
      ok: boolean;
      data: { sessionId: string; assistantMessage: { id: string; text: string } };
    };
    assert.equal(inboundBody.ok, true);
    assert.equal(typeof inboundBody.data.sessionId, "string");
    assert.equal(typeof inboundBody.data.assistantMessage.text, "string");
    assert.ok(inboundBody.data.assistantMessage.text.length > 0);

    const messagesRes = await fetch(
      `${svc.baseUrl}/api/v1/chat/sessions/${inboundBody.data.sessionId}/messages?limit=20`
    );
    assert.equal(messagesRes.status, 200);
    const messagesBody = (await messagesRes.json()) as {
      ok: boolean;
      data: { messages: Array<{ role: string; text: string }> };
    };
    assert.equal(messagesBody.ok, true);
    assert.equal(messagesBody.data.messages.length, 2);
    assert.equal(messagesBody.data.messages[0]?.role, "user");
    assert.equal(messagesBody.data.messages[1]?.role, "assistant");

    const eventsRes = await fetch(
      `${svc.baseUrl}/api/v1/chat/sessions/${inboundBody.data.sessionId}/events?stream=false&limit=20`
    );
    assert.equal(eventsRes.status, 200);
    const eventsBody = (await eventsRes.json()) as {
      ok: boolean;
      data: { events: Array<{ eventType: string }> };
    };
    assert.equal(eventsBody.ok, true);
    const eventTypes = eventsBody.data.events.map((entry) => entry.eventType);
    assert.ok(eventTypes.includes("chat.ack"));
    assert.ok(eventTypes.includes("chat.assistant_final"));
    assert.ok(eventTypes.includes("chat.completed"));
  } finally {
    await svc.close();
    teardownTestDb(dbPath);
  }
});

test("chat inbound idempotency dedupes non-webchat retries", async () => {
  const dbPath = setupTestDb("chat-inbound-idempotency");
  const svc = await startTestServer();
  try {
    const payload = {
      channel: "whatsapp_twilio",
      tenantId: "clinic-idem",
      user: {
        name: "Avi",
        phone: "+919999002222",
        language: "en"
      },
      message: {
        id: "wa1",
        text: "Need triage support"
      },
      routing: {
        workflow: "triage_intake",
        specialtyId: "family_medicine"
      }
    };
    const headers = {
      "content-type": "application/json",
      "x-idempotency-key": "idem-1"
    };

    const first = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      data: { sessionId: string };
    };
    assert.equal(firstBody.ok, true);

    const second = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      data: { sessionId: string };
    };
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.data.sessionId, firstBody.data.sessionId);

    const messagesRes = await fetch(
      `${svc.baseUrl}/api/v1/chat/sessions/${firstBody.data.sessionId}/messages?limit=20`
    );
    assert.equal(messagesRes.status, 200);
    const messagesBody = (await messagesRes.json()) as {
      ok: boolean;
      data: { messages: Array<{ role: string; text: string }> };
    };
    assert.equal(messagesBody.ok, true);
    assert.equal(messagesBody.data.messages.length, 2);
  } finally {
    await svc.close();
    teardownTestDb(dbPath);
  }
});

test("chat inbound idempotency rejects changed payload for same key", async () => {
  const dbPath = setupTestDb("chat-inbound-idempotency-conflict");
  const svc = await startTestServer();
  try {
    const headers = {
      "content-type": "application/json",
      "x-idempotency-key": "idem-2"
    };

    const first = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channel: "whatsapp_web",
        tenantId: "clinic-conflict",
        user: { phone: "+919999003333", language: "en" },
        message: { text: "Initial message" },
        routing: { workflow: "triage_intake", specialtyId: "family_medicine" }
      })
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channel: "whatsapp_web",
        tenantId: "clinic-conflict",
        user: { phone: "+919999003333", language: "en" },
        message: { text: "Changed message body" },
        routing: { workflow: "triage_intake", specialtyId: "family_medicine" }
      })
    });
    assert.equal(second.status, 409);
    const secondBody = (await second.json()) as { ok: boolean; code: string };
    assert.equal(secondBody.ok, false);
    assert.equal(secondBody.code, "CONFLICT");
  } finally {
    await svc.close();
    teardownTestDb(dbPath);
  }
});

test("chat inbound rejects cross-tenant session reuse", async () => {
  const dbPath = setupTestDb("chat-inbound-session-tenant-guard");
  const svc = await startTestServer();
  try {
    const first = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "webchat",
        tenantId: "tenant-a",
        user: { id: "u-a", name: "A", language: "en" },
        message: { text: "hello from tenant a" }
      })
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { ok: boolean; data: { sessionId: string } };
    assert.equal(firstBody.ok, true);

    const second = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "webchat",
        tenantId: "tenant-b",
        sessionId: firstBody.data.sessionId,
        user: { id: "u-b", name: "B", language: "en" },
        message: { text: "hello from tenant b" }
      })
    });
    assert.equal(second.status, 409);
    const secondBody = (await second.json()) as { ok: boolean; code: string };
    assert.equal(secondBody.ok, false);
    assert.equal(secondBody.code, "CONFLICT");

    const messagesRes = await fetch(
      `${svc.baseUrl}/api/v1/chat/sessions/${firstBody.data.sessionId}/messages?limit=20`
    );
    assert.equal(messagesRes.status, 200);
    const messagesBody = (await messagesRes.json()) as {
      ok: boolean;
      data: { messages: Array<{ role: string; text: string }> };
    };
    assert.equal(messagesBody.ok, true);
    assert.equal(messagesBody.data.messages.length, 2);
  } finally {
    await svc.close();
    teardownTestDb(dbPath);
  }
});

test("chat inbound idempotency returns conflict while key is in progress", async () => {
  const dbPath = setupTestDb("chat-inbound-idempotency-in-progress");
  const svc = await startTestServer({
    responder: async (systemPrompt) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return defaultResponder(systemPrompt);
    }
  });
  try {
    const payload = {
      channel: "whatsapp_twilio",
      tenantId: "clinic-race",
      user: {
        name: "Ria",
        phone: "+919999004444",
        language: "en"
      },
      message: {
        id: "wa-race-1",
        text: "Need triage support quickly"
      },
      routing: {
        workflow: "triage_intake",
        specialtyId: "family_medicine"
      }
    };
    const headers = {
      "content-type": "application/json",
      "x-idempotency-key": "idem-race-1"
    };

    const [aRes, bRes] = await Promise.all([
      fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      }),
      fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      })
    ]);

    const statuses = [aRes.status, bRes.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const aBody = (await aRes.json()) as { ok: boolean; code?: string; data?: { sessionId: string } };
    const bBody = (await bRes.json()) as { ok: boolean; code?: string; data?: { sessionId: string } };
    const successBody = aRes.status === 200 ? aBody : bBody;
    const conflictBody = aRes.status === 409 ? aBody : bBody;
    assert.equal(successBody.ok, true);
    assert.equal(conflictBody.ok, false);
    assert.equal(conflictBody.code, "CONFLICT");

    const replay = await fetch(`${svc.baseUrl}/api/v1/chat/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as { ok: boolean; data: { sessionId: string } };
    assert.equal(replayBody.ok, true);
    assert.equal(replayBody.data.sessionId, successBody.data?.sessionId);
  } finally {
    await svc.close();
    teardownTestDb(dbPath);
  }
});
