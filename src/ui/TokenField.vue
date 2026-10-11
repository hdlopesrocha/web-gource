<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  acceptToken,
  applyDraftToken,
  clearToken,
  detectTokenProvider,
  displayToken,
  hasToken,
  providerDescriptors,
  sanitizeToken,
  store,
  tokenHoldersFor,
} from '../state/store'

/**
 * Personal access token field.
 *
 * Deliberately forgiving: always editable, accepts a typed or pasted value at
 * any time (even before the repository URL is known), strips whitespace,
 * line breaks and an accidental `Bearer` prefix, and derives the host from the
 * token prefix when it can.
 *
 * The input is edited locally and committed to the store on blur, on Enter, or
 * shortly after typing stops — committing on every keystroke would persist
 * half-typed tokens and run host detection on partial prefixes.
 */
const props = withDefaults(
  defineProps<{
    /** Provider the token belongs to, when it is already known. */
    providerId: string | null
    /** Hide the explanatory footer (used inside the settings panel). */
    compact?: boolean
  }>(),
  { compact: false },
)

const emit = defineEmits<{ (event: 'saved', providerId: string | null): void }>()

const COMMIT_DELAY = 400

const visible = ref(false)
const status = ref<string | null>(null)
const error = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)
const text = ref(displayToken(props.providerId))
/** Last value written to the store, so clearing knows what to remove. */
let committed = text.value
let commitTimer: number | null = null

const providerName = (id: string): string =>
  providerDescriptors.find((descriptor) => descriptor.id === id)?.name ?? id

/** Host the current value will be used for. */
const targetLabel = computed(() => {
  const owner =
    detectTokenProvider(text.value) ?? props.providerId ?? store.loadOptions.lastTokenProvider
  return owner ? providerName(owner) : null
})

const saved = computed(() => {
  if (store.loadOptions.draftToken) return true
  if (props.providerId) return hasToken(props.providerId)
  return Object.keys(store.loadOptions.tokens).length > 0
})

/** Derived confirmation, always in sync with what is actually stored. */
const storedHint = computed(() => {
  if (!saved.value) return null
  const target = targetLabel.value
  if (!target) return 'Token stored — it will be matched to its host automatically'
  return `Stored for ${target}: it is only ever sent to that host`
})

function clearTimer(): void {
  if (commitTimer !== null) {
    window.clearTimeout(commitTimer)
    commitTimer = null
  }
}

/** Write the field content into the store. */
function commit(value: string): void {
  clearTimer()
  if (!value.trim()) {
    for (const id of tokenHoldersFor(props.providerId, committed)) clearToken(id)
    acceptToken('', null)
    text.value = ''
    committed = ''
    status.value = null
    return
  }
  const clean = sanitizeToken(value)
  const result = acceptToken(clean, props.providerId)
  text.value = clean
  committed = clean
  // When the host is known the derived hint below already confirms the state;
  // only genuinely different outcomes need a transient message.
  status.value = result.providerId ? null : 'Kept — it will be matched to the host once the URL is known'
  if (result.providerId) emit('saved', result.providerId)
}

function onInput(): void {
  error.value = null
  clearTimer()
  commitTimer = window.setTimeout(() => commit(text.value), COMMIT_DELAY)
}

function onBlur(): void {
  commit(text.value)
}

function onEnter(): void {
  commit(text.value)
}

/** Select everything on focus so typing replaces a stored token. */
function onFocus(event: FocusEvent): void {
  ;(event.target as HTMLInputElement | null)?.select()
}

/** Paste straight from the clipboard when the browser allows it. */
async function paste(): Promise<void> {
  error.value = null
  status.value = null
  try {
    if (!navigator.clipboard?.readText) throw new Error('unsupported')
    const clipboard = await navigator.clipboard.readText()
    if (!clipboard.trim()) {
      error.value = 'The clipboard is empty.'
      return
    }
    text.value = clipboard
    commit(clipboard)
    input.value?.focus()
  } catch {
    error.value = 'Clipboard access was blocked — click the field and paste with Ctrl/Cmd+V.'
    input.value?.focus()
  }
}

function clear(): void {
  for (const id of tokenHoldersFor(props.providerId, committed || text.value)) clearToken(id)
  acceptToken('', null)
  text.value = ''
  committed = ''
  status.value = 'Token cleared'
  error.value = null
}

// Keep the field in sync when the host changes or a draft is attached.
watch(
  () => [props.providerId, store.loadOptions.draftToken, store.loadOptions.tokens[props.providerId ?? '']],
  () => {
    const next = displayToken(props.providerId)
    if (next !== committed) {
      text.value = next
      committed = next
    }
  },
)

// Attach a draft as soon as the host becomes known.
watch(
  () => props.providerId,
  (providerId) => {
    if (providerId && applyDraftToken(providerId)) {
      const next = displayToken(providerId)
      text.value = next
      committed = next
      emit('saved', providerId)
    }
  },
)

onMounted(() => {
  if (saved.value) status.value = null
})

onBeforeUnmount(() => clearTimer())
</script>

<template>
  <div class="token-field">
    <label for="access-token">
      Personal access token<span v-if="targetLabel"> ({{ targetLabel }})</span> — optional, stored locally
    </label>
    <div class="row">
      <input
        id="access-token"
        ref="input"
        v-model="text"
        :type="visible ? 'text' : 'password'"
        class="token-input"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        placeholder="Type or paste a token (works before choosing a URL)"
        aria-label="Personal access token"
        @input="onInput"
        @blur="onBlur"
        @keyup.enter="onEnter"
        @focus="onFocus"
        @paste="error = null"
      />
      <button class="btn small" type="button" title="Read the token from the clipboard" @click="paste">Paste</button>
      <button class="btn small" type="button" @click="visible = !visible">{{ visible ? 'Hide' : 'Show' }}</button>
      <button v-if="saved" class="btn small" type="button" @click="clear">Clear</button>
    </div>
    <p v-if="storedHint" class="hint ok">{{ storedHint }}</p>
    <p v-if="status" class="hint ok">{{ status }}</p>
    <p v-if="error" class="hint warn">{{ error }}</p>
    <p v-if="!compact" class="hint muted">
      Spaces, line breaks and a leading <code>Bearer</code> are removed automatically. Tokens stay in this browser's
      local storage and are sent directly to the host API — there is no backend. GitHub tokens start with
      <code>ghp_</code>, GitLab tokens with <code>glpat-</code>: the prefix is used to attach an unrecognised token to
      the right host.
    </p>
  </div>
</template>

<style scoped>
.token-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.token-input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12.5px;
}

.hint {
  font-size: 12px;
  margin: 0;
}

.hint.ok {
  color: var(--add);
}

.hint.warn {
  color: var(--modify);
}

code {
  font-family: var(--mono);
  opacity: 0.85;
}
</style>
