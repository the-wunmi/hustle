import { describe, expect, it } from 'vitest';
import { parseChatStream } from '../src/client.ts';

// The shape NEAR AI Cloud streamed for a `web_context_search` call (verified live 2026-11-13).
const STREAM = [
  'data: {"id":"abc","choices":[{"delta":{"role":"assistant","content":""}}]}',
  'data: {"id":"abc","choices":[{"delta":{"tool_calls":[{"function":{"name":"web_context_search"}}]}}]}',
  'data: {"id":"abc","choices":[{"delta":{"nearai_tool_result":{"tool_call_id":"c1","name":"web_context_search","status":"ok","output":"[1] A\\nhttps://a.example\\ntext"}}}]}',
  'data: {"id":"abc","choices":[{"delta":{"content":"About "}}]}',
  'data: {"id":"abc","choices":[{"delta":{"content":"$308/month."}}]}',
  'data: {"id":"abc","choices":[],"usage":{"prompt_tokens":8364,"completion_tokens":76,"completion_tokens_details":{"reasoning_tokens":0}}}',
  'data: [DONE]',
].join('\n\n');

describe('a streamed chat completion with a provider tool', () => {
  it('reads the answer, the usage and what the tool returned', () => {
    const out = parseChatStream(STREAM);
    expect(out.id).toBe('abc');
    expect(out.content).toBe('About $308/month.');
    expect(out.usage).toEqual({ prompt_tokens: 8364, completion_tokens: 76, reasoning_tokens: 0 });
    expect(out.toolResults).toEqual([
      { name: 'web_context_search', status: 'ok', output: '[1] A\nhttps://a.example\ntext' },
    ]);
  });
});
