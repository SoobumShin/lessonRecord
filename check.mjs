import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./api/lesson-record.js', import.meta.url), 'utf8');
const code = source.replace("import { get, put } from '@vercel/blob';", `
const files = new Map();
async function get(path) { return files.has(path) ? { statusCode: 200, stream: files.get(path) } : null; }
async function put(path, value) { files.set(path, value); }
`);
const { default: handler } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
async function send(body, owner) {
  const headers = { 'content-type': 'application/json', authorization: owner ? 'Bearer ' + owner : '' };
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.body = data; } };
  await handler({ method: 'POST', headers, body }, response);
  return response;
}
const call = async (name, args) => (await send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name, arguments: args } })).body.result;
const transcript = '가'.repeat(200000) + '두 번째 차례';
const created = await send({ action: 'create', workflow: 'lesson_record', record_length: 'three_pages', transcript: { text: transcript },
  lesson: { education_type: 'university', lesson_date: '2026-11-27', course: '검증', topic: '검증' } });
assert.equal(created.code, 201);
const args = { request_code: created.body.code };
const record = (await call('get_lesson_record', args)).structuredContent;
assert.equal(record.workflow, 'lesson_record');
assert.equal(record.record_length, 'three_pages');
assert.equal('lesson_date' in record.lesson, false);
assert.ok(record.transcript_segments > 1);
assert.deepEqual(record.transcript_batches, [
  { batch: 1, first_segment: 1, last_segment: 50 },
  { batch: 2, first_segment: 51, last_segment: 51 }
]);
assert.equal((await call('get_lesson_transcript', { ...args, segment: 51 })).structuredContent.batch, 2);
const segments = [];
for (let segment = 1; segment <= record.transcript_segments; segment++) {
  segments.push((await call('get_lesson_transcript', { ...args, segment })).structuredContent.text);
}
assert.equal(segments.join(''), transcript);
assert.equal((await call('get_lesson_transcript', { ...args, segment: 0 })).isError, true);
const analysis = { summary: '검증', limitations: ['가상 수업'], ai_supplement: ['개념 보충'], lesson_flow: [
  { sequence: 1, title: '검증', description: '검증', evidence: ['가상 수업 기록입니다.'] }
] };
assert.equal((await call('save_lesson_analysis', { ...args, lesson_id: record.lesson_id, analysis })).structuredContent.status, 'draft');
assert.deepEqual((await send({ action: 'status', code: args.request_code }, created.body.owner)).body.result.analysis.lesson_flow, analysis.lesson_flow);
assert.deepEqual((await send({ action: 'status', code: args.request_code }, created.body.owner)).body.result.analysis.ai_supplement, analysis.ai_supplement);
console.log('Transcript segmentation, date omission and analysis round trip verified.');
