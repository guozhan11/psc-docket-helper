import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssistantRequestCancelledError,
  chatWithDocketAssistant
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
    'event: done\ndata: {}\n\n'
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

  try {
    const deltas: string[] = [];
    const reply = await chatWithDocketAssistant([], 'Question', 'test-client', null, undefined, delta => deltas.push(delta));
    assert.equal(reply, 'Hello world');
    assert.deepEqual(deltas, ['Hello', ' world']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
