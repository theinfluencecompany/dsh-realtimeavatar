/**
 * Hand-maintained PUBLIC facts about realtimeavatar.ai, verified against the
 * live site on {@link VERIFIED_ON}. Single source for the system-prompt
 * section, `/rta setup`, the api skill header, README tables and tests.
 *
 * Everything in this file is published by realtimeavatar.ai itself (docs,
 * pricing page, openapi.json). Nothing here may describe private infrastructure.
 *
 * @module dsh-realtimeavatar/facts
 */

export const VERIFIED_ON = '2026-09-03'

export const URLS = {
  site: 'https://realtimeavatar.ai',
  docs: 'https://realtimeavatar.ai/docs',
  llms: 'https://realtimeavatar.ai/llms.txt',
  llmsFull: 'https://realtimeavatar.ai/llms-full.txt',
  openapi: 'https://realtimeavatar.ai/openapi.json',
  apiBase: 'https://realtimeavatar.ai/api/v1',
  pricing: 'https://realtimeavatar.ai/pricing',
  signup: 'https://realtimeavatar.ai/signup',
  dashboard: 'https://realtimeavatar.ai/platform/dashboard',
  apiKeys: 'https://realtimeavatar.ai/platform/settings#api-keys',
  examples: 'https://realtimeavatar.ai/platform/examples',
  sdkNpm: 'https://www.npmjs.com/package/realtime-avatar',
  sdkRepo: 'https://github.com/theinfluencecompany/realtime-avatar-sdk',
} as const

/** The public env var name the docs use everywhere. */
export const ENV_VAR = 'REALTIME_AVATAR_API_KEY'
/** Key formats: environment-tagged, shown once. The tag is organisational, not a sandbox. */
export const KEY_PREFIXES = ['tic_live_', 'tic_test_'] as const
/** A public example avatar any key can call without creating one. */
export const EXAMPLE_AVATAR_ID = 'seed-rin-ashfall'
/** The public npm SDK. */
export const SDK_PACKAGE = 'realtime-avatar'
/** Per-key throttle documented under API reference → Conventions. */
export const RATE_LIMIT = { requests: 120, perSeconds: 60 } as const
/** Billing unit. */
export const CREDIT_RULE = '1 credit = 1 second on air; live conversation lands around $5 per hour'

/** Scopes as documented on the Authentication page. */
export const SCOPES = [
  { scope: 'realtime:write', grants: 'Start and end calls' },
  { scope: 'avatars:read', grants: 'List and fetch avatars and assets' },
  { scope: 'avatars:write', grants: 'Create and update avatars, upload assets, sync clips' },
  { scope: 'credits:read', grants: 'Read the balance' },
  { scope: 'usage:read', grants: 'Usage reporting (read)' },
  { scope: 'usage:write', grants: 'Usage reporting (write)' },
  { scope: 'api_keys:write', grants: 'Mint further keys — untick unless a back-office job needs it' },
  { scope: '*', grants: 'Everything, including scopes added later — avoid outside trusted back-office jobs' },
] as const

/** Public plans (pricing page). */
export const PLANS = [
  { name: 'Sandbox', usd: 0, credits: 1020, minutes: 17, streams: 1, avatars: 1, note: 'no card; enough for a first avatar plus a few minutes of calls' },
  { name: 'Starter', usd: 9, credits: 7200, minutes: 120, streams: 2, avatars: 5, note: 'overage $0.095/min' },
  { name: 'Developer', usd: 24, credits: 36000, minutes: 600, streams: 5, avatars: 25, note: 'overage $0.085/min' },
  { name: 'Studio', usd: 119, credits: 180000, minutes: 3000, streams: 20, avatars: 100, note: 'overage $0.08/min; experimental features' },
] as const

/**
 * The public copy-paste agent prompt that the dashboard hands over next to a
 * freshly minted key (also the landing page's step two). Reused verbatim.
 */
export const AGENT_PROMPT =
  'Build a one-button page that opens a live video call with the example avatar Rin (seed-rin-ashfall): she speaks first, two-way voice, her portrait while she connects, a hang-up button. Stop there for testing. Key in REALTIME_AVATAR_API_KEY. Follow https://realtimeavatar.ai/llms.txt.\n\nOptional — to use your own avatar instead: create Nova from nova.png with a warm mid-pitch voice, poll until ready, and repoint the same button at her without changing the page.'

/** One public API operation. `exposedAs` names the rta_* tool, or null when deliberately not exposed. */
export interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  operationId: string
  scope: string
  costsCredits: boolean
  idempotencyKey?: boolean
  deprecated?: boolean
  exposedAs: string | null
  summary: string
}

/** The 18 operations of the public OpenAPI document (paths relative to /api/v1). */
export const OPERATIONS: readonly Operation[] = [
  { method: 'GET', path: '/realtime/livekit/capacity', operationId: 'getLiveKitCapacity', scope: 'realtime:write', costsCredits: false, exposedAs: 'rta_capacity', summary: 'Get a capacity snapshot' },
  { method: 'POST', path: '/realtime/livekit/session', operationId: 'createLiveKitSession', scope: 'realtime:write', costsCredits: true, exposedAs: 'rta_session_mint', summary: 'Mint a realtime session' },
  { method: 'POST', path: '/realtime/livekit/session/release', operationId: 'releaseLiveKitClientSession', scope: 'realtime:write', costsCredits: false, exposedAs: 'rta_session_release', summary: "Release a session's capacity lease" },
  { method: 'GET', path: '/avatars', operationId: 'listAvatars', scope: 'avatars:read', costsCredits: false, exposedAs: 'rta_avatars', summary: 'List avatars' },
  { method: 'POST', path: '/avatars', operationId: 'createAvatar', scope: 'avatars:write', costsCredits: true, exposedAs: 'rta_avatar_create', summary: 'Create an avatar from a portrait' },
  { method: 'GET', path: '/avatars/{avatarId}', operationId: 'getAvatar', scope: 'avatars:read', costsCredits: false, exposedAs: 'rta_avatar', summary: 'Get an avatar' },
  { method: 'PATCH', path: '/avatars/{avatarId}', operationId: 'updateAvatar', scope: 'avatars:write', costsCredits: false, exposedAs: 'rta_avatar_update', summary: 'Update an avatar' },
  { method: 'DELETE', path: '/avatars/{avatarId}', operationId: 'deleteAvatar', scope: 'avatars:write', costsCredits: false, exposedAs: 'rta_avatar_delete', summary: 'Delete an avatar' },
  { method: 'GET', path: '/avatars/{avatarId}/clips', operationId: 'listAvatarClips', scope: 'avatars:read', costsCredits: false, exposedAs: 'rta_clips', summary: "List an avatar's motion clips" },
  { method: 'PUT', path: '/avatars/{avatarId}/clips', operationId: 'putAvatarClips', scope: 'avatars:write', costsCredits: true, idempotencyKey: true, exposedAs: 'rta_clips_set', summary: "Declare an avatar's clip library" },
  { method: 'POST', path: '/avatars/{avatarId}/clips', operationId: 'syncAvatarClips', scope: 'avatars:write', costsCredits: false, deprecated: true, exposedAs: null, summary: 'Sync an externally hosted clip library (deprecated)' },
  { method: 'PUT', path: '/avatars/{avatarId}/loop', operationId: 'putAvatarLoop', scope: 'avatars:write', costsCredits: true, idempotencyKey: true, exposedAs: 'rta_loop_set', summary: "Re-direct an avatar's resting loop" },
  { method: 'POST', path: '/api-keys', operationId: 'createApiKey', scope: 'api_keys:write', costsCredits: false, exposedAs: null, summary: 'Mint an API key (use the dashboard instead)' },
  { method: 'GET', path: '/assets', operationId: 'listAssets', scope: 'avatars:read', costsCredits: false, exposedAs: 'rta_assets', summary: 'List assets' },
  { method: 'POST', path: '/assets', operationId: 'uploadAsset', scope: 'avatars:write', costsCredits: false, exposedAs: null, summary: 'Upload an asset (multipart; use rta_asset_remote)' },
  { method: 'POST', path: '/assets/remote', operationId: 'createRemoteAsset', scope: 'avatars:write', costsCredits: false, exposedAs: 'rta_asset_remote', summary: 'Create an asset from a URL' },
  { method: 'GET', path: '/credits/balance', operationId: 'getCreditBalance', scope: 'credits:read', costsCredits: false, exposedAs: 'rta_balance', summary: 'Get the credit balance' },
  { method: 'GET', path: '/usage/sessions', operationId: 'listUsageSessions', scope: 'usage:read', costsCredits: false, exposedAs: 'rta_usage', summary: 'List billed realtime sessions' },
]

/** Error statuses as documented on the API reference page. */
export const ERROR_TABLE = [
  { status: 401, meaning: 'Missing, malformed, revoked, or expired key', action: 'Check the bearer and the environment tag' },
  { status: 402, meaning: 'insufficient_credits or spend_limit_exceeded', action: 'Top up (billingUrl) or raise the per-key spend limit; surface as a paywall' },
  { status: 403, meaning: 'The key lacks the scope for this operation, or the workspace is not active (error reads "Tenant is not active"), or a per-workspace rollout gate (code clip_library_not_enabled)', action: 'Read error first: mint a key with the scope (do not widen to *); an inactive workspace has to be reactivated (no self-serve switch); a rollout gate needs support' },
  { status: 404, meaning: 'No such avatar, voice, or key for this tenant', action: 'Check the id; soft-deleted avatars are gone from every read' },
  { status: 409, meaning: 'Conflict: no workspace yet, idempotency conflict, or avatar state settling', action: 'Read the error text; retry after it settles, or use a fresh Idempotency-Key' },
  { status: 413, meaning: 'JSON body over the per-route cap', action: 'Send media by URL, not inline' },
  { status: 422, meaning: 'Schema rejection (unknown, mis-cased or invalid field) or a safety-screen refusal', action: 'Check camelCase vs snake_case for the route' },
  { status: 429, meaning: 'Plan concurrency ceiling (code concurrency_limit_reached), capacity queue (queue_size + recommended_retry_ms), or the per-key rate limit (no code, no queue fields)', action: 'Close a session / upgrade; render the queue position and retry; or back off' },
  { status: 502, meaning: 'An upstream generation or render failed', action: 'Retry; if it persists it is theirs, not yours' },
  { status: 503, meaning: 'A dependency the route needs is unavailable; nothing was written', action: 'Retry with backoff' },
] as const

/** The 14 public documentation pages (slug → markdown URL). `overview` lives at /docs.md. */
export const DOC_PAGES = [
  { slug: 'overview', title: 'Realtime Avatar API', path: '/docs.md', canonical: '/docs', blurb: 'What the product is: a live character on a voice or video call, with your tools wired in.' },
  { slug: 'quickstart', title: 'Quickstart', path: '/docs/quickstart.md', canonical: '/docs/quickstart', blurb: 'From an API key to a live call in three steps, on the public example avatar first.' },
  { slug: 'authentication', title: 'Authentication', path: '/docs/authentication.md', canonical: '/docs/authentication', blurb: 'Get a key, keep it on your server, decide who may start a call.' },
  { slug: 'nextjs', title: 'Next.js', path: '/docs/nextjs.md', canonical: '/docs/nextjs', blurb: 'App Router route file plus one browser component.' },
  { slug: 'tanstack-start', title: 'TanStack Start', path: '/docs/tanstack-start.md', canonical: '/docs/tanstack-start', blurb: 'Splat server route plus one component.' },
  { slug: 'express', title: 'Express', path: '/docs/express.md', canonical: '/docs/express', blurb: 'Express 4/5 middleware with the shared authorize/session policy.' },
  { slug: 'hono', title: 'Hono, Workers, Bun and Deno', path: '/docs/hono.md', canonical: '/docs/hono', blurb: 'Any Fetch-handler runtime, including the apiKey factory Workers need.' },
  { slug: 'react', title: 'React and React Native', path: '/docs/react.md', canonical: '/docs/react', blurb: 'AvatarCall, useAvatarCall, and what changes on React Native.' },
  { slug: 'video', title: 'Creating an avatar', path: '/docs/video.md', canonical: '/docs/video', blurb: 'One image in, a moving character out; idle loop, motion clips, generation prices.' },
  { slug: 'sessions', title: 'Calls', path: '/docs/sessions.md', canonical: '/docs/sessions', blurb: 'What the server decides, the five client states, ending a call gracefully.' },
  { slug: 'editing', title: 'Editing a character', path: '/docs/editing.md', canonical: '/docs/editing', blurb: 'Changing clips and the resting loop after creation; how each change settles.' },
  { slug: 'tool-calling', title: 'Tool calling', path: '/docs/tool-calling.md', canonical: '/docs/tool-calling', blurb: 'The platform never runs your tools: the client tool plane and the server loop.' },
  { slug: 'api-reference', title: 'API reference', path: '/docs/api-reference.md', canonical: '/docs/api-reference', blurb: 'Every public /api/v1 endpoint, its scope, and how it fails.' },
  { slug: 'experimental', title: 'Experimental features', path: '/docs/experimental.md', canonical: '/docs/experimental', blurb: 'What is experimental, what the word promises, how to turn each one on (Studio and above).' },
] as const

export type DocSlug = (typeof DOC_PAGES)[number]['slug']

/** Which skill carries which pages. */
export const SKILL_PAGES = {
  'realtimeavatar-quickstart': ['overview', 'quickstart', 'authentication'],
  'realtimeavatar-integrate': ['nextjs', 'tanstack-start', 'express', 'hono', 'react'],
  'realtimeavatar-avatars': ['video', 'editing'],
  'realtimeavatar-calls': ['sessions', 'tool-calling', 'experimental'],
  'realtimeavatar-api': ['api-reference'],
} as const satisfies Record<string, readonly DocSlug[]>

export type SkillName = keyof typeof SKILL_PAGES
export const SKILL_NAMES = Object.keys(SKILL_PAGES) as SkillName[]
