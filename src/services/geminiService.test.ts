import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssistantRequestCancelledError,
  chatWithDocketAssistant,
  submitAnswerFeedback
} from './geminiService.ts';

test('cancelled chat requests stay distinct from connection failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  })) as typeof fetch;

  try {
    const controller = new AbortController();
    const request = chatWithDocketAssistant(
      [],
      'Summarize FC1176.',
      'test-client',
      null,
      controller.signal
    );
    controller.abort();
    await assert.rejects(request, AssistantRequestCancelledError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat responses stream incremental text to the caller', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response([
    'event: delta\ndata: {"delta":"Hello"}\n\n',
    'event: delta\ndata: {"delta":" world"}\n\n',
    'event: done\ndata: {"feedbackToken":"signed-token"}\n\n'
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

  try {
    const deltas: string[] = [];
    const reply = await chatWithDocketAssistant([], 'Question', 'test-client', null, undefined, delta => deltas.push(delta));
    assert.deepEqual(reply, { reply: 'Hello world', feedbackToken: 'signed-token', degraded: false });
    assert.deepEqual(deltas, ['Hello', ' world']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A stand-in reply arrives as an ordinary answer. Without the flag the caller
// cannot tell it from a finished turn, and the user is left retyping.
test('a stand-in reply is reported as degraded so the caller can offer a retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response([
    'event: delta\ndata: {"delta":"Could not complete this search."}\n\n',
    'event: done\ndata: {"feedbackToken":null,"degraded":true}\n\n'
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

  try {
    const reply = await chatWithDocketAssistant([], 'Question', 'test-client', null);
    assert.equal(reply.degraded, true);
    assert.equal(reply.feedbackToken, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a non-streamed reply carries the degraded flag through', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    reply: 'Could not complete this search.',
    feedbackToken: 'signed-token',
    degraded: true
  })) as typeof fetch;

  try {
    const reply = await chatWithDocketAssistant([], 'Question', 'test-client', null);
    assert.deepEqual(reply, {
      reply: 'Could not complete this search.',
      feedbackToken: 'signed-token',
      degraded: true
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('answer feedback posts the signed token and selected context', async () => {
  const originalFetch = globalThis.fetch;
  let submitted: unknown;
  globalThis.fetch = (async (_input, init) => {
    submitted = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await submitAnswerFeedback({
      token: 'signed-token',
      rating: 'down',
      reason: 'citation',
      comment: 'The linked page does not support the claim.',
      question: 'What happened?',
      answerExcerpt: 'An answer.'
    });
    assert.deepEqual(submitted, {
      token: 'signed-token',
      rating: 'down',
      reason: 'citation',
      comment: 'The linked page does not support the claim.',
      question: 'What happened?',
      answerExcerpt: 'An answer.'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
