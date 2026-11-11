/** Render generated image attachments in the tool result through the shared image slot. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { createElement as h } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

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

export const inject = ['slots']

/** Register the image tool view; the shared gallery is rendered through its root Factory. */
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image_with_review',
  }, ImageResultRow))
}
