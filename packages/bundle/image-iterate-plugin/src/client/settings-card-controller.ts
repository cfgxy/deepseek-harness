import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Namespace served by the image generation and review Host plugin. */
export const IMAGE_ITERATE_NS = 'image-iterate-plugin'

/** Settings stored by the image generation and review Host plugin. */
export interface ImageIterateSettings {
  imageBaseUrl?: string
  imageModel?: string
  imageCredential?: string
  reviewBaseUrl?: string
  reviewModel?: string
  reviewCredential?: string
  maxIterations?: number
  timeoutMs?: number
  defaultSize?: string
  defaultQuality?: string
  outputFormat?: string
}

/** Credential state shown for one write-only key control. */
export interface ImageCredentialState {
  ref: string
  configured: boolean
  writable: boolean
  known: boolean
}

/** State rendered by the image settings card. */
export interface ImageIterateSettingsCardState extends SettingsFormShell {
  imageBaseUrl: SettingsFieldState
  imageModel: SettingsFieldState
  imageCredential: SettingsFieldState
  reviewBaseUrl: SettingsFieldState
  reviewModel: SettingsFieldState
  reviewCredential: SettingsFieldState
  maxIterations: SettingsFieldState
  timeoutMs: SettingsFieldState
  defaultSize: SettingsFieldState
  defaultQuality: SettingsFieldState
  outputFormat: SettingsFieldState
  imageSecret: SettingsFieldState
  reviewSecret: SettingsFieldState
  imageConfigured: boolean
  imageWritable: boolean
  imageCredentialKnown: boolean
  reviewConfigured: boolean
  reviewWritable: boolean
  reviewCredentialKnown: boolean
}

/** Registration-side face injected into the image settings card. */
export interface ImageIterateSettingsCardFace extends SettingsFormActions {
  hooks: {
    imageIterateSettings: SnapshotStore<ImageIterateSettingsCardState>
  }
}

function boundedInteger(field: string, minimum: number, maximum: number) {
  return {
    ...settingsNumberField(field),
    parse: (text: string) => {
      if (text.trim() === '') return { kind: 'clear' as const }
      const value = Number(text)
      return Number.isInteger(value) && value >= minimum && value <= maximum ? { kind: 'set' as const, value } : undefined
    },
  }
}

function outputFormatField() {
  return {
    ...settingsTextField('outputFormat'),
    parse: (text: string) => {
      const value = text.trim()
      if (value === '') return { kind: 'clear' as const }
      return value === 'png' || value === 'webp' || value === 'jpeg' ? { kind: 'set' as const, value } : undefined
    },
  }
}

/** Bridges the image settings scope and credentials remote into the card. */
export class ImageIterateSettingsController {
  private readonly form: SettingsFormModel<ImageIterateSettings>
  private readonly store: SnapshotStore<ImageIterateSettingsCardState>
  private readonly formStore: SnapshotStore<SettingsFormShell>
  private readonly unsubscribe: () => void
  private readonly scopeUnsubscribe: () => void
  private credentials: { imageSecret: ImageCredentialState; reviewSecret: ImageCredentialState }
  private readSequence = 0
  private disposed = false

  /**
   * @param scope - The Host-backed settings scope.
   * @param ctx - Client context carrying the credentials remote.
   */
  constructor(scope: SettingsFormScope<ImageIterateSettings>, private readonly ctx: ClientContext) {
    this.form = new SettingsFormModel(scope, [
      settingsTextField('imageBaseUrl'), settingsTextField('imageModel'), settingsTextField('imageCredential'),
      settingsTextField('reviewBaseUrl'), settingsTextField('reviewModel'), settingsTextField('reviewCredential'),
      boundedInteger('maxIterations', 1, 3), boundedInteger('timeoutMs', 1000, Number.MAX_SAFE_INTEGER),
      settingsTextField('defaultSize'), settingsTextField('defaultQuality'), outputFormatField(),
    ], [
      { field: 'imageSecret', write: value => this.writeCredential('imageCredential', value) },
      { field: 'reviewSecret', write: value => this.writeCredential('reviewCredential', value) },
    ])
    this.credentials = {
      imageSecret: this.credential(this.reference('imageCredential'), this.reference('imageCredential') === ''),
      reviewSecret: this.credential(this.reference('reviewCredential'), this.reference('reviewCredential') === ''),
    }
    this.store = this.form.bind(() => this.projection())
    this.formStore = this.form.bind(() => this.form.shell())
    this.unsubscribe = this.formStore.subscribe(() => {
      this.resetCredentialReferences()
      this.publish()
    })
    this.scopeUnsubscribe = scope.subscribe(() => { void this.readCredentials() })
    void this.readCredentials()
  }

  private reference(field: 'imageCredential' | 'reviewCredential'): string {
    return this.form.field(field).text.trim()
  }

  private credential(ref: string, known: boolean): ImageCredentialState {
    return { ref, configured: false, writable: true, known }
  }

  private projection(): ImageIterateSettingsCardState {
    return {
      ...this.form.shell(),
      imageBaseUrl: this.form.field('imageBaseUrl'), imageModel: this.form.field('imageModel'), imageCredential: this.form.field('imageCredential'),
      reviewBaseUrl: this.form.field('reviewBaseUrl'), reviewModel: this.form.field('reviewModel'), reviewCredential: this.form.field('reviewCredential'),
      maxIterations: this.form.field('maxIterations'), timeoutMs: this.form.field('timeoutMs'),
      defaultSize: this.form.field('defaultSize'), defaultQuality: this.form.field('defaultQuality'), outputFormat: this.form.field('outputFormat'),
      imageSecret: this.form.field('imageSecret'), reviewSecret: this.form.field('reviewSecret'),
      imageConfigured: this.credentials.imageSecret.configured, imageWritable: this.credentials.imageSecret.writable,
      imageCredentialKnown: this.credentials.imageSecret.known,
      reviewConfigured: this.credentials.reviewSecret.configured, reviewWritable: this.credentials.reviewSecret.writable,
      reviewCredentialKnown: this.credentials.reviewSecret.known,
    }
  }

  private publish(): void {
    if (!this.disposed) this.store.set(this.projection())
  }

  private resetCredentialReferences(): boolean {
    const imageRef = this.reference('imageCredential')
    const reviewRef = this.reference('reviewCredential')
    let changed = false
    if (imageRef !== this.credentials.imageSecret.ref) {
      this.credentials.imageSecret = this.credential(imageRef, imageRef === '')
      changed = true
    }
    if (reviewRef !== this.credentials.reviewSecret.ref) {
      this.credentials.reviewSecret = this.credential(reviewRef, reviewRef === '')
      changed = true
    }
    if (changed) this.readSequence++
    return changed
  }

  private async readCredentials(): Promise<void> {
    if (this.disposed) return
    const imageRef = this.reference('imageCredential')
    const reviewRef = this.reference('reviewCredential')
    const reset = this.resetCredentialReferences()
    const sequence = ++this.readSequence
    const refs = [...new Set([imageRef, reviewRef].filter(Boolean))]
    if (reset) this.publish()
    if (refs.length === 0) {
      this.credentials.imageSecret = this.credential('', true)
      this.credentials.reviewSecret = this.credential('', true)
      this.publish()
      return
    }
    let response
    try {
      response = await this.ctx.remote.credentials.describe(refs)
    } catch (_error) {
      this.applyUnknownCredentialState(imageRef, reviewRef, sequence)
      return
    }
    if (this.disposed || sequence !== this.readSequence
      || imageRef !== this.reference('imageCredential') || reviewRef !== this.reference('reviewCredential')) return
    if (!response.ok) {
      this.applyUnknownCredentialState(imageRef, reviewRef, sequence)
      return
    }
    const value = (ref: string): ImageCredentialState => {
      const status = response.value[ref]
      return { ref, configured: status?.configured ?? false, writable: status?.writable ?? true, known: true }
    }
    this.credentials.imageSecret = imageRef === '' ? this.credential('', true) : value(imageRef)
    this.credentials.reviewSecret = reviewRef === '' ? this.credential('', true) : value(reviewRef)
    this.publish()
  }

  private applyUnknownCredentialState(imageRef: string, reviewRef: string, sequence: number): void {
    if (this.disposed || sequence !== this.readSequence
      || imageRef !== this.reference('imageCredential') || reviewRef !== this.reference('reviewCredential')) return
    this.credentials.imageSecret = imageRef === '' ? this.credential('', true) : this.credential(imageRef, false)
    this.credentials.reviewSecret = reviewRef === '' ? this.credential('', true) : this.credential(reviewRef, false)
    this.publish()
  }

  private async writeCredential(field: 'imageCredential' | 'reviewCredential', value: string): Promise<boolean> {
    const reference = this.reference(field)
    if (reference === '') return false
    const saved = await this.ctx.remote.credentials.set(reference, value)
    if (!saved.ok) return false
    await this.readCredentials()
    return this.credentialsFor(field).configured
  }

  private credentialsFor(field: 'imageCredential' | 'reviewCredential'): ImageCredentialState {
    return field === 'imageCredential' ? this.credentials.imageSecret : this.credentials.reviewSecret
  }

  /** Refresh the displayed state after another surface changes a credential. */
  refreshCredential(ref: string): void {
    if (ref === this.reference('imageCredential') || ref === this.reference('reviewCredential')) void this.readCredentials()
  }

  /** Build the slot face consumed by the settings card. */
  inject(): ImageIterateSettingsCardFace {
    const actions = this.form.actions()
    return {
      hooks: { imageIterateSettings: this.store },
      edit: (field, text) => {
        actions.edit(field, text)
        if (field === 'imageCredential' || field === 'reviewCredential') void this.readCredentials()
      },
      resetField: (field) => { actions.resetField(field) },
      save: actions.save,
      discard: () => { actions.discard(); void this.readCredentials() },
    }
  }

  /** Release subscriptions and prevent late credential reads from publishing. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.scopeUnsubscribe()
    this.form.dispose()
  }
}
