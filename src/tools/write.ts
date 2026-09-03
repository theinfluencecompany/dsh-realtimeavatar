/**
 * Write tools. Free writes (asset registration, avatar update/delete) ask for
 * approval by default; credit-spending writes (avatar create, loop, clips,
 * session mint) always ask. Every write is refused at execute time under
 * readOnly as a second layer behind the gate.
 *
 * @module dsh-realtimeavatar/tools/write
 */
import { assertId, createAvatar, createRemoteAsset, deleteAvatar, mintSession, setClipLibrary, setLoop, updateAvatar, type ClipDeclaration } from '../api.js'
import { EXAMPLE_AVATAR_ID } from '../facts.js'
import { redactSecrets } from '../redact.js'
import { ANY_OBJECT, asRecord, callContext, cancellable, compileParameters, optionalEnum, optionalInt, optionalRecord, optionalString, renderJson, requiredString, signalOf, textBlock, nullable, type RtaToolDefinition, type ToolDeps } from './shared.js'

const ASSET_KINDS = ['image', 'video', 'audio'] as const
const MODES = ['avatar', 'voice'] as const
const ROLES = ['idle', 'listen', 'gesture'] as const
const CONTEXT_ROLES = ['system', 'user', 'assistant'] as const

function assertWritable(deps: ToolDeps, name: string): void {
  if (deps.cfg.readOnly) throw new Error('readOnly=true, so ' + name + ' is disabled. Set readOnly:false in the plugin config and restart to allow writes.')
}

const LLM_PROVIDERS = ['local', 'gemini', 'openai'] as const
const STYLE_PRESETS = ['cinematic-founder', 'editorial-companion', 'warm-anime', 'luxury-realism', 'soft-3d', 'noir-avatar'] as const
/** Header-safe, and within the 180 chars the API honours (longer keys are silently ignored). */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,180}$/
const CLIP_ID_RE = /^[a-z0-9][a-z0-9_-]*$/
/** Request bodies are size-capped per route (8–64 KB); refuse anything absurd before it leaves the process. */
const MAX_BODY_BYTES = 1_048_576

function idempotencyKeyOf(args: Record<string, unknown>, generate: () => string): string {
  const raw = args.idempotencyKey
  if (raw === undefined || raw === null) return generate()
  if (typeof raw !== 'string') throw new Error('idempotencyKey must be a string.')
  const given = raw.trim()
  if (given === '') return generate()
  if (!IDEMPOTENCY_KEY_RE.test(given)) throw new Error('idempotencyKey must be 1-180 characters of letters, digits, ".", "_", ":" or "-" (the API ignores longer keys, which would defeat replay protection).')
  return given
}

function assertBodySize(body: unknown, label: string): void {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8')
  } catch {
    throw new Error(label + ' cannot be serialised as JSON (circular or too deeply nested).')
  }
  if (bytes > MAX_BODY_BYTES) throw new Error(label + ' is ' + bytes + ' bytes; the API caps request bodies at a few KB — send media by URL and trim large fields.')
}

export function buildWriteTools(deps: ToolDeps): RtaToolDefinition[] {
  const cfg = deps.cfg
  const RT = cfg.requestTimeoutMs
  /** Wording for free writes, which the gate asks about only while writeApproval is on. */
  const askNote = cfg.readOnly ? 'disabled while readOnly is on' : cfg.writeApproval ? 'asks for approval' : 'runs without approval (writeApproval:false)'

  const rtaAssetRemote: RtaToolDefinition = {
    name: 'rta_asset_remote',
    description: 'Register a file the platform fetches by URL as an asset (POST /v1/assets/remote): kind image · video · audio plus an absolute https URL. Free of generation cost. An image asset is the portrait rta_avatar_create needs. Scope avatars:write; ' + askNote + '.',
    parameters: compileParameters({
      kind: { type: 'string', enum: ASSET_KINDS, required: true, description: 'image, video or audio.' },
      remoteUrl: { type: 'string', required: true, description: 'Absolute http(s) URL the platform will fetch.' },
      originalFilename: { type: 'string', description: 'Optional display filename.' },
      metadata: { type: 'object', description: 'Optional string metadata.' },
    }),
    output: { schema: { type: 'object', properties: { id: nullable('string'), status: nullable('string') }, additionalProperties: true }, render: (_args, value) => renderJson(value) },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_asset_remote')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const kind = optionalEnum(args, 'kind', ASSET_KINDS)
      if (kind === undefined) throw new Error('kind is required (image, video or audio).')
      const input = { kind, remoteUrl: requiredString(args, 'remoteUrl', 2048), originalFilename: optionalString(args, 'originalFilename', 256), metadata: optionalRecord(args, 'metadata') }
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { id: null, status: null }, () => createRemoteAsset(ctx, input))
    },
    timeoutMs: RT,
  }

  const rtaAvatarUpdate: RtaToolDefinition = {
    name: 'rta_avatar_update',
    description: 'Partially update an avatar (PATCH /v1/avatars/{avatarId}): displayName, defaultVoiceId, llmProvider/llmModel, settings, metadata, persona, artDirection, stylePreset, anchorTimeMs. At least one field. Portrait swap is its own lane: pass sourceAssetId (an image asset from rta_asset_remote) alone, optionally with anchorTimeMs — it is exclusive of every other field. Scope avatars:write; ' + askNote + '.',
    parameters: compileParameters({
      avatarId: { type: 'string', required: true, description: 'Avatar id.' },
      displayName: { type: 'string' },
      defaultVoiceId: { type: 'string' },
      llmProvider: { type: 'string', enum: LLM_PROVIDERS },
      llmModel: { type: 'string' },
      settings: { type: 'object' },
      metadata: { type: 'object' },
      persona: { type: 'object', description: '{ name, personality, background, replyStyle }' },
      artDirection: { type: 'string' },
      stylePreset: { type: 'string', enum: STYLE_PRESETS },
      anchorTimeMs: { type: 'integer' },
      sourceAssetId: { type: 'string', description: 'Portrait swap: a new image asset id (exclusive of every other field except anchorTimeMs).' },
    }),
    output: { schema: { type: 'object', properties: { id: nullable('string'), status: nullable('string') }, additionalProperties: true }, render: (_args, value) => renderJson(value) },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_avatar_update')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const avatarId = requiredString(args, 'avatarId', 200)
      const input = {
        displayName: optionalString(args, 'displayName', 160),
        defaultVoiceId: optionalString(args, 'defaultVoiceId', 200),
        llmProvider: optionalEnum(args, 'llmProvider', LLM_PROVIDERS),
        llmModel: optionalString(args, 'llmModel', 200),
        settings: optionalRecord(args, 'settings'),
        metadata: optionalRecord(args, 'metadata'),
        persona: optionalRecord(args, 'persona'),
        artDirection: optionalString(args, 'artDirection', 2000),
        stylePreset: optionalEnum(args, 'stylePreset', STYLE_PRESETS),
        anchorTimeMs: optionalInt(args, 'anchorTimeMs', 0, 3_600_000),
        sourceAssetId: ((v) => (v === undefined ? undefined : assertId(v, 'sourceAssetId')))(optionalString(args, 'sourceAssetId', 200)),
      }
      if (input.sourceAssetId !== undefined) {
        const others = Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'sourceAssetId' && k !== 'anchorTimeMs').map(([k]) => k)
        if (others.length > 0) throw new Error('sourceAssetId (portrait swap) is exclusive of every other field except anchorTimeMs; remove: ' + others.join(', ') + '.')
      }
      assertBodySize(input, 'rta_avatar_update body')
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { id: avatarId, status: null }, () => updateAvatar(ctx, avatarId, input))
    },
    timeoutMs: RT,
  }

  const rtaAvatarDelete: RtaToolDefinition = {
    name: 'rta_avatar_delete',
    description: 'Soft-delete an avatar (DELETE /v1/avatars/{avatarId}). It disappears from every read afterwards. Scope avatars:write; ' + askNote + '.',
    parameters: compileParameters({ avatarId: { type: 'string', required: true, description: 'Avatar id.' } }),
    output: { schema: { type: 'object', properties: { avatarId: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['avatarId', 'deleted'], additionalProperties: true }, render: (_args, value) => textBlock(asRecord(value).deleted === true ? 'deleted ' + String(asRecord(value).avatarId) : 'not deleted') },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_avatar_delete')
      const signal = signalOf(exec)
      const avatarId = requiredString(asRecord(rawArgs), 'avatarId', 200)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { avatarId, deleted: false }, async () => {
        await deleteAvatar(ctx, avatarId)
        return { avatarId, deleted: true }
      })
    },
    timeoutMs: RT,
  }

  const rtaAvatarCreate: RtaToolDefinition = {
    name: 'rta_avatar_create',
    description: 'Create an avatar from a portrait image asset (POST /v1/avatars; image-only). The platform generates the idle loop and a motion library in the background: returns status preprocessing — poll rta_avatar every few seconds until ready (minutes). Spends credits (one generation); always asks for approval. Optional motionPrompt art-directs the loop; voiceDescription auto-picks a voice. Scope avatars:write.',
    parameters: compileParameters({
      displayName: { type: 'string', required: true, description: 'Character name shown in the dashboard.' },
      sourceAssetId: { type: 'string', required: true, description: 'Image asset id (from rta_asset_remote or rta_assets).' },
      motionPrompt: { type: 'string', description: 'Optional art direction for the generated resting loop.' },
      defaultVoiceId: { type: 'string', description: 'Optional voice id.' },
      voiceDescription: { type: 'string', description: 'Optional natural-language voice description (auto-selects a voice).' },
      llm: { type: 'object', description: 'Optional { provider, model }.' },
      settings: { type: 'object' },
      metadata: { type: 'object' },
    }),
    output: {
      schema: { type: 'object', properties: { id: nullable('string'), status: nullable('string'), next: { type: 'string' } }, additionalProperties: true },
      render: (_args, value) => {
        const a = asRecord(value)
        return textBlock('created avatar ' + String(a.id) + ' "' + String(a.displayName) + '" status=' + String(a.status) + '. ' + String(a.next ?? ''))
      },
    },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_avatar_create')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const llm = optionalRecord(args, 'llm')
      let llmInput: { provider: string; model?: string } | undefined
      if (llm !== undefined) {
        const provider = optionalEnum(llm, 'provider', LLM_PROVIDERS)
        if (provider === undefined) throw new Error('llm.provider is required when llm is given; one of ' + LLM_PROVIDERS.join(', ') + '.')
        const model = optionalString(llm, 'model', 200)
        llmInput = model === undefined ? { provider } : { provider, model }
      }
      const input = {
        displayName: requiredString(args, 'displayName', 160),
        sourceAssetId: requiredString(args, 'sourceAssetId', 200),
        motionPrompt: optionalString(args, 'motionPrompt', 1200),
        defaultVoiceId: optionalString(args, 'defaultVoiceId', 200),
        voiceDescription: optionalString(args, 'voiceDescription', 2000),
        llm: llmInput,
        settings: optionalRecord(args, 'settings'),
        metadata: optionalRecord(args, 'metadata'),
      }
      assertBodySize(input, 'rta_avatar_create body')
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { id: null, status: null, next: 'cancelled' }, async () => {
        const avatar = await createAvatar(ctx, input)
        return { ...avatar, next: 'poll rta_avatar with this id every few seconds until status is ready (a render takes minutes); then mint calls against it.' }
      })
    },
    timeoutMs: RT,
  }

  const rtaLoopSet: RtaToolDefinition = {
    name: 'rta_loop_set',
    description: "Re-direct an avatar's resting loop from a new motionPrompt (PUT /v1/avatars/{avatarId}/loop). Needs a portrait on the avatar (422 loop_not_generatable otherwise); do not gate on sourceKind — a ready avatar reads video once its generated loop attaches. Answers 202 and renders for minutes while the previous loop keeps serving; billed as one generation; always asks for approval. Sends an Idempotency-Key (auto-generated unless given, max 180 chars) so a retry never renders twice. Scope avatars:write.",
    parameters: compileParameters({
      avatarId: { type: 'string', required: true },
      motionPrompt: { type: 'string', required: true, description: 'How she should rest (screened before rendering).' },
      idempotencyKey: { type: 'string', description: 'Reuse to retry the same request safely; omit to auto-generate.' },
    }),
    output: { schema: { type: 'object', properties: { avatarId: nullable('string'), loopStatus: nullable('string'), idempotencyKey: { type: 'string' } }, additionalProperties: true }, render: (_args, value) => renderJson(value) },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_loop_set')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const avatarId = requiredString(args, 'avatarId', 200)
      const motionPrompt = requiredString(args, 'motionPrompt', 1200)
      const idempotencyKey = idempotencyKeyOf(args, deps.randomUUID)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { avatarId, loopStatus: null, idempotencyKey }, async () => ({ ...(await setLoop(ctx, avatarId, motionPrompt, idempotencyKey)), idempotencyKey }))
    },
    timeoutMs: RT,
  }

  const rtaClipsSet: RtaToolDefinition = {
    name: 'rta_clips_set',
    description: "Declare an avatar's clip library in full (PUT /v1/avatars/{avatarId}/clips): the platform renders what is new, keeps what matches, retires what you dropped. Each clip: clipId, role (idle · listen · gesture), optional whenHint, source { motionPrompt } or { assetId }. Pass expectedRevision (from rta_clips) for a compare-and-swap. Sends an Idempotency-Key. New clips render (may spend credits); always asks for approval. Scope avatars:write.",
    parameters: compileParameters({
      avatarId: { type: 'string', required: true },
      clips: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: 'Full library, at most 12 entries.' },
      expectedRevision: { type: 'integer', description: 'Current revision from rta_clips (optional compare-and-swap).' },
      idempotencyKey: { type: 'string' },
    }),
    output: { schema: { type: 'object', properties: { avatarId: nullable('string'), revision: nullable('number'), clips: { type: 'array', items: ANY_OBJECT }, idempotencyKey: { type: 'string' } }, additionalProperties: true }, render: (_args, value) => renderJson(value) },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_clips_set')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const avatarId = requiredString(args, 'avatarId', 200)
      const raw = args.clips
      // An empty array is allowed: the library reconciles, so [] retires every clip.
      if (!Array.isArray(raw) || raw.length > 12) throw new Error('clips must be an array of at most 12 clip declarations ([] retires the whole library).')
      const clips: ClipDeclaration[] = raw.map((item, i) => {
        const c = asRecord(item)
        const clipId = requiredString(c, 'clipId', 64)
        if (!CLIP_ID_RE.test(clipId)) throw new Error('clips[' + i + '].clipId must be lowercase letters, digits, "_" or "-" (1-64 chars, starting with a letter or digit).')
        const role = optionalEnum(c, 'role', ROLES)
        if (role === undefined) throw new Error('clips[' + i + '].role must be idle, listen or gesture.')
        const source = asRecord(c.source)
        let declared: ClipDeclaration['source']
        if (typeof source.motionPrompt === 'string') {
          const motionPrompt = optionalString(source, 'motionPrompt', 1200)
          if (motionPrompt === undefined) throw new Error('clips[' + i + '].source.motionPrompt must be a non-empty string (max 1200 chars).')
          declared = { motionPrompt }
        } else if (typeof source.assetId === 'string') {
          declared = { assetId: assertId(source.assetId, 'clips[' + i + '].source.assetId') }
        } else {
          throw new Error('clips[' + i + '].source must be { motionPrompt } or { assetId }.')
        }
        const decl: ClipDeclaration = { clipId, role, source: declared }
        const whenHint = optionalString(c, 'whenHint', 280)
        if (whenHint !== undefined) decl.whenHint = whenHint
        const durationSeconds = optionalInt(c, 'durationSeconds', 4, 8)
        if (durationSeconds !== undefined) decl.durationSeconds = durationSeconds
        if (c.reroll === true) decl.reroll = true
        return decl
      })
      const expectedRevision = optionalInt(args, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER)
      const idempotencyKey = idempotencyKeyOf(args, deps.randomUUID)
      assertBodySize({ clips, expectedRevision }, 'rta_clips_set body')
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { avatarId, revision: null, clips: [], idempotencyKey }, async () => ({ ...(await setClipLibrary(ctx, avatarId, clips, expectedRevision, idempotencyKey)), idempotencyKey }))
    },
    timeoutMs: RT,
  }

  const rtaSessionMint: RtaToolDefinition = {
    name: 'rta_session_mint',
    description: 'Mint a live call session for an avatar (POST /v1/realtime/livekit/session) — the server-side half of a call, normally done by your app\'s connect endpoint, useful here to test a character. Reserves a capacity slot and bills once a client joins; always asks for approval. The policy fields are server-authoritative: instructions (≤4000), initialContext (≤32 messages), maxSessionSeconds (capped at ' + cfg.maxSessionSeconds + ' by config), voice, mode avatar|voice, clientMetadata, transcriptWebhook. A capacity-full answer returns status queued (not an error) with a queue ticket. The participant token is withheld unless includeToken is true. Release with rta_session_release when done. The public example avatar ' + EXAMPLE_AVATAR_ID + ' works with any key. Scope realtime:write.',
    parameters: compileParameters({
      avatarId: { type: 'string', required: true, description: 'Avatar id (ava_… or a public seed-* id).' },
      mode: { type: 'string', enum: MODES, description: 'avatar (video) or voice (audio only).' },
      instructions: { type: 'string', description: 'Behaviour contract, up to 4000 chars.' },
      initialContext: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: [...CONTEXT_ROLES] }, content: { type: 'string' } }, required: ['role', 'content'], additionalProperties: false }, description: 'Up to 32 prior messages replayed as memory.' },
      maxSessionSeconds: { type: 'integer', description: 'Hard stop in seconds (1-1800; capped by config).' },
      voiceId: { type: 'string', description: 'Voice id override for this call (wire field voice_id).' },
      voice: { type: 'object', description: 'Full voice object override { provider, voice_id, model?, speed?, emotion?, language? } (wire field voice).' },
      clientMetadata: { type: 'object', description: 'Up to 16 string pairs (keys ≤64, values ≤200 chars) echoed on the transcript.' },
      transcriptWebhook: { type: 'object', properties: { url: { type: 'string' }, secret: { type: 'string' } }, description: '{ url (https, ≤500 chars), secret (16-200 chars) } to receive the signed transcript.' },
      includeToken: { type: 'boolean', description: 'Also return and render the participant token (a joinable credential). Default false.' },
    }),
    output: {
      schema: { type: 'object', properties: { status: { type: 'string' }, sessionId: nullable('string'), queueTicketId: nullable('string'), warning: { type: 'string' } }, required: ['status'], additionalProperties: true },
      render: (_args, value) => {
        const g = asRecord(value)
        if (g.status === 'queued') return textBlock('queued: position ' + String(g.queuePosition) + ' of ' + String(g.queueSize) + ', retry in ' + String(g.recommendedRetryMs) + ' ms (ticket ' + String(g.queueTicketId) + ')')
        if (g.status === 'ready') {
          const token = typeof g.participantToken === 'string' ? '\nparticipant token (requested with includeToken): ' + g.participantToken : ''
          return [{ type: 'text', text: redactSecrets('session ' + String(g.sessionId) + ' ready: room ' + String(g.roomName) + ' at ' + String(g.livekitUrl) + ', expires ' + String(g.reservationExpiresAt) + ', max ' + String(g.maxSessionSeconds) + ' s. ' + String(g.warning ?? '')) + token }]
        }
        return renderJson(value)
      },
    },
    async execute(rawArgs, exec) {
      assertWritable(deps, 'rta_session_mint')
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const avatarId = requiredString(args, 'avatarId', 200)
      const requested = optionalInt(args, 'maxSessionSeconds', 1, 1800) ?? cfg.maxSessionSeconds
      const maxSessionSeconds = Math.min(requested, cfg.maxSessionSeconds)
      const rawContext = args.initialContext
      let initialContext: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | undefined
      if (rawContext !== undefined) {
        if (!Array.isArray(rawContext) || rawContext.length > 32) throw new Error('initialContext must be an array of at most 32 messages.')
        initialContext = rawContext.map((item, i) => {
          const m = asRecord(item)
          const role = optionalEnum(m, 'role', CONTEXT_ROLES)
          const content = optionalString(m, 'content', 4000)
          if (role === undefined || content === undefined) throw new Error('initialContext[' + i + '] needs role (system|user|assistant) and content (1-4000 chars).')
          return { role, content }
        })
      }
      const metadataRaw = optionalRecord(args, 'clientMetadata')
      let clientMetadata: Record<string, string> | undefined
      if (metadataRaw !== undefined) {
        const entries = Object.entries(metadataRaw)
        if (entries.length > 16) throw new Error('clientMetadata must be at most 16 string pairs.')
        for (const [k, v] of entries) {
          if (typeof v !== 'string' || k.length === 0 || k.length > 64 || v.length > 200) throw new Error('clientMetadata: keys must be 1-64 chars and values strings of at most 200 chars (offending key: ' + k.slice(0, 40) + ').')
        }
        clientMetadata = Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))
      }
      const webhookRaw = optionalRecord(args, 'transcriptWebhook')
      let transcriptWebhook: { url: string; secret: string } | undefined
      if (webhookRaw !== undefined) {
        const url = optionalString(webhookRaw, 'url', 500)
        const secret = optionalString(webhookRaw, 'secret', 200)
        if (url === undefined || secret === undefined || secret.length < 16) throw new Error('transcriptWebhook needs an https url (≤500 chars) and a secret of 16-200 characters.')
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new Error('transcriptWebhook.url must be an absolute https URL.')
        }
        if (parsed.protocol !== 'https:') throw new Error('transcriptWebhook.url must use https.')
        transcriptWebhook = { url: parsed.toString(), secret }
      }
      const voiceObject = optionalRecord(args, 'voice')
      if (voiceObject !== undefined && (typeof voiceObject.provider !== 'string' || typeof voiceObject.voice_id !== 'string')) {
        throw new Error('voice must be an object with at least provider and voice_id (use voiceId for a plain voice id).')
      }
      const includeToken = args.includeToken === true
      const input = { avatarId, mode: optionalEnum(args, 'mode', MODES), instructions: optionalString(args, 'instructions', 4000), initialContext, maxSessionSeconds, voiceId: optionalString(args, 'voiceId', 240), voice: voiceObject, clientMetadata, transcriptWebhook }
      assertBodySize(input, 'rta_session_mint body')
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { status: 'cancelled', sessionId: null, queueTicketId: null }, async () => {
        const grant = await mintSession(ctx, input)
        if (grant.status === 'queued') return grant
        const { participantToken, ...rest } = grant
        return {
          ...rest,
          ...(includeToken ? { participantToken } : { participantToken: null, tokenWithheld: true }),
          warning: 'This holds a capacity slot and bills once a client joins; call rta_session_release with this sessionId when you are done (the reservation also expires on its own).',
        }
      })
    },
    timeoutMs: RT,
  }

  return [rtaAssetRemote, rtaAvatarUpdate, rtaAvatarDelete, rtaAvatarCreate, rtaLoopSet, rtaClipsSet, rtaSessionMint]
}
