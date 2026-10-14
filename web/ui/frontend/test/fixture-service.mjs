// Deliberately empty, local test data. No model, cloud, account or capability claims.
export function fixtureResponses() {
  const extensions = { scannedAt: '2026-01-01T00:00:00Z', workspaceRoot: '/fixture', items: [], deployments: [], commandUsages: [], summary: { itemCount: 0, deploymentCount: 0, byKind: {}, byKernel: {} } };
  return new Map(Object.entries({
    '/network/account': { ok: true, configured: false },
    '/health': { ok: true, name: 'frontend-test-fixture', tokenRequired: false, auth: { mode: 'bridge-token' } },
    '/settings': { ok: true, settings: { developerMode: true, directKernelChatEnabled: true, languagePreference: 'zh-CN', systemLanguage: 'zh-CN', kernel: 'codex', activeKernel: 'codex', activeModel: '', kernels: [], providers: [], modelProviderBindings: [], customProviders: [], kernelPathOverrides: {}, kernelProxy: { mode: 'system' }, appUpdates: { automatic: false }, mountedApps: [] } },
    '/settings/kernel-logins': { ok: true, logins: [] },
    '/settings/provider-models': { ok: true, providers: [] },
    '/inventory': { ok: true, artifacts: [], workingState: { pinnedArtifactIds: [], workingArtifactIds: [], pendingApprovalIds: [], pendingQuestionIds: [], activeToolCallIds: [], discoveredSkillIds: [], discoveredSkillNames: [], expandedSkillIds: [], invokedSkills: [], loadedNestedMemoryPaths: [], toolSchemaCache: {}, updatedAt: '2026-01-01T00:00:00Z' }, sessions: [], runs: [], executions: [], skills: [], tools: [], mountedApps: extensions },
    '/approvals': { ok: true, approvals: [] },
    '/questions': { ok: true, questions: [] },
    '/events': { ok: true, events: [], cursor: '0', oldestCursor: '0', hasMore: false, hasOlder: false, historyTruncated: false, resetRequired: false, longPollSupported: false, snapshot: true },
    '/rooms': { ok: true, rooms: [], members: [], messages: [], currentEventSeq: 0, deletedMemberIds: [], messagesTruncated: false },
    '/rooms/events': { ok: true, events: [], currentEventSeq: 0 },
    '/extensions': { ok: true, extensions },
    '/app-store': { ok: true, packages: [], registryConfigured: false, registryCatalogError: 'fixture_registry_not_configured' },
  }));
}
