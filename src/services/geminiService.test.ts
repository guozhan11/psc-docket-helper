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
