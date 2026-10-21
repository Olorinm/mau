const tool = (id, toolId, input, result, status = 'complete') => [
  { id: id + '-call', type: 'tool', phase: 'call', callId: id, toolId, title: toolId, input, status, error: '', approvalId: '', approvalStatus: '', approvalReason: '', questionId: '', questionStatus: '', questionPrompt: '' },
  ...(result === undefined ? [] : [{ id: id + '-result', type: 'tool', phase: 'result', callId: id, toolId, title: toolId, input, result, status, error: '', approvalId: '', approvalStatus: '', approvalReason: '', questionId: '', questionStatus: '', questionPrompt: '' }]),
];
const answer = { id: 'answer', type: 'text', text: '已经完成检查。\n\n- 第一项结果\n- 第二项结果' };
const note = { id: 'note', type: 'note', tone: 'diagnostic', text: '我先查看相关资料，再核对结果。', data: { kind: 'agent_message', phase: 'commentary' } };
const search = tool('search', 'webSearch', { type: 'webSearch', query: '前端组件的复用' }, { type: 'webSearch', query: '前端组件的复用', action: { type: 'search', query: '前端组件的复用' } });
const command = tool('cmd', 'commandExecution', { type: 'commandExecution', command: 'pwd' }, { type: 'commandExecution', command: 'pwd', aggregatedOutput: '/workspace/project', exitCode: 0 });
const edit = tool('edit', 'fileChange', { type: 'fileChange', changes: [{ path: 'src/example.ts', kind: { type: 'update' }, diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new' }] }, { type: 'fileChange', changes: [{ path: 'src/example.ts', kind: { type: 'update' }, diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new' }], status: 'completed' });
const base = tool('interaction', 'command', { command: 'pwd' })[0];
export const runFixtures = {
  plain: { parts: [answer], status: 'done' },
  search: { parts: [note, ...search, answer], status: 'done', duration: '2s' },
  mixed: { parts: [note, ...search, ...command, ...edit, answer], status: 'done', duration: '4s' },
  running: { parts: [note, ...tool('live', 'commandExecution', { type: 'commandExecution', command: 'npm test' }, undefined, 'running')], status: 'running' },
  approval: { parts: [{ ...base, phase: 'approval', approvalId: 'approve', approvalStatus: 'pending', approvalReason: '确认执行命令', approvalInput: { command: 'pwd' } }], status: 'running' },
  question: { parts: [{ ...base, phase: 'question', questionId: 'question', questionStatus: 'pending', questionPrompt: '选择工作目录', questionInput: { questions: [{ id: 'location', question: '使用哪个目录？', options: [{ label: 'workspace', description: '当前工作目录' }, { label: 'temporary', description: '临时目录' }] }] } }], status: 'running' },
  failure: { parts: [...tool('failed', 'commandExecution', { type: 'commandExecution', command: 'npm test' }, { type: 'commandExecution', command: 'npm test', aggregatedOutput: 'test failed', exitCode: 1 }, 'error')], status: 'failed' },
};
