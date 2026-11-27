import { get, put } from '@vercel/blob';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const equal = (left, right) => timingSafeEqual(Buffer.from(left), Buffer.from(right));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const pathFor = (code, part) => 'lesson-records/v1/' + hash(code) + '/' + part + '.json';
async function read(code, part) {
  const blob = await get(pathFor(code, part), { access: 'private', useCache: false });
  if (!blob) return null;
  if (blob.statusCode !== 200) fail(503, '저장소 응답을 확인할 수 없습니다.');
  return new Response(blob.stream).json();
}
async function write(code, part, data) {
  await put(pathFor(code, part), JSON.stringify(data), {
    access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json'
  });
}
async function writeOnce(code, part, data) {
  const previous = await read(code, part);
  if (previous) return previous;
  try {
    await write(code, part, data);
    return data;
  } catch (error) {
    const concurrent = await read(code, part);
    if (concurrent) return concurrent;
    throw error;
  }
}
function cleanLesson(lesson) {
  if (!object(lesson)) fail(400, '수업 정보 JSON이 필요합니다.');
  const fields = ['education_type', 'course', 'topic', 'memo', 'school_level',
    'grade', 'subject_code', 'semester', 'week', 'learning_objective'];
  const result = {};
  for (const field of fields) {
    if (typeof lesson[field] === 'string') result[field] = lesson[field].trim().slice(0, 4000);
  }
  if (!['k12', 'university'].includes(result.education_type) || !result.course || !result.topic) {
    fail(400, '수업 유형, 교과·교과목, 수업 주제를 입력하세요.');
  }
  if (result.education_type === 'k12') {
    if (!result.school_level || !result.grade || !result.subject_code) fail(400, '학교급, 학년, 교과를 선택하세요.');
    result.standards = (Array.isArray(lesson.standards) ? lesson.standards : []).slice(0, 1).map(item => {
      if (typeof item?.code !== 'string' || typeof item?.text !== 'string' || !item.code.trim() || !item.text.trim() ||
          item.code.length > 80 || item.text.length > 4000) fail(400, '성취기준 코드와 원문을 확인하세요.');
      return { code: item.code, text: item.text };
    });
  }
  return result;
}
const listKeys = ['key_concepts', 'explanations', 'examples_and_analogies', 'teacher_questions',
  'learning_activities', 'teaching_characteristics', 'curriculum_alignment', 'technology_usage',
  'contextual_features', 'new_ideas', 'ai_supplement', 'limitations'];
const strings = { type: 'array', items: { type: 'string' }, maxItems: 50 };
const analysisSchema = { type: 'object', required: ['summary', 'limitations'], additionalProperties: false,
  properties: { summary: { type: 'string', maxLength: 5000 },
    lesson_flow: { type: 'array', maxItems: 30, items: { type: 'object',
      required: ['sequence', 'title', 'description'], additionalProperties: false, properties: {
        sequence: { type: 'integer', minimum: 1 }, title: { type: 'string' },
        description: { type: 'string' }, start_seconds: { type: 'number', minimum: 0 },
        end_seconds: { type: 'number', minimum: 0 }, evidence: strings
      } } },
    ...Object.fromEntries(listKeys.map(key => [key, strings]))
  } };
function cleanAnalysis(value, hasTranscript, recordLength) {
  if (!object(value) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 5000 ||
      !Array.isArray(value.limitations) || !value.limitations.length ||
      (value.lesson_flow !== undefined && (!Array.isArray(value.lesson_flow) || (hasTranscript ? value.lesson_flow.length > 30 : value.lesson_flow.length)))) {
    fail(400, '요약과 분석 한계가 필요합니다. 전사 자료 없이 실제 수업 흐름을 기록할 수 없습니다.');
  }
  const flow = value.lesson_flow || [];
  if (flow.some(item => !object(item) || !Number.isInteger(item.sequence) || item.sequence < 1 ||
    typeof item.title !== 'string' || item.title.length > 500 || typeof item.description !== 'string' ||
    item.description.length > 2200)) fail(400, '수업 흐름의 순서, 제목, 설명을 확인하세요.');
  const analysis = { summary: value.summary, lesson_flow: flow.map(({ sequence, title, description, evidence }) =>
    ({ sequence, title, description, evidence: Array.isArray(evidence) ? evidence.filter(text => typeof text === 'string').slice(0, 5).map(text => text.slice(0, 500)) : [] })) };
  for (const key of listKeys) {
    const values = value[key] ?? [];
    if (!Array.isArray(values) || values.length > 50 || values.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) {
      fail(400, '분석 항목은 길이 2,000자 이내의 문자열 목록이어야 합니다.');
    }
    if (key === 'ai_supplement' && values.length && recordLength !== 'three_pages') {
      fail(400, 'AI 보충 설명은 A4 3장형에서 사용할 수 있습니다.');
    }
    analysis[key] = values;
  }
  return analysis;
}
const codeSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const tools = [
  { name: 'get_lesson_transcript', description: '조회한 수업의 전사문 구간을 읽습니다. 1번부터 전체 구간을 순서대로 읽으세요.',
    inputSchema: { type: 'object', required: ['request_code', 'segment'], additionalProperties: false,
      properties: { request_code: codeSchema, segment: { type: 'integer', minimum: 1 } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_lesson_record', description: '한 건의 수업 정보와 성취기준을 조회합니다.',
    inputSchema: { type: 'object', properties: { request_code: codeSchema }, required: ['request_code'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'save_lesson_analysis', description: '조회한 수업의 분석 결과를 교사 검토용 초안으로 저장합니다.',
    inputSchema: { type: 'object', properties: { request_code: codeSchema, lesson_id: { type: 'string' }, analysis: analysisSchema },
      required: ['request_code', 'lesson_id', 'analysis'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
];
async function find(code) {
  const record = validToken(code) ? await read(code, 'request') : null;
  if (!record) fail(404, '수업 분석 요청을 찾을 수 없습니다.');
  return record;
}
async function callTool(name, args) {
  if (!tools.some(tool => tool.name === name)) fail(400, '지원하지 않는 도구입니다.');
  const code = args?.request_code;
  const record = await find(code);
  if (Date.now() > record.expires_at) fail(410, '분석 요청 코드가 만료되었습니다.');
  const segments = record.segments || [];
  const batches = segments.length > 50
    ? [{ batch: 1, first_segment: 1, last_segment: 50 }, { batch: 2, first_segment: 51, last_segment: segments.length }]
    : segments.length ? [{ batch: 1, first_segment: 1, last_segment: segments.length }] : [];
  if (name === 'get_lesson_transcript') {
    const segment = args?.segment;
    if (!Number.isInteger(segment) || segment < 1 || segment > segments.length) fail(400, '전사 구간 번호를 확인하세요.');
    return { lesson_id: record.input.lesson_id, segment, total: segments.length,
      batch: segment <= 50 ? 1 : 2, total_batches: batches.length, text: segments[segment - 1] };
  }
  if (name === 'get_lesson_record') {
    const { lesson_date, ...lesson } = record.input.lesson;
    return { schema_version: 1, workflow: 'lesson_record', lesson_id: record.input.lesson_id, lesson,
      record_length: record.input.record_length ?? 'one_page',
      transcript_segments: segments.length, transcript_batches: batches };
  }
  if (record.draft) fail(409, '웹에서 이미 생성한 초안입니다.');
  if (args.lesson_id !== record.input.lesson_id) fail(400, '수업 ID가 조회한 기록과 일치해야 합니다.');
  const analysis = cleanAnalysis(args.analysis, segments.length > 0, record.input.record_length);
  const draft = await writeOnce(code, 'draft', { schema_version: 1, lesson_id: args.lesson_id, analysis, status: 'draft' });
  if (JSON.stringify(analysis) !== JSON.stringify(draft.analysis)) fail(409, '이미 초안이 저장되었습니다.');
  return { lesson_id: draft.lesson_id, status: await read(code, 'confirmed') ? 'confirmed' : 'draft' };
}
async function mcp(body, res) {
  const { id, method, params } = body;
  const respond = result => res.json({ jsonrpc: '2.0', id, result });
  const error = (code, message) => res.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (body.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'Invalid Request');
  if (id === undefined) return res.status(202).end();
  if (method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    return respond({ protocolVersion: supported.includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'lesson-record-studio', version: '1.0.0' },
      instructions: '사용자가 준 조회 코드로 get_lesson_record를 호출하세요. transcript_batches에 지정된 모든 구간을 get_lesson_transcript로 순서대로 읽고, 전사에 근거해 분석하세요. 읽지 못한 구간이 있으면 알리세요. 사용자가 분석 초안 저장을 요청하면 전체 구간을 읽은 뒤 save_lesson_analysis를 한 번 호출하세요.' });
  }
  if (method === 'ping') return respond({});
  if (method === 'tools/list') return respond({ tools });
  if (method !== 'tools/call') return error(-32601, 'Method not found');
  try {
    const result = await callTool(params?.name, params?.arguments);
    return respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
  } catch (failure) {
    return respond({ isError: true, content: [{ type: 'text', text: failure.status ? failure.message : '저장소 처리에 실패했습니다.' }] });
  }
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  try {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON 요청이 필요합니다.');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!object(body) || Buffer.byteLength(JSON.stringify(body)) > 1050000) fail(400, 'JSON 요청을 확인하세요.');
    if (body.jsonrpc) return await mcp(body, res);
    if (body.action === 'create') {
      if (process.env.LESSON_RECORD_ACCESS_KEY &&
          !equal(hash(String(body.access_key ?? '')), hash(process.env.LESSON_RECORD_ACCESS_KEY))) fail(403, '스튜디오 접근키를 확인하세요.');
      const lesson = cleanLesson(body.lesson);
      if (body.workflow !== undefined && body.workflow !== 'lesson_record') fail(400, '수업기록 요청 유형을 확인하세요.');
      const record_length = body.record_length ?? 'one_page';
      if (!['half_page', 'one_page', 'three_pages'].includes(record_length)) fail(400, '수업기록 분량을 선택하세요.');
      const transcriptInput = body.workflow === 'lesson_record' ? body.transcript?.text : body.transcript;
      const transcript = typeof transcriptInput === 'string' ? transcriptInput.trim() : '';
      if (!transcript || transcript.length > 240000) fail(400, '24만 자 이내의 전사문이 필요합니다.');
      const chars = Array.from(transcript);
      const segments = [];
      for (let i = 0; i < chars.length; i += 4000) segments.push(chars.slice(i, i + 4000).join(''));
      const code = token();
      const owner = token();
      const expires_at = Date.now() + 60 * 60 * 1000;
      const lesson_id = randomBytes(16).toString('hex');
      await write(code, 'request', { owner_hash: hash(owner), expires_at,
        segments, input: { schema_version: 1, lesson_id, lesson, record_length } });
      return res.status(201).json({ code, owner, expires_at });
    }
    const record = await find(body.code);
    const owner = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!validToken(owner) || !equal(hash(owner), record.owner_hash)) fail(404, '수업 분석 요청을 찾을 수 없습니다.');
    if (body.action === 'confirm') {
      if (!record.draft && !await read(body.code, 'draft')) fail(409, '확정할 분석 초안이 없습니다.');
      const analysis = cleanAnalysis(body.analysis, !!record.segments?.length, record.input.record_length);
      const result = await writeOnce(body.code, 'confirmed', { schema_version: 1, lesson_id: record.input.lesson_id, analysis, status: 'confirmed' });
      if (JSON.stringify(analysis) !== JSON.stringify(result.analysis)) fail(409, '이미 확정한 기록입니다.');
      return res.json(result);
    }
    if (body.action === 'status') {
      const result = await read(body.code, 'confirmed') || record.draft || await read(body.code, 'draft');
      return res.json({ lesson: record.input.lesson, state: result?.status || (Date.now() > record.expires_at ? 'expired' : 'pending'), result });
    }
    fail(400, '지원하지 않는 요청입니다.');
  } catch (error) {
    return res.status(error instanceof SyntaxError ? 400 : error.status || 503)
      .json({ error: error instanceof SyntaxError ? 'JSON 형식을 확인하세요.' : error.status ? error.message : '수업 기록 저장소에 연결하지 못했습니다.' });
  }
}
