/** Browser-side settings page and tool result view for image generation and review. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ChatNode, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition, MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { createElement as h } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SettingsCard } from './SettingsCard.tsx'
import { en, zh, type ImageIterateSettingsLocaleKey } from './locales.ts'
import { IMAGE_ITERATE_NS, ImageIterateSettingsController } from './settings-card-controller.ts'

type ImageToolViewProps = ToolCallViewProps & PropsRenderFactories

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function attachmentFrom(meta: unknown): ImageAttachmentRef | undefined {
  const image = record(record(meta)?.image)
  if (image === undefined) return undefined
  const attachmentId = typeof image.attachmentId === 'string' ? image.attachmentId : image.attachment_id
  const mediaType = typeof image.mediaType === 'string' ? image.mediaType : image.media_type
  const bytes = image.bytes
  const width = image.width
  const height = image.height
  if (typeof attachmentId !== 'string' || attachmentId === '' || !isImageMediaType(mediaType)
    || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1
    || typeof width !== 'number' || !Number.isInteger(width) || width < 1
    || typeof height !== 'number' || !Number.isInteger(height) || height < 1) return undefined
  const original = image.originalDimensions
  let originalDimensions: ImageAttachmentRef['originalDimensions']
  if (original !== undefined) {
    const dimensions = record(original)
    const originalWidth = dimensions?.width
    const originalHeight = dimensions?.height
    if (dimensions === undefined || typeof originalWidth !== 'number' || !Number.isInteger(originalWidth) || originalWidth < 1
      || typeof originalHeight !== 'number' || !Number.isInteger(originalHeight) || originalHeight < 1) return undefined
    originalDimensions = { width: originalWidth, height: originalHeight }
  }
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
    ...(typeof image.name === 'string' ? { name: image.name } : {}),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

function textFrom(content: readonly unknown[]): string {
  return content
    .filter((part): part is Record<string, unknown> => record(part)?.type === 'text' && typeof record(part)?.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}

function ImageResultRow(props: ImageToolViewProps): ReactNode {
  if (props.phase !== 'result') return null
  const attachment = props.block.isError ? undefined : attachmentFrom(props.block.meta)
  const text = textFrom(props.block.content)
  const children: ReactNode[] = text === '' ? [] : [h('pre', { key: 'output', style: { margin: 0, whiteSpace: 'pre-wrap' } }, text)]
  if (attachment !== undefined) {
    const image: { readonly attachment: ImageAttachmentRef } = { attachment }
    const loadImage: MessageImageLoader = props.loadImage
    children.push(props.renderFactorySlot('conversation.images.content', {
      images: [image], loadImage, align: 'start',
    }))
  }
  return children.length === 0 ? null : h('div', null, ...children)
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Saved image delivered by the image generation tool. */
    'generated-image': ImageAttachmentRef
  }
}

const generatedImageDefinition: ConversationNodeDefinition<ImageAttachmentRef | undefined> = {
  kind: 'generated-image',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data.message.isError
      || record(event.data.meta)?.kind !== 'image-iterate-result' || attachmentFrom(event.data.meta) === undefined) return null
    return { id: String(event.data.message.source.callId), role: 'start' }
  },
  start: (_context, { event }) => event.type === 'tool/result' ? attachmentFrom(event.data.meta) : undefined,
  update: ({ state }) => state,
  buildViewNode: ({ start, key, id, state: data }) => {
    if (start === undefined || data === undefined) return null
    return {
      key, id, kind: 'generated-image', target: 'chat', anchorSeq: start.event.seq,
      location: start.location, groupTree: 'turn', visibility: 'visible', data,
    } satisfies ChatNode<'generated-image'>
  },
}

function GeneratedImage({ node, loadImage, renderFactorySlot }: Pick<
  ChatNodeViewProps<'generated-image'>, 'node' | 'loadImage' | 'renderFactorySlot'
>): ReactNode {
  return renderFactorySlot('conversation.images.content', {
    images: [{ attachment: node.data }], loadImage, align: 'start',
  })
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image generation and review settings copy. */
    'settings.imageIterate': ImageIterateSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.imageIterate'

/** Client services required by the settings page and tool result view. */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms', 'uiConversation']

/** Register the image settings page and the persisted image result view. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'image-iterate-plugin: dictionaries')
  const card = new ImageIterateSettingsController(ctx.configForms.get(IMAGE_ITERATE_NS), ctx)
  ctx.effect(() => () => { card.dispose() }, 'image-iterate-plugin: form subscription')
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    'image-iterate-plugin: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([IMAGE_ITERATE_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'image-iterate-plugin', order: 30, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, SettingsCard))), 'image-iterate-plugin: page')
  ctx.uiConversation.events.register(generatedImageDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'generated-image',
  }, GeneratedImage))
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'generate_image_with_review',
  }, ImageResultRow)), 'image-iterate-plugin: tool row')
}
