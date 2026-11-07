window.__ModuleLoader__.load({
  id: 'dsh-image-iterate-plugin',
  factory(require) {
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const {
      SettingsForm, SettingsFormModel, SettingsSecretField, SettingsValueField,
      settingsNumberField, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const imageSlot = 'image-iterate.tool.call.images'
    const namespace = 'image-iterate-plugin'
    const localeNamespace = 'settings.imageIterate'
    const en = {
      title: 'Image generation and review', description: 'Configure the image provider and visual review provider.',
      imageBaseUrl: 'Image API base URL', imageModel: 'Image model', imageCredential: 'Image credential reference',
      reviewBaseUrl: 'Review API base URL', reviewModel: 'Review model', reviewCredential: 'Review credential reference',
      imageSecret: 'Image API key', reviewSecret: 'Review API key', secretHint: 'Stored outside the settings file. Leave blank to keep the current key.',
      configured: 'A key is configured.', unconfigured: 'No key is configured.', credentialUnknown: 'Credential status is unavailable.', maxIterations: 'Maximum iterations',
      timeoutMs: 'Request timeout (ms)', defaultSize: 'Default image size', defaultQuality: 'Default quality', outputFormat: 'Output format',
      overridden: 'Overridden', reset: 'Reset to default', readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.', save: 'Save', saving: 'Saving...',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.', invalidNumber: 'Enter a whole number in the accepted range.',
      invalidFormat: 'Choose png, webp, or jpeg.', invalidIterations: 'Enter an integer from 1 to 3.', invalidTimeout: 'Enter an integer of at least 1000.',
    }
    const zh = {
      title: '图像生成与审核', description: '配置图像提供方和视觉审核提供方。',
      imageBaseUrl: '图像 API 基础地址', imageModel: '图像模型', imageCredential: '图像凭据引用',
      reviewBaseUrl: '审核 API 基础地址', reviewModel: '审核模型', reviewCredential: '审核凭据引用',
      imageSecret: '图像 API Key', reviewSecret: '审核 API Key', secretHint: '不写入设置文件。留空表示保持当前密钥。',
      configured: '已配置密钥。', unconfigured: '未配置密钥。', credentialUnknown: '无法读取凭据状态。', maxIterations: '最大迭代次数',
      timeoutMs: '请求超时（毫秒）', defaultSize: '默认图片尺寸', defaultQuality: '默认质量', outputFormat: '输出格式',
      overridden: '已覆盖', reset: '恢复默认', readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。', save: '保存', saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。', invalidNumber: '请输入受支持范围内的整数。',
      invalidFormat: '请选择 png、webp 或 jpeg。', invalidIterations: '请输入 1 到 3 的整数。', invalidTimeout: '请输入不小于 1000 的整数。',
    }

    function attachmentFrom(meta) {
      if (typeof meta !== 'object' || meta === null) return undefined
      const image = meta.image
      if (typeof image !== 'object' || image === null) return undefined
      const attachmentId = typeof image.attachmentId === 'string' ? image.attachmentId : image.attachment_id
      const mediaType = typeof image.mediaType === 'string' ? image.mediaType : image.media_type
      if (typeof attachmentId !== 'string' || attachmentId === '' || typeof mediaType !== 'string' || mediaType === '') return undefined
      if (!Number.isInteger(image.bytes) || image.bytes < 1
        || !Number.isInteger(image.width) || image.width < 1
        || !Number.isInteger(image.height) || image.height < 1) return undefined
      let originalDimensions
      if (image.originalDimensions !== undefined) {
        if (typeof image.originalDimensions !== 'object' || image.originalDimensions === null
          || !Number.isInteger(image.originalDimensions.width) || image.originalDimensions.width < 1
          || !Number.isInteger(image.originalDimensions.height) || image.originalDimensions.height < 1) return undefined
        originalDimensions = { width: image.originalDimensions.width, height: image.originalDimensions.height }
      }
      return {
        attachmentId, mediaType, bytes: image.bytes, width: image.width, height: image.height,
        ...(typeof image.name === 'string' ? { name: image.name } : {}),
        ...(originalDimensions === undefined ? {} : { originalDimensions }),
      }
    }

    function textFrom(block) {
      if (!Array.isArray(block.content)) return ''
      return block.content
        .filter(part => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
    }

    function ImageResultRow({ phase, block, loadImage, renderSlot }) {
      const attachment = phase === 'result' && !block.isError ? attachmentFrom(block.meta) : undefined
      const text = phase === 'result' ? textFrom(block) : ''
      const children = text === '' ? [] : [h('pre', { key: 'output', style: { margin: 0, whiteSpace: 'pre-wrap' } }, text)]
      if (attachment !== undefined && typeof renderSlot === 'function') {
        children.push(renderSlot(imageSlot, { images: [{ attachment }], loadImage, align: 'start' }))
      }
      return children.length === 0 ? null : h('div', null, ...children)
    }

    function ImageResultGallery({ images, loadImage, align, renderFactorySlot }) {
      if (typeof renderFactorySlot !== 'function') return null
      return renderFactorySlot('conversation.images.content', { images, loadImage, align })
    }

    function boundedInteger(minimum, maximum) {
      return {
        ...settingsNumberField(''),
        parse(text) {
          if (text.trim() === '') return { kind: 'clear' }
          const value = Number(text)
          return Number.isInteger(value) && value >= minimum && value <= maximum ? { kind: 'set', value } : undefined
        },
      }
    }

    function outputFormatField() {
      return {
        ...settingsTextField('outputFormat'),
        parse(text) {
          const value = text.trim()
          if (value === '') return { kind: 'clear' }
          return ['png', 'webp', 'jpeg'].includes(value) ? { kind: 'set', value } : undefined
        },
      }
    }

    class ImageIterateSettingsController {
      constructor(ctx) {
        this.ctx = ctx
        this.scope = ctx.configForms.get(namespace)
        this.disposed = false
        this.readSequence = 0
        this.model = new SettingsFormModel(this.scope, [
          settingsTextField('imageBaseUrl'), settingsTextField('imageModel'), settingsTextField('imageCredential'),
          settingsTextField('reviewBaseUrl'), settingsTextField('reviewModel'), settingsTextField('reviewCredential'),
          { ...boundedInteger(1, 3), field: 'maxIterations' },
          { ...boundedInteger(1000, Number.MAX_SAFE_INTEGER), field: 'timeoutMs' },
          settingsTextField('defaultSize'), settingsTextField('defaultQuality'), outputFormatField(),
        ], [
          { field: 'imageSecret', write: value => this.writeCredential('imageCredential', value) },
          { field: 'reviewSecret', write: value => this.writeCredential('reviewCredential', value) },
        ])
        this.credentials = {
          imageSecret: this.credential(this.ref('imageCredential'), this.ref('imageCredential') === ''),
          reviewSecret: this.credential(this.ref('reviewCredential'), this.ref('reviewCredential') === ''),
        }
        this.store = createSnapshotStore(this.projection())
        this.formStore = this.model.bind(() => this.model.shell())
        this.unsubscribe = this.formStore.subscribe(() => {
          this.resetCredentialReferences()
          this.publish()
        })
        this.scopeUnsubscribe = this.scope.subscribe(() => { this.readCredentials() })
        void this.readCredentials()
      }

      ref(field) {
        return this.model.field(field).text.trim()
      }

      projection() {
        const shell = this.model.shell()
        const imageCredential = this.credentials.imageSecret
        const reviewCredential = this.credentials.reviewSecret
        return {
          ...shell,
          imageBaseUrl: this.model.field('imageBaseUrl'), imageModel: this.model.field('imageModel'), imageCredential: this.model.field('imageCredential'),
          reviewBaseUrl: this.model.field('reviewBaseUrl'), reviewModel: this.model.field('reviewModel'), reviewCredential: this.model.field('reviewCredential'),
          maxIterations: this.model.field('maxIterations'), timeoutMs: this.model.field('timeoutMs'),
          defaultSize: this.model.field('defaultSize'), defaultQuality: this.model.field('defaultQuality'), outputFormat: this.model.field('outputFormat'),
          imageSecret: this.model.field('imageSecret'), reviewSecret: this.model.field('reviewSecret'),
          imageConfigured: imageCredential.configured, imageWritable: imageCredential.writable, imageCredentialKnown: imageCredential.known,
          reviewConfigured: reviewCredential.configured, reviewWritable: reviewCredential.writable, reviewCredentialKnown: reviewCredential.known,
        }
      }

      publish() { if (!this.disposed) this.store.set(this.projection()) }

      credential(ref, known) {
        return { ref, configured: false, writable: true, known }
      }

      resetCredentialReferences() {
        const imageRef = this.ref('imageCredential')
        const reviewRef = this.ref('reviewCredential')
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

      async readCredentials() {
        const imageRef = this.ref('imageCredential')
        const reviewRef = this.ref('reviewCredential')
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
          if (this.disposed || sequence !== this.readSequence
            || imageRef !== this.ref('imageCredential') || reviewRef !== this.ref('reviewCredential')) return
          this.credentials.imageSecret = imageRef === ''
            ? this.credential('', true)
            : this.credential(imageRef, false)
          this.credentials.reviewSecret = reviewRef === ''
            ? this.credential('', true)
            : this.credential(reviewRef, false)
          this.publish()
          return
        }
        if (this.disposed || sequence !== this.readSequence
          || imageRef !== this.ref('imageCredential') || reviewRef !== this.ref('reviewCredential')) return
        if (!response.ok) {
          this.credentials.imageSecret = imageRef === ''
            ? this.credential('', true)
            : this.credential(imageRef, false)
          this.credentials.reviewSecret = reviewRef === ''
            ? this.credential('', true)
            : this.credential(reviewRef, false)
          this.publish()
          return
        }
        const value = (ref) => {
          const status = response.value[ref]
          return { ref, configured: status?.configured ?? false, writable: status?.writable ?? true, known: true }
        }
        this.credentials.imageSecret = imageRef === '' ? this.credential('', true) : value(imageRef)
        this.credentials.reviewSecret = reviewRef === '' ? this.credential('', true) : value(reviewRef)
        this.publish()
      }

      async writeCredential(referenceField, value) {
        const reference = this.ref(referenceField)
        if (reference === '') return false
        const saved = await this.ctx.remote.credentials.set(reference, value)
        if (!saved.ok) return false
        const response = await this.ctx.remote.credentials.describe([reference])
        if (!response.ok) return false
        await this.readCredentials()
        return response.value[reference]?.configured === true
      }

      refreshCredential(ref) {
        if (ref === this.ref('imageCredential') || ref === this.ref('reviewCredential')) void this.readCredentials()
      }

      inject() {
        return {
          hooks: { imageIterateSettings: this.store },
          edit: (field, value) => {
            this.model.actions().edit(field, value)
            if (field === 'imageCredential' || field === 'reviewCredential') void this.readCredentials()
          },
          resetField: field => { this.model.actions().resetField(field) },
          discard: () => { this.model.actions().discard(); void this.readCredentials() },
          save: () => { void this.save() },
        }
      }

      async save() {
        const state = this.model.shell()
        if (!state.available || state.invalid || state.saving) return
        await this.model.save()
      }

      dispose() {
        this.disposed = true
        this.unsubscribe()
        this.scopeUnsubscribe()
        this.model.dispose()
      }
    }

    function formLabels(t) {
      return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
    }

    function SettingsCard(props) {
      const state = props.useImageIterateSettings(snapshot => snapshot)
      const t = props.t
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable || state.saving
      const field = (name, numeric, invalid) => h(SettingsValueField, {
        id: `plugin-config-image-iterate-${name}`, label: t(name), overriddenLabel: t('overridden'), resetLabel: t('reset'),
        invalidLabel: t(invalid || 'invalidNumber'), disabled, numeric, ...state[name],
        onEdit: text => { props.edit(name, text) }, onReset: () => { props.resetField(name) },
      })
      return h(SettingsForm, { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
        field('imageBaseUrl'), field('imageModel'), field('imageCredential'),
        h(SettingsSecretField, {
          id: 'plugin-config-image-iterate-image-secret', label: t('imageSecret'), hint: t('secretHint'), text: state.imageSecret.text,
          disabled: !state.imageWritable || state.saving, configured: state.imageConfigured,
          stateLabel: !state.imageCredentialKnown ? t('credentialUnknown') : state.imageConfigured ? t('configured') : t('unconfigured'), onEdit: text => { props.edit('imageSecret', text) },
        }),
        field('reviewBaseUrl'), field('reviewModel'), field('reviewCredential'),
        h(SettingsSecretField, {
          id: 'plugin-config-image-iterate-review-secret', label: t('reviewSecret'), hint: t('secretHint'), text: state.reviewSecret.text,
          disabled: !state.reviewWritable || state.saving, configured: state.reviewConfigured,
          stateLabel: !state.reviewCredentialKnown ? t('credentialUnknown') : state.reviewConfigured ? t('configured') : t('unconfigured'), onEdit: text => { props.edit('reviewSecret', text) },
        }),
        field('maxIterations', true, 'invalidIterations'), field('timeoutMs', true, 'invalidTimeout'),
        field('defaultSize'), field('defaultQuality'), field('outputFormat', false, 'invalidFormat'),
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(localeNamespace)
        ctx.effect(() => ctx.locale.register(localeNamespace, { en, zh }), 'image-iterate-plugin: dictionaries')
        const card = new ImageIterateSettingsController(ctx)
        ctx.effect(() => () => { card.dispose() }, 'image-iterate-plugin: form subscription')
        ctx.effect(
          () => ctx.remote.$on('credentials/reference-updated', ref => { card.refreshCredential(ref) }),
          'image-iterate-plugin: credential invalidations',
        )
        ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item', id: 'image-iterate-plugin', order: 30, label: () => t('title'), locale: localeNamespace, inject: () => card.inject(),
        }, SettingsCard))), 'image-iterate-plugin: page')
        ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'generate_image_with_review', children: { [imageSlot]: { kind: 'single', scope: 'session' } },
        }, ImageResultRow)), 'image-iterate-plugin: tool row')
        ctx.effect(() => ctx.slots.inject(imageSlot, () => ctx.slots.register({ name: imageSlot, priority: 100 }, ImageResultGallery)), 'image-iterate-plugin: image gallery')
      },
    }
  },
})
