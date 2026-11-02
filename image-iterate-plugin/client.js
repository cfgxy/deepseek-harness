window.__ModuleLoader__.load({
  id: 'dsh-image-iterate-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const imageSlot = 'image-iterate.tool.call.images'

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
        originalDimensions = {
          width: image.originalDimensions.width,
          height: image.originalDimensions.height,
        }
      }
      return {
        attachmentId,
        mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
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
        children.push(renderSlot(imageSlot, {
          images: [{ attachment }],
          loadImage,
          align: 'start',
        }))
      }
      return children.length === 0 ? null : h('div', null, ...children)
    }

    function ImageResultGallery({ images, loadImage, align, renderFactorySlot }) {
      if (typeof renderFactorySlot !== 'function') return null
      return renderFactorySlot('conversation.images.content', { images, loadImage, align })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'generate_image_with_review',
          children: { [imageSlot]: { kind: 'single', scope: 'session' } },
        }, ImageResultRow))
        ctx.slots.inject(imageSlot, () => ctx.slots.register({
          name: imageSlot,
          priority: 100,
        }, ImageResultGallery))
      },
    }
  },
})
